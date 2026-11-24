'use strict';
// Checks the installable / offline setup: manifests, icons, and that both apps
// load and work with the network switched off after one online visit.
// Usage: node tools/build.js && node test/offline.smoke.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium, devices } = require('playwright');

const root = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
function assert(cond, msg) { if (!cond) throw new Error('ASSERT: ' + msg); }

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p.endsWith('/')) p += 'index.html';
      // mimic a project site at /Clue/
      if (!p.startsWith('/Clue/')) { res.writeHead(404); res.end(); return; }
      const file = path.join(root, p.slice('/Clue/'.length));
      if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  // static checks
  for (const m of ['manifest-solver.webmanifest', 'manifest-notepad.webmanifest']) {
    const j = JSON.parse(fs.readFileSync(path.join(root, m), 'utf8'));
    assert(j.start_url && j.icons.length, m + ' has start_url and icons');
    j.icons.forEach((ic) => assert(fs.existsSync(path.join(root, ic.src)), m + ' icon exists: ' + ic.src));
  }
  for (const [page, man, icon] of [['index.html', 'manifest-solver', 'solver-180'], ['notepad.html', 'manifest-notepad', 'notepad-180']]) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    assert(html.includes(man + '.webmanifest') && html.includes('icons/' + icon + '.png') && html.includes("register('./sw.js'"), page + ' wires manifest, icon and service worker');
  }
  for (const a of ['dist/artifact.html', 'dist/notepad-artifact.html']) assert(!fs.readFileSync(path.join(root, a), 'utf8').includes('sw.js'), a + ' must not register a service worker');

  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port + '/Clue/';
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'], deviceScaleFactor: 1 });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  // one online visit installs the service worker
  await page.goto(base);
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 15000 });
  await page.getByText('Saved on this device').waitFor({ timeout: 10000 });
  const cached = await page.evaluate(async () => {
    const keys = await caches.keys();
    const app = await caches.open(keys.find((k) => k.startsWith('clue-app-')));
    return (await app.keys()).map((r) => new URL(r.url).pathname);
  });
  for (const f of ['/Clue/', '/Clue/index.html', '/Clue/notepad.html', '/Clue/icons/solver-180.png']) assert(cached.includes(f), 'cached ' + f);

  // now go offline
  await ctx.setOffline(true);
  await page.reload();
  await page.getByText('Players in turn order').waitFor();
  await page.getByRole('button', { name: 'Explore a demo game first →' }).click();
  await page.locator('.sg').first().waitFor({ timeout: 15000 });
  const pill = (await page.locator('.pill').innerText()).replace(/\s+/g, ' ');
  assert(/best guess/.test(pill), 'solver works offline: ' + pill);

  await page.goto(base + 'notepad.html');
  await page.getByText('Players in turn order').waitFor();
  await page.getByRole('button', { name: 'Start game' }).click();
  await page.getByText('Detective sheet').waitFor();

  // a URL with a query string (as some launchers add) still opens offline, with the saved game
  await page.goto(base + 'index.html?from=homescreen');
  await page.getByText('Should you accuse?').waitFor();

  await browser.close();
  srv.close();
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  console.log('Offline smoke test passed (cached ' + cached.length + ' files)');
})().catch((e) => { console.error(e); process.exit(1); });
