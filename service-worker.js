// Service Worker - Konteo 05
const CACHE_NAME = 'konteo05-v5.7.0';
const APP_SHELL = [
  '/',
  '/index.html',
  '/privacy.html',
  '/terms.html',
  '/gmail-data.html',
  '/security.html',
  '/legal-notice.html',
  '/cookies.html',
  '/contact.html',
  '/complaints.html',
  '/css/styles.css',
  '/css/workspace.css',
  '/manifest.json',
  '/js/app.js',
  '/js/state.js',
  '/js/firebase/runtime-config.js',
  '/js/firebase/config.js',
  '/js/services/dbService.js',
  '/js/services/asyncControl.js',
  '/js/services/financialMath.js',
  '/js/services/walletPolicy.js',
  '/js/services/exportService.js',
  '/js/services/gmailService.js',
  '/js/services/gmailParser.js',
  '/js/ui/helpers.js',
  '/js/ui/toast.js',
  '/js/ui/modals.js',
  '/js/ui/render.js',
  '/js/ui/charts.js',
  '/js/ui/insights.js',
  '/js/ui/dailySpending.js',
  '/js/ui/guides.js',
  '/js/ui/mascot.js',
  '/js/ui/gmailImport.js',
  '/images/og-konteo-05.png',
  '/images/konteo-guide-welcome.jpg',
  '/images/konteo-guide-empty.jpg',
  '/images/konteo-guide-gmail.jpg',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png'
];

function isFirebaseRequest(url) {
  return (
    url.includes('firebaseio.com') ||
    url.includes('googleapis.com') ||
    url.includes('gstatic.com') ||
    url.includes('firestore')
  );
}

function isCacheableRequest(request, response) {
  return (
    request.method === 'GET' &&
    response &&
    response.ok &&
    (request.url.startsWith('https://') || request.url.startsWith('http://'))
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name.startsWith('konteo05-') && name !== CACHE_NAME).map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
    const { request } = event;

    if (request.method !== 'GET' || isFirebaseRequest(request.url)) {
        return;
    }

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) {
        return;
    }

    event.respondWith((async () => {
        try {
            const response = await fetch(request, { cache: 'no-store' });
            if (isCacheableRequest(request, response)) {
                const cache = await caches.open(CACHE_NAME);
                await cache.put(request, response.clone());
            }
            return response;
        } catch (_) {
            const cache = await caches.open(CACHE_NAME);
            const cached = await cache.match(request);
            if (cached) return cached;
            if (request.mode === 'navigate') return (await cache.match('/index.html')) || Response.error();
            return Response.error();
        }
    })());
});

self.addEventListener('push', (event) => {
  event.waitUntil(
    self.registration.showNotification('Konteo 05', {
      body: event.data ? event.data.text() : 'Nueva notificacion',
      icon: '/icons/icon-192x192.png',
      badge: '/icons/icon-72x72.png',
      vibrate: [200, 100, 200],
      tag: 'konteo05-notification'
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow('/'));
});
