import { Router } from 'express';
import { get, all, update } from '../db.js';
import { randomToken } from '../security.js';
import { html } from '../views/html.js';
import { layout, csrf, money, date, orderBadge, timeline, errorBox } from '../views/layout.js';
import { quote } from '../money.js';
import { testAccountsHint } from './seller.js';
import {
  UserError,
  BUYER_DISPUTE_CATEGORIES,
  zoneById,
  refreshDeal,
  startCheckout,
  getCheckout,
  placeOrder,
  confirmPayment,
  revealPin,
  openDispute,
  releaseToSeller,
  getSeller,
  getDeal,
  getOrder,
  applyDeliveryUpdate,
  verifyDeliveryPin,
  deliveryLabel,
} from '../core.js';
import { RULES } from '../terms.js';

export function buyerRoutes(ctx) {
  const r = Router();
  const page = (req, title, body) => layout(req, { title, body, area: 'buyer' });

  const loadDeal = (req, res, next) => {
    const d = get(ctx.db, 'SELECT * FROM deals WHERE token = :t', { t: req.params.token });
    if (!d) return res.status(404).send(page(req, 'Link not found', html`<section class="card narrow"><h1>Link not found</h1><p>Check the link with the seller.</p></section>`));
    req.deal = refreshDeal(ctx, d);
    req.dealSeller = getSeller(ctx, d.seller_id);
    if (req.deal.status !== 'open') return res.status(410).send(unavailable(req));
    next();
  };

  const unavailable = (req) => {
    const msg = {
      paid: 'This deal has already been paid for. If you paid, use the tracking link we sent to your phone.',
      expired: 'This payment link has expired. Ask the seller to send you a new one.',
      cancelled: 'The seller cancelled this link. Ask them for a new one if you still want the item.',
      replaced: 'The seller changed this deal and sent a newer link. Ask them for the latest one.',
    }[req.deal.status];
    return page(req, 'Link unavailable', html`<section class="card narrow"><h1>This link can’t be paid</h1><p>${msg}</p></section>`);
  };

  const breakdown = (d) => {
    const q = quote({ itemPrice: d.item_price, deliveryFee: d.delivery_fee, deliveryPayer: d.delivery_payer, feePayer: d.fee_payer }, ctx.config.fee);
    return html`<table class="breakdown">
      <tr><td>Item price${d.quantity > 1 ? ` (×${d.quantity})` : ''}</td><td>${money(q.itemPrice)}</td></tr>
      <tr><td>Delivery to ${zoneById(d.delivery_zone)?.name}</td><td>${q.buyerDelivery ? money(q.buyerDelivery) : html`<span class="muted">Paid by seller</span>`}</td></tr>
      <tr><td>Middleman protection fee${d.fee_payer === 'split' ? ' (your half)' : ''}</td><td>${q.buyerFeeShare ? money(q.buyerFeeShare) : html`<span class="muted">Paid by seller</span>`}</td></tr>
      <tr class="total"><td>You pay</td><td>${money(q.buyerTotal)}</td></tr>
    </table>`;
  };

  const steps = (n) => html`<ol class="steps"><li class="${n === 1 ? 'on' : 'done'}">Review deal</li><li class="${n === 2 ? 'on' : ''}">Delivery &amp; pay</li></ol>`;

  // ------------------------------------------------------------ step 1: review

  r.get('/d/:token', loadDeal, (req, res) => {
    const d = req.deal;
    const s = req.dealSeller;
    res.send(
      page(
        req,
        d.item_title,
        html`${steps(1)}
        <section class="card">
          <p class="seller-line">Seller: <strong>${s.business_name}</strong>
            ${s.identity_verified_at ? html`<span class="badge badge-ok">✓ Identity verified</span>` : html`<span class="badge badge-muted">Identity not yet verified</span>`}</p>
          <h1>${d.item_title}</h1>
          <p><span class="badge badge-info">${d.item_condition}</span> · Quantity ${d.quantity}</p>
          <p class="pre">${d.item_description}</p>
          ${breakdown(d)}
          <ul class="facts">
            <li>📦 Seller hands it to the courier within <strong>${d.delivery_days} day(s)</strong> of payment</li>
            <li>📍 Delivery area: <strong>${zoneById(d.delivery_zone)?.name}</strong></li>
            <li>🔍 You get <strong>${d.inspection_hours} hours</strong> after delivery to report a problem</li>
            <li>⏰ This link expires <strong>${date(d.expires_at)}</strong></li>
          </ul>
          <details class="rules" open><summary>How your money is protected</summary>
            <ol>${RULES(d).map((rule) => html`<li>${rule}</li>`)}</ol>
          </details>
          <form method="post" action="/d/${d.token}/confirm">
            ${csrf(req)}
            <button class="btn btn-block">This matches what we agreed — continue</button>
          </form>
          <p class="muted small center">Something wrong? Don’t continue. Tell the seller — they can send you a corrected link.</p>
        </section>`,
      ),
    );
  });

  r.post('/d/:token/confirm', loadDeal, (req, res) => {
    const checkoutId = startCheckout(ctx, req.deal, req.session.id);
    res.redirect(`/d/${req.deal.token}/details?c=${checkoutId}`);
  });

  // ------------------------------------------------------------ step 2: details & pay

  const detailsForm = async (req, checkout, v = {}, error) => {
    const d = req.deal;
    const banks = await ctx.payments.listBanks();
    return page(
      req,
      'Delivery & payment',
      html`${steps(2)}
      <section class="card">
        <h1>Delivery details</h1>
        <p class="muted">${d.item_title} · <strong>${money(d.buyer_total)}</strong></p>
        ${errorBox(error)}
        <form method="post" action="/d/${d.token}/pay" class="form">
          ${csrf(req)}
          <input type="hidden" name="c" value="${checkout.id}">
          <label>Full name <small>as on your bank account</small>
            <input name="buyer_name" required autocomplete="name" value="${v.buyer_name || ''}"></label>
          <div class="grid2">
            <label>Phone number <small>for delivery &amp; your PIN</small>
              <input name="buyer_phone" required inputmode="tel" autocomplete="tel" value="${v.buyer_phone || ''}"></label>
            <label>Email <small>for your receipt</small>
              <input name="buyer_email" type="email" required autocomplete="email" value="${v.buyer_email || ''}"></label>
          </div>
          <label>Delivery address
            <textarea name="delivery_address" required rows="2" maxlength="300" autocomplete="street-address">${v.delivery_address || ''}</textarea></label>
          <label>Nearest landmark <small>optional</small>
            <input name="delivery_landmark" maxlength="200" value="${v.delivery_landmark || ''}"></label>
          <label class="choice"><input type="checkbox" name="confirm_area" value="yes" required ${v.confirm_area === 'yes' ? 'checked' : ''}>
            My address is in <strong>${zoneById(d.delivery_zone)?.name}</strong></label>

          <fieldset><legend>Refund account</legend>
            <p class="muted small">Only used if you are owed a refund. It must be in your own name. The seller never sees it.</p>
            <div class="grid2">
              <label>Bank
                <select name="refund_bank_code" required>
                  <option value="">Choose your bank</option>
                  ${banks.map((b) => html`<option value="${b.code}" ${b.code === v.refund_bank_code ? 'selected' : ''}>${b.name}</option>`)}
                </select></label>
              <label>Account number
                <input name="refund_account_number" required inputmode="numeric" pattern="\\d{10}" maxlength="10" value="${v.refund_account_number || ''}"></label>
            </div>
            ${ctx.payments.name === 'mock' ? testAccountsHint() : ''}
          </fieldset>
          <button class="btn btn-block">Pay ${money(d.buyer_total)} securely</button>
          <p class="muted small center">Your money is held by Middleman, not the seller, until delivery.</p>
        </form>
      </section>`,
    );
  };

  const loadCheckout = (req, res, next) => {
    req.checkout = getCheckout(ctx, req.deal, req.query.c || req.body?.c);
    if (!req.checkout) return res.redirect(`/d/${req.deal.token}`);
    next();
  };

  r.get('/d/:token/details', loadDeal, loadCheckout, async (req, res) => {
    res.send(await detailsForm(req, req.checkout));
  });

  r.post('/d/:token/pay', loadDeal, loadCheckout, async (req, res) => {
    try {
      const { paymentUrl } = await placeOrder(ctx, { deal: req.deal, checkout: req.checkout, input: req.body });
      res.redirect(303, paymentUrl);
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      res.status(400).send(await detailsForm(req, req.checkout, req.body, err.message));
    }
  });

  // ------------------------------------------------------------ payment return

  r.get('/payments/callback', async (req, res) => {
    const order = await confirmPayment(ctx, String(req.query.tx_ref || ''), 'buyer');
    if (!order) return res.status(404).send(page(req, 'Payment', html`<section class="card narrow"><p>We couldn’t find that payment.</p></section>`));
    res.redirect(`/o/${order.buyer_token}`);
  });

  // Simulated hosted checkout, only present with the mock provider.
  if (ctx.payments.name === 'mock') {
    r.get('/pay/mock/:txRef', (req, res) => {
      const tx = get(ctx.db, 'SELECT * FROM mock_transactions WHERE tx_ref = :t', { t: req.params.txRef });
      if (!tx) return res.status(404).send('Unknown test payment.');
      res.send(
        page(
          req,
          'Test checkout',
          html`<section class="card narrow center">
            <p class="badge badge-warn">Simulated payment page</p>
            <h1>Pay ${money(tx.amount)}</h1>
            <p class="muted">In live mode this is Flutterwave’s checkout (card, bank transfer, USSD).</p>
            <form method="post" action="/pay/mock/${tx.tx_ref}">${csrf(req)}
              <button class="btn btn-block" name="result" value="successful">Simulate successful payment</button>
              <button class="btn btn-block btn-secondary" name="result" value="failed">Simulate failed payment</button>
            </form>
          </section>`,
        ),
      );
    });
    r.post('/pay/mock/:txRef', (req, res) => {
      ctx.payments.setMockStatus(req.params.txRef, req.body.result === 'successful' ? 'successful' : 'failed');
      res.redirect(`/payments/callback?tx_ref=${encodeURIComponent(req.params.txRef)}`);
    });
  }

  // ------------------------------------------------------------ buyer order page

  const loadOrder = (req, res, next) => {
    req.order = get(ctx.db, 'SELECT * FROM orders WHERE buyer_token = :t', { t: req.params.token });
    if (!req.order) return res.status(404).send(page(req, 'Not found', html`<section class="card narrow"><p>Order not found.</p></section>`));
    next();
  };

  r.get('/o/:token', loadOrder, (req, res) => {
    const o = req.order;
    const d = getDeal(ctx, o.deal_id);
    const s = getSeller(ctx, o.seller_id);
    const events = all(ctx.db, 'SELECT * FROM order_events WHERE order_id = :id ORDER BY id', { id: o.id });
    const dispute = get(ctx.db, 'SELECT * FROM disputes WHERE order_id = :id ORDER BY id DESC', { id: o.id });
    const pin = ['paid', 'shipping'].includes(o.status) ? revealPin(ctx, o) : null;
    const canDispute = ['paid', 'shipping'].includes(o.status) || (o.status === 'delivered' && new Date(o.inspection_ends_at) > ctx.now());
    const disputeForm = canDispute
      ? html`<details class="rules"><summary>Report a problem</summary>
          <form method="post" action="/o/${o.buyer_token}/dispute" class="form">
            ${csrf(req)}
            <label>What went wrong?
              <select name="category" required><option value="">Choose</option>
                ${Object.entries(BUYER_DISPUTE_CATEGORIES).map(([k, label]) => html`<option value="${k}">${label}</option>`)}
              </select></label>
            <label>Details <small>what you expected vs what you got</small><textarea name="description" required rows="3" maxlength="2000"></textarea></label>
            <p class="muted small">Keep the item, packaging and any unboxing video. Middleman will contact you for evidence. The money stays held until a decision.</p>
            <button class="btn btn-danger">Report problem &amp; hold payment</button>
          </form>
        </details>`
      : '';

    res.send(
      page(
        req,
        `Order ${o.ref}`,
        html`<section class="card">
          <div class="spread"><h1>Order ${o.ref}</h1>${orderBadge(o.status)}</div>
          <p><strong>${d.item_title}</strong> from ${s.business_name} · ${money(o.amount)}</p>

          ${o.status === 'awaiting_payment' || o.status === 'cancelled'
            ? html`<div class="callout warn">Payment not completed.
                ${refreshDeal(ctx, d).status === 'open'
                  ? html`<form method="post" action="/o/${o.buyer_token}/retry">${csrf(req)}<button class="btn">Try payment again</button></form>`
                  : html`<br>This link is no longer open. Ask the seller for a new one.`}</div>`
            : ''}
          ${pin
            ? html`<div class="pinbox">
                <p>Your delivery PIN</p>
                <div class="pin">${pin}</div>
                <p class="small">Check the item at the door. <strong>Only give this PIN to the rider if the item matches.</strong> If it doesn’t, refuse it and keep your PIN.</p>
              </div>`
            : ''}
          ${o.status === 'paid' ? html`<p>Your money is held by Middleman. The seller must hand the item to the courier before ${date(o.ship_by)}.</p>` : ''}
          ${o.status === 'shipping' ? html`<p>Parcel status: <strong>${deliveryLabel(o.delivery_status)}</strong></p>` : ''}
          ${o.status === 'delivered'
            ? html`<div class="callout info">
                Delivered ${date(o.delivered_at)}. If everything is fine, release the payment to the seller. If not, report it before <strong>${date(o.inspection_ends_at)}</strong>.
                <form method="post" action="/o/${o.buyer_token}/accept">${csrf(req)}<button class="btn">Everything is fine — pay the seller</button></form>
              </div>`
            : ''}
          ${o.status === 'completed' && !dispute ? html`<div class="callout ok">Complete. The seller has been paid.</div>` : ''}
          ${dispute
            ? html`<div class="callout ${dispute.status === 'open' ? 'warn' : 'info'}">
                <strong>${dispute.status === 'open' ? 'Under review' : 'Decision'}</strong>: ${dispute.status === 'open' ? 'Middleman is reviewing this order. Your money stays held.' : dispute.resolution_note}
                ${dispute.status === 'resolved' ? html`<br>Refund to you: <strong>${money(dispute.buyer_refund || 0)}</strong> → ${o.refund_bank_name} ••••${o.refund_account_last4}` : ''}
              </div>`
            : ''}
          ${o.status === 'duplicate_refunded' ? html`<div class="callout info">This deal was already paid, so this payment was refunded in full to ${o.refund_bank_name} ••••${o.refund_account_last4}.</div>` : ''}
          ${disputeForm}
          <h2>Timeline</h2>
          ${timeline(events)}
          <details class="rules"><summary>The terms you accepted</summary>
            <p class="small muted">Accepted ${date(o.terms_accepted_at)} · record ${o.terms_hash.slice(0, 12)}</p>
            <ol>${JSON.parse(o.terms_json).rules.map((rule) => html`<li>${rule}</li>`)}</ol>
          </details>
          <p class="muted small">Keep this page’s link — it’s your private tracking page.</p>
        </section>`,
      ),
    );
  });

  const buyerAction = (fn) => async (req, res) => {
    try {
      await fn(req);
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      req.flash(err.message);
    }
    res.redirect(`/o/${req.params.token}`);
  };

  r.post('/o/:token/retry', loadOrder, async (req, res) => {
    const o = req.order;
    const d = refreshDeal(ctx, getDeal(ctx, o.deal_id));
    if (!['awaiting_payment', 'cancelled'].includes(o.status) || d.status !== 'open') return res.redirect(`/o/${o.buyer_token}`);
    // A fresh reference per attempt; providers may reject a reused one.
    update(ctx.db, 'orders', o.id, { tx_ref: 'MMTX-' + randomToken(12), status: 'awaiting_payment', closed_at: null });
    const fresh = getOrder(ctx, o.id);
    const { url } = await ctx.payments.createCheckout({ order: fresh, redirectUrl: `${ctx.config.baseUrl}/payments/callback`, title: d.item_title });
    res.redirect(303, url);
  });

  r.post('/o/:token/accept', loadOrder, buyerAction((req) => releaseToSeller(ctx, req.order, 'buyer_confirmed')));

  r.post('/o/:token/dispute', loadOrder, buyerAction((req) => {
    if (!BUYER_DISPUTE_CATEGORIES[req.body.category]) throw new UserError('Choose what went wrong.');
    openDispute(ctx, req.order, { by: 'buyer', category: req.body.category, description: req.body.description });
    req.flash('Problem reported. Your money is held while Middleman reviews it.');
  }));

  // ------------------------------------------------------------ rider (manual courier)

  const loadRider = (req, res, next) => {
    req.order = get(ctx.db, 'SELECT * FROM orders WHERE rider_token = :t', { t: req.params.token });
    if (!req.order) return res.status(404).send('Unknown delivery.');
    next();
  };

  r.get('/r/:token', loadRider, (req, res) => {
    const o = req.order;
    const d = getDeal(ctx, o.deal_id);
    const s = getSeller(ctx, o.seller_id);
    const btn = (status, label, tone = '') =>
      html`<button class="btn ${tone}" name="status" value="${status}">${label}</button>`;
    res.send(
      layout(req, {
        title: `Delivery ${o.ref}`,
        area: 'buyer',
        body: html`<section class="card">
          <div class="spread"><h1>Delivery ${o.ref}</h1><span class="badge badge-info">${deliveryLabel(o.delivery_status)}</span></div>
          <h2>Item</h2>
          <p><strong>${d.item_title}</strong> (${d.item_condition}, ×${d.quantity})</p>
          <p class="pre small">${d.item_description}</p>
          <p class="small"><strong>Seller’s packing note:</strong> ${o.packing_note}</p>
          <div class="grid2">
            <div><h2>Pick up</h2><p>${s.business_name}<br>${s.phone}<br>${d.pickup_address}</p></div>
            <div><h2>Deliver to</h2><p>${o.buyer_name}<br>${o.buyer_phone}<br>${o.delivery_address}${o.delivery_landmark ? html`<br><em>Near ${o.delivery_landmark}</em>` : ''}</p></div>
          </div>
          ${o.status === 'shipping'
            ? html`<form method="post" action="/r/${o.rider_token}/status" class="form">
                ${csrf(req)}
                <div class="actions">${btn('picked_up', 'Picked up')}${btn('out_for_delivery', 'Out for delivery')}</div>
                <label>If delivery failed or was refused, say what happened
                  <input name="note" maxlength="500"></label>
                <div class="actions">${btn('attempt_failed', 'Buyer not available', 'btn-secondary')}${btn('refused', 'Buyer refused item', 'btn-danger')}</div>
              </form>
              <form method="post" action="/r/${o.rider_token}/pin" class="form pinform">
                ${csrf(req)}
                <label>Buyer’s 4-digit delivery PIN <input name="pin" inputmode="numeric" pattern="\\d{4}" maxlength="4" required></label>
                <button class="btn">Confirm delivery</button>
              </form>`
            : o.delivery_status === 'refused'
              ? html`<form method="post" action="/r/${o.rider_token}/status">${csrf(req)}${btn('returned', 'Returned to seller')}</form>`
              : html`<p class="muted">Nothing to do for this delivery.</p>`}
        </section>`,
      }),
    );
  });

  const riderAction = (fn) => async (req, res) => {
    try {
      await fn(req);
      req.flash('Updated.');
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      req.flash(err.message);
    }
    res.redirect(`/r/${req.params.token}`);
  };

  r.post('/r/:token/status', loadRider, riderAction((req) =>
    applyDeliveryUpdate(ctx, req.order, { status: req.body.status, note: req.body.note, actor: 'rider' }),
  ));
  r.post('/r/:token/pin', loadRider, riderAction((req) => verifyDeliveryPin(ctx, getOrder(ctx, req.order.id), req.body.pin, 'rider')));

  return r;
}
