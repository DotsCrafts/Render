// Diagnostic: does webContents.debugger drive a hidden WebContentsView to google?
import { app, BaseWindow, WebContentsView } from 'electron';
import { appendFileSync } from 'node:fs';

const LOG = '/tmp/diag.log';
const log = (s) => appendFileSync(LOG, `DIAG ${Date.now() % 100000} ${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await app.whenReady();
  log('app ready');
  const win = new BaseWindow({ width: 1280, height: 900, show: false, x: -4000, y: -4000 });
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1280, height: 900 });
  const wc = view.webContents;
  const dbg = wc.debugger;

  // Bring the renderer/page process to life before any CDP — a never-loaded
  // WebContentsView has no page, so Page.enable would hang forever.
  await wc.loadURL('about:blank');
  log('about:blank loaded; url=' + wc.getURL());

  try {
    dbg.attach('1.3');
    log('attached=' + dbg.isAttached());
  } catch (e) {
    log('attach err ' + e.message);
  }

  let loadFired = false;
  dbg.on('message', (_e, method) => {
    if (method === 'Page.loadEventFired' || method === 'Page.frameStoppedLoading') {
      loadFired = true;
      log('EVENT ' + method);
    }
  });

  await dbg.sendCommand('Page.enable').catch((e) => log('Page.enable err ' + e.message));
  await dbg.sendCommand('Runtime.enable').catch((e) => log('Runtime.enable err ' + e.message));
  log('enabled domains');

  const t0 = Date.now();
  log('navigating…');
  const navRes = await dbg
    .sendCommand('Page.navigate', { url: 'https://www.google.com/search?q=render+bridge+m1&hl=en&num=10' })
    .catch((e) => ({ err: e.message }));
  log('Page.navigate returned: ' + JSON.stringify(navRes));

  for (let i = 0; i < 48 && !loadFired; i++) await sleep(250);
  log('loadFired=' + loadFired + ' after ' + (Date.now() - t0) + 'ms');

  await sleep(800);
  const ev = async (expr) => {
    const r = await dbg.sendCommand('Runtime.evaluate', { expression: expr, returnByValue: true }).catch((e) => ({ err: e.message }));
    return r?.result?.value ?? r;
  };
  log('title=' + JSON.stringify(await ev('document.title')));
  log('url=' + JSON.stringify(await ev('location.href')));
  log('h3count=' + JSON.stringify(await ev('document.querySelectorAll("#rso a h3, #search a h3").length')));
  log('bodyLen=' + JSON.stringify(await ev('(document.body&&document.body.innerText||"").length')));
  log('DONE');
  app.exit(0);
}

main().catch((e) => {
  log('FATAL ' + (e?.stack || e));
  app.exit(1);
});
