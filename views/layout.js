import { html } from './html.js';
import { formatNaira } from '../money.js';
import { fmtDate } from '../core.js';

export const money = (kobo) => formatNaira(kobo);
export const date = (d) => (d ? fmtDate(d) : '');
export const csrf = (req) => html`<input type="hidden" name="_csrf" value="${req.session.csrf}">`;

const ORDER_STATUS = {
  awaiting_payment: ['Awaiting payment', 'muted'],
  paid: ['Paid — money held', 'info'],
  shipping: ['On the way', 'info'],
  delivered: ['Delivered — inspection period', 'info'],
  disputed: ['Under review', 'warn'],
  completed: ['Completed', 'ok'],
  refunded: ['Refunded', 'muted'],
  cancelled: ['Cancelled', 'muted'],
  duplicate_refunded: ['Duplicate payment — refunded', 'muted'],
};
const DEAL_STATUS = {
  open: ['Open — waiting for buyer', 'info'],
  paid: ['Paid', 'ok'],
  expired: ['Expired', 'muted'],
  cancelled: ['Cancelled', 'muted'],
  replaced: ['Replaced by a new version', 'muted'],
};

export const orderBadge = (s) => badge(ORDER_STATUS[s] || [s, 'muted']);
export const dealBadge = (s) => badge(DEAL_STATUS[s] || [s, 'muted']);
const badge = ([label, tone]) => html`<span class="badge badge-${tone}">${label}</span>`;

const EVENT_LABELS = {
  terms_accepted: 'Buyer reviewed and accepted the deal terms',
  checkout_started: 'Buyer started payment',
  payment_failed: 'Payment attempt failed',
  payment_mismatch: 'Payment amount did not match — flagged',
  payment_received: 'Payment received and held by Middleman',
  duplicate_payment_refunded: 'Duplicate payment refunded',
  pickup_booked: 'Seller packed the item and booked pickup',
  delivery_picked_up: 'Courier picked up the parcel',
  delivery_out_for_delivery: 'Out for delivery',
  delivery_attempt_failed: 'Delivery attempt failed',
  delivery_refused: 'Buyer refused the parcel at the door',
  delivery_returned: 'Parcel returned to seller',
  wrong_pin: 'Wrong delivery PIN entered',
  delivered_with_pin: 'Delivered — buyer gave the delivery PIN',
  dispute_opened: 'Problem reported — money held for review',
  dispute_resolved: 'Dispute decided',
  buyer_confirmed: 'Buyer confirmed everything is fine',
  auto_released: 'Inspection period ended — payment released',
  checkout_abandoned: 'Checkout expired without payment',
  transfer_failed: 'A bank transfer failed — will be retried',
};

export function timeline(events, { showDetail = false } = {}) {
  return html`<ol class="timeline">
    ${events.map(
      (e) => html`<li>
        <span class="t-time">${date(e.created_at)}</span>
        <span class="t-label">${EVENT_LABELS[e.type] || e.type}</span>
        ${showDetail && e.detail ? html`<code class="t-detail">${e.detail}</code>` : ''}
      </li>`,
    )}
  </ol>`;
}

export function layout(req, { title, body, area = 'public' }) {
  const ctx = req.app.locals.ctx;
  const seller = req.seller;
  const nav =
    area === 'seller' && seller
      ? html`<nav>
          <a href="/seller">Dashboard</a>
          <a href="/seller/deals/new">New link</a>
          <a href="/seller/settings">Settings</a>
          <form method="post" action="/seller/logout">${csrf(req)}<button class="linklike">Log out</button></form>
        </nav>`
      : area === 'admin' && req.session.is_admin
        ? html`<nav>
            <a href="/admin">Orders</a>
            <a href="/admin/disputes">Disputes</a>
            <a href="/admin/sellers">Sellers</a>
            <a href="/admin/outbox">Messages</a>
            <a href="/admin/ledger">Ledger</a>
            <form method="post" action="/admin/logout">${csrf(req)}<button class="linklike">Log out</button></form>
          </nav>`
        : area === 'buyer'
          ? html`<span class="protected">🔒 Payment protection</span>`
          : html`<nav><a href="/seller/login">Seller login</a> <a class="btn btn-small" href="/seller/signup">Start selling</a></nav>`;

  return `<!doctype html>${html`<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${title} · Middleman</title>
  <link rel="stylesheet" href="/static/styles.css">
</head>
<body>
  ${ctx.payments.isTest ? html`<div class="testbar">TEST MODE — no real money moves. Payments and couriers are simulated.</div>` : ''}
  <header class="top"><a class="logo" href="/">Middle<span>man</span></a>${nav}</header>
  <main>
    ${res_flash(req)}
    ${body}
  </main>
  <footer class="foot">Middleman · Pay safely on WhatsApp &amp; Instagram deals · <a href="/how-it-works">How it works</a></footer>
  <script src="/static/app.js" defer></script>
</body>
</html>`}`;
}

function res_flash(req) {
  const f = req.res?.locals.flash;
  return f ? html`<div class="flash">${f}</div>` : '';
}

export const errorBox = (message) => (message ? html`<div class="error" role="alert">${message}</div>` : '');
