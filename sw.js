/* ============================================================
   MegaTienda Service Worker — Offline + Auto-update
   Estrategia:
   - HTML (navegaciones)         → NetworkFirst (3s timeout) → cache
   - CSS / JS / fuentes / iconos → StaleWhileRevalidate
   - Imágenes (productos, /img/) → CacheFirst con expiración manual
   - GitHub API (api.github.com / raw.githubusercontent.com push) → Network only
   ============================================================ */
const VERSION = 'mt-v1.0.12-livesync';
const CACHE_STATIC  = 'mt-static-' + VERSION;
const CACHE_RUNTIME = 'mt-runtime-' + VERSION;
const CACHE_IMG     = 'mt-img-' + VERSION;

const PRECACHE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  // Fuentes y FontAwesome (cacheo en runtime al primer hit, pero los precargo)
  'https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Nunito:wght@400;600;700;800;900&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_STATIC).then(c =>
      Promise.all(PRECACHE.map(u =>
        c.add(new Request(u, { cache: 'reload' })).catch(err => console.warn('[SW] precache fail:', u, err))
      ))
    )
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => ![CACHE_STATIC, CACHE_RUNTIME, CACHE_IMG].includes(k)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Permite forzar skipWaiting desde la página
self.addEventListener('message', (e) => { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });

function isImage(req){
  if (req.destination === 'image') return true;
  const u = new URL(req.url);
  return /\.(png|jpg|jpeg|gif|webp|svg|ico)(\?|$)/i.test(u.pathname);
}
function isFontOrStyleOrScript(req){
  return ['style','script','font'].includes(req.destination);
}
function isHtmlNavigation(req){
  return req.mode === 'navigate' || (req.method === 'GET' && req.headers.get('accept')?.includes('text/html'));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                 // POST/PUT/DELETE → red directa
  const url = new URL(req.url);

  // GitHub API y raw.githubusercontent: SIEMPRE red, nunca caché (datos vivos)
  if (url.hostname === 'api.github.com') return;
  if (url.hostname === 'raw.githubusercontent.com') {
    // imágenes raw del repo SÍ se cachean (es contenido estático)
    if (!isImage(req)) return;
  }

  // Navegaciones HTML → NetworkFirst con timeout 3s
  if (isHtmlNavigation(req)) {
    event.respondWith((async () => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(()=>ctrl.abort(), 3000);
        const net = await fetch(req, { signal: ctrl.signal });
        clearTimeout(t);
        const c = await caches.open(CACHE_STATIC); c.put(req, net.clone());
        return net;
      } catch {
        const cached = await caches.match(req) || await caches.match('index.html') || await caches.match('./');
        return cached || new Response('Offline', { status: 503, statusText: 'Offline' });
      }
    })());
    return;
  }

  // Imágenes → StaleWhileRevalidate (sirve cache pero refresca en segundo plano,
  // así Android ve imágenes nuevas tras subir a GitHub sin esperar a invalidar caché).
  if (isImage(req)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_IMG);
      const hit = await cache.match(req);
      const fetchPromise = fetch(req).then(res => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => hit);
      return hit || fetchPromise;
    })());
    return;
  }

  // CSS / JS / Fuentes → StaleWhileRevalidate
  if (isFontOrStyleOrScript(req) || url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com' || url.hostname === 'cdnjs.cloudflare.com') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_RUNTIME);
      const hit = await cache.match(req);
      const fetchPromise = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(()=>hit);
      return hit || fetchPromise;
    })());
    return;
  }

  // Resto: red con fallback a caché
  event.respondWith(
    fetch(req).then(res => {
      if (res.ok) caches.open(CACHE_RUNTIME).then(c => c.put(req, res.clone()));
      return res;
    }).catch(() => caches.match(req))
  );
});
