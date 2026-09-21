const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('headless');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL(process.env.FF_PERFORMANCE_URL);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await window.webContents.executeJavaScript("document.querySelector('#result')?.textContent");
    if (value && value !== 'pending') {
      process.stdout.write(`ELECTRON_PERFORMANCE_BASELINE ${value}\n`);
      await app.quit();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  process.stderr.write('Electron performance harness timed out\n');
  app.exit(1);
});
