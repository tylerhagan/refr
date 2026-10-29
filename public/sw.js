/* Refr service worker. Caches ONLY the app shell. Never caches audio. */
const VERSION = 'v1';
const CACHE = `refr-shell-${VERSION}`;
const AUDIO_EXT = /\.(wav|aif|aiff|mp3|m4a|aac)$/i;

function isAudio(request) {
  if (request.destination === 'audio') return true;
  try {
    return AUDIO_EXT.test(new URL(request.url).pathname);
  } catch {
    return false;
  }
}

// Hashed build output lives under /assets/.
function isHashedAsset(url) {
  return url.origin === self.location.origin && url.pathname.startsWith('/assets/');
}

// Precache index.html plus the JS/CSS it references (names are hashed at build time).
async function precacheShell() {
  const cache = await caches.open(CACHE);
  const res = await fetch('/', { cache: 'reload' });
  if (!res.ok) throw new Error('Shell fetch failed');
  const html = await res.clone().text();
  const urls = new Set(['/']);
  for (const m of html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)) {
    urls.add(m[1]);
  }
  await cache.put('/', res);
  await Promise.all(
    [...urls]
      .filter((u) => u !== '/')
      .map(async (u) => {
        const r = await fetch(u);
        if (r.ok) await cache.put(u, r);
      }),
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith('refr-shell-') && k !== CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || isAudio(request)) return; // let the network handle it
  const url = new URL(request.url);

  // Network-first for navigations, falling back to the cached shell.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('/', copy));
          }
          return res;
        })
        .catch(async () => (await caches.match('/')) ?? Response.error()),
    );
    return;
  }

  // Cache-first for hashed assets.
  if (isHashedAsset(url)) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(request, copy));
            }
            return res;
          }),
      ),
    );
  }
});
