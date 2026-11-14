/* 어디서 열렸는지에 따라 데이터 받는 길을 고른다.
 * - "server": 이 PC의 crypto_live/server.py 로 열림 → 서버를 거침 (PIN 잠금, 코인원 비교, account.json 사용 가능)
 * - "static": 무료 정적 호스팅(GitHub Pages 등)으로 열림 → 업비트에 직접 연결, 코인원 비교 없음, 예시 모의 계좌
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
  upbit(pathAndQuery) {
    return this.mode === "server" ? `/api/upbit/${pathAndQuery}` : `https://api.upbit.com/v1/${pathAndQuery}`;
  },
  coinone(base) {
    return this.mode === "server" ? `/api/coinone/orderbook/${base}` : null; // 코인원은 브라우저 직접 요청을 막아 둠
  },
  account() {
    return this.mode === "server" ? "/api/account" : "mock_account.json";
  },
};

/* 인터넷 주소(https)로 열렸을 때만 홈 화면 앱 보조 파일 등록. 이 PC(localhost)·와이파이(http)에서는 안 함. */
if ("serviceWorker" in navigator && window.isSecureContext && !["localhost", "127.0.0.1"].includes(location.hostname)) {
  window.addEventListener("load", () => { navigator.serviceWorker.register("sw.js").catch(() => {}); });
}
