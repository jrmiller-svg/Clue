#!/usr/bin/env node
// Builds self-contained pages from src/:
//   index.html    + dist/artifact.html          — the solver (src/app.html + src/engine.js)
//   notepad.html  + dist/notepad-artifact.html  — the plain notepad (src/notepad.html)
// The root .html files are standalone pages (open locally or host anywhere);
// the dist/ files are body fragments for publishing as claude.ai artifacts.
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function standalone(fragment) {
  const split = fragment.indexOf('<div id="app">');
  if (split < 0) throw new Error('page is missing <div id="app">');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>:root{padding-top:env(safe-area-inset-top,0px)}</style>
${fragment.slice(0, split).trim()}
</head>
<body>
${fragment.slice(split).trim()}
</body>
</html>
`;
}

function emit(fragment, pageFile, artifactFile) {
  const page = standalone(fragment);
  fs.writeFileSync(path.join(root, pageFile), page);
  fs.writeFileSync(path.join(root, artifactFile), fragment.trim() + '\n');
  console.log('built ' + pageFile + ' (' + (page.length / 1024).toFixed(0) + ' KB) and ' + artifactFile);
}

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });

// solver: inline the engine so the page is one file
const engine = read('src/engine.js');
if (engine.includes('</script')) throw new Error('engine.js must not contain </script');
const app = read('src/app.html');
const tag = '<script src="engine.js"></script>';
if (!app.includes(tag)) throw new Error('engine placeholder missing from src/app.html');
emit(app.replace(tag, () => '<script id="engine-src">\n' + engine + '\n</script>'), 'index.html', 'dist/artifact.html');

// notepad: no engine at all
const notepad = read('src/notepad.html');
if (notepad.includes('engine')) throw new Error('the notepad must not include the solver');
emit(notepad, 'notepad.html', 'dist/notepad-artifact.html');
