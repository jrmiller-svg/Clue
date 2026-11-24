#!/usr/bin/env node
// Builds self-contained pages from src/:
//   index.html    + dist/artifact.html          — the solver (src/app.html + src/engine.js)
//   notepad.html  + dist/notepad-artifact.html  — the plain notepad (src/notepad.html)
// The root .html files are standalone, installable, offline-capable pages for
// GitHub Pages (with manifest + service worker); the dist/ files are body
// fragments for publishing as claude.ai artifacts (no service worker there).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const write = (p, s) => fs.writeFileSync(path.join(root, p), s);

const APPS = {
  solver: { page: 'index.html', manifest: 'manifest-solver.webmanifest', name: 'Clue Case Notes', short: 'Case Notes', icon: 'solver',
    description: 'Clue / Cluedo solver: exact envelope probabilities, accusation advice and suggestion ranking.' },
  notepad: { page: 'notepad.html', manifest: 'manifest-notepad.webmanifest', name: 'Clue Notepad', short: 'Notepad', icon: 'notepad',
    description: 'A plain Clue / Cluedo detective notepad. You make every mark; no hints.' }
};

// Shown once when the page has finished saving itself for offline use, plus a
// one-time hint in iPhone Safari on how to add it to the home screen.
const REGISTER = `<script>
(function () {
  function note(msg, ms) {
    var d = document.createElement('div');
    d.setAttribute('role', 'status');
    d.textContent = msg;
    d.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:calc(env(safe-area-inset-top,0px) + 72px);z-index:60;' +
      'background:var(--ink);color:var(--paper);padding:9px 14px;border-radius:10px;font-size:14px;line-height:1.35;max-width:calc(100% - 32px);text-align:center;box-shadow:0 4px 16px rgba(0,0,0,.2);pointer-events:none';
    document.body.appendChild(d);
    setTimeout(function () { d.remove(); }, ms || 3500);
  }
  if (!('serviceWorker' in navigator) || !(location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) return;
  window.addEventListener('load', function () {
    var firstInstall = !navigator.serviceWorker.controller;
    navigator.serviceWorker.register('./sw.js', { scope: './' }).then(function (reg) {
      var told = false;
      function watch(w) {
        if (!w || w.__watched) return;
        w.__watched = true;
        w.addEventListener('statechange', function () {
          if (w.state === 'activated' && firstInstall && !told) { told = true; note('Saved on this device — it now works offline.'); }
        });
      }
      watch(reg.installing);
      reg.addEventListener('updatefound', function () { watch(reg.installing); });
    }).catch(function () { /* offline support unavailable here */ });
    try {
      var ios = /iPhone|iPad|iPod/.test(navigator.userAgent), standalone = window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
      if (ios && !standalone && !localStorage.getItem('clue-install-hint')) {
        localStorage.setItem('clue-install-hint', '1');
        setTimeout(function () { note('Tip: tap Share, then “Add to Home Screen” to install this as an app that works offline.', 7000); }, 1200);
      }
    } catch (e) { /* storage blocked */ }
  });
})();
</script>`;

function pwaHead(app) {
  return [
    `<link rel="manifest" href="${app.manifest}">`,
    `<link rel="icon" type="image/png" sizes="192x192" href="icons/${app.icon}-192.png">`,
    `<link rel="apple-touch-icon" href="icons/${app.icon}-180.png">`,
    `<meta name="apple-mobile-web-app-title" content="${app.short}">`,
    `<meta name="apple-mobile-web-app-status-bar-style" content="default">`
  ].join('\n');
}

function standalone(fragment, app) {
  const split = fragment.indexOf('<div id="app">');
  if (split < 0) throw new Error('page is missing <div id="app">');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<style>:root{padding-top:env(safe-area-inset-top,0px)}</style>
${fragment.slice(0, split).trim()}
${pwaHead(app)}
</head>
<body>
${fragment.slice(split).trim()}
${REGISTER}
</body>
</html>
`;
}

function manifest(app) {
  return JSON.stringify({
    id: './' + app.page,
    name: app.name,
    short_name: app.short,
    description: app.description,
    start_url: './' + app.page,
    scope: './',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#eef1ef',
    theme_color: '#17624f',
    icons: [
      { src: `icons/${app.icon}-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `icons/${app.icon}-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: `icons/${app.icon}-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ]
  }, null, 2) + '\n';
}

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });

// solver: inline the engine so the page is one file
const engine = read('src/engine.js');
if (engine.includes('</script')) throw new Error('engine.js must not contain </script');
const appSrc = read('src/app.html');
const tag = '<script src="engine.js"></script>';
if (!appSrc.includes(tag)) throw new Error('engine placeholder missing from src/app.html');
const solverFragment = appSrc.replace(tag, () => '<script id="engine-src">\n' + engine + '\n</script>');

const notepadFragment = read('src/notepad.html');
if (notepadFragment.includes('engine')) throw new Error('the notepad must not include the solver');

const built = [];
for (const [key, fragment, artifact] of [['solver', solverFragment, 'dist/artifact.html'], ['notepad', notepadFragment, 'dist/notepad-artifact.html']]) {
  const app = APPS[key];
  const page = standalone(fragment, app);
  write(app.page, page);
  write(app.manifest, manifest(app));
  write(artifact, fragment.trim() + '\n');
  built.push(app.page + ' (' + (page.length / 1024).toFixed(0) + ' KB)');
}

// service worker: precache both apps; version = hash of everything cached
const icons = fs.readdirSync(path.join(root, 'icons')).filter((f) => f.endsWith('.png')).sort().map((f) => 'icons/' + f);
const assets = ['index.html', 'notepad.html', APPS.solver.manifest, APPS.notepad.manifest].concat(icons);
const hash = crypto.createHash('sha256');
assets.forEach((a) => hash.update(fs.readFileSync(path.join(root, a))));
const fontCss = Array.from(new Set((solverFragment + notepadFragment).match(/https:\/\/fonts\.googleapis\.com\/css2\?[^"']+/g) || []));
const sw = read('src/sw.js')
  .replace('__VERSION__', hash.digest('hex').slice(0, 12))
  .replace('__ASSETS__', JSON.stringify(['./'].concat(assets.map((a) => './' + a))))
  .replace('__FONT_CSS__', JSON.stringify(fontCss));
write('sw.js', sw);
write('.nojekyll', '');
console.log('built ' + built.join(', ') + ', manifests, sw.js and dist/ artifact fragments');
