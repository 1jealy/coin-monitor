/* 코인 모니터 — 내 계좌 (지금은 모의 계좌).
 * 계좌 기록(입금·매수·매도)은 NET.account() (PC 서버면 /api/account, 정적 호스팅이면 mock_account.json), 가격은 업비트 실시간.
 * 보유량·평균 산 가격·손익은 기록을 처음부터 따라가며 계산한다(업비트와 같은 이동평균 방식).
 */
"use strict";

const KST = 9 * 3600;
const $ = (id) => document.getElementById(id);
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 저장 못 해도 동작 */ } },
};

const S = {
  acct: null, events: [], fee: 0.0005, market: "KRW-BTC",
  price: null, change: "EVEN",
  candles: [], // { t(UTC초), close }
  eqPoints: [], // { time(KST초), value }
  ws: null, retry: 0, lastMsg: 0, pingTimer: null,
  alerts: { above: null, below: null, loss: null },
  fired: { above: false, below: false, loss: false },
  soundOn: false, audio: null,
};

/* ── 숫자 ── */
const won = (v, sign = false) => (v == null || !isFinite(v) ? "—" :
  `${sign && v > 0 ? "+" : ""}${Math.round(v).toLocaleString("ko-KR")}원`);
const pct = (v, sign = true) => (v == null || !isFinite(v) ? "—" : `${sign && v > 0 ? "+" : ""}${v.toFixed(2)}%`);
const btc = (q) => (q == null ? "—" : `${q.toLocaleString("ko-KR", { minimumFractionDigits: 4, maximumFractionDigits: 8 })} BTC`);
const dirOf = (v) => (v > 0 ? "up" : v < 0 ? "down" : "flat");
const parseNum = (s) => { const n = parseFloat(String(s).replace(/[,\s원%]/g, "")); return isFinite(n) ? n : null; };
function kstLabel(utcSec, withDate = true) {
  const d = new Date((utcSec + KST) * 1000);
  const p = (n) => String(n).padStart(2, "0");
  const hm = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  return withDate ? `${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())} ${hm}` : hm;
}

/* ── 계좌 계산: 기록을 시간 순서대로 따라간다 ── */
function replay(untilSec = Infinity) {
  let cash = 0, qty = 0, avg = 0, principal = 0, realized = 0;
  for (const e of S.events) {
    if (e.t > untilSec) break;
    if (e.type === "deposit") { cash += e.krw; principal += e.krw; }
    else if (e.type === "withdraw") { cash -= e.krw; principal -= e.krw; }
    else if (e.type === "buy") {
      cash -= e.price * e.qty * (1 + S.fee);
      avg = (avg * qty + e.price * e.qty) / (qty + e.qty);
      qty += e.qty;
    } else if (e.type === "sell") {
      cash += e.price * e.qty * (1 - S.fee);
      realized += (e.price - avg) * e.qty - e.price * e.qty * S.fee;
      qty -= e.qty;
      if (qty < 1e-12) { qty = 0; avg = 0; }
    }
  }
  return { cash, qty, avg, principal, realized };
}

/* ── 화면 갱신 ── */
function setDir(el, v) { el.dataset.dir = dirOf(v); }

function render() {
  const a = replay();
  const px = S.price;
  const value = px == null ? null : a.qty * px;
  const total = value == null ? null : a.cash + value;
  const pnl = total == null ? null : total - a.principal;
  const pnlPct = pnl == null || !a.principal ? null : (pnl / a.principal) * 100;

  $("total").textContent = won(total);
  const p = $("pnl");
  setDir(p, pnl);
  p.querySelector("use").setAttribute("href", pnl > 0 ? "#i-up" : pnl < 0 ? "#i-down" : "#i-flat");
  p.querySelector("span").textContent = pnl == null ? "—" : `${won(pnl, true)} (${pct(pnlPct)}) 넣은 돈 대비`;
  $("principal").textContent = won(a.principal);
  $("cash").textContent = won(a.cash);
  $("realized").textContent = won(a.realized, true);
  setDir($("realized"), a.realized);

  $("qty").textContent = btc(a.qty);
  $("avg").textContent = a.qty ? won(a.avg) : "—";
  $("now").textContent = won(px);
  $("now").dataset.dir = S.change === "RISE" ? "up" : S.change === "FALL" ? "down" : "flat";
  $("value").textContent = value == null ? "—" : won(value * (1 - S.fee));
  const upnl = px == null || !a.qty ? null : (px - a.avg) * a.qty;
  const upnlPct = upnl == null ? null : ((px - a.avg) / a.avg) * 100;
  $("upnl").textContent = upnl == null ? "—" : `${won(upnl, true)} (${pct(upnlPct)})`;
  setDir($("upnl"), upnl);

  // 24시간 전 계좌 가치와 비교
  const dayAgo = Date.now() / 1000 - 86400;
  const past = [...S.candles].reverse().find((c) => c.t <= dayAgo);
  if (past && total != null) {
    const b = replay(past.t + 3600);
    const then = b.cash + b.qty * past.close;
    const d = total - then;
    $("day-change").textContent = `${won(d, true)} (${pct((d / then) * 100)})`;
    setDir($("day-change"), d);
  }

  if (total != null) document.title = `${won(total)} · 코인 모니터`;
  checkAlerts(px, pnlPct);
}

/* ── 계좌 가치 그래프 ── */
let chart, eqSeries, baseLine;
function chartTheme() {
  return { bg: css("--surface"), ink: css("--ink-2"), grid: css("--hair"), axis: css("--axis"), eq: css("--eq"), base: css("--ink-3") };
}
function buildChart() {
  const c = chartTheme();
  chart = LightweightCharts.createChart($("eq-chart"), {
    autoSize: true,
    layout: { background: { color: c.bg }, textColor: c.ink, fontFamily: css("--font"), fontSize: 12 },
    grid: { vertLines: { visible: false }, horzLines: { color: c.grid } },
    rightPriceScale: { borderColor: c.axis, scaleMargins: { top: 0.15, bottom: 0.1 } },
    timeScale: { borderColor: c.axis, timeVisible: true, secondsVisible: false },
    crosshair: { mode: LightweightCharts.CrosshairMode.Magnet },
    localization: { locale: "ko-KR", priceFormatter: (v) => Math.round(v).toLocaleString("ko-KR"),
      timeFormatter: (t) => kstLabel(t - KST) },
    handleScroll: { vertTouchDrag: false }, // 폰에서 세로로 밀면 페이지가 내려가게
  });
  eqSeries = chart.addAreaSeries({
    lineColor: c.eq, lineWidth: 2, topColor: `${c.eq}33`, bottomColor: `${c.eq}05`,
    priceLineVisible: false, lastValueVisible: true,
  });
  chart.subscribeCrosshairMove((prm) => eqLegend(prm && prm.time != null ? prm.time : null));
}
function themeChart() {
  if (!chart) return;
  const c = chartTheme();
  chart.applyOptions({ layout: { background: { color: c.bg }, textColor: c.ink },
    grid: { horzLines: { color: c.grid } }, rightPriceScale: { borderColor: c.axis }, timeScale: { borderColor: c.axis } });
  eqSeries.applyOptions({ lineColor: c.eq, topColor: `${c.eq}33`, bottomColor: `${c.eq}05` });
  if (baseLine) baseLine.applyOptions({ color: c.base });
}

function buildEquity() {
  const first = S.events.length ? S.events[0].t : 0;
  S.eqPoints = S.candles
    .filter((c) => c.t + 3600 > first)
    .map((c) => { const a = replay(c.t + 3600); return { time: c.t + KST, value: a.cash + a.qty * c.close }; });
  eqSeries.setData(S.eqPoints);
  const a = replay();
  if (baseLine) eqSeries.removePriceLine(baseLine);
  baseLine = eqSeries.createPriceLine({ price: a.principal, color: chartTheme().base, lineWidth: 1,
    lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: "넣은 돈" });
  chart.timeScale().fitContent();
  eqLegend(null);
  eqTable();
}

function liveEquityPoint() {
  if (S.price == null || !S.eqPoints.length) return;
  const now = Math.floor(Date.now() / 1000);
  const t = now - (now % 3600) + KST;
  const a = replay();
  const pt = { time: t, value: a.cash + a.qty * S.price };
  const last = S.eqPoints[S.eqPoints.length - 1];
  if (last.time === t) S.eqPoints[S.eqPoints.length - 1] = pt;
  else if (t > last.time) S.eqPoints.push(pt);
  else return;
  eqSeries.update(pt);
}

let eqHover = null;
function eqLegend(time) {
  eqHover = time;
  const pts = S.eqPoints;
  const pt = time == null ? pts[pts.length - 1] : pts.find((p) => p.time === time);
  const box = $("eq-legend");
  box.replaceChildren();
  if (!pt) return;
  const base = replay().principal;
  const t = document.createElement("span"); t.textContent = kstLabel(pt.time - KST);
  const v = document.createElement("b"); v.textContent = won(pt.value);
  const d = document.createElement("span"); d.className = "delta"; d.dataset.dir = dirOf(pt.value - base);
  d.textContent = `${won(pt.value - base, true)} (${pct(((pt.value - base) / base) * 100)})`;
  box.append(t, v, d);
}
function eqTable() {
  const base = replay().principal;
  const rows = [...S.eqPoints].reverse().slice(0, 48).map((p) => {
    const tr = document.createElement("tr");
    [kstLabel(p.time - KST), won(p.value), `${won(p.value - base, true)} (${pct(((p.value - base) / base) * 100)})`]
      .forEach((s) => { const td = document.createElement("td"); td.textContent = s; tr.append(td); });
    return tr;
  });
  $("eq-rows").replaceChildren(...rows);
}

/* ── 거래 내역 ── */
function renderFills() {
  const list = $("fills");
  const names = { deposit: "입금", withdraw: "출금", buy: "매수", sell: "매도" };
  const items = [...S.events].reverse().map((e) => {
    const li = document.createElement("li");
    li.className = `fill ${e.type}`;
    const top = document.createElement("div");
    const kind = document.createElement("span"); kind.className = "kind"; kind.textContent = names[e.type] || e.type;
    const when = document.createElement("span"); when.className = "when"; when.textContent = kstLabel(e.t);
    top.append(kind, when);
    const body = document.createElement("div"); body.className = "detail";
    if (e.type === "deposit" || e.type === "withdraw") body.textContent = won(e.krw);
    else body.textContent = `${btc(e.qty)} · ${won(e.price)} · 금액 ${won(e.price * e.qty)}`;
    li.append(top, body);
    return li;
  });
  list.replaceChildren(...(items.length ? items : [Object.assign(document.createElement("li"), { className: "empty", textContent: "거래 기록이 없습니다." })]));
}

/* ── 알림 ── */
function loadAlerts() {
  for (const k of ["above", "below", "loss"]) {
    const v = parseNum(store.get(`al-${k}`, ""));
    S.alerts[k] = v;
    $(`al-${k}`).value = v == null ? "" : k === "loss" ? String(v) : Math.round(v).toLocaleString("ko-KR");
  }
  describeAlerts();
}
function describeAlerts() {
  const a = S.alerts, parts = [];
  if (a.above != null) parts.push(`${won(a.above)} 이상`);
  if (a.below != null) parts.push(`${won(a.below)} 이하`);
  if (a.loss != null) parts.push(`총 손익 ${a.loss}% 이하`);
  $("al-state").textContent = parts.length
    ? `켜진 알림: ${parts.join(" · ")}${S.soundOn ? " · 소리·진동 켜짐" : ""}`
    : "켜진 알림이 없습니다. 값을 넣고 저장하세요.";
}
function fire(text) {
  $("alert-text").textContent = text;
  $("alert-banner").hidden = false;
  if (S.soundOn) {
    if (navigator.vibrate) navigator.vibrate([200, 120, 200]);
    try {
      const ctx = S.audio, o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 880; g.gain.value = 0.08;
      o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.25);
    } catch { /* 소리를 못 내도 화면 알림은 보임 */ }
  }
  if (window.isSecureContext && "Notification" in window && Notification.permission === "granted") {
    try { new Notification("코인 모니터", { body: text, icon: "icons/icon-192.png" }); } catch { /* 무시 */ }
  }
}
function checkAlerts(px, pnlPct) {
  if (px == null) return;
  const a = S.alerts, f = S.fired;
  const test = (key, cond, text) => {
    if (cond && !f[key]) { f[key] = true; fire(text); }
    else if (!cond) f[key] = false; // 조건에서 벗어나면 다시 알릴 준비
  };
  if (a.above != null) test("above", px >= a.above, `가격이 ${won(a.above)} 이상이 됐습니다 (지금 ${won(px)}).`);
  if (a.below != null) test("below", px <= a.below, `가격이 ${won(a.below)} 이하로 내려갔습니다 (지금 ${won(px)}).`);
  if (a.loss != null && pnlPct != null) test("loss", pnlPct <= a.loss, `총 손익이 ${a.loss}% 이하입니다 (지금 ${pct(pnlPct)}).`);
}

/* ── 실험 #5 시간대 (한국 06~08시) ── */
function renderWindow5() {
  const now = new Date(Date.now() + KST * 1000); // KST 를 UTC 함수로 읽기
  const h = now.getUTCHours(), m = now.getUTCMinutes();
  const mins = h * 60 + m;
  const el = $("w5-state");
  const fmt = (x) => (x >= 60 ? `${Math.floor(x / 60)}시간 ${x % 60}분` : `${x}분`);
  if (mins >= 360 && mins < 480) {
    el.dataset.on = "true";
    el.textContent = `지금 시간대 안입니다 · ${fmt(480 - mins)} 뒤 끝남`;
  } else {
    el.dataset.on = "false";
    const until = mins < 360 ? 360 - mins : 1440 - mins + 360;
    el.textContent = `시간대 밖 · 다음 시작까지 ${fmt(until)}`;
  }
}

/* ── 실시간 ── */
function setStatus(kind, text) { $("status").dataset.state = kind; $("status-text").textContent = text; }
function connect() {
  clearInterval(S.pingTimer);
  if (S.ws) { S.ws.onclose = null; S.ws.close(); }
  setStatus("connecting", "연결 중");
  const ws = new WebSocket(NET.wsUrl());
  ws.binaryType = "arraybuffer";
  S.ws = ws;
  const dec = new TextDecoder();
  ws.onopen = () => {
    S.retry = 0;
    ws.send(JSON.stringify([{ ticket: `monitor-${Math.random().toString(36).slice(2)}` }, { type: "ticker", codes: [S.market] }]));
    S.pingTimer = setInterval(() => { if (ws.readyState === 1) ws.send("PING"); }, 60000);
  };
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(typeof ev.data === "string" ? ev.data : dec.decode(ev.data)); } catch { return; }
    if (!m || m.type !== "ticker" || m.code !== S.market) return;
    S.lastMsg = Date.now();
    S.price = m.trade_price;
    S.change = m.change;
    render();
    liveEquityPoint();
    if (eqHover == null) eqLegend(null);
  };
  ws.onclose = () => {
    clearInterval(S.pingTimer);
    let left = Math.min(15, 2 ** S.retry++);
    setStatus("error", `연결 끊김 · ${left}초 뒤 다시 연결`);
    const tick = () => {
      left -= 1;
      if (left <= 0) return connect();
      setStatus("error", `연결 끊김 · ${left}초 뒤 다시 연결`);
      setTimeout(tick, 1000);
    };
    setTimeout(tick, 1000);
  };
}
setInterval(() => {
  renderWindow5();
  if (!S.ws || S.ws.readyState !== 1 || !S.lastMsg) return;
  const s = (Date.now() - S.lastMsg) / 1000;
  setStatus(s < 30 ? "live" : "connecting", `실시간 · ${s < 1 ? "방금" : `${Math.floor(s)}초 전`} 갱신`);
}, 1000);

/* 폰에서 다른 앱 갔다 돌아오면 연결이 끊겨 있을 수 있음 → 바로 다시 연결 */
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && (!S.ws || S.ws.readyState > 1)) connect();
});

/* ── 시작 ── */
async function getJSON(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (r.status === 401 && NET.mode === "server") { location.href = `/login.html?next=${encodeURIComponent(location.pathname)}`; throw new Error("PIN 필요"); }
  const b = await r.json().catch(() => null);
  if (!r.ok) throw new Error((b && (b.error?.message || b.error)) || `HTTP ${r.status}`);
  return b;
}

function setTheme(t) {
  document.documentElement.dataset.theme = t;
  store.set("theme", t);
  $("theme").querySelector("use").setAttribute("href", t === "dark" ? "#i-sun" : "#i-moon");
  themeChart();
}

window.addEventListener("DOMContentLoaded", async () => {
  const theme = store.get("theme", null) || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.dataset.theme = theme;
  $("theme").querySelector("use").setAttribute("href", theme === "dark" ? "#i-sun" : "#i-moon");
  $("theme").addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
  $("alert-close").addEventListener("click", () => { $("alert-banner").hidden = true; });
  $("alert-form").addEventListener("submit", (e) => {
    e.preventDefault();
    for (const k of ["above", "below", "loss"]) store.set(`al-${k}`, $(`al-${k}`).value.trim());
    S.fired = { above: false, below: false, loss: false };
    loadAlerts();
    render();
  });
  $("al-sound").addEventListener("click", async () => {
    try { S.audio = S.audio || new (window.AudioContext || window.webkitAudioContext)(); await S.audio.resume(); } catch { /* 무시 */ }
    S.soundOn = true;
    if (window.isSecureContext && "Notification" in window && Notification.permission === "default") {
      try { await Notification.requestPermission(); } catch { /* 무시 */ }
    }
    $("al-sound").textContent = "소리·진동 켜짐";
    $("al-sound").disabled = true;
    describeAlerts();
  });
  loadAlerts();
  renderWindow5();
  buildChart();

  try {
    await NET.detect();
    NET.label();
    S.acct = await getJSON(NET.account());
  } catch (e) {
    $("total").textContent = "계좌를 불러오지 못했습니다";
    $("pnl").querySelector("span").textContent = e.message;
    return;
  }
  S.fee = S.acct.fee_rate ?? 0.0005;
  S.market = S.acct.market || "KRW-BTC";
  $("hold-logo").replaceChildren(COIN_LOGO.el(S.market.slice(4), 26));
  if (S.market !== "KRW-BTC") $("hold-name").textContent = S.market.slice(4);
  $("mock-note").hidden = !S.acct.mock;
  S.events = (S.acct.events || [])
    .map((e) => ({ ...e, t: Math.floor(Date.parse(e.time) / 1000) }))
    .filter((e) => isFinite(e.t))
    .sort((a, b) => a.t - b.t);
  renderFills();
  render();
  connect();

  try {
    const rows = await getJSON(NET.upbit(`candles/minutes/60?market=${S.market}&count=200`));
    S.candles = rows.map((r) => ({ t: Math.floor(Date.parse(`${r.candle_date_time_utc}Z`) / 1000), close: r.trade_price }))
      .sort((a, b) => a.t - b.t);
    buildEquity();
    render();
  } catch (e) {
    $("eq-legend").textContent = `그래프용 가격을 받지 못했습니다 (${e.message}).`;
  }
});
