// Razorpay Standard Checkout: the server creates an order, the page opens
// Razorpay's checkout, and the server checks the signature Razorpay returns
// before any membership is granted. Amounts are in paise.
import crypto from 'node:crypto';

export class Razorpay {
  constructor(keyId, keySecret) { this.keyId = keyId; this.keySecret = keySecret; }
  get ready() { return !!(this.keyId && this.keySecret); }

  async createOrder({ amount, receipt, notes }) {
    const r = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64') },
      body: JSON.stringify({ amount, currency: 'INR', receipt, notes }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.description || 'Could not start the payment');
    return j;
  }

  /** True only for the signature Razorpay computes over order_id|payment_id with our secret. */
  verify({ orderId, paymentId, signature }) {
    if (!orderId || !paymentId || !signature) return false;
    const want = crypto.createHmac('sha256', this.keySecret).update(`${orderId}|${paymentId}`).digest('hex');
    return want.length === signature.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(signature));
  }
}

/** Plans on sale. Prices come from the environment so the shop can change them without code. */
export function plans(env = process.env) {
  return [
    { id: 'monthly', name: 'Monthly', days: 30, price: +(env.PRICE_MONTHLY || 799) },
    { id: 'yearly', name: 'Yearly', days: 365, price: +(env.PRICE_YEARLY || 5999) },
  ].map((p) => ({ ...p, perDay: Math.round(p.price / p.days) }));
}
