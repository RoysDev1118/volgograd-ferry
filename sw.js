const CACHE_NAME = 'vlg-ferry-v1';
const ASSETS = ['./', './index.html', './manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

// Стратегия Network First для schedule.json (всегда свежие данные, но работает без сети)
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// Отображение Push-уведомления на экране Android
self.addEventListener('push', (e) => {
  const data = e.data ? e.data.json() : { title: 'Речпорт Волгоград', body: 'Расписание обновилось' };
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: 'https://flaticon.com',
      vibrate: [200, 100, 200]
    })
  );
});

// Открытие приложения при клике на уведомление
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(clients.openWindow('./'));
});
