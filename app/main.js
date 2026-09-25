// 任务管理器-N100：Electron 主进程
// 数据源：N100 上常驻的 n100_agent（HTTP + gzip），按需采集，流量可统计
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

app.setName('任务管理器-N100');
nativeTheme.themeSource = 'dark'; // 锁定深色，避免浅色模式下毛玻璃看不清

const DEFAULT_CFG = {
  host: '100.111.73.34',
  port: 9100,
  intervalMs: 5000,   // 默认 5 秒（省流量）
  procTop: 80         // 进程表最多取多少条
};
const CFG_PATH = path.join(app.getPath('userData'), 'config.json');
function loadCfg() {
  try { return Object.assign({}, DEFAULT_CFG, JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'))); }
  catch (e) { return Object.assign({}, DEFAULT_CFG); }
}
function saveCfg(c) { try { fs.writeFileSync(CFG_PATH, JSON.stringify(c, null, 2)); } catch (e) { } }
let cfg = loadCfg();

let wantProcs = false;     // 进程页是否打开（按需采集）
let wantDocker = false;    // 容器页是否打开
let lastSnap = null, lastProcs = { list: [], count: 0 }, lastDocker = { containers: [] };
let bytesTotal = 0, polls = 0, lastRtt = 0, linkOk = false, failStreak = 0;

// ---------------------------------------------------------------- HTTP
function getJSON(p) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = http.request({
      host: cfg.host, port: cfg.port, path: p, method: 'GET', timeout: 8000,
      headers: { 'Accept-Encoding': 'gzip', 'Connection': 'keep-alive' }
    }, (res) => {
      const chunks = [];
      let raw = 0;
      res.on('data', c => { chunks.push(c); raw += c.length; });
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        try {
          if (res.headers['content-encoding'] === 'gzip') buf = zlib.gunzipSync(buf);
        } catch (e) { }
        bytesTotal += raw; // 统计线上字节（压缩后）
        const ms = Date.now() - t0;
        try { resolve({ ok: true, data: JSON.parse(buf.toString('utf8')), ms, bytes: raw }); }
        catch (e) { resolve({ ok: false, err: 'bad json', ms, bytes: raw }); }
      });
    });
    req.on('error', () => resolve({ ok: false, err: 'conn' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, err: 'timeout' }); });
    req.end();
  });
}

function postJSON(p, obj) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(obj));
    const req = http.request({
      host: cfg.host, port: cfg.port, path: p, method: 'POST', timeout: 8000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length }
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { bytesTotal += body.length; resolve({ ok: res.statusCode === 200, body: d }); });
    });
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
    req.write(body); req.end();
  });
}

// ---------------------------------------------------------------- 数据整形
const MEM = (m) => {
  const total = m.MemTotal || 1;
  const avail = m.MemAvailable || 0;
  const used = total - avail;
  return {
    total, avail, used,
    percent: used / total * 100,
    cached: (m.Cached || 0) + (m.SReclaimable || 0),
    buffers: m.Buffers || 0,
    shmem: m.Shmem || 0,
    anon: m.AnonPages || 0,
    swapTotal: m.SwapTotal || 0,
    swapUsed: (m.SwapTotal || 0) - (m.SwapFree || 0)
  };
};

function buildPayload() {
  const s = lastSnap || {};
  const mem = MEM(s.mem || {});
  const pkgW = (s.power_pkg || 0);
  const procsList = (lastProcs.list || []).map(p => ({
    pid: p.pid, name: p.name, cpu: p.cpu, cpuCore: p.cpuCore, rss: p.rss,
    dr: p.dr, dw: p.dw, nrx: p.nrx, ntx: p.ntx,
    // 能耗估算：真实整机封装功耗 × CPU 整机份额（比 macOS 版的纯估算准确得多）
    energy: pkgW * (p.cpu / 100)
  }));
  return {
    link: { ok: linkOk, rtt: lastRtt, bytes: bytesTotal, polls, interval: cfg.intervalMs,
            host: cfg.host + ':' + cfg.port },
    cpu: {
      cores: s.cores || [], total: s.cpu_total || 0, user: s.cpu_user || 0,
      sys: s.cpu_sys || 0, iowait: s.cpu_iowait || 0,
      freq: s.freq || [], freqMax: (s.sys && s.sys.freqMaxMhz) || 0,
      load: s.load || [0, 0, 0], count: (s.sys && s.sys.cores) || (s.cores || []).length,
      model: (s.sys && s.sys.model) || ''
    },
    mem,
    disk: {
      devices: s.disk || [], totalR: s.disk_total_r || 0, totalW: s.disk_total_w || 0,
      volumes: (s.sys && s.sys.disks) || []
    },
    net: { ifaces: s.net || [] },
    power: { pkg: pkgW, cores: s.power_cores || 0, ok: !!s.power_ok, temp: s.temp || {} },
    sys: s.sys || {},
    procs: { list: procsList, count: lastProcs.count || 0 },
    docker: lastDocker
  };
}

// ---------------------------------------------------------------- 轮询
let timer = null;
let lastProcFetch = 0, lastDockerFetch = 0;

async function poll() {
  const r = await getJSON('/api/snapshot');
  polls++;
  if (r.ok) {
    linkOk = true; failStreak = 0; lastRtt = r.ms; lastSnap = r.data;
  } else {
    failStreak++;
    if (failStreak >= 2) linkOk = false;
  }

  const now = Date.now();
  if (wantProcs && now - lastProcFetch >= Math.max(cfg.intervalMs, 3000)) {
    const rp = await getJSON('/api/procs?top=' + cfg.procTop);
    if (rp.ok) lastProcs = rp.data;
    lastProcFetch = now;
  }
  if (wantDocker && now - lastDockerFetch >= 15000) {
    const rd = await getJSON('/api/docker');
    if (rd.ok) lastDocker = rd.data;
    lastDockerFetch = now;
  }

  const win = BrowserWindow.getAllWindows()[0];
  if (win) win.webContents.send('stats', buildPayload());
}

function schedule() {
  if (timer) { clearInterval(timer); timer = null; }
  timer = setInterval(poll, cfg.intervalMs);
}

// ---------------------------------------------------------------- 窗口
function createWindow() {
  const win = new BrowserWindow({
    width: 1180, height: 760, minWidth: 900, minHeight: 600,
    title: '任务管理器-N100',
    backgroundColor: '#00000000',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    titleBarStyle: 'hiddenInset',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  win.loadFile(path.join(__dirname, 'index.html'));

  // 调试用：/tmp/tm_view 内容为页签名（perf/procs/docker），启动时直达该页
  win.webContents.on('did-finish-load', () => {
    try {
      const f = '/tmp/tm_view';
      if (fs.existsSync(f)) {
        const v = fs.readFileSync(f, 'utf8').trim();
        if (['perf', 'procs', 'docker'].includes(v)) {
          win.webContents.executeJavaScript(`try{switchView('${v}')}catch(e){}`).catch(() => {});
        }
      }
    } catch (e) { }
  });

  poll();          // 首次立即取一次
  schedule();
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ---------------------------------------------------------------- IPC
ipcMain.on('set-view', (e, v) => {
  wantProcs = (v === 'procs');
  wantDocker = (v === 'docker');
  if (wantProcs || wantDocker) poll();  // 切过去立刻取一次
});
ipcMain.on('set-interval', (e, ms) => {
  ms = parseInt(ms, 10);
  if ([2000, 5000, 10000].includes(ms)) { cfg.intervalMs = ms; saveCfg(cfg); schedule(); }
});
ipcMain.handle('get-config', () => cfg);
ipcMain.handle('kill-process', async (e, pid) => {
  const r = await postJSON('/api/kill', { pid, sig: 'TERM' });
  return r.ok;
});
