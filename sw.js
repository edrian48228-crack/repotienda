/* ============================================================
   MegaTienda Service Worker — Offline TOTAL + Auto-update (v17)
   ============================================================ */
const VERSION = 'mt-v1.0.25-idleshow';
const CACHE_STATIC  = 'mt-static-' + VERSION;
const CACHE_RUNTIME = 'mt-runtime-' + VERSION;
const CACHE_IMG     = 'mt-img-' + VERSION;
const CACHE_IMG_RT  = 'mt-img-runtime-v1'; // compartido con la app

const PRECACHE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'icon-512-maskable.png',
  'https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Nunito:wght@400;600;700;800;900&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil((async () => {
    const c = await caches.open(CACHE_STATIC);
    await Promise.all(PRECACHE.map(u =>
      c.add(new Request(u, { cache: 'reload' })).catch(err => console.warn('[SW] precache fail:', u, err))
    ));
    // Precargar todas las imágenes del repo (carpeta /img/) para offline total
    try{
      const base = self.registration.scope; // ej: https://user.github.io/repo/
      const r = await fetch(new URL('img/images.txt', base).toString(), {cache:'no-store'});
      if(r.ok){
        const list = (await r.text()).split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
        const imgCache = await caches.open(CACHE_IMG);
        await Promise.all(list.map(name=>{
          const u = new URL('img/'+name, base).toString();
          return imgCache.add(new Request(u, {cache:'reload'})).catch(()=>{});
        }));
      }
    }catch(_){}
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => ![CACHE_STATIC, CACHE_RUNTIME, CACHE_IMG, CACHE_IMG_RT].includes(k)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

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
  return req.mode === 'navigate' || (req.method === 'GET' && (req.headers.get('accept')||'').includes('text/html'));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // GitHub API: red directa (datos vivos)
  if (url.hostname === 'api.github.com') return;
  if (url.hostname === 'raw.githubusercontent.com' && !isImage(req)) return;

  // HTML → NetworkFirst con fallback offline a index.html (offline total)
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
        const cached = await caches.match(req)
          || await caches.match('index.html')
          || await caches.match('./');
        return cached || new Response('Offline', { status: 503 });
      }
    })());
    return;
  }

  // Imágenes → CacheFirst (offline total) con refresco en segundo plano
  if (isImage(req)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_IMG);
      const rt    = await caches.open(CACHE_IMG_RT);
      const hit = (await cache.match(req)) || (await rt.match(req));
      const fetchPromise = fetch(req).then(res => {
        if (res && (res.ok || res.type==='opaque')) cache.put(req, res.clone()).catch(()=>{});
        return res;
      }).catch(() => hit);
      return hit || fetchPromise;
    })());
    return;
  }

  // CSS / JS / Fuentes / CDN → CacheFirst (offline total para Windows y Android)
  if (isFontOrStyleOrScript(req) || ['fonts.googleapis.com','fonts.gstatic.com','cdnjs.cloudflare.com'].includes(url.hostname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_RUNTIME);
      const hit = await cache.match(req);
      if (hit) {
        // refresco silencioso en segundo plano
        fetch(req).then(res => { if (res && (res.ok||res.type==='opaque')) cache.put(req, res.clone()).catch(()=>{}); }).catch(()=>{});
        return hit;
      }
      try{
        const res = await fetch(req);
        if (res && (res.ok||res.type==='opaque')) cache.put(req, res.clone()).catch(()=>{});
        return res;
      }catch(e){
        return hit || new Response('', {status:503});
      }
    })());
    return;
  }

  // Resto: red con fallback caché
  event.respondWith(
    fetch(req).then(res => {
      if (res && res.ok) caches.open(CACHE_RUNTIME).then(c => c.put(req, res.clone()));
      return res;
    }).catch(() => caches.match(req))
  );
});
