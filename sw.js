// Service worker for NJ Fishing PWA.
// - Cache-first for shell + CDN libraries (instant load when offline or on flaky LTE).
// - Network-only for live API data (always fresh).
//
// VERSIONING: bump CACHE_NAME whenever you change anything in SHELL or CDN_ASSETS,
// or when an old cached copy must be evicted. Otherwise old browsers serve a stale
// shell forever — there's no built-in "check for new sw.js" UX in a PWA.

const CACHE_NAME = 'nj-fishing-v8';

// Local app shell — files served from your own origin.
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './stocking-schedule-2026-spring.json',
  './lakes-bergen.json',
  './access-pins.json',
  './hatch-charts-nj.json',
  './nj-aquatic-insects.json'
];

// Third-party libraries pulled from a CDN. Cached so the app fully renders
// offline. Versions are pinned in index.html; if you change a version there,
// update it here and bump CACHE_NAME.
const CDN_ASSETS = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/suncalc@1.9.0/suncalc.js'
];

// Hostnames that serve live data — never cached. Add a new one whenever you
// integrate a new live API.
const API_HOSTS = [
  'api.open-meteo.com',
  'historical-forecast-api.open-meteo.com',
  'api.waterdata.usgs.gov',
  'waterservices.usgs.gov',
  'mapsdep.nj.gov',
  // OpenStreetMap tiles: not "API data" per se but high-cost to cache aggressively
  // (every zoom/pan downloads new tiles) and the browser caches them on its own.
  // Leaving them as network-only here; browser HTTP cache handles them adequately.
  'tile.openstreetmap.org',
  'a.tile.openstreetmap.org',
  'b.tile.openstreetmap.org',
  'c.tile.openstreetmap.org'
];

function isApiHost(hostname) {
  return API_HOSTS.some((h) => hostname === h || hostname.endsWith('.' + h));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // addAll is atomic — if any URL 404s the whole install fails. CDN assets
      // are more likely to fail (network blips), so add them individually and
      // let the shell succeed even if a CDN file is temporarily down.
      const shellPromise = cache.addAll(SHELL);
      const cdnPromises = CDN_ASSETS.map((url) =>
        cache.add(new Request(url, { mode: 'cors' })).catch((e) => {
          // Don't fail the install if a CDN file is unreachable at install time.
          // The fetch handler will retry on next access.
          console.warn('[sw] CDN precache failed for', url, e);
        })
      );
      return Promise.all([shellPromise, ...cdnPromises]);
    })
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
  // Only handle GET. Don't try to cache POST/PUT/DELETE.
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Live API data — always network. If offline, let it fail cleanly so the app
  // shows its own "API error" state rather than serving stale data.
  if (isApiHost(url.hostname)) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Everything else (own-origin shell + CDN libs): cache-first with background
  // refresh. This is the critical fix vs the old network-first behavior — at
  // the streamside with bad signal, the app loads instantly from cache instead
  // of waiting for every request to time out.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      // Kick off a background fetch to refresh the cache for next time.
      // Don't await; serve cached immediately if we have it.
      const networkFetch = fetch(event.request)
        .then((resp) => {
          // Only cache successful responses. Don't cache 4xx/5xx as the "current" copy.
          if (resp && resp.status === 200) {
            const copy = resp.clone();
            caches.open(CACHE_NAME).then((c) => c.put(event.request, copy)).catch(() => {});
          }
          return resp;
        })
        .catch(() => null);

      // Return cached if we have it; otherwise wait on the network.
      return cached || networkFetch.then((resp) => resp || new Response('Offline and not cached', { status: 503 }));
    })
  );
});
