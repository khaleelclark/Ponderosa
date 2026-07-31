const {
  contextBridge,
  ipcRenderer,
} = require("electron") as typeof import("electron");

contextBridge.exposeInMainWorld("ponderosaEngine", {
  snapshot: () => ipcRenderer.invoke("engine:snapshot"),
  openPonderosa: () => ipcRenderer.invoke("engine:open"),
  restart: () => ipcRenderer.invoke("engine:restart"),
  quit: () => ipcRenderer.invoke("engine:quit"),
  copyLogs: (text: string) => ipcRenderer.invoke("engine:copy-logs", text),
});
