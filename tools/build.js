#!/usr/bin/env node
// Builds two self-contained pages from src/app.html + src/engine.js:
//   index.html          — standalone page (open locally, or host anywhere, e.g. GitHub Pages)
//   dist/artifact.html  — body fragment for publishing as a claude.ai artifact
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'src/app.html'), 'utf8');
const engine = fs.readFileSync(path.join(root, 'src/engine.js'), 'utf8');
if (engine.includes('</script')) throw new Error('engine.js must not contain </script');

const tag = '<script src="engine.js"></script>';
if (!app.includes(tag)) throw new Error('engine placeholder missing from src/app.html');
const inlined = app.replace(tag, () => '<script id="engine-src">\n' + engine + '\n</script>');

const split = inlined.indexOf('<div id="app">');
const head = inlined.slice(0, split).trim();
const body = inlined.slice(split).trim();

const standalone = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>:root{padding-top:env(safe-area-inset-top,0px)}</style>
${head}
</head>
<body>
${body}
</body>
</html>
`;

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'index.html'), standalone);
fs.writeFileSync(path.join(root, 'dist/artifact.html'), inlined.trim() + '\n');
console.log('built index.html (' + (standalone.length / 1024).toFixed(0) + ' KB) and dist/artifact.html');
