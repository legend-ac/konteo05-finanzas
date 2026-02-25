// Service Worker — Konteo 05
const CACHE_NAME = 'konteo05-v2.0.0';
const urlsToCache = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/manifest.json',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap',
  'https://cdn.sheetjs.com/xlsx-0.20.1/package/dist/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js'
];

// Install
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
      .then(() => self.skipWaiting())
  );
});

// Activate — clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(names.map(name => {
        if (name !== CACHE_NAME) return caches.delete(name);
      }))
    ).then(() => self.clients.claim())
  );
});

// Fetch — Network first, fallback to cache
self.addEventListener('fetch', (event) => {
  // Skip Firebase requests
  if (event.request.url.includes('firebaseio.com') ||
    event.request.url.includes('googleapis.com') ||
    event.request.url.includes('firestore')) {
    return event.respondWith(fetch(event.request));
  }

  event.respondWith(
    fetch(event.request)
      .then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      })
      .catch(() =>
        caches.match(event.request).then(response => {
          if (response) return response;
          if (event.request.mode === 'navigate') return caches.match('/index.html');
        })
      )
  );
});

// Push notifications (future)
self.addEventListener('push', (event) => {
  event.waitUntil(
    self.registration.showNotification('Konteo 05', {
      body: event.data ? event.data.text() : 'Nueva notificación',
      icon: '/icons/icon-192x192.png',
      badge: '/icons/icon-72x72.png',
      vibrate: [200, 100, 200],
      tag: 'andy05-notification'
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow('/'));
});
