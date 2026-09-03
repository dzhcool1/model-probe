import { app, BrowserWindow, dialog, shell } from "electron";
import { once } from "node:events";
import path from "node:path";
import { pathToFileURL } from "node:url";

let localServer;
let mainWindow;

async function startLocalServer() {
  process.env.MODEL_PROBE_PORT = "0";
  const serverPath = path.join(app.getAppPath(), "server.mjs");
  const module = await import(pathToFileURL(serverPath).href);
  localServer = module.server;
  if (!localServer) throw new Error("本地服务启动失败：找不到服务实例。");
  if (!localServer.listening) await once(localServer, "listening");

  const address = localServer.address();
  if (!address || typeof address === "string") throw new Error("本地服务没有分配有效端口。");
  return `http://127.0.0.1:${address.port}`;
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: "#eef1ef",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (/^https?:\/\//i.test(targetUrl)) void shell.openExternal(targetUrl);
    return { action: "deny" };
  });
  void mainWindow.loadURL(url);
}

async function closeLocalServer() {
  if (!localServer?.listening) return;
  await new Promise((resolve) => localServer.close(resolve));
}

app.whenReady().then(async () => {
  try {
    createWindow(await startLocalServer());
  } catch (error) {
    dialog.showErrorBox("Model Probe 启动失败", error?.message || "无法启动本地服务。");
    app.quit();
  }
});

app.on("before-quit", () => {
  void closeLocalServer();
});

app.on("window-all-closed", () => {
  app.quit();
});
