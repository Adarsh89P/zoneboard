// Scanner engine: pure functions, no I/O. The server feeds it Kite data and
// the board shows what it returns. Nothing here is advice; it ranks and marks.

/* ── strength ────────────────────────────────────────────────────────────
 * One 0–100 score per stock, signed by direction. A stock earns it by:
 *   move   — how far it has moved, against how far it usually moves (ATR)
 *   hold   — where it sits in today's range (a bull near the high, a bear near the low)
 *   trend  — how much of the day's range is one-way travel rather than chop
 *   oi     — whether futures open interest backs the move (fresh positions)
 * A stock that is moving but chopping, or giving back its move, scores 0
 * and stays off the board.
 * ──────────────────────────────────────────────────────────────────────── */

const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

/** How futures OI and price moved together. */
export function oiBuildup(priceChg, oiChg) {
  if (oiChg == null || !isFinite(oiChg)) return 'unknown';
  if (priceChg >= 0) return oiChg >= 0 ? 'long_buildup' : 'short_covering';
  return oiChg >= 0 ? 'short_buildup' : 'long_unwinding';
}

/**
 * @param {object} s
 * @param {number} s.ltp        last price (cash)
 * @param {number} s.prevClose  previous close (cash)
 * @param {number} s.open
 * @param {number} s.high
 * @param {number} s.low
 * @param {number} [s.atrPct]   14-day ATR as % of price; falls back to today's range
 * @param {number} [s.volume]
 * @param {number} [s.avgVolume] 20-day average volume
 * @param {number} [s.oi]       futures open interest now
 * @param {number} [s.prevOi]   futures open interest at yesterday's close
 */
export function scoreStock(s) {
  const chgPct = ((s.ltp - s.prevClose) / s.prevClose) * 100;
  const range = s.high - s.low;
  const dir = chgPct >= 0 ? 1 : -1;
  if (!(range > 0) || !isFinite(chgPct)) return { chgPct: chgPct || 0, dir, score: 0, choppy: true };

  const dayRangePct = (range / s.prevClose) * 100;
  const atrPct = s.atrPct > 0 ? s.atrPct : null;
  const move = clamp(Math.abs(chgPct) / (atrPct ?? Math.max(dayRangePct, 0.5)) / 1.2);
  const pos = (s.ltp - s.low) / range;
  const hold = dir > 0 ? pos : 1 - pos;
  const trend = clamp(Math.abs(s.ltp - s.open) / range);

  const oiChgPct = s.oi > 0 && s.prevOi > 0 ? ((s.oi - s.prevOi) / s.prevOi) * 100 : null;
  const buildup = oiBuildup(chgPct, oiChgPct);
  // fresh positions in the move's direction count fully; covering/unwinding half; unknown is neutral
  const oiScore = buildup === 'unknown' ? 0.5
    : buildup === 'long_buildup' || buildup === 'short_buildup' ? clamp(0.6 + Math.abs(oiChgPct) / 10)
      : 0.35;

  const relVol = s.avgVolume > 0 && s.volume > 0 ? s.volume / s.avgVolume : null;
  const volScore = relVol == null ? 0.5 : clamp(relVol / 2);

  // chop: little one-way travel, or the move is mostly given back
  const choppy = trend < 0.25 || hold < 0.45 || Math.abs(chgPct) < 0.3;
  const raw = 0.35 * move + 0.2 * hold + 0.2 * trend + 0.15 * oiScore + 0.1 * volScore;
  const score = choppy ? 0 : Math.round(raw * 100);

  return {
    chgPct: round(chgPct, 2), dir, score, choppy,
    parts: { move: round(move, 2), hold: round(hold, 2), trend: round(trend, 2), oi: round(oiScore, 2), vol: round(volScore, 2) },
    oiChgPct: oiChgPct == null ? null : round(oiChgPct, 2), buildup,
    relVol: relVol == null ? null : round(relVol, 2),
    atrPct: atrPct == null ? null : round(atrPct, 2),
  };
}

/** Bullish and bearish boards, strongest first. */
export function rankBoard(rows, top = 20) {
  const live = rows.filter((r) => r.score > 0);
  const bull = live.filter((r) => r.dir > 0).sort((a, b) => b.score - a.score || b.chgPct - a.chgPct).slice(0, top);
  const bear = live.filter((r) => r.dir < 0).sort((a, b) => b.score - a.score || a.chgPct - b.chgPct).slice(0, top);
  const counts = {
    bullish: rows.filter((r) => r.dir > 0 && r.score > 0).length,
    bearish: rows.filter((r) => r.dir < 0 && r.score > 0).length,
    choppy: rows.filter((r) => r.score === 0).length,
  };
  return { bull, bear, counts };
}

/* ── daily statistics ─────────────────────────────────────────────────── */

/** 14-day ATR as % of the last close, and 20-day average volume, from daily candles [t,o,h,l,c,v]. */
export function dailyStats(days) {
  if (!days || days.length < 2) return {};
  const trs = [];
  for (let i = 1; i < days.length; i++) {
    const [, , h, l] = days[i], pc = days[i - 1][4];
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const atr = avg(trs.slice(-14));
  const last = days[days.length - 1][4];
  const vols = days.slice(-20).map((d) => d[5]).filter((v) => v > 0);
  return { atrPct: (atr / last) * 100, avgVolume: vols.length ? avg(vols) : undefined };
}

/* ── zones ───────────────────────────────────────────────────────────────
 * From intraday candles (5-minute by default), oldest first, each
 * { t, o, h, l, c }:
 *   swings      — fractal highs/lows (higher/lower than 2 candles each side)
 *   order block — the last opposite candle before a displacement that broke
 *                 structure (closed past the latest swing), still unmitigated
 *   liquidity   — the nearest swing beyond the order block, where the
 *                 stop-losses of the other side sit
 *   support / resistance — nearest swing low below / swing high above price
 * ──────────────────────────────────────────────────────────────────────── */

export function aggregate(candles, minutes) {
  const out = [];
  for (const c of candles) {
    const t = new Date(c.t), bucket = Math.floor((t.getUTCHours() * 60 + t.getUTCMinutes()) / minutes);
    const key = c.t.slice(0, 10) + ':' + bucket;
    const last = out[out.length - 1];
    if (last && last.key === key) {
      last.h = Math.max(last.h, c.h); last.l = Math.min(last.l, c.l); last.c = c.c; last.v += c.v || 0;
    } else out.push({ key, t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v || 0 });
  }
  return out.map(({ key, ...c }) => c);
}

export function swings(candles, k = 2) {
  const highs = [], lows = [];
  for (let i = k; i < candles.length - k; i++) {
    let hi = true, lo = true;
    for (let j = 1; j <= k; j++) {
      if (!(candles[i].h > candles[i - j].h && candles[i].h >= candles[i + j].h)) hi = false;
      if (!(candles[i].l < candles[i - j].l && candles[i].l <= candles[i + j].l)) lo = false;
    }
    if (hi) highs.push({ i, price: candles[i].h, t: candles[i].t });
    if (lo) lows.push({ i, price: candles[i].l, t: candles[i].t });
  }
  return { highs, lows };
}

/**
 * The most recent valid order block in direction dir (1 bullish, -1 bearish).
 * Returns { lo, hi, i, t, brokeAt } or null.
 */
export function findOrderBlock(candles, dir, sw = swings(candles)) {
  const ranges = candles.map((c) => c.h - c.l);
  const avgRange = avg(ranges) || 0;
  const levels = dir > 0 ? sw.highs : sw.lows;

  for (let b = candles.length - 1; b > 2; b--) {
    const c = candles[b];
    // the latest swing formed before this candle (needs its 2 right-hand candles before b)
    const prior = [...levels].reverse().find((s) => s.i + 2 < b);
    if (!prior) continue;
    const broke = dir > 0 ? c.c > prior.price && candles[b - 1].c <= prior.price
      : c.c < prior.price && candles[b - 1].c >= prior.price;
    if (!broke) continue;

    // walk back from the break to where the impulse started: the last opposite-colour candle
    let ob = -1;
    for (let j = b; j > Math.max(0, prior.i - 12); j--) {
      const bear = candles[j].c < candles[j].o, bull = candles[j].c > candles[j].o;
      if ((dir > 0 && bear) || (dir < 0 && bull)) { ob = j; break; }
    }
    if (ob < 0) continue;

    // displacement: the move from the OB to the break must be impulsive
    const travel = dir > 0 ? c.c - candles[ob].l : candles[ob].h - c.c;
    if (travel < 2 * avgRange) continue;

    const zone = { lo: candles[ob].l, hi: candles[ob].h, i: ob, t: candles[ob].t, brokeAt: b, broke: prior.price };
    // mitigated: a later close through the far side of the zone voids it
    const voided = candles.slice(b + 1).some((x) => (dir > 0 ? x.c < zone.lo : x.c > zone.hi));
    if (!voided) return zone;
  }
  return null;
}

export function zones(candles, dir, ltp) {
  if (!candles || candles.length < 10) return null;
  const sw = swings(candles);
  const ob = findOrderBlock(candles, dir, sw);
  const price = ltp ?? candles[candles.length - 1].c;
  const below = sw.lows.filter((s) => s.price < price).sort((a, b) => b.price - a.price);
  const above = sw.highs.filter((s) => s.price > price).sort((a, b) => a.price - b.price);
  const dayHigh = Math.max(...candles.map((c) => c.h)), dayLow = Math.min(...candles.map((c) => c.l));

  // Laid out the way a bull reads it, top down: resistance, price, order block, support, liquidity.
  // A bear's is the mirror. Support (bull) is the first swing low under the order block, and
  // liquidity the one under that: where the stops of anyone long from support are resting.
  // A level only counts on its own side of the price: a stock trading past the day's
  // extreme has no resistance (or support) above (below) it, and the board says so.
  const under = (lim) => below.filter((s) => s.price < lim).map((s) => s.price).concat(dayLow < lim ? [dayLow] : []);
  const over = (lim) => above.filter((s) => s.price > lim).map((s) => s.price).concat(dayHigh > lim ? [dayHigh] : []);
  let support, resistance, liquidity;
  if (dir > 0) {
    resistance = over(price)[0] ?? null;
    const u = [...new Set(under(ob ? ob.lo : price))];
    support = u[0] ?? null;
    liquidity = u[1] ?? null;
  } else {
    support = under(price)[0] ?? null;
    const o = [...new Set(over(ob ? ob.hi : price))];
    resistance = o[0] ?? null;
    liquidity = o[1] ?? null;
  }
  return {
    orderBlock: ob && { lo: round(ob.lo, 2), hi: round(ob.hi, 2), t: ob.t, broke: round(ob.broke, 2) },
    support: maybe(support), resistance: maybe(resistance), liquidity: maybe(liquidity),
  };
}

/* ── helpers ──────────────────────────────────────────────────────────── */
function avg(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function round(v, d) { const f = 10 ** d; return Math.round(v * f) / f; }
function maybe(v) { return v == null ? null : round(v, 2); }
