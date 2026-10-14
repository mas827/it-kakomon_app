// Service Worker - オフライン対応
const CACHE = 'fe-exam-v27';
const ASSETS = [
  './', './index.html', './app.js', './manifest.json', './icon-192.png', './icon-512.png',
  './katex/katex.min.css',
  './katex/fonts/KaTeX_AMS-Regular.woff2',
  './katex/fonts/KaTeX_Caligraphic-Bold.woff2',
  './katex/fonts/KaTeX_Caligraphic-Regular.woff2',
  './katex/fonts/KaTeX_Fraktur-Bold.woff2',
  './katex/fonts/KaTeX_Fraktur-Regular.woff2',
  './katex/fonts/KaTeX_Main-Bold.woff2',
  './katex/fonts/KaTeX_Main-BoldItalic.woff2',
  './katex/fonts/KaTeX_Main-Italic.woff2',
  './katex/fonts/KaTeX_Main-Regular.woff2',
  './katex/fonts/KaTeX_Math-BoldItalic.woff2',
  './katex/fonts/KaTeX_Math-Italic.woff2',
  './katex/fonts/KaTeX_SansSerif-Bold.woff2',
  './katex/fonts/KaTeX_SansSerif-Italic.woff2',
  './katex/fonts/KaTeX_SansSerif-Regular.woff2',
  './katex/fonts/KaTeX_Script-Regular.woff2',
  './katex/fonts/KaTeX_Size1-Regular.woff2',
  './katex/fonts/KaTeX_Size2-Regular.woff2',
  './katex/fonts/KaTeX_Size3-Regular.woff2',
  './katex/fonts/KaTeX_Size4-Regular.woff2',
  './katex/fonts/KaTeX_Typewriter-Regular.woff2',
];

// IMAGES:START（tools/sync_sw_images.py が生成。手で編集しない）
const IMAGES = [
  './images/2009A-25.png',
  './images/2009A-42.png',
  './images/2009A-51.png',
  './images/2009A-61.png',
  './images/2009A-76.png',
  './images/2009A-80.png',
  './images/2010A-15.png',
  './images/2010A-24.png',
  './images/2010A-51.png',
  './images/2010A-52.png',
  './images/2010A-75.png',
  './images/2010A-77.png',
  './images/2010A-80.png',
  './images/2011A-07.png',
  './images/2011A-09.png',
  './images/2011A-19.png',
  './images/2011A-20.png',
  './images/2011A-33.png',
  './images/2011A-51.png',
  './images/2012A-06.png',
  './images/2012A-15.png',
  './images/2012A-22.png',
  './images/2012A-38.png',
  './images/2012A-52.png',
  './images/2012A-77.png',
  './images/2013A-01.png',
  './images/2013A-08.png',
  './images/2013A-25.png',
  './images/2013A-46.png',
  './images/2013A-53.png',
  './images/2013A-76.png',
  './images/2014A-21.png',
  './images/2014A-23.png',
  './images/2014A-52.png',
  './images/2015A-02.png',
  './images/2015A-06.png',
  './images/2015A-18.png',
  './images/2015A-23.png',
  './images/2015A-47.png',
  './images/2015A-51.png',
  './images/2015H-09.png',
  './images/2015H-11.png',
  './images/2015H-14.png',
  './images/2015H-23.png',
  './images/2015H-28.png',
  './images/2015H-30.png',
  './images/2015H-40.png',
  './images/2015H-49.png',
  './images/2015H-50.png',
  './images/2015H-54.png',
  './images/2016A-03.png',
  './images/2016A-06.png',
  './images/2016A-09.png',
  './images/2016A-11.png',
  './images/2016A-18.png',
  './images/2016A-21.png',
  './images/2016A-23.png',
  './images/2016A-31.png',
  './images/2016A-34.png',
  './images/2016A-68.png',
  './images/2016A-72.png',
  './images/2016A-77.png',
  './images/2016A-78.png',
  './images/2016H-02.png',
  './images/2016H-05.png',
  './images/2016H-08.png',
  './images/2016H-14.png',
  './images/2016H-23.png',
  './images/2016H-27.png',
  './images/2016H-49.png',
  './images/2016H-69.png',
  './images/2016H-77.png',
  './images/2017A-04.png',
  './images/2017A-11.png',
  './images/2017A-19.png',
  './images/2017A-23.png',
  './images/2017A-28.png',
  './images/2017A-44.png',
  './images/2017A-53.png',
  './images/2017A-66.png',
  './images/2017A-79.png',
  './images/2017H-05.png',
  './images/2017H-14.png',
  './images/2017H-17.png',
  './images/2017H-18.png',
  './images/2017H-22.png',
  './images/2017H-25.png',
  './images/2017H-26.png',
  './images/2017H-32.png',
  './images/2017H-49.png',
  './images/2017H-51.png',
  './images/2017H-53.png',
  './images/2017H-71.png',
  './images/2017H-74.png',
  './images/2018A-22.png',
  './images/2018A-26.png',
  './images/2018H-02.png',
  './images/2018H-04.png',
  './images/2018H-06.png',
  './images/2018H-09.png',
  './images/2018H-16.png',
  './images/2018H-23.png',
  './images/2018H-49.png',
  './images/2018H-51.png',
  './images/2018H-80.png',
  './images/2019A-01.png',
  './images/2019A-03.png',
  './images/2019A-05.png',
  './images/2019A-09.png',
  './images/2019A-13.png',
  './images/2019A-22.png',
  './images/2019A-29.png',
  './images/NO1-17.png',
  './images/NO1-21.png',
  './images/NO1-25.png',
  './images/NO1-45.png',
  './images/NO1-52.png',
  './images/NO2-77.png',
  './images/NO3-15.png',
  './images/NO3-52.png',
  './images/NO3-66.png',
];
// IMAGES:END

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS))
      // 画像はコア資産と分ける。1枚の取得失敗でinstall全体を失敗させないため、
      // addAll ではなく allSettled で個別に積む（失敗した図は次回アクセス時にキャッシュされる）。
      .then(() => caches.open(CACHE))
      .then((c) => Promise.allSettled(IMAGES.map((url) => c.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request).then((res) => {
        if (!res || res.status !== 200 || res.type === 'opaque') return res;
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, clone));
        return res;
      });
    })
  );
});
