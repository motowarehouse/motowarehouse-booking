// Motowarehouse Service Worker — PWA + Push Notifications
const CACHE_NAME = 'mw-admin-v1';

// ── Install: cache core admin assets ────────────────────────────────────────
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll([
        '/admin/',
        '/assets/MWH_Logo_New.png',
        '/icons/icon-192.png',
        '/icons/icon-512.png',
      ]).catch(() => {}) // don't fail install if some assets are missing
    )
  );
});

// ── Activate: clean up old caches ───────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: network-first, fall back to cache for admin pages ────────────────
self.addEventListener('fetch', event => {
  // Only handle GET requests for our own origin
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // API calls — always go to network, never cache
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    fetch(event.request)
      .then(res => {
        // Cache successful responses for admin assets
        if (res.ok && (url.pathname.startsWith('/admin') || url.pathname.startsWith('/assets') || url.pathname.startsWith('/icons'))) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

// ── Push: receive notification from server ──────────────────────────────────
self.addEventListener('push', event => {
  let data = { title: 'Motowarehouse', body: 'New notification', tag: 'mw-default' };

  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (e) {
    if (event.data) data.body = event.data.text();
  }

  const options = {
    body:    data.body,
    tag:     data.tag || 'mw-notification',
    icon:    '/icons/icon-192.png',
    badge:   '/icons/icon-192.png',
    vibrate: [200, 100, 200],
    data:    { url: data.url || '/admin/' },
    actions: data.actions || [],
    requireInteraction: data.requireInteraction || false,
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// ── Notification click: open/focus admin panel ───────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const targetUrl = (event.notification.data && event.notification.data.url)
    ? event.notification.data.url
    : '/admin/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // If admin panel is already open, focus it
      for (const client of windowClients) {
        if (client.url.includes('/admin') && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open a new window
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
