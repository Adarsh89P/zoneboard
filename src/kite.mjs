// Minimal Kite Connect v3 client: login, instruments, quotes, historical.
// Paced to Kite's limits (quote 1/s, historical 3/s) so a full scan never trips 429.
import crypto from 'node:crypto';

const API = 'https://api.kite.trade';

export class Kite {
  constructor(apiKey, apiSecret, accessToken = '') {
    this.apiKey = apiKey; this.apiSecret = apiSecret; this.accessToken = accessToken;
    this.lanes = { quote: { gap: 1100, next: 0 }, hist: { gap: 360, next: 0 } };
  }

  loginUrl() { return `https://kite.zerodha.com/connect/login?v=3&api_key=${encodeURIComponent(this.apiKey)}`; }

  /** Trades the request_token from Kite's redirect for the day's access token. */
  async createSession(requestToken) {
    const checksum = crypto.createHash('sha256').update(this.apiKey + requestToken + this.apiSecret).digest('hex');
    const body = new URLSearchParams({ api_key: this.apiKey, request_token: requestToken, checksum });
    const r = await this.#req('POST', '/session/token', { body, auth: false });
    this.accessToken = r.access_token;
    return r;
  }

  /** Stock futures (nearest expiry, and the next one for rollover weeks) with their cash-market
   *  tokens. Index futures are left out. */
  async fnoUniverse(today = new Date()) {
    const [nfo, nse] = await Promise.all([this.#csv('/instruments/NFO'), this.#csv('/instruments/NSE')]);
    const cash = new Map(nse.filter((r) => r.segment === 'NSE').map((r) => [r.tradingsymbol, +r.instrument_token]));
    const day = today.toISOString().slice(0, 10), byName = new Map();
    for (const r of nfo) {
      if (r.segment !== 'NFO-FUT' || r.expiry < day || !cash.has(r.name)) continue;
      (byName.get(r.name) || byName.set(r.name, []).get(r.name)).push(r);
    }
    return [...byName.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, list]) => {
      const [near, next] = list.sort((a, b) => a.expiry.localeCompare(b.expiry));
      return {
        name, fut: near.tradingsymbol, fut_token: +near.instrument_token, lot: +near.lot_size, token: cash.get(name),
        ...(next ? { fut2: next.tradingsymbol, fut2_token: +next.instrument_token } : {}),
      };
    });
  }

  async quote(instruments) {
    const out = {};
    for (let i = 0; i < instruments.length; i += 500) {
      const qs = instruments.slice(i, i + 500).map((x) => 'i=' + encodeURIComponent(x)).join('&');
      await this.#pace('quote');
      Object.assign(out, await this.#req('GET', '/quote?' + qs));
    }
    return out;
  }

  /** Candles as { t, o, h, l, c, v, oi }. from/to: 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM:SS' (IST). */
  async historical(token, interval, from, to, oi = false) {
    await this.#pace('hist');
    const qs = new URLSearchParams({ from, to, ...(oi ? { oi: '1' } : {}) });
    const r = await this.#req('GET', `/instruments/historical/${token}/${interval}?${qs}`);
    return r.candles.map((c) => ({ t: c[0], o: c[1], h: c[2], l: c[3], c: c[4], v: c[5], oi: c[6] }));
  }

  async #pace(lane) {
    const l = this.lanes[lane], now = Date.now(), at = Math.max(now, l.next);
    l.next = at + l.gap;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }

  async #csv(path) {
    const text = await this.#req('GET', path, { raw: true });
    const [head, ...lines] = text.trim().split('\n');
    const cols = head.split(',');
    return lines.map((l) => { const v = l.split(','); return Object.fromEntries(cols.map((c, i) => [c, v[i]])); });
  }

  async #req(method, path, { body, auth = true, raw = false } = {}, attempt = 0) {
    const headers = { 'X-Kite-Version': '3' };
    if (auth) headers.Authorization = `token ${this.apiKey}:${this.accessToken}`;
    const res = await fetch(API + path, { method, headers, body });
    if (res.status === 429 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      return this.#req(method, path, { body, auth, raw }, attempt + 1);
    }
    if (raw && res.ok) return res.text();
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.status === 'error') {
      const e = new Error(j.message || `Kite ${res.status}`);
      e.status = res.status; e.kiteType = j.error_type;
      throw e;
    }
    return j.data;
  }
}
