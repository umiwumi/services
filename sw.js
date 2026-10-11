/* Yuzawa Station Guide — service worker (offline support)
 *
 * What it does
 *  - On the first visit (while online) it saves the pages and files listed in PRECACHE.
 *  - Pages: network first, but if the network is down OR too slow (weak mountain signal),
 *    the saved copy is shown instead.
 *  - guide-data.js (timetable, notices): same network-first rule, so staff edits show up
 *    quickly, while the saved copy still works with no signal.
 *  - PDFs and other files: the saved copy is shown at once and refreshed in the background.
 *  - Whatever happens, every request gets a real Response (never null/undefined).
 *
 * When you change the PRECACHE list or want everyone to re-download everything,
 * bump CACHE_VERSION.
 */

const CACHE_PREFIX = 'yuzawa-services-';
const CACHE_VERSION = 'v2';
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;

// Each file is saved on its own. A file that does not exist yet (for example a PDF that
// has not been uploaded) is skipped instead of breaking the whole install.
const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './docs/train_info.pdf',
  './docs/onsen_map.pdf'
];

// Files staff edit: try the network first (short wait), then the saved copy.
const NETWORK_FIRST = [/\/guide-data\.js$/];

// If a saved copy exists, give up on the network after this long.
const NETWORK_TIMEOUT_MS = 4000;

/* ---------- helpers ---------- */

// Cache key: the URL without ?query or #hash, so /page.html?lang=ko uses the saved /page.html.
function keyFor(url) {
  const u = new URL(url);
  u.search = '';
  u.hash = '';
  return u.href;
}

// A redirected response cannot be used to answer a page navigation, so rebuild it.
async function clean(res) {
  if (!res.redirected) return res;
  const body = await res.blob();
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

// "copy" must already be a clone: cloning later fails once the page is reading the body.
async function save(req, copy) {
  try {
    if (!copy || copy.status !== 200) return;
    const cache = await caches.open(CACHE_NAME);
    await cache.put(keyFor(req.url), await clean(copy));
  } catch (err) {
    console.warn('[SW] could not save', req.url, err && err.message);
  }
}

function fetchWithTimeout(req, ms, init) {
  if (!ms) return fetch(req, init);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(req, Object.assign({}, init, { signal: ctrl.signal }))
    .finally(() => clearTimeout(timer));
}

// Saved copy of a request, also trying "/" <-> "/index.html".
async function findSaved(cache, req) {
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const u = new URL(req.url);
  u.search = '';
  if (u.pathname.endsWith('/')) {
    return cache.match(u.href + 'index.html', { ignoreSearch: true });
  }
  if (u.pathname.endsWith('/index.html')) {
    return cache.match(u.href.replace(/index\.html$/, ''), { ignoreSearch: true });
  }
  return undefined;
}

function offlinePage() {
  const html = '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline</title>' +
    '<style>body{font-family:sans-serif;background:#0f172a;color:#f8fafc;padding:24px;line-height:1.6}' +
    'a{color:#38bdf8}</style></head><body><h1>📶 Offline</h1>' +
    '<p>This page has not been saved on your phone yet. Please reconnect to the internet and open it once.</p>' +
    '<p>このページはまだ保存されていません。ネットワークに接続して一度開いてください。</p>' +
    '<p>此頁面尚未儲存，請連線後開啟一次。 / 此页面尚未保存，请联网后打开一次。</p>' +
    '<p>이 페이지는 아직 저장되지 않았습니다. 인터넷에 연결한 후 한 번 열어 주세요.</p>' +
    '<p><a href="./">← Home</a></p></body></html>';
  return new Response(html, {
    status: 503,
    statusText: 'Offline',
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

function offlineAsset() {
  return new Response('', { status: 504, statusText: 'Offline' });
}

/* ---------- strategies (each always resolves to a Response, or null for the caller to replace) ---------- */

async function networkFirst(event, req, init) {
  const cache = await caches.open(CACHE_NAME);
  const saved = await findSaved(cache, req);
  try {
    const res = await fetchWithTimeout(req, saved ? NETWORK_TIMEOUT_MS : 0, init);
    if (res.ok || !saved) {
      event.waitUntil(save(req, res.clone()));
      return res;
    }
    return saved; // server error but we have a good saved copy
  } catch (err) {
    return saved || null; // offline, or too slow
  }
}

async function staleWhileRevalidate(event, req) {
  const cache = await caches.open(CACHE_NAME);
  const saved = await findSaved(cache, req);
  const refresh = fetch(req)
    .then((res) => {
      event.waitUntil(save(req, res.clone()));
      return res;
    })
    .catch(() => null);
  if (saved) {
    event.waitUntil(refresh);
    return saved;
  }
  return refresh;
}

// respondWith() must be given a Response. This guarantees one, whatever goes wrong.
function respond(event, work, fallback) {
  event.respondWith(
    work.then((res) => res || fallback()).catch(() => fallback())
  );
}

/* ---------- lifecycle ---------- */

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(PRECACHE.map(async (path) => {
      try {
        const url = new URL(path, self.registration.scope).href;
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        await cache.put(keyFor(url), await clean(res));
      } catch (err) {
        console.warn('[SW] not saved for offline:', path, err && err.message);
      }
    }));
  })());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // other websites: leave to the browser

  // Pages
  if (req.mode === 'navigate') {
    respond(event, networkFirst(event, req), offlinePage);
    return;
  }

  // Data staff edit (always revalidate with the server, bypassing the browser's HTTP cache)
  if (NETWORK_FIRST.some((re) => re.test(url.pathname))) {
    respond(event, networkFirst(event, req, { cache: 'no-cache' }), offlineAsset);
    return;
  }

  // Everything else (PDFs, icons, ...)
  respond(event, staleWhileRevalidate(event, req), offlineAsset);
});
