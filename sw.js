/* Offline support for Clue Case Notes and Clue Notepad.
 * Generated into /sw.js by tools/build.js (the placeholders are filled in there).
 *
 * - Install: saves both apps, their manifests and icons, and (best effort)
 *   the web fonts, so the apps open with no connection at all.
 * - Pages: served from the saved copy instantly; a fresh copy is fetched in
 *   the background when online, so updates arrive on the next launch.
 */
'use strict';
var VERSION = 'f441eb03d723';
var CACHE = 'clue-app-' + VERSION;
var FONT_CACHE = 'clue-fonts-v1';
var ASSETS = ["./","./index.html","./notepad.html","./manifest-solver.webmanifest","./manifest-notepad.webmanifest","./icons/notepad-180.png","./icons/notepad-192.png","./icons/notepad-512.png","./icons/solver-180.png","./icons/solver-192.png","./icons/solver-512.png"];
var FONT_CSS = ["https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500;600&family=Special+Elite&display=swap"];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) { return cache.addAll(ASSETS.map(function (u) { return new Request(u, { cache: 'reload' }); })); })
      .then(function () { return cacheFonts().catch(function () {}); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k.indexOf('clue-app-') === 0 && k !== CACHE; })
          .map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

// Save the font stylesheet and the font files it points to.
function cacheFonts() {
  return caches.open(FONT_CACHE).then(function (cache) {
    return Promise.all(FONT_CSS.map(function (url) {
      return cache.match(url).then(function (hit) {
        if (hit) return null;
        return fetch(url, { mode: 'cors' }).then(function (res) {
          if (!res.ok) return null;
          return res.clone().text().then(function (css) {
            var files = (css.match(/https:\/\/fonts\.gstatic\.com\/[^)'"]+/g) || []);
            return cache.put(url, res).then(function () {
              return Promise.all(files.map(function (f) {
                return fetch(f, { mode: 'cors' }).then(function (r) { if (r.ok) return cache.put(f, r); }).catch(function () {});
              }));
            });
          });
        });
      });
    }));
  });
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);

  // Fonts: saved copy first, network only if missing.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(caches.open(FONT_CACHE).then(function (cache) {
      return cache.match(req).then(function (hit) {
        return hit || fetch(req).then(function (res) {
          if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
          return res;
        }).catch(function () { return Response.error(); });
      });
    }));
    return;
  }
  if (url.origin !== self.location.origin) return;

  // App files: answer from the saved copy at once, refresh it in the background.
  var refresh = fetch(req).then(function (res) {
    if (!res || !res.ok) return res;
    var copy = res.clone();
    return caches.open(CACHE)
      .then(function (cache) { return cache.put(req, copy); })
      .catch(function () {})
      .then(function () { return res; });
  }).catch(function () { return null; });

  event.respondWith(caches.open(CACHE).then(function (cache) {
    return cache.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      return refresh.then(function (res) {
        if (res) return res;
        if (req.mode === 'navigate') return cache.match('./index.html');
        return Response.error();
      });
    });
  }));
  event.waitUntil(refresh);
});
