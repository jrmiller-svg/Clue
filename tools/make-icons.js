#!/usr/bin/env node
// Renders the home-screen icons (PNG) from inline SVG with headless Chromium.
// Run once after changing the artwork: node tools/make-icons.js
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const out = path.join(__dirname, '..', 'icons');

// Artwork is kept inside the central 80% so Android's maskable crop and
// iOS's rounded corners never clip it. Full-bleed opaque backgrounds:
// iOS fills transparency with black.
const fit = (body) => `<g transform="translate(256 256) scale(.84) translate(-256 -256)">${body}</g>`;

const solver = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#17624f"/>
  ${fit(`
  <rect x="86" y="132" width="268" height="182" rx="16" fill="#f4f6f3"/>
  <path d="M90 144 L220 238 L350 144" fill="none" stroke="#c4cfca" stroke-width="12" stroke-linejoin="round"/>
  <circle cx="220" cy="240" r="28" fill="#c8402f"/>
  <circle cx="318" cy="300" r="86" fill="#17624f" fill-opacity=".55" stroke="#ffffff" stroke-width="28"/>
  <line x1="380" y1="362" x2="436" y2="418" stroke="#ffffff" stroke-width="38" stroke-linecap="round"/>`)}
</svg>`;

const check = (x, y) => `<rect x="${x}" y="${y}" width="64" height="64" rx="12" fill="#17624f"/>
  <path d="M${x + 16} ${y + 33} l12 12 l21 -24" fill="none" stroke="#ffffff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>`;
const cross = (x, y) => `<path d="M${x + 20} ${y + 20} l24 24 M${x + 44} ${y + 20} l-24 24" stroke="#8b979d" stroke-width="8" stroke-linecap="round"/>`;
const notepad = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#e3ebe7"/>
  ${fit(`
  <rect x="96" y="80" width="320" height="352" rx="20" fill="#ffffff" stroke="#c4cfca" stroke-width="6"/>
  <path d="M116 168 H396 M116 256 H396 M116 344 H396" stroke="#d3dad6" stroke-width="5"/>
  <path d="M252 96 V416 M330 96 V416" stroke="#d3dad6" stroke-width="5"/>
  <rect x="124" y="117" width="96" height="14" rx="7" fill="#1b2230"/>
  <rect x="124" y="205" width="80" height="14" rx="7" fill="#1b2230"/>
  <rect x="124" y="293" width="92" height="14" rx="7" fill="#a3adb2"/>
  <path d="M116 300 H228" stroke="#c8402f" stroke-width="7" stroke-linecap="round"/>
  <rect x="124" y="381" width="70" height="14" rx="7" fill="#1b2230"/>
  ${check(259, 92)}${cross(337, 92)}${cross(259, 180)}${check(337, 180)}
  ${cross(259, 268)}${cross(337, 268)}
  <circle cx="291" cy="388" r="11" fill="#c08a22"/>${check(337, 356)}`)}
</svg>`;

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const [name, svg] of [['solver', solver], ['notepad', notepad]]) {
    for (const size of [180, 192, 512]) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(`<html><body style="margin:0;background:#fff">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
      await page.screenshot({ path: path.join(out, `${name}-${size}.png`), clip: { x: 0, y: 0, width: size, height: size } });
    }
  }
  await browser.close();
  console.log('icons written to', out);
})();
