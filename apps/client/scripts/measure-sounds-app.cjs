// Processo main do medidor (M12). Casca: sobe uma janela OCULTA, entrega a
// lista de arquivos ao renderer e imprime o relatório que ele devolve.
//
// `nodeIntegration` ligado é seguro aqui e só aqui: esta janela carrega um
// arquivo local do próprio repositório, sem rede e sem conteúdo de terceiro.
// Não confundir com o app de verdade (apps/desktop/src/main.ts), onde o
// renderer é isolado e a ponte passa por contextBridge.
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");

// A lista sai daqui, e não de argv: JSON em argv atravessando o shell do
// Windows perde as aspas e o processo trava sem dizer por quê (custou uma
// rodada de 3 minutos para descobrir).
const AUDIO = /\.(mp3|wav|ogg|oga|opus|m4a|flac)$/i;
const dir = path.join(__dirname, "..", "assets", "sounds");
const plano = { dir, files: fs.readdirSync(dir).filter((f) => AUDIO.test(f)).sort() };

app.disableHardwareAcceleration();
app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  ipcMain.handle("plano", () => plano);
  ipcMain.on("pronto", (_ev, report) => {
    process.stdout.write("RELATORIO " + JSON.stringify(report) + "\n");
    app.exit(0);
  });
  ipcMain.on("falhou", (_ev, msg) => {
    process.stderr.write("FALHOU " + msg + "\n");
    app.exit(1);
  });
  win.loadFile(path.join(__dirname, "measure-sounds-page.html"));
});
