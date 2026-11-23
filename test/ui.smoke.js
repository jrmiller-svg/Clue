'use strict';
// End-to-end smoke test of the built page in headless Chromium at phone size.
// Usage: node tools/build.js && node test/ui.smoke.js [screenshotDir]
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium, devices } = require('playwright');

const root = path.join(__dirname, '..');
const shotDir = process.argv[2];

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const file = path.join(root, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
      if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'text/plain' });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, () => resolve(srv));
  });
}

function assert(cond, msg) { if (!cond) throw new Error('ASSERT: ' + msg); }

(async () => {
  const srv = await serve();
  const url = 'http://localhost:' + srv.address().port + '/index.html';
  const browser = await chromium.launch();
  const errors = [];
  async function run(colorScheme) {
    const ctx = await browser.newContext({ ...devices['iPhone 13'], colorScheme, deviceScaleFactor: 1 });
    // Google Fonts is unreachable in the sandbox; don't let it stall loads
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(colorScheme + ' pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/fonts|ERR_FAILED/.test(m.text())) errors.push(colorScheme + ' console: ' + m.text()); });
    await page.goto(url);
    const shot = async (name) => { if (shotDir) await page.screenshot({ path: path.join(shotDir, colorScheme + '-' + name + '.png'), fullPage: false }); };

    // ---- setup: 4 players, classic deck → hands 5,5,4,4
    await page.getByText('Players in turn order').waitFor();
    await shot('01-setup');
    const names = ['Me', 'Ava', 'Ben', 'Cleo'];
    for (let i = 1; i < 4; i++) await page.fill('#pname-' + i, names[i]);
    // pick my 5 cards
    for (const c of ['Colonel Mustard', 'Revolver', 'Lounge', 'Conservatory', 'Study']) {
      await page.locator('section', { hasText: 'Your cards' }).getByRole('button', { name: c, exact: true }).click();
    }
    await page.getByRole('button', { name: 'Start game' }).click();
    await page.locator('.case').waitFor();
    await page.waitForFunction(() => !document.querySelector('.pill.busy'));
    await shot('02-log-empty');

    // ---- log: Me suggests Scarlet/Candlestick/Hall, Ava shows Candlestick
    const sheet = page.locator('section.sheet').filter({ hasText: 'Who is suggesting?' });
    await sheet.locator('.chips').first().getByRole('button', { name: 'You' }).click();
    for (const c of ['Miss Scarlet', 'Candlestick', 'Hall']) await sheet.getByRole('button', { name: c, exact: true }).first().click();
    await sheet.locator('.stack', { hasText: 'Who showed a card?' }).getByRole('button', { name: 'Ava' }).click();
    await sheet.locator('.stack', { hasText: 'Which card did Ava show you?' }).getByRole('button', { name: 'Candlestick' }).click();
    await shot('03-log-filled');
    await page.getByRole('button', { name: 'Save entry' }).click();
    await page.waitForFunction(() => !document.querySelector('.pill.busy'));
    // the next suggester defaults to Ava
    assert(await sheet.locator('.chips').first().getByRole('button', { name: 'Ava' }).getAttribute('aria-pressed') === 'true', 'next suggester should be Ava');

    // Ava suggests Green/Rope/Kitchen: Ben passes, Cleo shows
    for (const c of ['Mr. Green', 'Rope', 'Kitchen']) await sheet.getByRole('button', { name: c, exact: true }).first().click();
    await sheet.locator('.stack', { hasText: 'Who showed a card?' }).getByRole('button', { name: 'Cleo' }).click();
    assert(await sheet.getByText('Passed:').count() === 1, 'pass line visible');
    await page.getByRole('button', { name: 'Save entry' }).click();
    await page.waitForFunction(() => !document.querySelector('.pill.busy'));

    // Ben suggests and nobody can show
    for (const c of ['Mrs. Peacock', 'Lead Pipe', 'Library']) await sheet.getByRole('button', { name: c, exact: true }).first().click();
    await sheet.locator('.stack', { hasText: 'Who showed a card?' }).getByRole('button', { name: 'No one' }).click();
    await page.getByRole('button', { name: 'Save entry' }).click();
    await page.waitForFunction(() => !document.querySelector('.pill.busy'));
    await shot('04-log-after');

    // ---- notes grid
    await page.getByRole('button', { name: 'Notes' }).click();
    await page.locator('table.grid').waitFor();
    const candle = await page.locator('tr', { hasText: 'Candlestick' }).locator('td').nth(1).innerText();
    assert(candle.includes('✓'), 'Ava must be marked as holding Candlestick, got ' + candle);
    await shot('05-notes');
    await page.locator('tr', { hasText: 'Library' }).getByRole('button').click();
    await page.getByRole('dialog').waitFor();
    await shot('06-card-sheet');
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();

    // ---- advice
    await page.getByRole('button', { name: 'Advice' }).click();
    await page.getByText('Should you accuse?').waitFor();
    await page.locator('.sg').first().waitFor({ timeout: 15000 });
    await shot('07-advice');
    await page.locator('.sheet', { hasText: 'Your next suggestion' }).getByRole('button', { name: 'Kitchen', exact: true }).click();
    await page.locator('.sg').first().waitFor({ timeout: 15000 });
    const firstSugg = await page.locator('.sg .title').first().innerText();
    assert(firstSugg.includes('Kitchen'), 'room filter applied: ' + firstSugg);

    // ---- history: edit then contradiction detection
    await page.getByRole('button', { name: 'History' }).click();
    await page.getByText('Log · 3 entries').waitFor();
    await shot('08-history');

    // Log a contradictory fact: Ava does not have Candlestick (she showed it)
    await page.getByRole('button', { name: 'Log turn' }).click();
    await page.getByRole('button', { name: 'Saw a card' }).click();
    const fact = page.locator('section.sheet').filter({ hasText: 'outside a normal turn' });
    await fact.locator('.chips').first().getByRole('button', { name: 'Ava' }).click();
    await fact.getByRole('button', { name: 'Candlestick', exact: true }).click();
    await fact.getByRole('button', { name: 'Doesn’t have it' }).click();
    await page.getByRole('button', { name: 'Save entry' }).click();
    await page.getByText('Entry #4 conflicts').waitFor({ timeout: 15000 });
    await shot('09-conflict');
    await page.getByRole('button', { name: 'Review' }).click();
    await page.locator('.ev.bad').waitFor();
    await page.getByRole('button', { name: 'Undo last' }).click();
    await page.waitForFunction(() => !document.querySelector('.pill.busy'));
    assert(await page.locator('.banner.bad').count() === 0, 'conflict cleared after undo');

    // ---- persistence across reload
    await page.reload();
    await page.getByText('Log · 3 entries').waitFor();

    // ---- demo game
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('button', { name: 'New game' }).click();
    await page.getByRole('button', { name: 'Tap again to discard this game' }).click();
    await page.getByRole('button', { name: 'Explore a demo game first →' }).click();
    await page.getByText('Should you accuse?').waitFor();
    await page.locator('.sg').first().waitFor({ timeout: 15000 });
    await shot('10-demo-advice');
    const pill = await page.locator('.pill').innerText();
    console.log(colorScheme, 'demo header pill:', pill.replace(/\s+/g, ' '));
    // no horizontal overflow on any tab
    for (const t of ['Log turn', 'Notes', 'Advice', 'History']) {
      await page.getByRole('button', { name: t }).click();
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert(over <= 0, t + ' overflows horizontally by ' + over + 'px');
    }
    await page.getByRole('button', { name: 'Notes' }).click();
    await shot('11-demo-notes');
    await ctx.close();
  }
  try {
    await run('light');
    await run('dark');
  } finally {
    await browser.close();
    srv.close();
  }
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  console.log('UI smoke test passed');
})().catch((e) => { console.error(e); process.exit(1); });
