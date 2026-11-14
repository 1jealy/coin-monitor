/* 실험 #8 규칙을 브라우저에서 그대로 계산 (src/autotrade/breakout.py 와 같은 정의).
 * 4시간봉 변동성 응축 돌파 + 60일 추세 필터 + 3×ATR 추적 손절. 결정은 캔들 마감, 체결은 다음 캔들 시가.
 * 시각은 모두 UTC 초. 숫자를 바꾸면 검증한 전략이 아니게 되므로 PARAMS 는 고정.
 */
"use strict";

const STRAT = {
  PARAMS: Object.freeze({ smaN: 360, bbN: 20, squeezeWindow: 1080, squeezePct: 0.2, squeezeRecent: 6,
    breakoutN: 20, atrN: 14, atrMult: 3 }),

  /** 1시간 캔들 → UTC 0·4·8·12·16·20시 기준 4시간 캔들 */
  to4h(hours) {
    const out = [];
    for (const c of hours) {
      const t = c.t - (c.t % 14400);
      const last = out[out.length - 1];
      if (last && last.t === t) {
        last.h = Math.max(last.h, c.h); last.l = Math.min(last.l, c.l); last.c = c.c; last.n += 1;
      } else {
        out.push({ t, o: c.o, h: c.h, l: c.l, c: c.c, n: 1 });
      }
    }
    return out;
  },

  /** 지표 붙이기. bars: [{t,o,h,l,c}] (오름차순) */
  indicators(bars) {
    const P = this.PARAMS, n = bars.length;
    const close = bars.map((b) => b.c);
    const sma = new Array(n).fill(NaN), bw = new Array(n).fill(NaN), rank = new Array(n).fill(NaN);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += close[i];
      if (i >= P.smaN) sum -= close[i - P.smaN];
      if (i >= P.smaN - 1) sma[i] = sum / P.smaN;
      if (i >= P.bbN - 1) {
        let m = 0;
        for (let j = i - P.bbN + 1; j <= i; j++) m += close[j];
        m /= P.bbN;
        let v = 0;
        for (let j = i - P.bbN + 1; j <= i; j++) v += (close[j] - m) ** 2;
        const sd = Math.sqrt(v / P.bbN); // 모집단 표준편차 (ddof=0)
        bw[i] = (4 * sd) / m; // (위 − 아래) ÷ 가운데 = 2k·sd ÷ m, k=2
      }
    }
    for (let i = 0; i < n; i++) {
      const s = i - P.squeezeWindow + 1;
      if (s < 0) continue;
      let ok = true, cnt = 0;
      for (let j = s; j <= i; j++) {
        if (Number.isNaN(bw[j])) { ok = false; break; }
        if (bw[j] <= bw[i]) cnt += 1;
      }
      if (ok) rank[i] = cnt / P.squeezeWindow;
    }
    const squeeze = rank.map((r) => !Number.isNaN(r) && r <= P.squeezePct);
    const atr = new Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      const b = bars[i], pc = i ? bars[i - 1].c : NaN;
      const tr = i ? Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)) : b.h - b.l;
      atr[i] = i ? atr[i - 1] + (tr - atr[i - 1]) / P.atrN : tr;
    }
    return bars.map((b, i) => {
      let recent = false;
      if (i >= P.squeezeRecent) for (let j = i - P.squeezeRecent; j < i; j++) recent ||= squeeze[j];
      let dc = NaN;
      if (i >= P.breakoutN) { dc = -Infinity; for (let j = i - P.breakoutN; j < i; j++) dc = Math.max(dc, bars[j].h); }
      const entry = b.c > sma[i] && recent && b.c > dc;
      return { ...b, sma: sma[i], bw: bw[i], rank: rank[i], squeeze: squeeze[i], recent, dc, atr: atr[i], entry };
    });
  },

  /** 결정: pos[i] = 캔들 i 마감 때 '다음 캔들 동안 보유'. events 에 매수·매도 이유 기록. */
  positions(d, first, last = Infinity) {
    const P = this.PARAMS;
    const pos = new Array(d.length).fill(false), events = [], stops = new Array(d.length).fill(NaN);
    let holding = false, peak = -Infinity;
    for (let i = 0; i < d.length; i++) {
      const b = d[i];
      if (holding) {
        peak = Math.max(peak, b.h);
        stops[i] = peak - P.atrMult * b.atr;
        if (b.c < stops[i]) { holding = false; events.push({ i, type: "sell", why: "추적 손절선 아래로 마감" }); }
        else if (b.c < b.sma) { holding = false; events.push({ i, type: "sell", why: "60일 평균 아래로 마감" }); }
      } else if (i >= first && i < last && b.entry) {
        holding = true; peak = -Infinity;
        events.push({ i, type: "buy", why: "응축 뒤 20개 캔들 최고가 돌파" });
      }
      if (i >= last - 1 && holding) { holding = false; events.push({ i, type: "sell", why: "기간 끝" }); }
      pos[i] = holding;
    }
    return { pos, events, stops };
  },

  filterPositions(d, first) {
    return d.map((b, i) => i >= first && b.c > b.sma);
  },

  /** 시가→다음 시가 평가. value[j] = 시가 j 에 거래하기 직전 자산. trades: 사고판 기록 */
  equity(d, pos, cost, capital = 1) {
    const n = d.length, value = new Array(n).fill(capital), trades = [];
    let v = capital, entry = null;
    for (let j = 0; j < n; j++) {
      value[j] = v;
      const held = j > 0 && pos[j - 1], prev = j > 1 && pos[j - 2];
      if (held && !prev) { v /= 1 + cost; entry = j; }
      if (!held && prev) {
        v *= 1 - cost;
        trades.push({ entryI: entry, exitI: j, buy: d[entry].o, sell: d[j].o,
          net: (d[j].o / d[entry].o) * (1 - cost) / (1 + cost) - 1 });
        entry = null;
      }
      if (held && j + 1 < n) v *= d[j + 1].o / d[j].o;
    }
    const open = entry !== null ? { entryI: entry, buy: d[entry].o } : null;
    return { value, trades, open };
  },
};
