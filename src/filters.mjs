// Market filters: what the rest of the market was doing at the moment a plan was made.
// Everything here comes from candles, so the backtest can replay it exactly and say
// whether skipping flagged plans would have helped. A flag is information, not a verdict:
// nothing is skipped unless PLAN_FILTERS asks for it, and that should follow the backtest.

import { minuteOf } from './plans.mjs';

export const FLAGS = {
  against_index: 'Against NIFTY',   // the plan's direction fights the index (NIFTY moving the other way)
  vix_up: 'VIX rising',             // India VIX up more than 5% on the day: a nervous, two-way market
  big_gap: 'Big gap',               // the stock opened more than 2% from yesterday's close
  late: 'After 13:00',              // made after 13:00, with less of the session left to work
};
const T = { againstIndex: 0.2, vixUp: 5, bigGap: 2, late: 13 * 60 };

/**
 * A lookup over an index's 5-minute candles: for a time t, its % change against the
 * previous session's close, using the last candle at or before t.
 */
export function seriesAt(candles = []) {
  const days = [...new Set(candles.map((c) => c.t.slice(0, 10)))], prevClose = new Map();
  for (let d = 1; d < days.length; d++) prevClose.set(days[d], candles.filter((c) => c.t.startsWith(days[d - 1])).at(-1).c);
  return (t) => {
    const day = t.slice(0, 10), pc = prevClose.get(day);
    if (pc == null) return null;
    let last = null;
    for (const c of candles) { if (c.t > t) break; if (c.t.startsWith(day)) last = c; }
    return last ? Math.round(((last.c - pc) / pc) * 10000) / 100 : null;
  };
}

/** The market around a plan, at the time it was made. */
export function planContext(plan, { nifty, vix, gapPct } = {}) {
  const ctx = { niftyChg: nifty?.(plan.createdAt) ?? null, vixChg: vix?.(plan.createdAt) ?? null, gapPct: gapPct ?? null, minute: minuteOf(plan.createdAt) };
  const flags = [];
  if (ctx.niftyChg != null && plan.dir * ctx.niftyChg < -T.againstIndex) flags.push('against_index');
  if (ctx.vixChg != null && ctx.vixChg > T.vixUp) flags.push('vix_up');
  if (ctx.gapPct != null && Math.abs(ctx.gapPct) > T.bigGap) flags.push('big_gap');
  if (ctx.minute >= T.late) flags.push('late');
  return { ctx, flags };
}

/** The flags PLAN_FILTERS names (comma-separated), for skipping. Unknown names are ignored. */
export const skipList = (env = '') => env.split(',').map((s) => s.trim()).filter((s) => s in FLAGS);

/**
 * Backtest variants: the same trades, with each flag's plans left out in turn, then all of
 * them, plus results by the time the plan was made. `summarise` is the backtest's own.
 */
export function variants(trades, summarise) {
  const out = [{ key: 'all', label: 'Every plan', ...summarise(trades) }];
  for (const [k, label] of Object.entries(FLAGS)) {
    const flagged = trades.filter((t) => t.flags?.includes(k));
    out.push({ key: 'skip_' + k, label: `Skip "${label}"`, skipped: flagged.length, ...summarise(trades.filter((t) => !t.flags?.includes(k))), flaggedAvgR: summarise(flagged).avgR });
  }
  out.push({ key: 'skip_any', label: 'Skip any flag', ...summarise(trades.filter((t) => !t.flags?.length)) });
  const buckets = [['09:20–10:30', 560, 630], ['10:30–12:00', 630, 720], ['12:00–13:00', 720, 780], ['13:00–14:30', 780, 871]]
    .map(([label, a, b]) => ({ label, ...summarise(trades.filter((t) => { const m = minuteOf(t.createdAt); return m >= a && m < b; })) }));
  return { variants: out, byTime: buckets };
}
