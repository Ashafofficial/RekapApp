const CACHE_NAME = 'sarimbit-pro-cache-v2';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './pembukuan.html',
  './database.js',
  './logo.png',
  './logo-toko.png',
  './manifest.json',
  // MENYIMPAN ASSET TAMPILAN SUPAYA MESKIPUN OFFLINE TETAP MEWAH
  'https://cdn.tailwindcss.com',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap',
  // Menyimpan library pendukung cetak nota offline
  'https://unpkg.com/dexie/dist/dexie.js',
  'https://unpkg.com/docx@7.1.0/build/index.js',
  'https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/2.0.5/FileSaver.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.25/jspdf.plugin.autotable.min.js',
  'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js'
];

// Tahap Install: Amankan semua aset ke memori browser laptop
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('Menyimpan aset tampilan ke brankas offline...');
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(() => self.skipWaiting())
  );
});

// Tahap Aktivasi: Sapu cache versi lama jika ada pembaruan sistem
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            console.log('Membersihkan cache usang...');
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Tahap Fetch: Menyajikan tampilan secara instan dari lokal jika offline
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse; // Ambil dari brankas lokal (Instan & Anti-Rusak)
      }
      return fetch(event.request).catch(() => {
        // Fallback jika bener-bener mentok offline dan aset gak ada di cache
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});