const CACHE_NAME = 'sarimbit-pro-cache-v4'; // Versi dinaikkan agar cache lama otomatis dihapus
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './dashboard.html',
  './pembukuan.html',
  './datadouble.html',
  './database.js',
  './dexie.js',
  './logo-toko.png',
  './logo-habiba.png',
  './logo-masara.png',
  './manifest.json',
  'https://cdn.tailwindcss.com',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap',
  'https://unpkg.com/docx@7.1.0/build/index.js',
  'https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/2.0.5/FileSaver.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.25/jspdf.plugin.autotable.min.js',
  'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

// Tahap Install: Simpan aset satu per satu agar 1 file error tidak menggagalkan seluruh update
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('Menyimpan aset tampilan v4 ke brankas offline...');
      return Promise.allSettled(
        ASSETS_TO_CACHE.map((url) =>
          cache.add(url).catch((err) => console.warn('Lewati aset gagal cache:', url, err))
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// Tahap Aktivasi: Sapu semua cache versi lama (v1, v2, v3, dst.)
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            console.log('Membersihkan cache usang:', cache);
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Tahap Fetch: Network-First untuk halaman HTML, Cache-First untuk aset statis
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  // Jangan pernah cache request API Supabase atau Telegram
  if (event.request.url.includes('supabase.co') || event.request.url.includes('api.telegram.org')) {
    return;
  }

  // Untuk file HTML (navigasi halaman): utamakan ambil versi terbaru, fallback ke cache jika offline
  if (event.request.mode === 'navigate' || event.request.url.endsWith('.html')) {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return networkResponse;
        })
        .catch(() => caches.match(event.request).then((res) => res || caches.match('./index.html')))
    );
    return;
  }

  // Untuk aset statis (JS, CSS, Font, Gambar): ambil dari cache agar instan
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      return cachedResponse || fetch(event.request).catch(() => {});
    })
  );
});