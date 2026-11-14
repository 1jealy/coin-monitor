/* 홈 화면 앱용 보조 파일 (https 주소에서만 등록됨).
 * 화면 파일은 항상 새로 받고, 인터넷이 끊겼을 때만 마지막으로 받은 것을 보여 준다.
 * 시세·계좌 데이터는 저장하지 않는다.
 */
const CACHE = "coin-monitor-v4";
const SHELL = ["./", "paper.html", "account.html", "index.html", "styles.css", "net.js", "coins.js", "strategy.js", "paper.js", "account.js", "app.js",
  "manifest.webmanifest", "icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // 시세 API 는 건드리지 않음
  if (url.pathname.endsWith(".json")) return; // 계좌 기록도 저장하지 않음
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});
