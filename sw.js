/* sw.js — 静态资源离线缓存。API 请求(api.anthropic.com)永不缓存。 */
"use strict";

const CACHE = "companion-v1";
const ASSETS = [
  "./", "./index.html", "./style.css",
  "./db.js", "./api.js", "./sensors.js", "./app.js",
  "./manifest.json", "./icons/icon-192.png", "./icons/icon-512.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  // API 与一切跨域请求:直连网络,不缓存
  if (url.origin !== location.origin) return;
  // 同源静态资源:cache-first,断网可用
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request))
  );
});
