// 任务管理器-N100 渲染进程：远程 agent 数据 + 本机版 UI 风格
const HIST = 60;
const hist = { cpu: [], mem: [], disk: [], netrx: [], nettx: [], power: [], temp: [], cores: [] };

const cards = [
  { id: 'cpu',   title: 'CPU',      color: '#0a84ff' },
  { id: 'mem',   title: '内存',     color: '#bf5af2' },
  { id: 'disk',  title: '磁盘',     color: '#30d158' },
  { id: 'net',   title: '网络',     color: '#ffd60a' },
  { id: 'power', title: '功耗 / 温度', color: '#ff9f0a' }
];
const cardColor = Object.fromEntries(cards.map(c => [c.id, c.color]));
let activeCard = 'cpu';
let latest = null;
let procSort = 'cpu';
let procQuery = '';
let bodyBuilt = false;

// ---------- 工具 ----------
function fmtSize(b) {
  if (b === null || b === undefined || isNaN(b)) return '—';
  if (b >= 100 * 1024 ** 3) return (b / 1024 ** 3).toFixed(0) + ' GB';
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(1) + ' GB';
  if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(0) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
  return b.toFixed(0) + ' B';
}
function fmtRate(bps) {
  if (bps === null || bps === undefined || isNaN(bps)) return '—';
  if (bps >= 1024 ** 2) return (bps / 1024 ** 2).toFixed(1) + ' MB/s';
  if (bps >= 1024) return (bps / 1024).toFixed(0) + ' KB/s';
  return bps.toFixed(0) + ' B/s';
}
function push(arr, v) { arr.push(v); if (arr.length > HIST) arr.shift(); }
function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function setText(id, v) { const el = document.getElementById(id); if (el && el.textContent !== v) el.textContent = v; }

function setupCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const r = cv.getBoundingClientRect();
  const w = Math.max(1, r.width), h = Math.max(1, r.height);
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function drawSeries(cv, data, color, yMax) {
  if (!cv) return;
  const { ctx, w, h } = setupCanvas(cv);
  ctx.clearRect(0, 0, w, h);
  if (!data || data.length < 2) return;
  const max = Math.max(yMax || 0, ...data, 0.0001) * 1.15;
  const step = w / (HIST - 1);
  const x0 = w - (data.length - 1) * step;
  ctx.beginPath();
  data.forEach((v, i) => {
    const x = x0 + i * step;
    const y = h - 1.5 - (v / max) * (h - 3);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke();
  ctx.lineTo(x0 + (data.length - 1) * step, h); ctx.lineTo(x0, h); ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, color + '40'); g.addColorStop(1, color + '00');
  ctx.fillStyle = g; ctx.fill();
}

function drawOverlaid(cv, primary, secondary, c1, c2) {
  drawSeries(cv, primary, c1);
  if (!cv) return;
  const { ctx, w, h } = setupCanvas(cv);
  if (!secondary || secondary.length < 2) return;
  const max = Math.max(...primary, ...secondary, 0.0001) * 1.15;
  const step = w / (HIST - 1);
  const x0 = w - (secondary.length - 1) * step;
  ctx.beginPath();
  secondary.forEach((v, i) => {
    const x = x0 + i * step;
    const y = h - 1.5 - (v / max) * (h - 3);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = c2; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke();
}

// ---------- 侧栏 ----------
function buildSidebar() {
  const sb = document.getElementById('sidebar');
  sb.innerHTML = '';
  cards.forEach(c => {
    const el = document.createElement('div');
    el.className = 'card' + (c.id === activeCard ? ' active' : '');
    el.dataset.id = c.id;
    el.innerHTML = `
      <span class="dot" style="background:${c.color}"></span>
      <div class="card-body">
        <div class="card-title">${c.title}</div>
        <div class="card-sub" id="sub-${c.id}">正在采样…</div>
      </div>
      <canvas id="spark-${c.id}"></canvas>`;
    el.onclick = () => { activeCard = c.id; bodyBuilt = false; buildSidebar(); tickDetail(true); };
    sb.appendChild(el);
  });
}

function updateSidebar(d) {
  setText('sub-cpu', `${d.cpu.total.toFixed(0)}% · ${d.cpu.count} 核`);
  setText('sub-mem', `${fmtSize(d.mem.used)} / ${fmtSize(d.mem.total)}`);
  setText('sub-disk', `${fmtRate(d.disk.totalR + d.disk.totalW)}`);
  const main = mainIface(d);
  setText('sub-net', main ? `${main.name} ↓${fmtRate(main.rx)}` : '无接口');
  setText('sub-power', d.power.ok
    ? `${d.power.pkg.toFixed(1)} W · ${pkgTemp(d)}℃`
    : `${pkgTemp(d)}℃ · 功耗不可用`);

  drawSeries(document.getElementById('spark-cpu'), hist.cpu, '#0a84ff');
  drawSeries(document.getElementById('spark-mem'), hist.mem, '#bf5af2', 100);
  drawSeries(document.getElementById('spark-disk'), hist.disk, '#30d158');
  drawSeries(document.getElementById('spark-net'), hist.netrx, '#ffd60a');
  drawSeries(document.getElementById('spark-net'), hist.nettx, '#ff453a');
  drawSeries(document.getElementById('spark-power'), hist.power, '#ff9f0a');
}

function mainIface(d) {
  const list = d.net.ifaces || [];
  const pref = ['wlo1', 'wlan0', 'eth0', 'enp1s0', 'enp3s0', 'tailscale0'];
  for (const n of pref) { const f = list.find(i => i.name === n); if (f) return f; }
  return list.slice().sort((a, b) => (b.rx + b.tx) - (a.rx + a.tx))[0] || null;
}
function pkgTemp(d) {
  const t = d.power.temp || {};
  return t['x86_pkg_temp'] !== undefined ? t['x86_pkg_temp'].toFixed(0)
    : Object.values(t)[0] !== undefined ? Object.values(t)[0].toFixed(0) : '—';
}

// ---------- 详情 ----------
const titleMap = { cpu: 'CPU', mem: '内存', disk: '磁盘', net: '网络', power: '功耗 / 温度' };

const detailDefs = {
  cpu: {
    build(d) {
      let html = `
        <div class="panel">
          <div class="panel-head">
            <span class="panel-title">全部核心（${d.cpu.count} 核）</span>
            <span class="panel-value" style="color:var(--p-core)" id="cpu-val">—</span>
          </div>
          <canvas id="cpu-curve"></canvas>
        </div>
        <div class="section-title">逻辑核心（真实频率，非估算）</div><div class="tiles">`;
      d.cpu.cores.forEach((v, i) => {
        html += `
          <div class="tile">
            <div class="tile-head">
              <span class="tile-name"><b>CPU ${i}</b></span>
              <span class="tile-val" id="tile-val-${i}">—</span>
            </div>
            <canvas id="tile-cv-${i}"></canvas>
            <div class="tile-name" style="margin-top:2px" id="tile-freq-${i}">—</div>
          </div>`;
      });
      html += `</div>
        <div class="info-grid">
          <div class="info-item"><div class="info-label">总利用率</div><div class="info-value" id="cpu-total">—</div></div>
          <div class="info-item"><div class="info-label">用户 / 系统</div><div class="info-value" id="cpu-us">—</div></div>
          <div class="info-item"><div class="info-label">I/O 等待</div><div class="info-value" id="cpu-io">—</div></div>
          <div class="info-item"><div class="info-label">当前频率</div><div class="info-value" id="cpu-freq">—</div></div>
          <div class="info-item"><div class="info-label">负载均值 (1/5/15 分钟)</div><div class="info-value" id="cpu-load">—</div></div>
          <div class="info-item"><div class="info-label">型号</div><div class="info-value" style="font-size:12.5px">${esc(d.cpu.model)}</div></div>
        </div>`;
      return html;
    },
    update(d) {
      setText('cpu-val', d.cpu.total.toFixed(0) + '%');
      drawSeries(document.getElementById('cpu-curve'), hist.cpu, '#0a84ff', 100);
      d.cpu.cores.forEach((v, i) => {
        setText('tile-val-' + i, v.toFixed(0) + '%');
        setText('tile-freq-' + i, (d.cpu.freq[i] ? (d.cpu.freq[i] / 1000).toFixed(2) + ' GHz' : '—'));
        drawSeries(document.getElementById('tile-cv-' + i), hist.cores[i], '#0a84ff', 100);
      });
      setText('cpu-total', d.cpu.total.toFixed(1) + '%');
      setText('cpu-us', `${d.cpu.user.toFixed(1)}% / ${d.cpu.sys.toFixed(1)}%`);
      setText('cpu-io', d.cpu.iowait.toFixed(1) + '%');
      const avgF = d.cpu.freq.length ? d.cpu.freq.reduce((a, b) => a + b, 0) / d.cpu.freq.length / 1000 : 0;
      setText('cpu-freq', avgF ? avgF.toFixed(2) + ' GHz（最大 ' + (d.cpu.freqMax / 1000).toFixed(2) + ' GHz）' : '—');
      const la = d.cpu.load;
      setText('cpu-load', `${(la[0] || 0).toFixed(2)} / ${(la[1] || 0).toFixed(2)} / ${(la[2] || 0).toFixed(2)}`);
    },
    meta(d) { return `${d.cpu.model} · ${d.cpu.count} 核 · 真实频率（cpufreq）`; }
  },
  mem: {
    build() {
      return `
        <div class="info-grid">
          <div class="info-item"><div class="info-label">物理内存</div><div class="info-value" id="mem-used">—</div></div>
          <div class="info-item"><div class="info-label">内存占用率</div><div class="info-value" id="mem-pct">—</div></div>
          <div class="info-item"><div class="info-label">缓存 (Cached)</div><div class="info-value" id="mem-cache">—</div></div>
          <div class="info-item"><div class="info-label">交换分区 (Swap)</div><div class="info-value" id="mem-swap">—</div></div>
        </div>
        <div class="section-title">内存构成</div><div id="mem-bars"></div>`;
    },
    update(d) {
      const m = d.mem;
      setText('mem-used', `${fmtSize(m.used)} / ${fmtSize(m.total)}`);
      setText('mem-pct', m.percent.toFixed(0) + '%');
      setText('mem-cache', fmtSize(m.cached));
      setText('mem-swap', m.swapTotal ? `${fmtSize(m.swapUsed)} / ${fmtSize(m.swapTotal)}` : '未启用');
      const rows = [
        ['已使用（匿名）', m.anon, '#bf5af2'], ['缓存 + 可回收', m.cached, '#0a84ff'],
        ['共享内存 (shmem)', m.shmem, '#ffd60a'], ['缓冲区', m.buffers, '#30d158'],
        ['可用', m.avail, 'rgba(235,240,248,0.3)']
      ];
      const bar = document.getElementById('mem-bars');
      if (bar && !bar.dataset.built) {
        bar.innerHTML = rows.map((r, i) => `
          <div class="bar-row">
            <span class="bar-label">${r[0]}</span>
            <div class="bar-track"><div class="bar-fill" id="bar-mem-${i}" style="background:${r[2]}"></div></div>
            <span class="bar-num" id="bar-num-${i}">—</span>
          </div>`).join('');
        bar.dataset.built = '1';
      }
      rows.forEach((r, i) => {
        const f = document.getElementById('bar-mem-' + i);
        if (f) f.style.width = Math.min(100, r[1] / m.total * 100).toFixed(1) + '%';
        setText('bar-num-' + i, fmtSize(r[1]));
      });
    },
    meta(d) { return `${fmtSize(d.mem.total)} 物理内存 · Swap ${fmtSize(d.mem.swapTotal)}`; }
  },
  disk: {
    build() {
      return `
        <div class="info-grid">
          <div class="info-item"><div class="info-label">读取速率</div><div class="info-value" style="color:var(--cyan)" id="disk-r">—</div></div>
          <div class="info-item"><div class="info-label">写入速率</div><div class="info-value" style="color:var(--amber)" id="disk-w">—</div></div>
          <div class="info-item"><div class="info-label">60 秒峰值</div><div class="info-value" id="disk-peak">—</div></div>
        </div>
        <div class="section-title">块设备</div>
        <table class="vol-table">
          <thead><tr><th>设备</th><th style="text-align:right">读取</th><th style="text-align:right">写入</th></tr></thead>
          <tbody id="dev-tbody"></tbody>
        </table>
        <div class="section-title">挂载点容量</div>
        <table class="vol-table">
          <thead><tr><th>挂载点</th><th>容量</th><th style="text-align:right">可用</th></tr></thead>
          <tbody id="vol-tbody"></tbody>
        </table>`;
    },
    update(d) {
      setText('disk-r', fmtRate(d.disk.totalR));
      setText('disk-w', fmtRate(d.disk.totalW));
      setText('disk-peak', fmtRate(Math.max(...hist.disk, 0) * 1048576));
      const tb = document.getElementById('dev-tbody');
      if (tb) tb.innerHTML = (d.disk.devices.length ? d.disk.devices : []).map(v => `
        <tr>
          <td>${esc(v.name)}</td>
          <td style="text-align:right;color:var(--cyan)">${fmtRate(v.r)}</td>
          <td style="text-align:right;color:var(--amber)">${fmtRate(v.w)}</td>
        </tr>`).join('') || '<tr><td colspan="3" class="empty-hint">无块设备</td></tr>';
      const vt = document.getElementById('vol-tbody');
      if (vt) vt.innerHTML = (d.disk.volumes || []).map(v => `
        <tr>
          <td>${esc(v.mount)}</td>
          <td>${fmtSize(v.used)} / ${fmtSize(v.total)}
            <span class="usage-track"><span class="usage-fill" style="width:${(v.used / v.total * 100).toFixed(0)}%"></span></span>
          </td>
          <td>可用 ${fmtSize(v.avail)}</td>
        </tr>`).join('') || '<tr><td colspan="3" class="empty-hint">无数据</td></tr>';
    },
    meta() { return '块设备吞吐（/proc/diskstats 1 秒窗口差分）'; }
  },
  net: {
    build() {
      return `
        <div class="info-grid">
          <div class="info-item"><div class="info-label">总接收 ↓</div><div class="info-value" style="color:#ffd60a" id="net-rx">—</div></div>
          <div class="info-item"><div class="info-label">总发送 ↑</div><div class="info-value" style="color:#ff453a" id="net-tx">—</div></div>
          <div class="info-item"><div class="info-label">主接口</div><div class="info-value" id="net-main">—</div></div>
          <div class="info-item"><div class="info-label">主接口累计</div><div class="info-value" id="net-tot">—</div></div>
        </div>
        <div class="section-title">网络接口（<span style="color:#ffd60a">黄=接收</span> / <span style="color:#ff453a">红=发送</span>）</div>
        <table class="vol-table">
          <thead><tr><th>接口</th><th>接收</th><th>发送</th><th>累计</th></tr></thead>
          <tbody id="net-tbody"></tbody>
        </table>`;
    },
    update(d) {
      const m = mainIface(d) || { name: '—', rx: 0, tx: 0, rxTotal: 0, txTotal: 0 };
      setText('net-rx', fmtRate(m.rx));
      setText('net-tx', fmtRate(m.tx));
      setText('net-main', m.name);
      setText('net-tot', `收 ${fmtSize(m.rxTotal)} / 发 ${fmtSize(m.txTotal)}`);
      const tb = document.getElementById('net-tbody');
      if (tb) tb.innerHTML = (d.net.ifaces || []).map(i => `
        <tr>
          <td>${esc(i.name)}</td>
          <td style="color:#ffd60a">↓ ${fmtRate(i.rx)}</td>
          <td style="color:#ff453a">↑ ${fmtRate(i.tx)}</td>
          <td>累计收 ${fmtSize(i.rxTotal)} / 发 ${fmtSize(i.txTotal)}</td>
        </tr>`).join('') || '<tr><td colspan="4" class="empty-hint">无接口</td></tr>';
    },
    meta(d) { const m = mainIface(d); return m ? `主接口 ${m.name}` : '无网络接口'; }
  },
  power: {
    build() {
      return `
        <div class="info-grid">
          <div class="info-item"><div class="info-label">整机封装功耗</div><div class="info-value" style="color:var(--orange)" id="pw-pkg">—</div></div>
          <div class="info-item"><div class="info-label">CPU 核心功耗</div><div class="info-value" id="pw-cores">—</div></div>
          <div class="info-item"><div class="info-label">CPU 封装温度</div><div class="info-value" id="pw-temp">—</div></div>
          <div class="info-item"><div class="info-label">主板温度</div><div class="info-value" id="pw-acpi">—</div></div>
          <div class="info-item"><div class="info-label">无线网卡温度</div><div class="info-value" id="pw-wifi">—</div></div>
          <div class="info-item"><div class="info-label">数据源</div><div class="info-value" style="font-size:12.5px">Intel RAPL（真实寄存器）</div></div>
        </div>
        <div class="section-title">近 60 秒功耗 / 温度（<span style="color:var(--orange)">橙=功耗</span> / <span style="color:var(--red)">红=温度</span>）</div>`;
    },
    update(d) {
      setText('pw-pkg', d.power.ok ? d.power.pkg.toFixed(2) + ' W' : '不可用');
      setText('pw-cores', d.power.ok ? d.power.cores.toFixed(2) + ' W' : '—');
      const t = d.power.temp || {};
      setText('pw-temp', t['x86_pkg_temp'] !== undefined ? t['x86_pkg_temp'].toFixed(1) + ' ℃' : '—');
      setText('pw-acpi', t['acpitz'] !== undefined ? t['acpitz'].toFixed(1) + ' ℃' : '—');
      const wifiKey = Object.keys(t).find(k => k.startsWith('iwlwifi'));
      setText('pw-wifi', wifiKey ? t[wifiKey].toFixed(1) + ' ℃' : '—');
    },
    meta(d) { return d.power.ok ? `RAPL 实时功耗 · ${d.power.pkg.toFixed(1)} W` : 'RAPL 不可读（需 root 运行 agent）'; }
  }
};

function tickDetail(force) {
  if (!latest) return;
  const body = document.getElementById('detail-body');
  if (!bodyBuilt || force) {
    try { body.innerHTML = detailDefs[activeCard].build(latest); bodyBuilt = true; }
    catch (e) { console.error('detail.build', e); return; }
  }
  try { detailDefs[activeCard].update(latest); } catch (e) { console.error('detail.update', e); }
  setText('detail-title', titleMap[activeCard]);
  try {
    const big = document.getElementById('bigchart');
    if (activeCard === 'net') {
      drawOverlaid(big, hist.netrx, hist.nettx, '#ffd60a', '#ff453a');
      setText('chart-max', fmtRate(Math.max(...hist.netrx, ...hist.nettx, 0.001)));
    } else if (activeCard === 'power') {
      drawSeries(big, hist.power, '#ff9f0a');
      const { ctx, w, h } = setupCanvas(big);
      if (hist.temp.length > 1) {
        const max = Math.max(...hist.temp, 1) * 1.2;
        const step = w / (HIST - 1);
        const x0 = w - (hist.temp.length - 1) * step;
        ctx.beginPath();
        hist.temp.forEach((v, i) => {
          const x = x0 + i * step, y = h - 1.5 - (v / max) * (h - 3);
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.strokeStyle = '#ff453a'; ctx.lineWidth = 1.5; ctx.stroke();
      }
      setText('chart-max', Math.max(...hist.power, 0).toFixed(1) + ' W');
    } else {
      const series = { cpu: hist.cpu, mem: hist.mem, disk: hist.disk };
      const yMax = activeCard === 'mem' ? 100 : undefined;
      drawSeries(big, series[activeCard], cardColor[activeCard], yMax);
      setText('chart-max', activeCard === 'mem' ? '100%'
        : activeCard === 'disk' ? fmtRate(Math.max(...hist.disk, 0) * 1048576) : '');
    }
  } catch (e) { console.error('detail.chart', e); }
  try { setText('detail-meta', detailDefs[activeCard].meta(latest)); } catch (e) { }
}

// ---------- 进程 ----------
const procSortLabels = { cpu: 'CPU', mem: '内存', disk: '磁盘', net: '网速', energy: '能耗', pid: 'PID' };
function renderProcs(d) {
  const tbody = document.getElementById('proc-tbody');
  if (!tbody) return;
  const q = procQuery.toLowerCase();
  let list = d.procs.list || [];
  if (q) list = list.filter(p => (p.name || '').toLowerCase().includes(q) || String(p.pid).includes(q));
  const key = procSort;
  const metric = (p) => key === 'cpu' ? p.cpu : key === 'mem' ? p.rss : key === 'disk' ? p.dr + p.dw
    : key === 'net' ? p.nrx + p.ntx : key === 'energy' ? p.energy : p.pid;
  list = [...list].sort((a, b) => key === 'pid' ? a.pid - b.pid : metric(b) - metric(a));
  const shown = list.slice(0, 200);
  tbody.innerHTML = shown.map(p => {
    const dTotal = p.dr + p.dw;
    const ioTxt = dTotal > 0 ? `R ${fmtRate(p.dr)} / W ${fmtRate(p.dw)}` : '<span style="opacity:.35">—</span>';
    const netTxt = (p.nrx + p.ntx) > 0 ? `<span style="color:#ffd60a">↓ ${fmtRate(p.nrx)}</span> <span style="color:#ff453a">↑ ${fmtRate(p.ntx)}</span>` : '<span style="opacity:.35">—</span>';
    return `
    <tr>
      <td class="td-num" style="color:var(--text-3)">${p.pid}</td>
      <td style="max-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</td>
      <td class="td-num ${p.cpu > 20 ? 'cpu-hot' : ''}">${p.cpu.toFixed(1)}</td>
      <td class="td-num">${fmtSize(p.rss)}</td>
      <td class="td-num"><span class="io-detail">${ioTxt}</span></td>
      <td class="td-num">${netTxt}</td>
      <td class="td-num">${p.energy > 0.05 ? p.energy.toFixed(2) + ' W' : '<span style="opacity:.35">—</span>'}</td>
      <td style="text-align:right"><button class="kill-btn" data-pid="${p.pid}">结束</button></td>
    </tr>`;
  }).join('');
  setText('proc-summary', `显示 ${shown.length} / ${d.procs.count} 个进程 · 按 ${procSortLabels[key] || 'CPU'} 排序（点击表头切换）`);
  tbody.querySelectorAll('.kill-btn').forEach(btn => {
    btn.onclick = () => window.bridge.killProcess(parseInt(btn.dataset.pid, 10));
  });
  document.querySelectorAll('#proc-table th.sortable').forEach(th => {
    th.classList.toggle('sort-active', th.dataset.sort === procSort);
  });
}

// ---------- 容器 ----------
function renderDocker(d) {
  const tbody = document.getElementById('docker-tbody');
  if (!tbody) return;
  const list = (d.docker && d.docker.containers) || [];
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-hint">正在采集容器数据…（打开本页后约 10 秒出现，需 N100 上运行 Docker）</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(c => `
    <tr>
      <td>${esc(c.name)}</td>
      <td class="td-num ${parseFloat(c.cpu) > 50 ? 'cpu-hot' : ''}">${esc(c.cpu)}</td>
      <td class="td-num">${esc(c.mem)}</td>
      <td class="td-num"><span class="io-detail">${esc(c.net)}</span></td>
      <td class="td-num"><span class="io-detail">${esc(c.io)}</span></td>
      <td class="td-num">${esc(c.pids)}</td>
    </tr>`).join('');
}

// ---------- 状态栏 ----------
function fmtUptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  return d > 0 ? `${d} 天 ${h} 小时` : h > 0 ? `${h} 小时 ${m} 分` : `${m} 分钟`;
}
function fmtTraffic(b) {
  if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(2) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
  return b + ' B';
}

// ---------- 事件 ----------
let currentView = 'perf';
function switchView(v) {
  currentView = v;
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.dataset.view === v));
  document.getElementById('perf-view').classList.toggle('active', v === 'perf');
  document.getElementById('procs-view').classList.toggle('active', v === 'procs');
  document.getElementById('docker-view').classList.toggle('active', v === 'docker');
  try { window.bridge.setView(v); } catch (e) { }   // 通知主进程按需采集
  if (v === 'perf' && latest) tickDetail(true);
  if (v === 'procs' && latest) renderProcs(latest);
  if (v === 'docker' && latest) renderDocker(latest);
}
document.querySelectorAll('.tab').forEach(t => { t.onclick = () => switchView(t.dataset.view); });
function selectCard(id) {
  if (!detailDefs[id]) return;
  activeCard = id; bodyBuilt = false;
  switchView('perf'); buildSidebar(); tickDetail(true);
}
document.getElementById('proc-search').addEventListener('input', e => {
  procQuery = e.target.value;
  if (latest) renderProcs(latest);
});
document.querySelectorAll('#proc-table th.sortable').forEach(th => {
  th.onclick = () => { procSort = th.dataset.sort; if (latest) renderProcs(latest); };
});
document.querySelectorAll('#poll-ctl button').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('#poll-ctl button').forEach(b => b.classList.remove('on'));
    btn.classList.add('on');
    try { window.bridge.setInterval(parseInt(btn.dataset.ms, 10)); } catch (e) { }
  };
});
window.addEventListener('keydown', e => {
  if (e.metaKey && e.key === '1') { e.preventDefault(); switchView('perf'); }
  else if (e.metaKey && e.key === '2') { e.preventDefault(); switchView('procs'); }
  else if (e.metaKey && e.key === '3') { e.preventDefault(); switchView('docker'); }
  else if (e.key === 'Escape') {
    const s = document.getElementById('proc-search');
    if (s.value) { s.value = ''; procQuery = ''; if (latest) renderProcs(latest); }
  }
  document.body.classList.toggle('cmd-down', e.metaKey);
});
window.addEventListener('keyup', e => { if (!e.metaKey) document.body.classList.remove('cmd-down'); });

// ---------- 主循环 ----------
window.bridge.onStats((d) => {
  latest = d;
  push(hist.cpu, d.cpu.total);
  push(hist.mem, d.mem.percent);
  push(hist.disk, (d.disk.totalR + d.disk.totalW) / 1048576);
  const m = mainIface(d);
  push(hist.netrx, m ? m.rx : 0);
  push(hist.nettx, m ? m.tx : 0);
  push(hist.power, d.power.pkg);
  const tp = parseFloat(pkgTemp(d));
  push(hist.temp, isNaN(tp) ? 0 : tp);
  d.cpu.cores.forEach((v, i) => {
    if (!hist.cores[i]) hist.cores[i] = [];
    push(hist.cores[i], v);
  });

  // 顶栏：主机信息 + 连接状态
  const up = d.sys.uptime || 0;
  document.getElementById('osinfo').innerHTML =
    `${esc(d.sys.hostname || 'N100')} · ${esc(d.sys.os || 'Linux')} · ${esc(d.cpu.model)}`;
  const dot = document.getElementById('sb-dot');
  dot.className = 'sb-dot' + (d.link.ok ? '' : ' bad');
  setText('sb-left', d.link.ok
    ? `已连接 ${d.link.host} · 延迟 ${d.link.rtt} ms · 轮询 ${(d.link.interval / 1000).toFixed(0)} 秒 · 本次会话已用流量 ${fmtTraffic(d.link.bytes)}（${d.link.polls} 次请求）`
    : `连接中断，正在重试…（${d.link.host}）`);
  setText('sb-right', `${d.procs.count ? '进程 ' + d.procs.count : '进程表未加载（打开进程页后采集）'} · 已运行 ${fmtUptime(up)}`);

  updateSidebar(d);
  if (currentView === 'perf') tickDetail();
  if (currentView === 'procs') renderProcs(d);
  if (currentView === 'docker') renderDocker(d);
});

buildSidebar();
switchView('perf');
