const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('bridge', {
  onStats: (cb) => ipcRenderer.on('stats', (e, data) => cb(data)),
  killProcess: (pid) => ipcRenderer.invoke('kill-process', pid),
  // 告诉主进程当前在看哪个页签，用于按需采集（省流量）
  setView: (v) => ipcRenderer.send('set-view', v),
  // 轮询间隔（毫秒）：2000 / 5000 / 10000
  setInterval: (ms) => ipcRenderer.send('set-interval', ms),
  getConfig: () => ipcRenderer.invoke('get-config')
});
