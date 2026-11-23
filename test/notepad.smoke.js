'use strict';
// Smoke test of the plain notepad in headless Chromium at phone size.
// Usage: node tools/build.js && node test/notepad.smoke.js [screenshotDir]
const path = require('path');
const { chromium, devices } = require('playwright');

const url = 'file://' + path.join(__dirname, '..', 'notepad.html');
const shotDir = process.argv[2];
function assert(cond, msg) { if (!cond) throw new Error('ASSERT: ' + msg); }

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  async function run(colorScheme) {
    const ctx = await browser.newContext({ ...devices['iPhone 13'], colorScheme, deviceScaleFactor: 1 });
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(colorScheme + ' pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/ERR_FAILED/.test(m.text())) errors.push(colorScheme + ' console: ' + m.text()); });
    await page.goto(url);
    const shot = async (n) => { if (shotDir) await page.screenshot({ path: path.join(shotDir, 'np-' + colorScheme + '-' + n + '.png') }); };
    const cell = (card, player) => page.getByRole('button', { name: new RegExp('^' + card + ', ' + player + ':') });

    // setup
    await page.getByText('Players in turn order').waitFor();
    await shot('01-setup');
    for (const [i, n] of [[1, 'Ava'], [2, 'Ben'], [3, 'Cleo']]) await page.fill('#pname-' + i, n);
    for (const c of ['Colonel Mustard', 'Rope']) await page.locator('section', { hasText: 'Your cards' }).getByRole('button', { name: c, exact: true }).click();
    await page.getByRole('button', { name: 'Start game' }).click();
    await page.getByText('Detective sheet').waitFor();

    // own cards ticked + crossed off; no probabilities anywhere
    assert(await cell('Colonel Mustard', 'Me').innerText() === '✓', 'own card ticked');
    assert(await page.getByRole('button', { name: 'Colonel Mustard, crossed off' }).count() === 1, 'own card crossed off');
    const body = await page.locator('main').innerText();
    assert(!/%/.test(body), 'notepad must not show percentages');

    // default pen × ; tap twice toggles off
    await cell('Hall', 'Ava').click();
    assert(await cell('Hall', 'Ava').innerText() === '×', 'cross mark');
    await cell('Hall', 'Ava').click();
    assert(await cell('Hall', 'Ava').innerText() === '', 'tap again clears');
    // tick pen
    await page.getByRole('button', { name: 'Tick: has it' }).click();
    await cell('Knife', 'Ben').click();
    assert(await cell('Knife', 'Ben').innerText() === '✓', 'tick');
    // tag pen #1 then #2 via number strip
    await page.getByRole('button', { name: /Number tag 1/ }).click();
    for (const c of ['Miss Scarlet', 'Wrench', 'Kitchen']) await cell(c, 'Cleo').click();
    await page.getByRole('button', { name: /Number tag 1/ }).click();
    await page.getByRole('button', { name: '#2', exact: true }).click();
    await cell('Kitchen', 'Cleo').click();
    assert((await cell('Kitchen', 'Cleo').innerText()).replace(/\s+/g, ' ').trim() === '1 2', 'two tags on Kitchen/Cleo');
    await shot('02-sheet');
    // undo removes tag 2
    await page.getByRole('button', { name: 'Undo last mark' }).click();
    assert((await cell('Kitchen', 'Cleo').innerText()).trim() === '1', 'undo tag');
    // card name cycle: cross off then circle
    await page.getByRole('button', { name: 'Library', exact: true }).click();
    await page.getByRole('button', { name: 'Library, crossed off' }).click();
    assert(await page.getByRole('button', { name: 'Library, circled' }).count() === 1, 'circle');

    // hide / show
    await page.getByRole('button', { name: 'Hide' }).click();
    await page.getByText('Notes hidden. Tap to show.').waitFor();
    await shot('03-hidden');
    await page.getByRole('button', { name: 'Show notes' }).click();

    // turn log does not touch the sheet
    await page.getByRole('button', { name: 'Turns' }).click();
    const form = page.locator('section.sheet').first();
    for (const c of ['Mrs. Peacock', 'Lead Pipe', 'Study']) await form.getByRole('button', { name: c, exact: true }).click();
    await form.getByRole('button', { name: 'Ben', exact: true }).last().click();
    await page.getByRole('button', { name: 'Save turn' }).click();
    await page.getByText('Turn 1 saved').waitFor();
    await page.getByText('Passed: Ava.').waitFor();
    await shot('04-turns');
    await page.getByRole('button', { name: 'Sheet' }).click();
    assert(await cell('Mrs. Peacock', 'Ava').innerText() === '', 'turn log must not mark the sheet');

    // scratch persists through reload, as do marks
    await page.getByRole('button', { name: 'Scratch' }).click();
    await page.fill('#scratch', 'Ben keeps asking about the Study');
    await page.reload();
    await page.getByRole('button', { name: 'Scratch' }).waitFor();
    assert(await page.inputValue('#scratch') === 'Ben keeps asking about the Study', 'scratch persisted');
    await page.getByRole('button', { name: 'Sheet' }).click();
    assert(await cell('Knife', 'Ben').innerText() === '✓', 'marks persisted');

    for (const t of ['Sheet', 'Turns', 'Scratch']) {
      await page.getByRole('button', { name: t, exact: true }).click();
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert(over <= 0, t + ' overflows by ' + over + 'px');
    }
    await ctx.close();
  }
  try { await run('light'); await run('dark'); } finally { await browser.close(); }
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  console.log('Notepad smoke test passed');
})().catch((e) => { console.error(e); process.exit(1); });
