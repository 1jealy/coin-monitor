/* 모의 투자 화면 — 시작일 이후 실제 시세에 실험 #8 규칙(strategy.js)을 적용해 매번 다시 계산한다.
 * 저장하는 것이 없어서 어느 기기에서 열어도 같은 결과가 나온다(같은 거래소 시세 기준).
 */
"use strict";

const KST = 9 * 3600, BAR = 4 * 3600;
const $ = (id) => document.getElementById(id);
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 없어도 동작 */ } },
};
const won = (v, sign = false) => (v == null || !isFinite(v) ? "—" : `${sign && v > 0 ? "+" : ""}${Math.round(v).toLocaleString("ko-KR")}원`);
const pct = (v, d = 2, sign = true) => (v == null || !isFinite(v) ? "—" : `${sign && v > 0 ? "+" : ""}${(v * 100).toFixed(d)}%`);
const dirOf = (v) => (v > 0 ? "up" : v < 0 ? "down" : "flat");
function kst(sec, withYear = false) {
  const d = new Date((sec + KST) * 1000), p = (n) => String(n).padStart(2, "0");
  return `${withYear ? `${d.getUTCFullYear()}.` : ""}${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

const S = { cfg: null, start: 0, official: true, hours: new Map(), price: null, ws: null, retry: 0, lastMsg: 0, model: null, chart: null };

/* ── 데이터 ── */
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
async function getJSON(url, tries = 6) {
  for (let k = 0; ; k++) {
    const r = await fetch(url, { cache: "no-store" });
    if (r.status === 429 && k < tries) { await sleep(600 * 2 ** k); continue; } // 요청이 몰려 거절됨 → 잠깐 쉬고 다시
    if (r.status === 401 && NET.mode === "server") { location.href = `/login.html?next=${encodeURIComponent(location.pathname)}`; throw new Error("PIN 필요"); }
    const b = await r.json().catch(() => null);
    if (!r.ok) throw new Error((b && (b.error?.message || b.error)) || `HTTP ${r.status}`);
    return b;
  }
}
function addHours(rows) {
  for (const r of rows) {
    const t = Math.floor(Date.parse(`${r.candle_date_time_utc}Z`) / 1000);
    S.hours.set(t, { t, o: +r.opening_price, h: +r.high_price, l: +r.low_price, c: +r.trade_price });
  }
}
/** fromSec 까지 거슬러 올라가며 1시간 캔들을 모은다 */
async function loadHistory(fromSec, onProgress) {
  let to = 0, page = 0;
  const need = Math.ceil((Date.now() / 1000 - fromSec) / 3600 / 200) + 1;
  while (page < Math.min(need, 140)) {
    const rows = await getJSON(NET.hourCandles(S.cfg.market, to));
    if (!Array.isArray(rows) || !rows.length) break;
    addHours(rows);
    page += 1;
    onProgress?.(page, need);
    await sleep(NET.mode === "server" ? 150 : 50); // 거래소 요청 한도 여유
    const oldest = Math.floor(Date.parse(`${rows[rows.length - 1].candle_date_time_utc}Z`) / 1000);
    if (oldest <= fromSec || rows.length < 200) break;
    to = oldest;
  }
}
async function refreshLatest() {
  addHours(await getJSON(NET.hourCandles(S.cfg.market, 0)));
}

/* ── 계산 ── */
function compute() {
  const now = Date.now() / 1000;
  const hours = [...S.hours.values()].sort((a, b) => a.t - b.t);
  const all = STRAT.to4h(hours);
  const d = STRAT.indicators(all);
  const closedN = d.filter((b) => b.t + BAR <= now).length; // 마감된 캔들 수 (마지막 하나는 진행 중일 수 있음)
  const closed = d.slice(0, closedN);
  const startI = closed.findIndex((b) => b.t >= S.start);
  const ready = closed.findIndex((b) => !Number.isNaN(b.rank));
  const first = Math.max(startI < 0 ? closed.length : startI, ready < 0 ? closed.length : ready);
  const { pos, events, stops } = STRAT.positions(closed, first);
  const posAll = d.map((_, i) => (i < closedN ? pos[i] : false));
  const fpos = STRAT.filterPositions(closed, first).concat(d.slice(closedN).map(() => false));
  const cost = S.cfg.side_cost, cap = S.cfg.capital;
  const eq = STRAT.equity(d, posAll, cost, cap);
  const eqF = STRAT.equity(d, fpos, cost, cap);
  const startBar = d.findIndex((b) => b.t >= S.start);
  return { d, closed, closedN, first, pos, posAll, fpos, events, stops, eq, eqF, startBar, cost, cap };
}

/** 마지막 캔들 동안 들고 있는지 (그 직전 캔들 마감 때의 결정) */
function heldInLastBar(d, posAll) {
  const j = d.length - 1;
  return j > 0 && posAll[j - 1];
}
/** 지금 값: 마지막 캔들 시가의 값에서 그 시가의 매수·매도 비용을 반영하고, 들고 있으면 지금 가격까지의 변화를 곱한다 */
function valueNow(d, values, posAll, cost, livePrice) {
  const j = d.length - 1;
  const held = j > 0 && posAll[j - 1], before = j > 1 && posAll[j - 2];
  let v = values[j];
  if (held && !before) v /= 1 + cost;
  if (!held && before) v *= 1 - cost;
  if (held) v *= (livePrice ?? d[j].c) / d[j].o;
  return v;
}

/* ── 그리기 ── */
function render() {
  const m = S.model;
  if (!m) return;
  const now = Date.now() / 1000;
  const lastClosed = m.closed[m.closed.length - 1];
  const holdingNow = heldInLastBar(m.d, m.posAll);
  const value = valueNow(m.d, m.eq.value, m.posAll, m.cost, S.price);
  const pnl = value - m.cap;
  $("value").textContent = won(value);
  const p = $("value-pnl");
  p.dataset.dir = dirOf(pnl);
  p.querySelector("span").textContent = `${won(pnl, true)} (${pct(pnl / m.cap)}) 시작 ${won(m.cap)} 대비`;
  const days = Math.max(0, Math.floor((now - S.start) / 86400));
  $("dday").textContent = now >= S.start ? `D+${days}` : `시작 전`;

  const badge = $("state-badge");
  if (holdingNow) {
    const buyE = [...m.events].reverse().find((e) => e.type === "buy");
    const held = buyE ? (now - m.closed[buyE.i].t - BAR) / 86400 : 0;
    badge.dataset.state = "hold";
    badge.textContent = "들고 있어요";
    $("state-line").textContent = `${held >= 1 ? `${Math.floor(held)}일째` : "오늘 산"} 비트코인을 들고 있어요. 추적 손절선 아래로 마감하면 팝니다.`;
  } else {
    const ok = checkStates(lastClosed);
    badge.dataset.state = "wait";
    badge.textContent = "쉬는 중";
    $("state-line").textContent = ok.count === 3 ? "조건이 다 맞았어요. 다음 캔들 시작에 삽니다."
      : `현금으로 기다리는 중이에요. 사는 조건 3개 중 ${ok.count}개가 맞아요.`;
  }

  renderRace(m, value, now);
  renderChecks(m, lastClosed, holdingNow);
  renderHolding(m, holdingNow);
  renderTimeline(m);
  renderExpect(m, value, now);
  document.title = `${won(value)} · 모의 투자`;
}

function checkStates(b) {
  if (!b) return { count: 0 };
  const trend = b.c > b.sma, squeeze = b.recent, brk = b.c > b.dc;
  return { trend, squeeze, brk, count: [trend, squeeze, brk].filter(Boolean).length };
}

function renderRace(m, value, now) {
  const list = $("race");
  if (m.startBar < 0 || now < S.start) {
    list.replaceChildren(Object.assign(document.createElement("li"), { className: "empty", textContent: "시작하면 여기서 대결이 시작돼요." }));
    return;
  }
  const px = S.price ?? m.d[m.d.length - 1].c;
  const hold = m.cap * (px / m.d[m.startBar].o) / (1 + m.cost);
  const filt = valueNow(m.d, m.eqF.value, m.fpos, m.cost, S.price);
  const rows = [
    { name: "모의 투자 (실험 #8)", v: value, me: true },
    { name: "비트코인 그냥 보유", v: hold },
    { name: "60일선 위에서만 보유", v: filt },
  ].filter((r) => r.v != null).sort((a, b) => b.v - a.v);
  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.v / m.cap - 1)), 0.005);
  list.replaceChildren(...rows.map((r, i) => {
    const li = document.createElement("li");
    li.className = `race-row${r.me ? " me" : ""}`;
    const rank = document.createElement("span"); rank.className = "rank"; rank.textContent = `${i + 1}`;
    const name = document.createElement("span"); name.className = "name"; name.textContent = r.name;
    const ret = r.v / m.cap - 1;
    const val = document.createElement("span"); val.className = "ret"; val.dataset.dir = dirOf(ret); val.textContent = pct(ret);
    const bar = document.createElement("span"); bar.className = "race-bar";
    const fill = document.createElement("i"); fill.dataset.dir = dirOf(ret);
    fill.style.width = `${Math.max(2, (Math.abs(ret) / maxAbs) * 100)}%`;
    bar.append(fill);
    li.append(rank, name, val, bar);
    return li;
  }));
}

function checkItem(ok, title, detail, meter) {
  const li = document.createElement("li");
  li.className = `check ${ok ? "ok" : "no"}`;
  const ic = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  ic.setAttribute("width", "22"); ic.setAttribute("height", "22"); ic.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", ok ? "#i-ok" : "#i-no");
  ic.append(use);
  const body = document.createElement("div");
  const t = document.createElement("p"); t.className = "check-title"; t.textContent = title;
  const s = document.createElement("p"); s.className = "check-detail"; s.textContent = detail;
  body.append(t, s);
  if (meter != null) {
    const mt = document.createElement("div"); mt.className = "meter small";
    const f = document.createElement("i"); f.style.width = `${Math.max(3, Math.min(100, meter * 100))}%`;
    mt.append(f); body.append(mt);
  }
  li.append(ic, body);
  return li;
}

function renderChecks(m, b, holdingNow) {
  if (!b) return;
  const c = checkStates(b);
  const px = S.price ?? b.c;
  const trendGap = b.c / b.sma - 1;
  const lastSq = [...m.closed].reverse().findIndex((x) => x.squeeze);
  const sqAgo = lastSq < 0 ? null : lastSq * 4;
  const toBreak = b.dc / px - 1;
  $("check-sub").textContent = holdingNow
    ? "지금은 들고 있어서 새로 사지 않아요. 참고로 마지막 캔들 기준 상태입니다."
    : `마지막으로 끝난 캔들(${kst(b.t + BAR)} 마감) 기준. 세 가지가 모두 맞으면 다음 캔들 시작에 삽니다.`;
  $("checks").replaceChildren(
    checkItem(c.trend, "상승 추세: 60일 평균 위",
      `종가 ${won(b.c)} · 60일 평균 ${won(b.sma)} (${pct(trendGap)})`, null),
    checkItem(c.squeeze, "힘 모으기: 최근 하루 안에 변동성 응축",
      `지금 변동 폭은 최근 6개월 중 하위 ${Math.round((b.rank || 0) * 100)}% · ${sqAgo === null ? "최근 응축 없음" : sqAgo === 0 ? "지금 응축 중" : `마지막 응축 ${sqAgo}시간 전`} (하위 20% 이하가 응축)`,
      Number.isNaN(b.rank) ? null : Math.max(0, 1 - b.rank)),
    checkItem(c.brk, "돌파: 최근 20개 캔들 최고가 위로 마감",
      c.brk ? `종가 ${won(b.c)} > 최고가 ${won(b.dc)}` : `최고가 ${won(b.dc)}까지 ${pct(toBreak)} 남음 (지금 ${won(px)})`,
      c.brk ? 1 : Math.max(0, 1 - toBreak / 0.05)),
  );
}

function renderHolding(m, holdingNow) {
  $("holding-card").hidden = !holdingNow;
  if (!holdingNow) return;
  const buyE = [...m.events].reverse().find((e) => e.type === "buy");
  const entryBar = m.d[buyE.i + 1];
  const buy = entryBar.o;
  const px = S.price ?? m.closed[m.closedN - 1].c;
  const stop = m.stops[m.closedN - 1];
  const lastB = m.closed[m.closedN - 1];
  const net = (px / buy) * (1 - m.cost) / (1 + m.cost) - 1;
  const rows = [
    ["산 시각", kst(entryBar.t)], ["산 가격", won(buy)], ["지금 가격", won(px)],
    ["지금 팔면 (비용 포함)", `${pct(net)}`], ["추적 손절선", won(stop)], ["60일 평균", won(lastB.sma)],
  ];
  $("holding").replaceChildren(...rows.flatMap(([k, v]) => {
    const div = document.createElement("div");
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = v;
    if (k.startsWith("지금 팔면")) dd.dataset.dir = dirOf(net);
    div.append(dt, dd);
    return [div];
  }));
  const dist = px / stop - 1;
  $("stop-dist").textContent = `${pct(dist)} 남음`;
  $("stop-meter").style.width = `${Math.max(3, Math.min(100, (dist / 0.15) * 100))}%`;
  $("stop-meter").dataset.danger = dist < 0.02 ? "true" : "false";
}

function renderTimeline(m) {
  const items = [];
  if (S.start <= Date.now() / 1000) items.push({ t: S.start, kind: "start", text: `모의 투자 시작 — ${won(m.cap)}` });
  let prevSq = false;
  for (let i = Math.max(m.first, 0); i < m.closed.length; i++) {
    const b = m.closed[i];
    if (b.squeeze && !prevSq) items.push({ t: b.t + BAR, kind: "squeeze", text: "변동 폭이 줄었어요(응축). 돌파를 기다려요." });
    prevSq = b.squeeze;
  }
  const trades = m.eq.trades;
  for (const e of m.events) {
    const execBar = m.d[e.i + 1];
    if (!execBar) continue;
    if (e.type === "buy") {
      items.push({ t: execBar.t, kind: "buy", text: `${e.why}! ${won(execBar.o)}에 샀어요.` });
    } else {
      const tr = trades.find((x) => x.exitI === e.i + 1);
      items.push({ t: execBar.t, kind: "sell", text: `${e.why} → ${won(execBar.o)}에 팔았어요${tr ? ` (${pct(tr.net)})` : ""}.`, dir: tr ? dirOf(tr.net) : "flat" });
    }
  }
  items.sort((a, b) => b.t - a.t);
  const list = $("timeline");
  if (!items.length) {
    list.replaceChildren(Object.assign(document.createElement("li"), { className: "empty", textContent: "아직 일어난 일이 없어요. 시작을 기다리는 중입니다." }));
    return;
  }
  list.replaceChildren(...items.slice(0, 60).map((it) => {
    const li = document.createElement("li");
    li.className = `tl ${it.kind}`;
    const when = document.createElement("span"); when.className = "when"; when.textContent = kst(it.t);
    const what = document.createElement("span"); what.className = "what"; what.textContent = it.text;
    if (it.dir) what.dataset.dir = it.dir;
    li.append(when, what);
    return li;
  }));
}

function renderExpect(m, value, now) {
  const ex = S.cfg.expect, tr = m.eq.trades;
  const yrs = Math.max(1 / 365, (now - S.start) / (365 * 86400));
  const vals = m.eq.value.slice(Math.max(0, m.startBar)).concat([value]);
  let peak = -Infinity, mdd = 0;
  for (const v of vals) { peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1); }
  const inv = m.pos.slice(m.first).filter(Boolean).length / Math.max(1, m.closed.length - m.first);
  const wins = tr.filter((t) => t.net > 0).length;
  const rows = [
    ["1년 거래 수", `${ex.trades_per_year.toFixed(0)}번`, tr.length ? `${tr.length}번 (1년 환산 ${(tr.length / yrs).toFixed(0)}번)` : "아직 없음"],
    ["이긴 비율", pct(ex.win_rate, 0, false), tr.length ? pct(wins / tr.length, 0, false) : "—"],
    ["거래당 평균", pct(ex.avg_trade), tr.length ? pct(tr.reduce((s, t) => s + t.net, 0) / tr.length) : "—"],
    ["가장 크게 떨어졌을 때", pct(ex.max_drawdown, 1), pct(mdd, 1)],
    ["돈이 들어가 있던 시간", pct(ex.invested, 0, false), pct(inv, 0, false)],
  ];
  $("expect").replaceChildren(...rows.map((r) => {
    const tr2 = document.createElement("tr");
    r.forEach((c, i) => { const el = document.createElement(i ? "td" : "th"); if (!i) el.scope = "row"; el.textContent = c; tr2.append(el); });
    return tr2;
  }));
  $("ex-note").textContent = tr.length < 10
    ? `거래가 ${tr.length}번뿐이라 아직 비교하기 일러요. 10번 이상 쌓이면 기대 범위 안인지 볼 만해집니다. 검증 기간 수익률은 연 ${pct(ex.cagr, 1)}였습니다.`
    : `가장 크게 떨어졌을 때가 검증 기간(${pct(ex.max_drawdown, 1)})보다 훨씬 나쁘면 규칙이 지금 시장에 안 맞는다는 신호일 수 있어요.`;
}

/* ── 차트 ── */
function buildChart() {
  S.chart = LightweightCharts.createChart($("p-chart"), {
    autoSize: true,
    layout: { background: { color: css("--surface") }, textColor: css("--ink-2"), fontFamily: css("--font"), fontSize: 12 },
    grid: { vertLines: { visible: false }, horzLines: { color: css("--hair") } },
    rightPriceScale: { borderColor: css("--axis") },
    timeScale: { borderColor: css("--axis"), timeVisible: true, secondsVisible: false },
    localization: { locale: "ko-KR", priceFormatter: (v) => Math.round(v).toLocaleString("ko-KR"), timeFormatter: (t) => kst(t - KST) },
    handleScroll: { vertTouchDrag: false },
  });
  S.series = {
    band: S.chart.addHistogramSeries({ priceScaleId: "band", priceLineVisible: false, lastValueVisible: false }),
    candles: S.chart.addCandlestickSeries({ priceLineWidth: 1 }),
    sma: S.chart.addLineSeries({ lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
    dc: S.chart.addLineSeries({ lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
  };
  S.stopSeries = []; // 거래마다 따로 그림 (거래 사이를 잇지 않도록)
  // 응축은 차트 아래쪽 얇은 띠로만 표시
  S.chart.priceScale("band").applyOptions({ visible: false, scaleMargins: { top: 0.955, bottom: 0 } });
  themeChart();
}
function themeChart() {
  if (!S.chart) return;
  S.chart.applyOptions({ layout: { background: { color: css("--surface") }, textColor: css("--ink-2") },
    grid: { horzLines: { color: css("--hair") } }, rightPriceScale: { borderColor: css("--axis") }, timeScale: { borderColor: css("--axis") } });
  const up = css("--up"), dn = css("--down");
  S.series.candles.applyOptions({ upColor: up, downColor: dn, borderUpColor: up, borderDownColor: dn, wickUpColor: up, wickDownColor: dn });
  S.series.sma.applyOptions({ color: css("--ma60") });
  S.series.dc.applyOptions({ color: css("--ink-3") });
  S.series.band.applyOptions({ color: css("--warn") });
  if (S.model) drawChart();
}
function drawChart() {
  const m = S.model, from = S.start - 30 * 86400;
  const view = m.d.filter((b) => b.t >= from);
  const T = (t) => t + KST;
  S.series.candles.setData(view.map((b) => ({ time: T(b.t), open: b.o, high: b.h, low: b.l, close: b.c })));
  S.series.sma.setData(view.filter((b) => !Number.isNaN(b.sma)).map((b) => ({ time: T(b.t), value: b.sma })));
  S.series.dc.setData(view.filter((b) => isFinite(b.dc)).map((b) => ({ time: T(b.t), value: b.dc })));
  S.series.band.setData(view.map((b) => ({ time: T(b.t), value: b.squeeze ? 1 : 0 })));
  // 추적 손절선: 보유 구간마다 따로 선을 만든다
  S.stopSeries.forEach((s) => S.chart.removeSeries(s));
  S.stopSeries = [];
  let seg = [];
  const flush = () => {
    if (seg.length) {
      const s = S.chart.addLineSeries({ color: css("--bad"), lineWidth: 2, priceLineVisible: false,
        lastValueVisible: false, crosshairMarkerVisible: false });
      s.setData(seg);
      S.stopSeries.push(s);
    }
    seg = [];
  };
  m.d.forEach((b, i) => {
    if (i < m.closedN && b.t >= from && isFinite(m.stops[i])) seg.push({ time: T(b.t), value: m.stops[i] });
    else flush();
  });
  flush();
  const marks = [];
  if (S.start >= m.d[0].t) marks.push({ time: T(m.d[Math.max(0, m.startBar)].t), position: "aboveBar", color: css("--ink-3"), shape: "square", text: "시작" });
  for (const e of m.events) {
    const x = m.d[e.i + 1];
    if (!x || x.t < from) continue;
    marks.push(e.type === "buy"
      ? { time: T(x.t), position: "belowBar", color: css("--up"), shape: "arrowUp", text: "매수" }
      : { time: T(x.t), position: "aboveBar", color: css("--down"), shape: "arrowDown", text: "매도" });
  }
  marks.sort((a, b) => a.time - b.time);
  if (marks.length > 14) marks.forEach((mk) => { if (mk.text !== "시작") mk.text = ""; }); // 많으면 글자 생략
  S.series.candles.setMarkers(marks);
}

/* ── 실시간 가격 ── */
function setStatus(kind, text) { $("status").dataset.state = kind; $("status-text").textContent = text; }
function connect() {
  if (S.ws) { S.ws.onclose = null; S.ws.close(); }
  const ws = new WebSocket(NET.wsUrl());
  ws.binaryType = "arraybuffer";
  S.ws = ws;
  const dec = new TextDecoder();
  ws.onopen = () => { S.retry = 0; ws.send(JSON.stringify([{ ticket: `paper-${Math.random().toString(36).slice(2)}` }, { type: "ticker", codes: [S.cfg.market] }])); };
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(typeof ev.data === "string" ? ev.data : dec.decode(ev.data)); } catch { return; }
    if (!m || m.type !== "ticker" || m.code !== S.cfg.market) return;
    S.price = m.trade_price; S.lastMsg = Date.now();
    render();
  };
  ws.onclose = () => {
    let left = Math.min(15, 2 ** S.retry++);
    setStatus("error", `연결 끊김 · ${left}초 뒤 다시 연결`);
    const tick = () => { left -= 1; if (left <= 0) return connect(); setStatus("error", `연결 끊김 · ${left}초 뒤 다시 연결`); setTimeout(tick, 1000); };
    setTimeout(tick, 1000);
  };
}

/* 1초마다: 카운트다운, 캔들 마감 뒤 다시 계산 */
let nextClose = 0, refreshing = false;
setInterval(async () => {
  const now = Date.now() / 1000;
  nextClose = (Math.floor(now / BAR) + 1) * BAR;
  const left = Math.max(0, Math.floor(nextClose - now));
  const p = (n) => String(n).padStart(2, "0");
  $("countdown").textContent = `${Math.floor(left / 3600)}:${p(Math.floor((left % 3600) / 60))}:${p(left % 60)}`;
  $("next-close").textContent = `(${kst(nextClose)})`;
  if (S.ws && S.ws.readyState === 1 && S.lastMsg) {
    const s = (Date.now() - S.lastMsg) / 1000;
    setStatus(s < 30 ? "live" : "connecting", `실시간 · ${s < 1 ? "방금" : `${Math.floor(s)}초 전`} 갱신`);
  }
  // 캔들이 끝나고 90초 뒤 최신 캔들 다시 받기 (거래소 집계 여유)
  if (S.model && !refreshing && now - (nextClose - BAR) > 90 && now - (nextClose - BAR) < 95) {
    refreshing = true;
    try { await refreshLatest(); S.model = compute(); drawChart(); render(); } catch { /* 다음 기회에 */ }
    refreshing = false;
  }
}, 1000);
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || !S.cfg) return;
  if (!S.ws || S.ws.readyState > 1) connect();
  try { await refreshLatest(); S.model = compute(); drawChart(); render(); } catch { /* 무시 */ }
});

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
  buildChart();

  await NET.detect();
  NET.label();
  try {
    S.cfg = await getJSON("paper_config.json");
  } catch (e) {
    $("state-line").textContent = `설정을 불러오지 못했습니다 (${e.message}).`;
    return;
  }
  const q = new URLSearchParams(location.search).get("start");
  const qs = q && /^\d{4}-\d{2}-\d{2}$/.test(q) ? Date.parse(`${q}T00:00:00Z`) / 1000 : NaN;
  S.official = !isFinite(qs);
  S.start = S.official ? Date.parse(S.cfg.start) / 1000 : Math.max(qs, Date.parse("2025-01-01T00:00:00Z") / 1000);
  $("start-text").textContent = kst(S.start, true);
  $("cost-text").textContent = `${(S.cfg.side_cost * 100).toFixed(2)}%`;
  $("xp-date").max = new Date().toISOString().slice(0, 10);
  $("xp-date").value = new Date(S.start * 1000).toISOString().slice(0, 10);
  $("xp-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("xp-date").value;
    if (v) location.search = `?start=${v}`;
  });
  if (!S.official) {
    const n = $("explore-note");
    n.hidden = false;
    n.textContent = `미리보기: ${kst(S.start, true)}에 시작했다고 가정한 결과입니다. 공식 모의 투자 기록이 아닙니다.`;
  }

  connect();
  try {
    await loadHistory(S.start - 210 * 86400, (p, n) => { $("state-line").textContent = `과거 시세 불러오는 중… (${p}/${n})`; });
  } catch (e) {
    $("state-line").textContent = `시세를 불러오지 못했습니다 (${e.message}). 잠시 뒤 새로고침해 주세요.`;
    return;
  }
  S.model = compute();
  drawChart();
  S.chart.timeScale().setVisibleRange({ from: S.start - 20 * 86400 + KST, to: Date.now() / 1000 + KST + BAR });
  render();
  window.__paper = S; // 확인용
});
