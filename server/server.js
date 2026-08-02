// ShadowSim checkout backend
// Flow:  browser -> POST /api/checkout -> Paymento /payment/request -> redirect to gateway
//        Paymento -> POST /api/paymento/callback (HMAC verified) -> /payment/verify -> email download link
//
// Docs: https://docs.paymento.io/api-documention/api-overview

import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config (from .env — see .env.example)
// ---------------------------------------------------------------------------
const {
  PORT = 3000,
  PAYMENTO_API_KEY,          // Merchant API key   (app.paymento.io -> API)
  PAYMENTO_SECRET,           // Webhook/HMAC secret (app.paymento.io -> Webhooks)
  PUBLIC_BASE_URL,           // Public URL of THIS server, e.g. https://api.shadowsim.com
  DOWNLOAD_URL,              // Where the software is downloaded from
  SMTP_HOST, SMTP_PORT = 587, SMTP_USER, SMTP_PASS,
  MAIL_FROM = 'ShadowSim <no-reply@shadowsim.com>',
  SUPPORT_EMAIL = 'support@shadowsim.com'
} = process.env;

const PAYMENTO_API = 'https://api.paymento.io/v1';
const GATEWAY_URL  = 'https://app.paymento.io/gateway';

// ---------------------------------------------------------------------------
// Pricing = server-side source of truth (never trust the amount from the browser)
// Amounts in USD.
// ---------------------------------------------------------------------------
const PRICES = {
  uk:     { name: 'United Kingdom', week: 249, month: 599, life: 7999 },
  usa:    { name: 'United States',  week: 239, month: 499, life: 4999 },
  canada: { name: 'Canada',         week: 179, month: 459, life: 2599 }
};
const PLAN_LABEL = { week: 'Weekly', month: 'Monthly', life: 'Lifetime' };

// ---------------------------------------------------------------------------
// Tiny JSON order store (swap for a real DB in production)
// ---------------------------------------------------------------------------
const DB_FILE = path.join(__dirname, 'orders.json');
function loadOrders() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return {}; }
}
function saveOrders(o) { fs.writeFileSync(DB_FILE, JSON.stringify(o, null, 2)); }
let orders = loadOrders();
function putOrder(o) { orders[o.orderId] = o; saveOrders(orders); }

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------
const mailer = (SMTP_HOST && SMTP_USER)
  ? nodemailer.createTransport({
      host: SMTP_HOST, port: Number(SMTP_PORT),
      secure: Number(SMTP_PORT) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    })
  : null;

function licenceKey() {
  const g = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return `SS-${g()}-${g()}-${g()}-${g()}`;
}

async function sendDownloadEmail(order) {
  const key = order.licence || (order.licence = licenceKey());
  const planName = PLAN_LABEL[order.plan];
  const html = `
  <div style="font-family:Segoe UI,Arial,sans-serif;background:#0a0d16;color:#eef1f8;padding:32px;border-radius:16px;max-width:560px;margin:auto">
    <h1 style="margin:0 0 6px">Welcome to <span style="color:#22d3ee">ShadowSim</span> 🎉</h1>
    <p style="color:#9aa4bd">Your payment is confirmed. Here's everything you need to get started.</p>
    <table style="width:100%;border-collapse:collapse;margin:18px 0">
      <tr><td style="color:#9aa4bd;padding:6px 0">Licence</td><td style="text-align:right"><b>${planName} — ${PRICES[order.country].name}</b></td></tr>
      <tr><td style="color:#9aa4bd;padding:6px 0">Amount paid</td><td style="text-align:right"><b>$${order.amount} USD</b></td></tr>
      <tr><td style="color:#9aa4bd;padding:6px 0">Licence key</td><td style="text-align:right"><b style="color:#00ffa3">${key}</b></td></tr>
    </table>
    <a href="${DOWNLOAD_URL}" style="display:inline-block;background:linear-gradient(100deg,#22d3ee,#00ffa3);color:#08111a;font-weight:800;text-decoration:none;padding:14px 26px;border-radius:999px">⬇ Download ShadowSim</a>
    <p style="color:#9aa4bd;font-size:13px;margin-top:22px">Keep your licence key private — you'll enter it in the app to activate.<br>
    Need help? Reach us at <a style="color:#22d3ee" href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
  </div>`;

  if (!mailer) { return; }
  await mailer.sendMail({
    from: MAIL_FROM,
    to: order.email,
    subject: 'Your ShadowSim download link & licence key',
    html
  });
  console.log(`[email] sent download link to ${order.email} (order ${order.orderId})`);
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();

// Basic CORS so the static site (served from elsewhere/localhost) can call the API.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Serve the landing page for convenience.
app.use(express.static(path.join(__dirname, '..')));

// 1) Create a Paymento order --------------------------------------------------
app.post('/api/checkout', express.json(), async (req, res) => {
  try {
    const { country, plan, email } = req.body || {};
    if (!PRICES[country] || !PLAN_LABEL[plan]) return res.status(400).json({ error: 'Invalid plan.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) return res.status(400).json({ error: 'Invalid email.' });
    if (!PAYMENTO_API_KEY) return res.status(500).json({ error: 'Payment gateway not configured.' });

    const amount = PRICES[country][plan];
    const orderId = crypto.randomUUID();

    const payload = {
      fiatAmount: String(amount),
      fiatCurrency: 'USD',
      ReturnUrl: `${PUBLIC_BASE_URL}/api/paymento/callback`,
      orderId,
      Speed: 0, // 0 = fast (mempool acceptance)
      EmailAddress: email,
      additionalData: [
        { key: 'country', value: country },
        { key: 'plan', value: plan },
        { key: 'email', value: email }
      ]
    };

    const r = await fetch(`${PAYMENTO_API}/payment/request`, {
      method: 'POST',
      headers: { 'Api-key': PAYMENTO_API_KEY, 'Content-Type': 'application/json', 'Accept': 'text/plain' },
      body: JSON.stringify(payload)
    });
    const data = await r.json();
    if (!data.success || !data.body) {
      console.error('[paymento] request failed:', data);
      return res.status(502).json({ error: data.message || 'Could not create payment.' });
    }
    const token = data.body;

    putOrder({ orderId, token, country, plan, amount, email, status: 'created', fulfilled: false, createdAt: Date.now() });
    res.json({ redirectUrl: `${GATEWAY_URL}?token=${encodeURIComponent(token)}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Checkout failed.' });
  }
});

// 2) Paymento callback (ReturnUrl) — HMAC-verified, then verify + fulfil ------
// Use raw body so the HMAC matches exactly what Paymento signed.
app.post('/api/paymento/callback', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const raw = req.body instanceof Buffer ? req.body.toString('utf8') : '';
    const sig = req.get('X-HMAC-SHA256-SIGNATURE') || '';

    if (PAYMENTO_SECRET) {
      const expected = crypto.createHmac('sha256', PAYMENTO_SECRET).update(raw).digest('hex').toUpperCase();
      const a = Buffer.from(expected), b = Buffer.from(sig.toUpperCase());
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        console.warn('[callback] HMAC mismatch — rejecting');
        return res.status(401).send('invalid signature');
      }
    }

    const body = JSON.parse(raw || '{}');
    const token = body.Token || body.token;
    const order = Object.values(orders).find(o => o.token === token) || orders[body.OrderId];
    if (!order) { console.warn('[callback] unknown order for token', token); return res.status(404).send('unknown order'); }

    // ALWAYS verify with the API before fulfilling (docs requirement).
    const vr = await fetch(`${PAYMENTO_API}/payment/verify`, {
      method: 'POST',
      headers: { 'Api-key': PAYMENTO_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ token })
    });
    const vd = await vr.json();
    const approved = vd.success === true && String(vd.body?.orderStatus).toLowerCase() === 'approve';

    order.status = approved ? 'paid' : (vd.body?.orderStatus || 'failed');
    putOrder(order);

    if (approved && !order.fulfilled) {
      order.fulfilled = true;
      putOrder(order);
      await sendDownloadEmail(order);          // <-- download link emailed immediately
    }

    // If the buyer's browser landed here, show a friendly page; server-to-server callers ignore it.
    res.status(200).send(approved
      ? `<meta http-equiv="refresh" content="0;url=/?paid=1"><p>Payment confirmed — check your email for the ShadowSim download link.</p>`
      : `<p>Payment status: ${order.status}. If you were charged, contact ${SUPPORT_EMAIL}.</p>`);
  } catch (err) {
    console.error('[callback]', err);
    res.status(500).send('error');
  }
});

// Optional: buyer polls this from a thank-you page to see if fulfilment happened.
app.get('/api/order-status', express.json(), (req, res) => {
  const o = orders[req.query.orderId];
  res.json(o ? { status: o.status, fulfilled: o.fulfilled } : { status: 'unknown' });
});

app.listen(PORT, () => {
  console.log(`ShadowSim checkout server on http://localhost:${PORT}`);
  if (!PAYMENTO_API_KEY) console.warn('⚠  PAYMENTO_API_KEY not set — /api/checkout will fail until you add it to .env');

});
