/* GymTrack service worker — instant loads + full offline app shell.
   Data requests (Supabase) are never intercepted; the app itself queues
   offline writes and falls back to its last synced snapshot for reads. */

// Bump SW_VERSION with every deploy, matching index.html's ?v= tags. A new
// version re-runs install (fresh precache) and activate drops the old cache,
// so offline users never get a new index.html paired with a stale app.js.
const SW_VERSION = '2026-07-15x';
const CACHE = 'gymtrack-' + SW_VERSION;

// Everything needed to boot with no network at all — the versioned asset
// URLs exactly as index.html requests them.
const SHELL = [
  './',
  'index.html',
  'styles.css?v=' + SW_VERSION,
  'app.js?v=' + SW_VERSION,
  'supabase-config.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

// Hosts we cache. Anything else (the Supabase API) goes straight to network.
const CACHEABLE_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === location.origin;
  if (!sameOrigin && !CACHEABLE_HOSTS.includes(url.hostname)) return;

  // Pages: network-first so deploys land immediately; cached shell offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('index.html', copy));
          return res;
        })
        .catch(() => caches.match('index.html'))
    );
    return;
  }

  // Assets: cache-first on the exact URL (they're version-tagged, so a new
  // ?v= misses and fetches fresh); when offline, fall back to any cached
  // version of the same file so the app still boots.
  e.respondWith(
    caches.match(req).then((exact) => {
      if (exact) return exact;
      return fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }));
    })
  );
});
