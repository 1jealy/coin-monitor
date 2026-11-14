/* 어디서 열렸는지에 따라 데이터 받는 길을 고른다.
 * - "server": 이 PC의 crypto_live/server.py 로 열림 → 서버를 거침 (PIN 잠금, 코인원 비교, account.json 사용 가능)
 * - "static": 무료 정적 호스팅(GitHub Pages 등)으로 열림 → **빗썸**에 직접 연결, 코인원 비교 없음, 예시 모의 계좌
 *   (업비트는 다른 웹사이트에서 오는 브라우저 요청을 10초에 1번 정도로 막아서 공개 주소에서는 쓸 수 없음.
 *    빗썸 v1 API 는 업비트와 같은 형식이라 화면 코드는 그대로 쓴다.)
 */
"use strict";

const NET = {
  mode: null,
  async detect() {
    if (this.mode) return this.mode;
    try {
      const r = await fetch("/api/server", { cache: "no-store" });
      if (r.ok && (r.headers.get("content-type") || "").includes("json")) {
        await r.json();
        this.mode = "server";
        return this.mode;
      }
      if (r.status === 401) { this.mode = "server"; return this.mode; }
    } catch { /* 서버 없음 */ }
    this.mode = "static";
    return this.mode;
  },
  /** 시세 REST 주소 (업비트 형식 경로: candles/minutes/1, ticker, market/all ...) */
  upbit(pathAndQuery) {
    return this.mode === "server" ? `/api/upbit/${pathAndQuery}` : `https://api.bithumb.com/v1/${pathAndQuery}`;
  },
  wsUrl() {
    return this.mode === "server" ? "wss://api.upbit.com/websocket/v1" : "wss://ws-api.bithumb.com/websocket/v1";
  },
  exchange() {
    return this.mode === "server" ? "업비트" : "빗썸";
  },
  /** 화면에서 data-ex 가 붙은 곳에 거래소 이름을 채운다 */
  label() {
    document.querySelectorAll("[data-ex]").forEach((el) => { el.textContent = this.exchange(); });
    document.documentElement.dataset.mode = this.mode;
  },
  coinone(base) {
    return this.mode === "server" ? `/api/coinone/orderbook/${base}` : null; // 코인원은 브라우저 직접 요청을 막아 둠
  },
  account() {
    return this.mode === "server" ? "/api/account" : "mock_account.json";
  },
  /** 1시간 캔들 200개 주소 (toSec 이전 것). 업비트는 UTC 'Z', 빗썸은 한국 시간 문자열을 받는다. */
  hourCandles(market, toSec) {
    const q = new URLSearchParams({ market, count: "200" });
    if (toSec) {
      if (this.mode === "server") {
        q.set("to", new Date(toSec * 1000).toISOString().slice(0, 19) + "Z");
      } else {
        const k = new Date((toSec + 9 * 3600) * 1000).toISOString();
        q.set("to", `${k.slice(0, 10)} ${k.slice(11, 19)}`);
      }
    }
    return this.upbit(`candles/minutes/60?${q}`);
  },
};

/* 인터넷 주소(https)로 열렸을 때만 홈 화면 앱 보조 파일 등록. 이 PC(localhost)·와이파이(http)에서는 안 함. */
if ("serviceWorker" in navigator && window.isSecureContext && !["localhost", "127.0.0.1"].includes(location.hostname)) {
  window.addEventListener("load", () => { navigator.serviceWorker.register("sw.js").catch(() => {}); });
}
