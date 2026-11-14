/* 코인 시세 분석 — 화면 동작.
 * - 과거 캔들: 업비트 REST (PC 서버로 열면 서버를 거치고, 정적 호스팅이면 직접 — net.js)
 * - 실시간 체결·호가·시세: 브라우저가 업비트 웹소켓에 직접 연결
 * - 코인원 호가: PC 서버로 열었을 때만 3초마다 (코인원은 브라우저 직접 요청을 막아 둠)
 * 차트 시각은 한국 시간으로 보이도록 UTC+9 만큼 밀어서 넣는다.
 */
"use strict";

const KST = 9 * 3600;
const IV_SECONDS = { "1": 60, "5": 300, "15": 900, "60": 3600, D: 86400 };
const HISTORY_PAGES = 2; // 200개씩 2번 → 400개
const BAND_HOURS = [6, 8]; // 실험 #5: 한국 시간 06~08시
const TRADES_MAX = 40;

const $ = (id) => document.getElementById(id);
const state = {
  market: null,
  iv: "1",
  markets: [],
  candles: [], // { time(KST초), open, high, low, close, volume }
  ws: null,
  wsRetry: 0,
  wsTimer: null,
  pingTimer: null,
  lastMsg: 0,
  upSpread: null,
  coSpread: null,
  coTimer: null,
  bookFrame: 0,
  pendingBook: null,
  loadId: 0,
};

/* ── 저장된 설정 (브라우저마다, 없어도 동작) ── */
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 저장 못 해도 괜찮음 */ } },
};

/* ── 숫자 표시 ── */
function decimalsFor(p) {
  p = Math.abs(p);
  if (p === 0 || p >= 1000) return 0;
  if (p >= 100) return 1;
  if (p >= 1) return 2;
  if (p >= 0.01) return 4;
  return 8;
}
const fmtPrice = (p) => (p == null || !isFinite(p) ? "—" :
  p.toLocaleString("ko-KR", { minimumFractionDigits: decimalsFor(p), maximumFractionDigits: decimalsFor(p) }));
const fmtQty = (q) => (q == null ? "—" : q.toLocaleString("ko-KR", { maximumFractionDigits: q >= 100 ? 0 : 4 }));
const fmtPct = (x, d = 3) => (x == null || !isFinite(x) ? "—" : `${x.toFixed(d)}%`);
function fmtKrwBig(v) {
  if (v == null) return "—";
  if (v >= 1e12) return `${(v / 1e12).toFixed(2)}조 원`;
  if (v >= 1e8) return `${Math.round(v / 1e8).toLocaleString("ko-KR")}억 원`;
  return `${Math.round(v).toLocaleString("ko-KR")}원`;
}
function fmtTime(sec, withDate) {
  const d = new Date(sec * 1000); // 이미 KST 로 밀어 둔 값 → UTC 함수로 읽는다
  const p = (n) => String(n).padStart(2, "0");
  const hm = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  if (state.iv === "D") return `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())}`;
  return withDate ? `${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())} ${hm}` : hm;
}

/* ── 색은 CSS 변수에서 읽는다 (밝은/어두운 화면 전환 시 다시 읽음) ── */
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/* ── 차트 ── */
let chart, candleSeries, volSeries, ma20Series, ma60Series, bandSeries;

function chartColors() {
  return {
    bg: css("--surface"), ink: css("--ink-2"), grid: css("--hair"), axis: css("--axis"),
    up: css("--up"), down: css("--down"), ma20: css("--ma20"), ma60: css("--ma60"), band: css("--band"),
    upSoft: css("--up-soft"), downSoft: css("--down-soft"),
  };
}

function buildChart() {
  const c = chartColors();
  chart = LightweightCharts.createChart($("chart"), {
    autoSize: true,
    layout: { background: { color: c.bg }, textColor: c.ink, fontFamily: css("--font"), fontSize: 12 },
    grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
    rightPriceScale: { borderColor: c.axis, scaleMargins: { top: 0.12, bottom: 0.24 } },
    timeScale: { borderColor: c.axis, timeVisible: true, secondsVisible: false, rightOffset: 6 },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    localization: { locale: "ko-KR", timeFormatter: (t) => fmtTime(t, true), priceFormatter: fmtPrice },
  });
  bandSeries = chart.addHistogramSeries({
    priceScaleId: "band", color: c.band, priceLineVisible: false, lastValueVisible: false,
  });
  chart.priceScale("band").applyOptions({ visible: false, scaleMargins: { top: 0, bottom: 0 } });
  volSeries = chart.addHistogramSeries({
    priceScaleId: "vol", priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false,
  });
  chart.priceScale("vol").applyOptions({ visible: false, scaleMargins: { top: 0.8, bottom: 0 } });
  candleSeries = chart.addCandlestickSeries({
    upColor: c.up, downColor: c.down, borderUpColor: c.up, borderDownColor: c.down,
    wickUpColor: c.up, wickDownColor: c.down, priceLineWidth: 1,
  });
  ma20Series = chart.addLineSeries({ color: c.ma20, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  ma60Series = chart.addLineSeries({ color: c.ma60, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  chart.subscribeCrosshairMove(renderLegend);
}

function applyChartTheme() {
  if (!chart) return;
  const c = chartColors();
  chart.applyOptions({
    layout: { background: { color: c.bg }, textColor: c.ink },
    grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
    rightPriceScale: { borderColor: c.axis }, timeScale: { borderColor: c.axis },
  });
  candleSeries.applyOptions({ upColor: c.up, downColor: c.down, borderUpColor: c.up, borderDownColor: c.down, wickUpColor: c.up, wickDownColor: c.down });
  ma20Series.applyOptions({ color: c.ma20 });
  ma60Series.applyOptions({ color: c.ma60 });
  bandSeries.applyOptions({ color: c.band });
  redrawAll();
}

const volBar = (k, c) => ({ time: k.time, value: k.volume, color: k.close >= k.open ? c.upSoft : c.downSoft });
const inBand = (t) => { const h = new Date(t * 1000).getUTCHours(); return h >= BAND_HOURS[0] && h < BAND_HOURS[1]; };
const bandOn = () => $("band").checked && state.iv !== "D";

function bandPoint(k) { return { time: k.time, value: bandOn() && inBand(k.time) ? 1 : 0 }; }

function maAt(arr, i, n) {
  if (i + 1 < n) return null;
  let s = 0;
  for (let j = i - n + 1; j <= i; j++) s += arr[j].close;
  return s / n;
}
function maSeries(n) {
  const out = [];
  state.candles.forEach((k, i) => { const v = maAt(state.candles, i, n); if (v != null) out.push({ time: k.time, value: v }); });
  return out;
}

function redrawAll() {
  const c = chartColors();
  candleSeries.setData(state.candles);
  volSeries.setData(state.candles.map((k) => volBar(k, c)));
  bandSeries.setData(state.candles.map(bandPoint));
  ma20Series.setData(maSeries(20));
  ma60Series.setData(maSeries(60));
  renderLegend();
  renderTable();
}

function updateLast() {
  const c = chartColors();
  const i = state.candles.length - 1;
  const k = state.candles[i];
  candleSeries.update(k);
  volSeries.update(volBar(k, c));
  bandSeries.update(bandPoint(k));
  const m20 = maAt(state.candles, i, 20), m60 = maAt(state.candles, i, 60);
  if (m20 != null) ma20Series.update({ time: k.time, value: m20 });
  if (m60 != null) ma60Series.update({ time: k.time, value: m60 });
}

/* 범례: 마우스가 올라간 캔들, 없으면 마지막 캔들 */
let legendTime = null;
function renderLegend(param) {
  if (param !== undefined) legendTime = param && param.time != null ? param.time : null;
  const idx = legendTime == null ? state.candles.length - 1 : state.candles.findIndex((k) => k.time === legendTime);
  const k = state.candles[idx];
  const box = $("legend");
  box.replaceChildren();
  if (!k) return;
  const add = (label, value, cls) => {
    const s = document.createElement("span");
    if (cls) s.className = cls;
    s.append(document.createTextNode(`${label} `));
    const b = document.createElement("b");
    b.textContent = value;
    s.append(b);
    box.append(s);
  };
  add("", fmtTime(k.time, true));
  add("시", fmtPrice(k.open)); add("고", fmtPrice(k.high)); add("저", fmtPrice(k.low)); add("종", fmtPrice(k.close));
  add("거래량", fmtQty(k.volume));
  [[20, "--ma20"], [60, "--ma60"]].forEach(([n, v]) => {
    const m = maAt(state.candles, idx, n);
    const s = document.createElement("span");
    s.className = "ma";
    const i = document.createElement("i");
    i.style.background = css(v);
    const b = document.createElement("b");
    b.textContent = m == null ? "—" : fmtPrice(m);
    s.append(i, document.createTextNode(`${n}평균 `), b);
    box.append(s);
  });
}

function renderTable() {
  const body = $("candle-rows");
  const rows = state.candles.slice(-30).reverse().map((k) => {
    const tr = document.createElement("tr");
    [fmtTime(k.time, true), fmtPrice(k.open), fmtPrice(k.high), fmtPrice(k.low), fmtPrice(k.close), fmtQty(k.volume)]
      .forEach((v) => { const td = document.createElement("td"); td.textContent = v; tr.append(td); });
    return tr;
  });
  body.replaceChildren(...rows);
}

/* ── 데이터 받기 ── */
async function api(path) {
  const res = await fetch(path, { cache: "no-store" });
  let body = null;
  try { body = await res.json(); } catch { /* 본문이 JSON 이 아님 */ }
  if (!res.ok) throw new Error((body && (body.error?.message || body.error)) || `HTTP ${res.status}`);
  return body;
}

const utcSec = (s) => Math.floor(Date.parse(`${s}Z`) / 1000);
function toCandle(r) {
  return {
    time: utcSec(r.candle_date_time_utc) + KST,
    open: r.opening_price, high: r.high_price, low: r.low_price, close: r.trade_price,
    volume: r.candle_acc_trade_volume,
  };
}

async function loadHistory() {
  const id = ++state.loadId;
  const box = $("chart-box");
  box.dataset.loading = "true";
  box.dataset.error = "false";
  $("chart-msg").textContent = "차트 불러오는 중…";
  const path = state.iv === "D" ? "candles/days" : `candles/minutes/${state.iv}`;
  try {
    let rows = [];
    let to = "";
    for (let p = 0; p < HISTORY_PAGES; p++) {
      const q = new URLSearchParams({ market: state.market, count: "200" });
      if (to) q.set("to", to);
      const page = await api(NET.upbit(`${path}?${q}`));
      if (!Array.isArray(page) || page.length === 0) break;
      rows = rows.concat(page);
      to = `${page[page.length - 1].candle_date_time_utc}Z`;
      if (page.length < 200) break;
    }
    if (id !== state.loadId) return; // 그사이 코인/간격이 바뀜
    const seen = new Set();
    state.candles = rows.map(toCandle).filter((k) => !seen.has(k.time) && seen.add(k.time)).sort((a, b) => a.time - b.time);
    redrawAll();
    chart.timeScale().fitContent();
    if (state.iv !== "D") chart.timeScale().setVisibleLogicalRange({ from: state.candles.length - 140, to: state.candles.length + 6 });
    box.dataset.loading = "false";
  } catch (e) {
    if (id !== state.loadId) return;
    box.dataset.loading = "false";
    box.dataset.error = "true";
    $("chart-msg").textContent = `차트를 불러오지 못했습니다 (${e.message}). 잠시 뒤 코인을 다시 골라 보세요.`;
  }
}

async function loadMarkets() {
  const all = await api(NET.upbit("market/all?isDetails=false"));
  const krw = all.filter((m) => m.market.startsWith("KRW-"));
  let ranked = krw;
  try {
    // 한 번에 다 넣으면 주소가 너무 길어 거절됨(414) → 100개씩 나눠 요청
    const groups = [];
    for (let i = 0; i < krw.length; i += 100) groups.push(krw.slice(i, i + 100));
    const tick = (await Promise.all(groups.map((g) =>
      api(NET.upbit(`ticker?markets=${g.map((m) => m.market).join(",")}`))))).flat();
    const value = new Map(tick.map((t) => [t.market, t.acc_trade_price_24h]));
    ranked = [...krw].sort((a, b) => (value.get(b.market) || 0) - (value.get(a.market) || 0));
  } catch { /* 순위 없이 이름 순 */ }
  state.markets = ranked;
  const sel = $("market");
  sel.replaceChildren(...ranked.map((m) => {
    const o = document.createElement("option");
    o.value = m.market;
    o.textContent = `${m.korean_name} (${m.market.slice(4)})`;
    return o;
  }));
}

/* ── 실시간 (업비트 웹소켓) ── */
function setStatus(kind, text) {
  $("status").dataset.state = kind;
  $("status-text").textContent = text;
}

function connect() {
  clearTimeout(state.wsTimer);
  clearInterval(state.pingTimer);
  if (state.ws) { state.ws.onclose = null; state.ws.close(); }
  setStatus("connecting", "연결 중");
  const ws = new WebSocket(NET.wsUrl());
  ws.binaryType = "arraybuffer";
  state.ws = ws;
  const decoder = new TextDecoder();
  ws.onopen = () => {
    state.wsRetry = 0;
    ws.send(JSON.stringify([
      { ticket: `crypto-live-${Math.random().toString(36).slice(2)}` },
      { type: "ticker", codes: [state.market] },
      { type: "trade", codes: [state.market] },
      { type: "orderbook", codes: [state.market] },
    ]));
    state.pingTimer = setInterval(() => { if (ws.readyState === 1) ws.send("PING"); }, 60000);
  };
  ws.onmessage = (ev) => {
    const text = typeof ev.data === "string" ? ev.data : decoder.decode(ev.data);
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || msg.code !== state.market) return;
    state.lastMsg = Date.now();
    if (msg.type === "trade") onTrade(msg);
    else if (msg.type === "ticker") onTicker(msg);
    else if (msg.type === "orderbook") { state.pendingBook = msg; scheduleBook(); }
  };
  ws.onclose = () => {
    clearInterval(state.pingTimer);
    const wait = Math.min(15, 2 ** state.wsRetry++);
    let left = wait;
    setStatus("error", `연결 끊김 · ${left}초 뒤 다시 연결`);
    const tick = () => {
      left -= 1;
      if (left <= 0) return connect();
      setStatus("error", `연결 끊김 · ${left}초 뒤 다시 연결`);
      state.wsTimer = setTimeout(tick, 1000);
    };
    state.wsTimer = setTimeout(tick, 1000);
  };
  ws.onerror = () => { /* onclose 가 이어서 처리 */ };
}

function onTrade(m) {
  const iv = IV_SECONDS[state.iv];
  const utc = Math.floor(m.trade_timestamp / 1000);
  const t = utc - (utc % iv) + KST;
  const last = state.candles[state.candles.length - 1];
  const px = m.trade_price, q = m.trade_volume;
  if (last && t === last.time) {
    last.high = Math.max(last.high, px);
    last.low = Math.min(last.low, px);
    last.close = px;
    last.volume += q;
  } else if (!last || t > last.time) {
    state.candles.push({ time: t, open: px, high: px, low: px, close: px, volume: q });
    if (state.candles.length > 1500) state.candles.shift();
  } else {
    return; // 이미 지난 캔들에 늦게 도착한 체결은 무시
  }
  updateLast();
  if (legendTime == null) renderLegend();
  addTrade(m);
}

function onTicker(m) {
  const dir = m.change === "RISE" ? "up" : m.change === "FALL" ? "down" : "flat";
  $("price").textContent = fmtPrice(m.trade_price);
  $("price").dataset.dir = dir;
  const ch = $("change");
  ch.dataset.dir = dir;
  ch.querySelector("use").setAttribute("href", dir === "up" ? "#i-up" : dir === "down" ? "#i-down" : "#i-flat");
  const sign = m.signed_change_rate > 0 ? "+" : "";
  ch.querySelector("span").textContent =
    `${sign}${(m.signed_change_rate * 100).toFixed(2)}%  ${sign}${fmtPrice(m.signed_change_price)}`;
  $("hi").textContent = fmtPrice(m.high_price);
  $("lo").textContent = fmtPrice(m.low_price);
  $("vol24").textContent = fmtKrwBig(m.acc_trade_price_24h);
  document.title = `${fmtPrice(m.trade_price)} · ${m.code.slice(4)} · 코인 모니터`;
}

function addTrade(m) {
  const list = $("trades");
  const empty = list.querySelector(".empty");
  if (empty) empty.remove();
  const li = document.createElement("li");
  li.className = `${m.ask_bid === "BID" ? "buy" : "sell"} new`;
  const d = new Date(m.trade_timestamp + KST * 1000);
  const p = (n) => String(n).padStart(2, "0");
  const t = document.createElement("span"); t.className = "t";
  t.textContent = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  const pr = document.createElement("span"); pr.className = "p"; pr.textContent = fmtPrice(m.trade_price);
  const q = document.createElement("span"); q.className = "q";
  q.textContent = `${fmtQty(m.trade_volume)} ${m.ask_bid === "BID" ? "매수" : "매도"}`;
  li.append(t, pr, q);
  list.prepend(li);
  while (list.children.length > TRADES_MAX) list.lastChild.remove();
}

function scheduleBook() {
  if (state.bookFrame) return;
  state.bookFrame = requestAnimationFrame(() => { state.bookFrame = 0; renderBook(state.pendingBook); });
}

function renderBook(m) {
  const units = (m.orderbook_units || []).slice(0, 10);
  if (!units.length) return;
  const maxSize = Math.max(...units.flatMap((u) => [u.ask_size, u.bid_size]));
  const row = (cls, px, sz) => {
    const r = document.createElement("div");
    r.className = `row ${cls}`;
    const fill = document.createElement("i");
    fill.className = "bar-fill";
    fill.style.width = `${Math.max(2, (sz / maxSize) * 100)}%`;
    const a = document.createElement("span"); a.className = "px"; a.textContent = fmtPrice(px);
    const b = document.createElement("span"); b.className = "sz"; b.textContent = fmtQty(sz);
    r.append(fill, a, b);
    return r;
  };
  const asks = [...units].reverse().map((u) => row("ask", u.ask_price, u.ask_size));
  const bids = units.map((u) => row("bid", u.bid_price, u.bid_size));
  const best = units[0];
  const spread = ((best.ask_price - best.bid_price) / ((best.ask_price + best.bid_price) / 2)) * 100;
  state.upSpread = spread;
  const mid = document.createElement("div");
  mid.className = "mid";
  const l = document.createElement("span"); l.textContent = "가격 차이";
  const v = document.createElement("b"); v.textContent = `${fmtPrice(best.ask_price - best.bid_price)}원 · ${fmtPct(spread)}`;
  mid.append(l, v);
  $("book").replaceChildren(...asks, mid, ...bids);
  renderCost();
}

/* ── 코인원 호가 (3초마다) ── */
async function pollCoinone() {
  clearTimeout(state.coTimer);
  const url = NET.coinone(state.market.slice(4));
  if (!url) { state.coSpread = "static"; renderCost(); return; }
  try {
    const b = await api(url);
    if (b.result !== "success" || !b.bids?.length || !b.asks?.length) throw new Error("no book");
    const bid = parseFloat(b.bids[0].price), ask = parseFloat(b.asks[0].price);
    state.coSpread = ((ask - bid) / ((ask + bid) / 2)) * 100;
  } catch {
    state.coSpread = undefined; // 코인원에 없는 코인이거나 연결 실패
  }
  renderCost();
  state.coTimer = setTimeout(pollCoinone, 3000);
}

function renderCost() {
  const UP_FEE = NET.mode === "server" ? 0.1 : null; // 업비트 0.05% × 2. 공개 주소(빗썸)는 수수료를 따로 확인해야 해서 비워 둠
  $("up-spread").textContent = fmtPct(state.upSpread);
  $("up-total").textContent = state.upSpread == null || UP_FEE == null ? "—" : fmtPct(state.upSpread + UP_FEE);
  if (state.coSpread === "static") {
    $("co-spread").textContent = "PC 서버에서만";
    $("co-total").textContent = "—";
  } else if (state.coSpread === undefined) {
    $("co-spread").textContent = "없음";
    $("co-total").textContent = "—";
  } else {
    $("co-spread").textContent = fmtPct(state.coSpread);
    $("co-total").textContent = fmtPct(state.coSpread);
  }
}

/* "몇 초 전 갱신" 표시 */
setInterval(() => {
  if (!state.ws || state.ws.readyState !== 1) return;
  if (!state.lastMsg) return setStatus("connecting", "실시간 연결됨 · 체결 기다리는 중");
  const s = (Date.now() - state.lastMsg) / 1000;
  setStatus(s < 30 ? "live" : "connecting", `실시간 · ${s < 1 ? "방금" : `${Math.floor(s)}초 전`} 갱신`);
}, 500);

/* ── 조작 ── */
function selectInterval(iv) {
  state.iv = iv;
  store.set("iv", iv);
  document.querySelectorAll("#intervals button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.iv === iv)));
  $("band").disabled = iv === "D";
  document.body.dataset.band = $("band").checked && iv !== "D" ? "on" : "off";
  legendTime = null;
  loadHistory();
}

function selectMarket(market) {
  state.market = market;
  store.set("market", market);
  const info = state.markets.find((m) => m.market === market);
  $("price-heading").textContent = info ? info.korean_name : market;
  $("coin-code").textContent = `${market.slice(4)} / 원화`;
  $("coin-logo").replaceChildren(COIN_LOGO.el(market.slice(4), 40));
  $("price").textContent = "—";
  $("trades").replaceChildren(Object.assign(document.createElement("li"), { className: "empty", textContent: "체결을 기다리는 중…" }));
  $("book").replaceChildren(Object.assign(document.createElement("p"), { className: "empty", textContent: "호가를 기다리는 중…" }));
  state.upSpread = null; state.coSpread = null; state.lastMsg = 0;
  renderCost();
  legendTime = null;
  loadHistory();
  connect();
  pollCoinone();
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  store.set("theme", theme);
  $("theme").querySelector("use").setAttribute("href", theme === "dark" ? "#i-sun" : "#i-moon");
  applyChartTheme();
}

/* 시작 */
window.addEventListener("DOMContentLoaded", async () => {
  const savedTheme = store.get("theme", null);
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = savedTheme || (prefersDark ? "dark" : "light");
  document.documentElement.dataset.theme = theme;
  $("theme").querySelector("use").setAttribute("href", theme === "dark" ? "#i-sun" : "#i-moon");

  buildChart();
  $("theme").addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
  document.querySelectorAll("#intervals button").forEach((b) => b.addEventListener("click", () => selectInterval(b.dataset.iv)));
  $("intervals").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const btns = [...document.querySelectorAll("#intervals button")];
    const i = btns.findIndex((b) => b.dataset.iv === state.iv);
    const next = btns[(i + (e.key === "ArrowRight" ? 1 : btns.length - 1)) % btns.length];
    next.focus();
    selectInterval(next.dataset.iv);
  });
  $("band").addEventListener("change", () => {
    document.body.dataset.band = $("band").checked && state.iv !== "D" ? "on" : "off";
    bandSeries.setData(state.candles.map(bandPoint));
  });
  $("market").addEventListener("change", (e) => selectMarket(e.target.value));

  state.iv = IV_SECONDS[store.get("iv", "1")] ? store.get("iv", "1") : "1";
  document.querySelectorAll("#intervals button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.iv === state.iv)));
  $("band").disabled = state.iv === "D";
  document.body.dataset.band = $("band").checked && state.iv !== "D" ? "on" : "off";

  await NET.detect();
  NET.label();
  if (NET.mode !== "server") $("up-fee").textContent = "확인 필요";
  try {
    await loadMarkets();
  } catch (e) {
    setStatus("error", "코인 목록을 못 받음");
    $("chart-box").dataset.loading = "false";
    $("chart-box").dataset.error = "true";
    $("chart-msg").textContent = `코인 목록을 받지 못했습니다 (${e.message}). 인터넷 연결을 확인하고 새로고침해 주세요.`;
    return;
  }
  const saved = store.get("market", "KRW-BTC");
  const market = state.markets.some((m) => m.market === saved) ? saved : "KRW-BTC";
  $("market").value = market;
  selectMarket(market);
});
