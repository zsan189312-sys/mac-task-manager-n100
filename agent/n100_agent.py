#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
n100_agent.py — 任务管理器-N100 的数据采集端（常驻 agent）

设计目标：
  1. 零第三方依赖（仅 Python 3 标准库）
  2. 流量极省：响应 gzip 压缩 + 按需采集（进程表/Docker 只在被请求时采样）
  3. 数据最全：/proc + /sys 直读，root 运行可拿到 RAPL 真实功耗与全部进程磁盘 IO

接口：
  GET /api/snapshot          系统快照（CPU/内存/磁盘/网络/GPU/温度/功耗/系统信息）
  GET /api/procs?top=60      进程表（按需采样，返回 Top N）
  GET /api/docker            Docker 容器列表与占用（按需采样）
  GET /api/health            健康检查

安全：
  默认只监听 Tailscale 地址（BIND_HOST），可选 token 校验（TOKEN）
"""

import gzip
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BIND_HOST = os.environ.get("N100_BIND", "100.111.73.34")
BIND_PORT = int(os.environ.get("N100_PORT", "9100"))
TOKEN = os.environ.get("N100_TOKEN", "")
CACHE_SECONDS = float(os.environ.get("N100_CACHE", "0.8"))

SAMPLE_INTERVAL = 1.0          # 系统指标采样周期（秒）
PROC_INTERVAL = 2.0            # 进程表采样周期（秒，按需）
PROC_IDLE_TIMEOUT = 8.0        # 多久没人要进程表就停止采样
DOCKER_INTERVAL = 10.0         # Docker 采样周期（秒，按需）
DOCKER_IDLE_TIMEOUT = 30.0
NET_PROC_INTERVAL = 5.0        # 每进程网速（ss 解析，较慢）采样周期

HZ = os.sysconf("SC_CLK_TCK")

# ---------------------------------------------------------------- 工具函数

def read_file(path, default=""):
    try:
        with open(path, "r", errors="ignore") as f:
            return f.read()
    except Exception:
        return default


def read_int(path, default=0):
    v = read_file(path, "")
    try:
        return int(v.strip())
    except Exception:
        return default


def sh(cmd, timeout=6):
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return r.stdout
    except Exception:
        return ""


# ---------------------------------------------------------------- Intel 核显（i915 / xe）

_GPU_CACHE = {"path": None, "path_t": 0.0, "info": None, "info_t": 0.0}


def gpu_gt_path():
    """定位核显 sysfs 节点 /sys/class/drm/card*/gt/gt0（i915 与 xe 驱动通用），60 秒缓存"""
    now = time.time()
    if _GPU_CACHE["path"] is not None and now - _GPU_CACHE["path_t"] < 60:
        return _GPU_CACHE["path"]
    path = None
    base = "/sys/class/drm"
    if os.path.isdir(base):
        for d in sorted(os.listdir(base)):
            if not re.match(r"^card\d+$", d):
                continue
            p = os.path.join(base, d, "gt", "gt0")
            if os.path.isdir(p):
                path = p
                break
    _GPU_CACHE["path"] = path
    _GPU_CACHE["path_t"] = now
    return path


def gpu_info():
    """核显静态信息（型号 / 驱动 / PCI ID），10 分钟缓存；无核显时返回 None"""
    now = time.time()
    if _GPU_CACHE["info"] is not None and now - _GPU_CACHE["info_t"] < 600:
        return _GPU_CACHE["info"]
    name = driver = pci = slot = ""
    base = "/sys/class/drm"
    card = None
    if os.path.isdir(base):
        for d in sorted(os.listdir(base)):
            if re.match(r"^card\d+$", d):
                card = d
                break
    if card:
        dev = os.path.join(base, card, "device")
        try:
            slot = os.path.basename(os.path.realpath(dev))
        except Exception:
            slot = ""
        for line in read_file(os.path.join(dev, "uevent")).splitlines():
            if line.startswith("DRIVER="):
                driver = line.split("=", 1)[1].strip()
            elif line.startswith("PCI_ID="):
                pci = line.split("=", 1)[1].strip()
    # 型号名：优先 lspci（取其 "设备类编号]: " 之后的部分，并去掉结尾的 [厂商:设备] 编号）
    if slot:
        out = sh("lspci -nn -s %s 2>/dev/null" % slot, timeout=4)
        m = re.search(r"\[[0-9a-fA-F]{4}\]:\s*(.+)$", out.strip())
        if m:
            name = re.sub(r"\s*\[[0-9a-fA-F]{4}:[0-9a-fA-F]{4}\]\s*$", "", m.group(1)).strip()
    if not name:
        name = ("Intel 核显" if pci.startswith("8086") else "核显") + ((" (" + pci + ")") if pci else "")
    v = {"name": name, "driver": driver, "pci": pci, "shared": True} if (driver or pci or name) else None
    _GPU_CACHE["info"] = v
    _GPU_CACHE["info_t"] = now
    return v


# ---------------------------------------------------------------- 系统指标采样器

class Sampler(threading.Thread):
    """后台常驻采样：CPU 每核 / 磁盘速率 / 网络速率 / RAPL 功耗 / 温度"""

    def __init__(self):
        super().__init__(daemon=True)
        self.lock = threading.Lock()
        self.prev_cpu = self._read_cpu()
        self.prev_disk = self._read_diskstats()
        self.prev_net = self._read_netdev()
        self.prev_rapl = self._read_rapl()
        self.prev_t = time.time()
        self.prev_gpu_rc6 = None
        self.state = {
            "cores": [], "cpu_total": 0.0, "cpu_user": 0.0, "cpu_sys": 0.0,
            "cpu_iowait": 0.0, "disk": [], "disk_total_r": 0.0, "disk_total_w": 0.0,
            "net": [], "gpu": None, "power_pkg": 0.0, "power_cores": 0.0, "power_ok": False,
            "temp": {}, "sample_age": 0.0,
        }
        self._stop = False

    # ---- 原始数据读取 ----
    @staticmethod
    def _read_cpu():
        """返回 {core_id: [user,nice,system,idle,iowait,irq,softirq,steal]}"""
        out = {}
        for line in read_file("/proc/stat").splitlines():
            if not line.startswith("cpu"):
                continue
            p = line.split()
            if p[0] == "cpu":
                continue
            try:
                cid = int(p[0][3:])
            except ValueError:
                continue
            vals = [int(x) for x in p[1:9]]
            out[cid] = vals
        return out

    @staticmethod
    def _is_real_disk(name):
        """排除 loop/ram/zram/dm 等虚拟设备，以及分区（只保留整块磁盘，避免重复计数）"""
        if re.match(r"^(loop|ram|zram|dm-|fd|sr)", name):
            return False
        if os.path.exists("/sys/class/block/%s/partition" % name):
            return False
        return True

    @classmethod
    def _read_diskstats(cls):
        out = {}
        for line in read_file("/proc/diskstats").splitlines():
            p = line.split()
            if len(p) < 14:
                continue
            name = p[2]
            if not cls._is_real_disk(name):
                continue
            try:
                # 字段：reads, merges, sectors_read, ms, writes, merges_w, sectors_written...
                out[name] = (int(p[5]) * 512, int(p[9]) * 512, int(p[12]))
            except (ValueError, IndexError):
                continue
        return out

    @staticmethod
    def _is_kept_iface(name):
        """只保留物理网卡 / Wi-Fi / Tailscale / docker0，排除 veth*、br-*（容器虚拟网卡，数量多且无意义）"""
        if name == "lo":
            return False
        if re.match(r"^(veth|br-|virbr|zt|tun[0-9]|wg[0-9])", name):
            return False
        return True

    @classmethod
    def _read_netdev(cls):
        out = {}
        for line in read_file("/proc/net/dev").splitlines()[2:]:
            if ":" not in line:
                continue
            name, rest = line.split(":", 1)
            name = name.strip()
            if not cls._is_kept_iface(name):
                continue
            p = rest.split()
            if len(p) < 16:
                continue
            try:
                out[name] = (int(p[0]), int(p[8]))
            except ValueError:
                continue
        return out

    @staticmethod
    def _read_rapl():
        """返回 {name: energy_uj}，无权限时为空"""
        vals = {}
        base = "/sys/class/powercap"
        if not os.path.isdir(base):
            return vals
        for d in os.listdir(base):
            if not d.startswith("intel-rapl"):
                continue
            p = os.path.join(base, d)
            v = read_int(os.path.join(p, "energy_uj"), -1)
            if v >= 0:
                vals[d] = v
            for sub in os.listdir(p) if os.path.isdir(p) else []:
                if sub.startswith("intel-rapl"):
                    v2 = read_int(os.path.join(p, sub, "energy_uj"), -1)
                    if v2 >= 0:
                        vals[sub] = v2
        return vals

    @staticmethod
    def _read_temp():
        temps = {}
        base = "/sys/class/thermal"
        if not os.path.isdir(base):
            return temps
        for d in sorted(os.listdir(base)):
            if not d.startswith("thermal_zone"):
                continue
            t = read_int(os.path.join(base, d, "temp"), -999)
            typ = read_file(os.path.join(base, d, "type"), d).strip()
            if t > -999:
                temps[typ] = round(t / 1000.0, 1)
        return temps

    # ---- 采样循环 ----
    def run(self):
        while not self._stop:
            time.sleep(SAMPLE_INTERVAL)
            now = time.time()
            dt = max(now - self.prev_t, 0.001)
            try:
                self._tick(dt)
            except Exception as e:
                sys.stderr.write("sampler error: %r\n" % (e,))
            self.prev_t = now

    def _tick(self, dt):
        cpu = self._read_cpu()
        cores = []
        tot_u = tot_s = tot_i = tot_w = 0
        for cid in sorted(cpu.keys()):
            cur, prev = cpu[cid], self.prev_cpu.get(cid)
            if not prev:
                cores.append(0.0)
                continue
            du = cur[0] - prev[0]
            dn = cur[1] - prev[1]
            ds = cur[2] - prev[2]
            di = cur[3] - prev[3]
            dw = cur[4] - prev[4]
            total = du + dn + ds + di + dw
            busy = du + dn + ds
            cores.append(round(busy * 100.0 / total, 1) if total > 0 else 0.0)
            tot_u += du
            tot_s += ds
            tot_i += di
            tot_w += dw
        self.prev_cpu = cpu

        total_all = tot_u + tot_s + tot_i + tot_w
        cpu_total = (tot_u + tot_s) * 100.0 / total_all if total_all > 0 else 0.0

        disk = self._read_diskstats()
        disks = []
        tr = tw = 0.0
        for name, (r, w, busy_ms) in disk.items():
            pr, pw, _ = self.prev_disk.get(name, (r, w, 0))
            dr = max(0, r - pr) / dt
            dw = max(0, w - pw) / dt
            tr += dr
            tw += dw
            if dr + dw > 0 or name in ("nvme0n1", "sda", "mmcblk0"):
                disks.append({"name": name, "r": round(dr, 1), "w": round(dw, 1)})
        self.prev_disk = disk

        net = self._read_netdev()
        ifaces = []
        for name, (rx, tx) in net.items():
            prx, ptx = self.prev_net.get(name, (rx, tx))
            rxb = max(0, rx - prx) / dt
            txb = max(0, tx - ptx) / dt
            ifaces.append({"name": name, "rx": round(rxb, 1), "tx": round(txb, 1),
                           "rxTotal": rx, "txTotal": tx})
        self.prev_net = net

        rapl = self._read_rapl()
        pkg = cores_w = 0.0
        power_ok = bool(rapl)
        if rapl:
            for key, cur in rapl.items():
                prev = self.prev_rapl.get(key)
                if prev is None:
                    continue
                d = cur - prev
                if d < 0:  # 计数器回绕
                    continue
                watts = d / 1e6 / dt
                if key == "intel-rapl:0":
                    pkg = watts
                elif key == "intel-rapl:0:0":
                    cores_w = watts
        self.prev_rapl = rapl

        gpu = self._read_gpu(dt)

        with self.lock:
            self.state.update({
                "cores": cores,
                "cpu_total": round(cpu_total, 1),
                "cpu_user": round(tot_u * 100.0 / total_all, 1) if total_all else 0.0,
                "cpu_sys": round(tot_s * 100.0 / total_all, 1) if total_all else 0.0,
                "cpu_iowait": round(tot_w * 100.0 / total_all, 1) if total_all else 0.0,
                "disk": disks,
                "disk_total_r": round(tr, 1),
                "disk_total_w": round(tw, 1),
                "net": ifaces,
                "gpu": gpu,
                "power_pkg": round(pkg, 2),
                "power_cores": round(cores_w, 2),
                "power_ok": power_ok,
                "temp": self._read_temp(),
                "sample_age": 0.0,
            })

    def _read_gpu(self, dt):
        """核显实时状态：rc6_residency_ms（空闲驻留 ms）差分 → 真实利用率；rps_cur_freq 为当前频率

        无核显 / 无 gt 节点 / 无权限时返回 None，前端自动隐藏 GPU 卡片。
        """
        gt = gpu_gt_path()
        if not gt:
            return None
        rc6 = read_int(os.path.join(gt, "rc6_residency_ms"), -1)
        cur_f = read_int(os.path.join(gt, "rps_cur_freq_mhz"), 0) or read_int(os.path.join(gt, "rps_act_freq_mhz"), 0)
        fmax = read_int(os.path.join(gt, "rps_RP0_freq_mhz"), 0) or read_int(os.path.join(gt, "rps_max_freq_mhz"), 0)
        fmin = read_int(os.path.join(gt, "rps_RPn_freq_mhz"), 0) or read_int(os.path.join(gt, "rps_min_freq_mhz"), 0)
        busy = None
        if rc6 >= 0:
            if self.prev_gpu_rc6 is not None:
                d = rc6 - self.prev_gpu_rc6
                if d >= 0:
                    # rc6 计的是"空闲"时间：利用率 = 1 - 空闲占比
                    busy = max(0.0, min(100.0, 100.0 * (1.0 - (d / 1000.0) / dt)))
            self.prev_gpu_rc6 = rc6
        info = gpu_info() or {}
        return {
            "busy": round(busy, 1) if busy is not None else None,
            "freq": cur_f, "freqMax": fmax, "freqMin": fmin,
            "name": info.get("name", ""), "driver": info.get("driver", ""),
            "shared": True,
        }

    def snapshot(self):
        with self.lock:
            st = dict(self.state)
        st["cores"] = list(st["cores"])
        st["disk"] = [dict(d) for d in st["disk"]]
        st["net"] = [dict(n) for n in st["net"]]
        st["temp"] = dict(st["temp"])
        st["gpu"] = dict(st["gpu"]) if st.get("gpu") else None
        return st

    def stop(self):
        self._stop = True


# ---------------------------------------------------------------- 进程表采样器（按需）

class ProcSampler(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self.lock = threading.Lock()
        self.last_request = 0.0
        self.prev_stat = {}
        self.prev_io = {}
        self.prev_net = {}
        self.prev_t = 0.0
        self.procs = []
        self.cache = {}
        self.cache_t = 0.0
        self._stop = False

    @staticmethod
    def _read_proc_stat():
        """{pid: (utime+stime, rss_pages, comm)}"""
        out = {}
        for pid in os.listdir("/proc"):
            if not pid.isdigit():
                continue
            try:
                with open("/proc/%s/stat" % pid, "r", errors="ignore") as f:
                    data = f.read()
                rp = data.rfind(")")
                if rp < 0:
                    continue
                comm = data[data.find("(") + 1:rp]
                fields = data[rp + 2:].split()
                utime = int(fields[11])
                stime = int(fields[12])
                rss_pages = int(fields[21])
                out[int(pid)] = (utime + stime, rss_pages, comm)
            except Exception:
                continue
        return out

    @staticmethod
    def _read_proc_io(pids):
        out = {}
        for pid in pids:
            try:
                vals = {}
                with open("/proc/%d/io" % pid, "r", errors="ignore") as f:
                    for line in f:
                        if "read_bytes" in line or "write_bytes" in line:
                            k, v = line.split(":")
                            vals[k.strip()] = int(v.strip())
                if vals:
                    out[pid] = (vals.get("read_bytes", 0), vals.get("write_bytes", 0))
            except Exception:
                continue
        return out

    @staticmethod
    def _read_proc_net():
        """用 ss -tinp 统计每个进程的 TCP 累计字节（UDP 不计）"""
        out = {}
        raw = sh("ss -tinp state connected 2>/dev/null")
        cur_pid = None
        for line in raw.splitlines():
            m = re.search(r'pid=(\d+)', line)
            if m and not line.startswith("\t"):
                cur_pid = int(m.group(1))
            elif line.startswith("\t") and cur_pid is not None:
                sent = re.search(r"bytes_sent:(\d+)", line)
                recv = re.search(r"bytes_received:(\d+)", line)
                if sent or recv:
                    s = int(sent.group(1)) if sent else 0
                    r = int(recv.group(1)) if recv else 0
                    a, b = out.get(cur_pid, (0, 0))
                    out[cur_pid] = (a + r, b + s)
        return out

    def request(self):
        """客户端请求进程表：唤醒采样"""
        self.last_request = time.time()
        now = time.time()
        if now - self.cache_t < CACHE_SECONDS and self.cache:
            return self.cache
        with self.lock:
            return self.cache or {"list": [], "count": 0}

    def run(self):
        while not self._stop:
            time.sleep(PROC_INTERVAL)
            if time.time() - self.last_request > PROC_IDLE_TIMEOUT:
                continue  # 无人请求，不采样（省 CPU）
            try:
                self._tick()
            except Exception as e:
                sys.stderr.write("proc sampler error: %r\n" % (e,))

    def _tick(self):
        now = time.time()
        dt = max(now - self.prev_t, 0.001) if self.prev_t else PROC_INTERVAL
        stat = self._read_proc_stat()
        pids = list(stat.keys())
        io = self._read_proc_io(pids)
        if now - getattr(self, "_net_t", 0) >= NET_PROC_INTERVAL:
            self.prev_net_snapshot = self._read_proc_net()
            self._net_t = now
        net_now = getattr(self, "prev_net_snapshot", {})

        ncores = os.cpu_count() or 4
        rows = []
        for pid, (ticks, rss_pages, comm) in stat.items():
            prev = self.prev_stat.get(pid)
            cpu = 0.0
            if prev:
                cpu = max(0.0, (ticks - prev) / HZ / dt * 100.0)
            pr, pw = self.prev_io.get(pid, (0, 0))
            cr, cw = io.get(pid, (0, 0))
            dr = max(0, cr - pr) / dt if prev else 0.0
            dw = max(0, cw - pw) / dt if prev else 0.0
            pnr, pnt = self._prev_net_map.get(pid, (0, 0)) if hasattr(self, "_prev_net_map") else (0, 0)
            cnr, cnt = net_now.get(pid, (0, 0))
            nrx = max(0, cnr - pnr) / (NET_PROC_INTERVAL if pnr else dt)
            ntx = max(0, cnt - pnt) / (NET_PROC_INTERVAL if pnt else dt)
            rows.append({
                "pid": pid,
                "name": comm,
                "cpu": round(cpu / ncores, 2),      # 整机占比口径（最大 100）
                "cpuCore": round(cpu, 1),           # 单核口径
                "rss": rss_pages * os.sysconf("SC_PAGE_SIZE"),
                "dr": round(dr, 1),
                "dw": round(dw, 1),
                "nrx": round(nrx, 1),
                "ntx": round(ntx, 1),
            })
        self.prev_stat = {pid: v[0] for pid, v in stat.items()}
        self.prev_io = io
        self._prev_net_map = net_now
        self.prev_t = now
        rows.sort(key=lambda r: -r["cpu"])
        with self.lock:
            self.cache = {"list": rows, "count": len(rows), "ts": now}
            self.cache_t = now

    def top(self, n):
        with self.lock:
            rows = list(self.cache.get("list", []))
            cnt = self.cache.get("count", 0)
        return {"list": rows[:n], "count": cnt, "ts": self.cache.get("ts", 0)}

    def stop(self):
        self._stop = True


# ---------------------------------------------------------------- Docker 采样器（按需）

class DockerSampler(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self.lock = threading.Lock()
        self.last_request = 0.0
        self.cache = {"containers": [], "ts": 0}
        self._stop = False

    def request(self):
        self.last_request = time.time()
        with self.lock:
            return self.cache

    def run(self):
        while not self._stop:
            time.sleep(DOCKER_INTERVAL)
            if time.time() - self.last_request > DOCKER_IDLE_TIMEOUT:
                continue
            try:
                self._tick()
            except Exception:
                pass

    def _tick(self):
        # 注意：docker stats --format 不支持 .Status（非法字段会导致整条命令无输出）
        fmt = '{{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}\\t{{.MemPerc}}\\t{{.NetIO}}\\t{{.BlockIO}}\\t{{.PIDs}}'
        raw = sh("docker stats --no-stream --format '%s' 2>/dev/null" % fmt, timeout=12)
        rows = []
        for line in raw.splitlines():
            p = line.split("\t")
            if len(p) < 6:
                continue
            rows.append({
                "name": p[0],
                "cpu": p[1],
                "mem": p[2].split(" / ")[0] if " / " in p[2] else p[2],
                "memPerc": p[3],
                "net": p[4],
                "io": p[5],
                "pids": p[6] if len(p) > 6 else "",
            })
        with self.lock:
            self.cache = {"containers": rows, "ts": time.time()}

    def stop(self):
        self._stop = True


# ---------------------------------------------------------------- 系统静态/慢变信息

_static_cache = {"t": 0, "v": None}


def static_info():
    now = time.time()
    if _static_cache["v"] and now - _static_cache["t"] < 300:
        return _static_cache["v"]
    cpuinfo = read_file("/proc/cpuinfo")
    model = ""
    for line in cpuinfo.splitlines():
        if line.startswith("model name"):
            model = line.split(":", 1)[1].strip()
            break
    freq_max = read_int("/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq", 0) // 1000
    uptime_s = float(read_file("/proc/uptime", "0 0").split()[0] or 0)
    mem_total = 0
    for line in read_file("/proc/meminfo").splitlines():
        if line.startswith("MemTotal"):
            mem_total = int(line.split()[1]) * 1024
            break
    disks = []
    for line in sh("df -B1 -x tmpfs -x devtmpfs -x overlay -x squashfs 2>/dev/null").splitlines()[1:]:
        p = line.split()
        if len(p) < 6:
            continue
        try:
            disks.append({"mount": p[5], "total": int(p[1]), "used": int(p[2]), "avail": int(p[3])})
        except ValueError:
            continue
    os_name = ""
    for line in read_file("/etc/os-release").splitlines():
        if line.startswith("PRETTY_NAME"):
            os_name = line.split("=", 1)[1].strip().strip('"')
            break
    v = {
        "model": model,
        "cores": os.cpu_count() or 1,
        "freqMaxMhz": freq_max,
        "memTotal": mem_total,
        "hostname": read_file("/proc/sys/kernel/hostname", "n100").strip(),
        "kernel": read_file("/proc/sys/kernel/osrelease", "").strip(),
        "os": os_name,
        "uptime": round(uptime_s),
        "gpu": gpu_info(),
        "disks": disks[:8],
    }
    _static_cache["v"] = v
    _static_cache["t"] = now
    return v


def mem_info():
    d = {}
    keys = ("MemTotal", "MemFree", "MemAvailable", "Buffers", "Cached",
            "SReclaimable", "Shmem", "AnonPages", "SwapTotal", "SwapFree", "Dirty", "Mapped")
    for line in read_file("/proc/meminfo").splitlines():
        k = line.split(":")[0]
        if k in keys:
            try:
                d[k] = int(line.split()[1]) * 1024
            except (ValueError, IndexError):
                pass
    return d


def freq_current():
    vals = []
    for d in sorted(os.listdir("/sys/devices/system/cpu")):
        m = re.match(r"cpu(\d+)$", d)
        if not m:
            continue
        f = read_int("/sys/devices/system/cpu/%s/cpufreq/scaling_cur_freq" % d, 0)
        vals.append(f // 1000)
    return vals


def load_avg():
    parts = read_file("/proc/loadavg", "0 0 0").split()
    try:
        return [float(parts[0]), float(parts[1]), float(parts[2])]
    except (ValueError, IndexError):
        return [0, 0, 0]


# ---------------------------------------------------------------- HTTP 服务

sampler = Sampler()
procs = ProcSampler()
dockers = DockerSampler()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "n100-agent/1.0"

    def log_message(self, fmt, *args):
        pass  # 静默，避免刷日志占磁盘

    def _auth_ok(self):
        if not TOKEN:
            return True
        return self.headers.get("X-Token") == TOKEN

    def _reply(self, obj, status=200):
        body = json.dumps(obj, separators=(",", ":")).encode("utf-8")
        headers = {"Content-Type": "application/json; charset=utf-8"}
        if "gzip" in (self.headers.get("Accept-Encoding") or ""):
            body = gzip.compress(body, 6)
            headers["Content-Encoding"] = "gzip"
        headers["Content-Length"] = str(len(body))
        headers["Cache-Control"] = "no-store"
        self.send_response(status)
        for k, v in headers.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if not self._auth_ok():
            self._reply({"error": "unauthorized"}, 401)
            return
        path = self.path.split("?")[0]
        try:
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n else b"{}"
            obj = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            obj = {}
        if path == "/api/kill":
            pid = int(obj.get("pid", 0))
            sig_name = str(obj.get("sig", "TERM")).upper()
            if pid <= 1:
                self._reply({"ok": False, "error": "invalid pid"}, 400)
                return
            sig = getattr(signal, "SIG" + sig_name, signal.SIGTERM)
            try:
                os.kill(pid, sig)
                self._reply({"ok": True, "pid": pid, "sig": sig_name})
            except ProcessLookupError:
                self._reply({"ok": False, "error": "no such process"}, 404)
            except PermissionError:
                self._reply({"ok": False, "error": "permission denied"}, 403)
            except Exception as e:
                self._reply({"ok": False, "error": str(e)}, 500)
        else:
            self._reply({"error": "not found"}, 404)

    def do_GET(self):
        if not self._auth_ok():
            self._reply({"error": "unauthorized"}, 401)
            return
        path = self.path.split("?")[0]
        q = {}
        if "?" in self.path:
            for kv in self.path.split("?", 1)[1].split("&"):
                if "=" in kv:
                    k, v = kv.split("=", 1)
                    q[k] = v
        try:
            if path == "/api/health":
                self._reply({"ok": True, "ts": time.time()})
            elif path == "/api/snapshot":
                st = sampler.snapshot()
                st.update({
                    "mem": mem_info(),
                    "freq": freq_current(),
                    "load": load_avg(),
                    "sys": static_info(),
                    "ts": time.time(),
                })
                self._reply(st)
            elif path == "/api/procs":
                procs.request()
                n = int(q.get("top", "80"))
                n = max(1, min(n, 400))
                self._reply(procs.top(n))
            elif path == "/api/docker":
                self._reply(dockers.request())
            else:
                self._reply({"error": "not found"}, 404)
        except Exception as e:
            self._reply({"error": str(e)}, 500)


def main():
    sampler.start()
    procs.start()
    dockers.start()
    srv = ThreadingHTTPServer((BIND_HOST, BIND_PORT), Handler)
    sys.stderr.write("n100-agent listening on %s:%d\n" % (BIND_HOST, BIND_PORT))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        sampler.stop()
        procs.stop()
        dockers.stop()


if __name__ == "__main__":
    main()
