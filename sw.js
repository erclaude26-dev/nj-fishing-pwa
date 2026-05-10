// Service worker for NJ Fishing PWA.
// Minimal: enables "Install app" prompt and caches the shell for offline shell load.
// API data is always fetched fresh, never cached (we want current conditions).

const CACHE_NAME = 'nj-fishing-v1';
const SHELL = ['./', './index.html', './manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Never cache API calls — always go to network for fresh data
  const isApi =
    url.hostname.includes('open-meteo.com') ||
    url.hostname.includes('waterdata.usgs.gov') ||
    url.hostname.includes('mapsdep.nj.gov');
  if (isApi) {
    event.respondWith(fetch(event.request));
    return;
  }
  // Shell: network first, fallback to cache (so updates land when online, app still loads offline)
  event.respondWith(
    fetch(event.request)
      .then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE_NAME).then((c) => c.put(event.request, copy)).catch(() => {});
        return resp;
      })
      .catch(() => caches.match(event.request))
  );
});
