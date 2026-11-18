// Trade plans: fixed, mechanical rules turned into entry, stop and target levels.
// The same functions drive the live board and the backtest, so what the
// backtest measures is exactly what the board shows. A plan is a set of levels
// to watch, not a forecast: most days some of them stop out.
//
// The rule (bullish; bearish is the mirror):
//   setup   the stock is on the bullish board and has an unbroken order block below price
//   entry   price trades back down into the order block: entry at the zone's top
//   stop    just under the liquidity level beneath the zone (or the zone's low if none)
//   target  entry + 2 × risk
//   window  plans form from 09:20 to 14:30; anything open at 15:15 is closed there

import { zones, scoreStock } from './engine.mjs';

export const RULES = { reward: 2, firstPlan: 9 * 60 + 20, lastPlan: 14 * 60 + 30, closeAt: 15 * 60 + 15, bufferAtr: 0.1 };

/** Minutes since midnight IST for a Kite timestamp like 2026-11-18T10:25:00+05:30. */
export const minuteOf = (t) => +t.slice(11, 13) * 60 + +t.slice(14, 16);

/** Average 5-minute range: the stop's breathing room scales with it. */
function avgRange(c) { const r = c.slice(-20).map((x) => x.h - x.l); return r.reduce((a, b) => a + b, 0) / (r.length || 1); }

/**
 * Levels for one board row. Returns null when the rule has no setup.
 * @param {{name:string, dir:number, ltp:number}} row
 * @param {Array} candles 5-minute candles {t,o,h,l,c}, oldest first, up to now
 */
export function makePlan(row, candles) {
  if (!candles?.length) return null;
  const now = candles[candles.length - 1].t, m = minuteOf(now);
  if (m < RULES.firstPlan || m > RULES.lastPlan) return null;
  const z = zones(candles, row.dir, row.ltp);
  const ob = z?.orderBlock;
  if (!ob) return null;
  const pad = avgRange(candles) * RULES.bufferAtr;
  const bull = row.dir > 0;
  // the zone must still be on the far side of price, or there is nothing to wait for
  if (bull ? row.ltp <= ob.lo : row.ltp >= ob.hi) return null;
  const entry = bull ? ob.hi : ob.lo;
  const deep = bull ? (z.liquidity != null && z.liquidity < ob.lo ? z.liquidity : ob.lo) : (z.liquidity != null && z.liquidity > ob.hi ? z.liquidity : ob.hi);
  const stop = bull ? deep - pad : deep + pad;
  const risk = Math.abs(entry - stop);
  if (!(risk > 0) || risk / entry > 0.03) return null; // a stop more than 3% away is not this kind of trade
  const target = bull ? entry + RULES.reward * risk : entry - RULES.reward * risk;
  return {
    name: row.name, dir: row.dir, side: bull ? 'CALL' : 'PUT', createdAt: now,
    entry: r2(entry), stop: r2(stop), target: r2(target), riskPct: r2((risk / entry) * 100),
    zone: { lo: ob.lo, hi: ob.hi }, status: 'waiting', events: [{ t: now, s: 'waiting' }],
  };
}

/**
 * Moves a plan through waiting → active → target / stop / closed / expired,
 * using candles that came after it was made. Within one candle, a stop is
 * assumed to come before a target (the cautious reading of a candle that touched both).
 */
export function advance(plan, candles) {
  const bull = plan.dir > 0;
  for (const c of candles) {
    if (c.t <= (plan.events.at(-1)?.t || plan.createdAt)) continue;
    const m = minuteOf(c.t);
    if (plan.status === 'waiting') {
      if (m > RULES.closeAt) { set(plan, c.t, 'expired'); break; }
      const touched = bull ? c.l <= plan.entry : c.h >= plan.entry;
      const blown = bull ? c.l <= plan.stop : c.h >= plan.stop;
      if (touched) {
        set(plan, c.t, 'active');
        if (blown) { set(plan, c.t, 'stop', plan.stop); break; }
      }
      continue;
    }
    if (plan.status === 'active') {
      if (bull ? c.l <= plan.stop : c.h >= plan.stop) { set(plan, c.t, 'stop', plan.stop); break; }
      if (bull ? c.h >= plan.target : c.l <= plan.target) { set(plan, c.t, 'target', plan.target); break; }
      if (m >= RULES.closeAt) { set(plan, c.t, 'closed', c.c); break; }
    }
  }
  return plan;
}

/**
 * The plan the board would have made for one stock on one session: from 09:20,
 * the first 5-minute candle at which the stock scores onto a board and has a
 * setup, then run forward through the rest of the candles given.
 * @param prev  the previous session's 5-minute candles
 * @param today this session's 5-minute candles so far
 * @param extra fields the live scanner knows (oi, prevOi, oiDrift, atrPct...) for scoring
 */
export function firstPlan(name, prev, today, extra = {}, minScore = 60) {
  if (!prev?.length || !today?.length) return null;
  const prevClose = prev.at(-1).c;
  for (let i = 0; i < today.length; i++) {
    if (minuteOf(today[i].t) < RULES.firstPlan) continue;
    const sofar = today.slice(0, i + 1);
    const ltp = sofar.at(-1).c;
    const s = scoreStock({ ltp, prevClose, open: sofar[0].o, high: Math.max(...sofar.map((x) => x.h)), low: Math.min(...sofar.map((x) => x.l)), ...extra });
    if (s.score < minScore) continue;
    const plan = makePlan({ name, dir: s.dir, ltp }, [...prev, ...sofar]);
    if (plan) { plan.score = s.score; return advance(plan, today.slice(i + 1)); }
  }
  return null;
}

/** At the end of a finished session: a plan still waiting expires, a live one closes at the last price. */
export function finish(plan, last) {
  if (plan.status === 'waiting') set(plan, last.t, 'expired');
  else if (plan.status === 'active') set(plan, last.t, 'closed', last.c);
  return plan;
}

/** Profit in units of risk: +2 at target, −1 at the stop, in between when closed at 15:15. */
export function resultR(plan) {
  const risk = Math.abs(plan.entry - plan.stop);
  if (plan.status === 'target') return RULES.reward;
  if (plan.status === 'stop') return -1;
  if (plan.status === 'closed') return r2(((plan.exit - plan.entry) * plan.dir) / risk);
  return null;
}

function set(plan, t, s, exit) { plan.status = s; plan.events.push({ t, s }); if (exit != null) plan.exit = r2(exit); }
function r2(v) { return Math.round(v * 100) / 100; }

/* ── options ────────────────────────────────────────────────────────────
 * The plan's levels are on the stock; the option is the vehicle. The contract
 * is the at-the-money strike, nearest expiry unless it is two trading days or
 * less away (when time decay outruns most intraday moves), then the next one.
 * ──────────────────────────────────────────────────────────────────────── */
export function pickOption(chain, price, side, today) {
  if (!chain) return null;
  const expiries = Object.keys(chain).sort();
  const usable = expiries.filter((e) => e >= today);
  const near = usable[0];
  const exp = near && tradingDaysBetween(today, near) <= 2 && usable[1] ? usable[1] : near;
  if (!exp) return null;
  const legs = chain[exp][side === 'CALL' ? 'CE' : 'PE'] || [];
  let best = null;
  for (const l of legs) if (!best || Math.abs(l.strike - price) < Math.abs(best.strike - price)) best = l;
  return best && { symbol: best.symbol, strike: best.strike, expiry: exp, lot: best.lot };
}

export function tradingDaysBetween(from, to) {
  let n = 0; const d = new Date(from + 'T00:00:00Z'), end = new Date(to + 'T00:00:00Z');
  while (d < end) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w && w !== 6) n++; }
  return n;
}
