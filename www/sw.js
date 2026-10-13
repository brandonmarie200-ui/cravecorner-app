/* CraveCorner service worker — Stage 1.
 * Cache-first for app shell, network-first for navigations.
 * Bumped automatically by deploy/deploy.sh on every deploy. */
var CC_SW_VERSION = 'cc-v24';
var CACHE_NAME = 'cravecorner-' + CC_SW_VERSION;
var APP_SHELL = [
  './',
  './index.html',
  './explore.html',
  './assets/css/design-system.css',
  './assets/js/icons.js',
  './assets/js/app.js',
  './js/data/demo.js',
  './assets/img/logo-cc.jpg',
  './assets/img/apple-touch-icon.png',
  './assets/img/icon-192.png',
  './assets/img/icon-512.png',
  './manifest.webmanifest',
  './assets/img/placeholder-food.jpg'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(APP_SHELL);
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key.indexOf('cravecorner-') === 0 && key !== CACHE_NAME) {
          return caches.delete(key);
        }
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  /* NEVER cache API or cross-origin requests (Supabase REST/storage/auth).
     Cache-first on those serves stale database reads after every write —
     e.g. a saved avatar that "disappears" on refresh. Only the same-origin
     app shell gets cached. */
  try {
    if (new URL(req.url).origin !== self.location.origin) return;
  } catch (e) { return; }
  // Navigations: network first, fall back to cache.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(function () { return caches.match('./index.html'); })
    );
    return;
  }
  // Assets: cache first, then network.
  event.respondWith(
    caches.match(req).then(function (cached) {
      return cached || fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(req, copy); });
        return res;
      });
    })
  );
});

/* ------------------------------------------------------------------ */
/* Web Push notifications                                              */
/* ------------------------------------------------------------------ */
self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  var title = data.title || 'CraveCorner';
  var options = {
    body: data.body || 'You have a new update.',
    icon: './assets/img/icon-192.png',
    badge: './assets/img/icon-192.png',
    data: { url: data.url || './index.html' },
    tag: data.tag || 'cc-push'
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || './index.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].url.indexOf(self.location.origin) === 0) {
          list[i].navigate(url);
          return list[i].focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
