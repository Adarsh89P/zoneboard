import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRss, parseBan, eventTags, aiWhy } from '../src/context.mjs';
import { seriesAt, planContext, variants, skipList } from '../src/filters.mjs';
import { summarise } from '../scripts/backtest.mjs';

const NOW = Date.parse('2026-11-18T06:00:00Z');
const rss = `<?xml version="1.0"?><rss><channel><title>x</title>
<item><title>SBI Q2 results: net profit rises 12% - Moneycontrol</title><link>https://news.google.com/rss/articles/a</link><pubDate>Tue, 18 Nov 2026 04:10:00 GMT</pubDate><source url="https://www.moneycontrol.com">Moneycontrol</source></item>
<item><title><![CDATA[SBI &amp; peers: brokers raise target price]]></title><link>https://news.google.com/rss/articles/b</link><pubDate>Tue, 18 Nov 2026 05:30:00 GMT</pubDate><source url="https://x">Mint</source></item>
<item><title>Old story</title><link>https://news.google.com/rss/articles/c</link><pubDate>Fri, 07 Nov 2026 05:30:00 GMT</pubDate><source url="https://x">Mint</source></item>
<item><title>Bad date</title><link>https://x</link><pubDate>not a date</pubDate></item>
</channel></rss>`;

test('news: Google News RSS, newest first, source suffix trimmed, old and undated items dropped', () => {
  const items = parseRss(rss, { now: NOW });
  assert.deepEqual(items.map((i) => i.title), ['SBI & peers: brokers raise target price', 'SBI Q2 results: net profit rises 12%']);
  assert.equal(items[1].source, 'Moneycontrol');
  assert.deepEqual(eventTags(items), ['results', 'broker call']);
});

test('F&O ban list from the NSE csv', () => {
  const ban = parseBan('Securities in Ban For Trade Date 18-NOV-2026:\n1,RBLBANK\n2,M&MFIN\n3, IDEA\n');
  assert.deepEqual([...ban], ['RBLBANK', 'M&MFIN', 'IDEA']);
});

test('no AI line without an API key', async () => {
  const key = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  assert.equal(await aiWhy({ name: 'X', chgPct: 1, dir: 1 }, []), null);
  if (key) process.env.ANTHROPIC_API_KEY = key;
});

const c = (t, close, o = close) => ({ t, o, h: Math.max(o, close), l: Math.min(o, close), c: close });
const nifty = seriesAt([c('2026-11-17T15:25:00+05:30', 100), c('2026-11-18T09:15:00+05:30', 99.9), c('2026-11-18T10:00:00+05:30', 99.5), c('2026-11-18T13:10:00+05:30', 100.4)]);

test('market filters: index change at the plan time, and the flags it raises', () => {
  assert.equal(nifty('2026-11-18T10:05:00+05:30'), -0.5);
  assert.equal(nifty('2026-11-17T15:25:00+05:30'), null); // no session before it
  const vix = () => 6.2;
  const a = planContext({ dir: 1, createdAt: '2026-11-18T10:05:00+05:30' }, { nifty, vix, gapPct: 2.4 });
  assert.deepEqual(a.flags, ['against_index', 'vix_up', 'big_gap']);
  const b = planContext({ dir: 1, createdAt: '2026-11-18T13:15:00+05:30' }, { nifty, gapPct: 0.3 });
  assert.deepEqual(b.flags, ['late']);
  assert.equal(b.ctx.niftyChg, 0.4);
  assert.deepEqual(skipList('late, against_index,bogus'), ['late', 'against_index']);
});

test('backtest variants leave flagged trades out and split by time', () => {
  const t = (flags, status, hhmm) => ({ flags, status, r: status === 'target' ? 2 : status === 'stop' ? -1 : null, createdAt: `2026-11-18T${hhmm}:00+05:30` });
  const trades = [t([], 'target', '09:40'), t(['late'], 'stop', '13:20'), t(['late', 'vix_up'], 'stop', '13:45'), t(['against_index'], 'expired', '11:00')];
  const v = variants(trades, summarise);
  const by = Object.fromEntries(v.variants.map((x) => [x.key, x]));
  assert.equal(by.all.avgR, 0);
  assert.equal(by.skip_late.avgR, 2);
  assert.equal(by.skip_late.skipped, 2);
  assert.equal(by.skip_late.flaggedAvgR, -1);
  assert.equal(by.skip_any.plans, 1);
  assert.equal(v.byTime.find((x) => x.label.startsWith('13')).plans, 2);
});
