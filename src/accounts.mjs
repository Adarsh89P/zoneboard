// Accounts, sessions and Google sign-in. Users live in one JSON file; a session
// is an HMAC-signed cookie, so nothing session-shaped is stored server-side.
import crypto from 'node:crypto';
import fs from 'node:fs';

const DAY = 864e5;

export class Accounts {
  /** @param {{ file: string, secret: string }} o */
  constructor({ file, secret }) {
    if (!secret || secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
    this.file = file; this.secret = secret;
    try { this.users = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.users = {}; }
  }

  #save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.users, null, 2));
    fs.renameSync(tmp, this.file); // a crash mid-write never leaves a half-written user list
  }

  /** Finds or creates the user for a verified email. */
  upsert({ email, name = '', picture = '' }) {
    email = String(email).trim().toLowerCase();
    const id = 'u_' + crypto.createHash('sha256').update(email).digest('hex').slice(0, 16);
    const u = this.users[id] || { id, email, createdAt: Date.now(), paidUntil: 0, payments: [] };
    Object.assign(u, { name, picture, lastSeen: Date.now() });
    this.users[id] = u; this.#save();
    return u;
  }

  get(id) { return this.users[id] || null; }

  isMember(u) { return !!u && u.paidUntil > Date.now(); }

  /** Extends membership from whichever is later: now, or the current end date. */
  grant(id, days, payment) {
    const u = this.users[id];
    if (!u) throw new Error('No such user');
    if (payment && u.payments.some((p) => p.paymentId === payment.paymentId)) return u; // a retried verify
    u.paidUntil = Math.max(Date.now(), u.paidUntil) + days * DAY;
    if (payment) u.payments.push({ ...payment, at: Date.now() });
    this.#save();
    return u;
  }

  /* ── sessions ──────────────────────────────────────────────────────── */
  #sign(v) { return crypto.createHmac('sha256', this.secret).update(v).digest('base64url'); }

  sessionCookie(userId, secure, days = 30) {
    const v = `${userId}.${Date.now() + days * DAY}`;
    return cookie('zb_s', `${v}.${this.#sign(v)}`, { maxAge: days * 86400, secure });
  }

  /** The signed-in user for a request, or null. */
  userFrom(req) {
    const raw = cookies(req).zb_s;
    if (!raw) return null;
    const i = raw.lastIndexOf('.');
    const v = raw.slice(0, i), sig = raw.slice(i + 1);
    const want = this.#sign(v);
    if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
    const [id, exp] = v.split('.');
    return +exp > Date.now() ? this.get(id) : null;
  }
}

/* ── Google sign-in (OAuth 2.0 authorization code) ───────────────────── */
export const google = {
  authUrl({ clientId, redirectUri, state }) {
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account' });
    return 'https://accounts.google.com/o/oauth2/v2/auth?' + q;
  },
  /** Exchanges the code and returns Google's verified profile. */
  async profile({ clientId, clientSecret, redirectUri, code }) {
    const t = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
    }).then((r) => r.json());
    if (!t.access_token) throw new Error(t.error_description || 'Google sign-in failed');
    const p = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: 'Bearer ' + t.access_token } }).then((r) => r.json());
    if (!p.email || !p.email_verified) throw new Error('Google did not confirm this email address');
    return { email: p.email, name: p.name || '', picture: p.picture || '' };
  },
};

/* ── cookies ──────────────────────────────────────────────────────────── */
export function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name, value, { maxAge, secure, httpOnly = true } = {}) {
  return [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax', httpOnly && 'HttpOnly', secure && 'Secure',
    maxAge != null && `Max-Age=${maxAge}`].filter(Boolean).join('; ');
}

export const randomToken = () => crypto.randomBytes(18).toString('base64url');
