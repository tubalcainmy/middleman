import { Router } from 'express';
import { get, all, update } from '../db.js';
import { safeEqual } from '../security.js';
import { html } from '../views/html.js';
import { layout, csrf, money, date, orderBadge, timeline, errorBox } from '../views/layout.js';
import {
  UserError,
  DISPUTE_CATEGORIES,
  zoneById,
  getOrder,
  getDeal,
  getSeller,
  resolveDispute,
  sendTransfer,
  runJobs,
  deliveryLabel,
  buyerUrl,
} from '../core.js';

export function adminRoutes(ctx) {
  const r = Router();
  const page = (req, title, body) => layout(req, { title, body, area: 'admin' });
  const naira = (kobo) => (kobo / 100).toFixed(2).replace(/\.00$/, '');

  r.get('/login', (req, res) => res.send(loginPage(req)));
  const loginPage = (req, error) =>
    page(
      req,
      'Admin login',
      html`<section class="card narrow"><h1>Admin</h1>${errorBox(error)}
        <form method="post" action="/admin/login" class="form">${csrf(req)}
          <label>Password <input name="password" type="password" required autocomplete="current-password"></label>
          <button class="btn">Log in</button></form></section>`,
    );
  r.post('/login', (req, res) => {
    if (!safeEqual(String(req.body.password || ''), ctx.config.adminPassword)) {
      return res.status(401).send(loginPage(req, 'Wrong password.'));
    }
    req.rotateSession({ is_admin: 1 });
    res.redirect('/admin');
  });

  r.use((req, res, next) => (req.session.is_admin ? next() : res.redirect('/admin/login')));

  r.post('/logout', (req, res) => {
    req.rotateSession({});
    res.redirect('/');
  });

  // ------------------------------------------------------------ orders

  r.get('/', (req, res) => {
    const status = String(req.query.status || '');
    const orders = all(
      ctx.db,
      `SELECT o.*, d.item_title, s.business_name FROM orders o
       JOIN deals d ON d.id = o.deal_id JOIN sellers s ON s.id = o.seller_id
       WHERE (:status = '' AND o.status != 'cancelled') OR o.status = :status
       ORDER BY o.id DESC LIMIT 200`,
      { status },
    );
    const counts = Object.fromEntries(all(ctx.db, 'SELECT status, COUNT(*) n FROM orders GROUP BY status').map((x) => [x.status, x.n]));
    const filters = ['', 'awaiting_payment', 'paid', 'shipping', 'delivered', 'disputed', 'completed', 'refunded', 'cancelled'];
    res.send(
      page(
        req,
        'Orders',
        html`<div class="spread"><h1>Orders</h1>
          <form method="post" action="/admin/jobs">${csrf(req)}<button class="btn btn-small btn-secondary">Run timers now</button></form></div>
        <p class="filters">${filters.map(
          (f) => html`<a class="${f === status ? 'on' : ''}" href="/admin?status=${f}">${f || 'active'}${f ? ` (${counts[f] || 0})` : ''}</a> `,
        )}</p>
        <div class="list">${orders.map(
          (o) => html`<a class="row" href="/admin/orders/${o.id}">
            <div><strong>${o.ref}</strong> · ${o.item_title}<br><small class="muted">${o.business_name} → ${o.buyer_name} · ${date(o.created_at)}</small></div>
            <div class="right">${orderBadge(o.status)}<br><small>${money(o.amount)}</small></div>
          </a>`,
        )}</div>`,
      ),
    );
  });

  r.post('/jobs', async (req, res) => {
    const result = await runJobs(ctx);
    req.flash(`Timers run: ${JSON.stringify(result)}`);
    res.redirect('/admin');
  });

  r.get('/orders/:id', (req, res) => {
    const o = getOrder(ctx, Number(req.params.id));
    if (!o) return res.status(404).send(page(req, 'Not found', html`<p>Order not found.</p>`));
    const d = getDeal(ctx, o.deal_id);
    const s = getSeller(ctx, o.seller_id);
    const events = all(ctx.db, 'SELECT * FROM order_events WHERE order_id = :id ORDER BY id', { id: o.id });
    const disputes = all(ctx.db, 'SELECT * FROM disputes WHERE order_id = :id ORDER BY id', { id: o.id });
    const ledger = all(ctx.db, 'SELECT * FROM ledger WHERE order_id = :id ORDER BY id', { id: o.id });
    const messages = all(ctx.db, 'SELECT * FROM outbox WHERE order_id = :id ORDER BY id', { id: o.id });
    const open = disputes.find((x) => x.status === 'open');

    const presets = open
      ? [
          ['Seller at fault: full refund, charge seller both delivery trips', { buyer_refund: o.amount, seller_payout: 0, seller_charge: d.delivery_fee * 2 }],
          ['Buyer refused a correct item: refund minus both delivery trips', { buyer_refund: Math.max(0, o.amount - d.delivery_fee * 2), seller_payout: 0, seller_charge: 0 }],
          ['Claim not supported: pay seller as normal', { buyer_refund: 0, seller_payout: d.seller_payout, seller_charge: 0 }],
        ]
      : [];

    res.send(
      page(
        req,
        `Order ${o.ref}`,
        html`<section class="card">
          <div class="spread"><h1>Order ${o.ref}</h1>${orderBadge(o.status)}</div>
          <div class="grid2">
            <div>
              <h2>Deal</h2>
              <p><strong>${d.item_title}</strong> (${d.item_condition}, ×${d.quantity})</p>
              <p class="pre small">${d.item_description}</p>
              <p class="small">Item ${money(d.item_price)} · delivery ${money(d.delivery_fee)} (${d.delivery_payer}) · fee ${money(d.platform_fee)} (${d.fee_payer})<br>
                Buyer paid <strong>${money(o.amount)}</strong> · seller gets <strong>${money(d.seller_payout)}</strong></p>
              <p class="small">Packing note: ${o.packing_note || '—'}</p>
            </div>
            <div>
              <h2>Seller</h2>
              <p><a href="/admin/sellers">${s.business_name}</a> (${s.full_name})<br>${s.phone} · ${s.email}<br>
                Pickup: ${d.pickup_address} (${zoneById(d.pickup_zone)?.name})<br>
                Payout: ${s.payout_bank_name} ${s.payout_account_number}${s.amount_owed ? html`<br><strong>Owes ${money(s.amount_owed)}</strong>` : ''}</p>
              <h2>Buyer</h2>
              <p>${o.buyer_name}<br>${o.buyer_phone} · ${o.buyer_email}<br>${o.delivery_address} (${zoneById(d.delivery_zone)?.name})
                ${o.delivery_landmark ? html`<br>Near ${o.delivery_landmark}` : ''}<br>
                Refund: ${o.refund_bank_name} ••••${o.refund_account_last4} (${o.refund_account_name})</p>
              <p class="small"><a href="${buyerUrl(ctx, o)}">Buyer tracking page</a>
                ${o.rider_token ? html` · <a href="/r/${o.rider_token}">Rider page</a> <button type="button" class="linklike" data-copy="${ctx.config.baseUrl}/r/${o.rider_token}">(copy rider link)</button>` : ''}</p>
            </div>
          </div>
          <p class="small">Delivery: ${deliveryLabel(o.delivery_status)} ${o.delivery_ref ? `· ${o.delivery_ref}` : ''} · ship by ${date(o.ship_by)} · PIN attempts ${o.pin_attempts}</p>
        </section>

        ${disputes.map(
          (x) => html`<section class="card ${x.status === 'open' ? 'card-warn' : ''}">
            <h2>Dispute #${x.id} — ${DISPUTE_CATEGORIES[x.category] || x.category} (${x.status})</h2>
            <p class="small muted">Opened by ${x.opened_by} · ${date(x.created_at)}</p>
            <p class="pre">${x.description}</p>
            ${x.status === 'resolved'
              ? html`<p><strong>Decision:</strong> ${x.resolution_note}<br>Buyer refund ${money(x.buyer_refund)} · seller payout ${money(x.seller_payout)} · seller charge ${money(x.seller_charge)}</p>`
              : html`<form method="post" action="/admin/disputes/${x.id}/resolve" class="form" id="resolve">
                  ${csrf(req)}
                  <p class="small">Collected ${money(o.amount)}. Whatever isn’t refunded or paid out is kept to cover delivery and fees.
                    Check evidence from both sides and the rider before deciding. Presets only fill the form.</p>
                  <div class="actions">${presets.map(
                    ([label, v]) => html`<button type="button" class="btn btn-small btn-secondary" data-fill="${JSON.stringify({
                      buyer_refund: naira(v.buyer_refund),
                      seller_payout: naira(v.seller_payout),
                      seller_charge: naira(v.seller_charge),
                    })}">${label}</button>`,
                  )}</div>
                  <div class="grid3">
                    <label>Refund to buyer (₦) <input name="buyer_refund" inputmode="decimal" value="0"></label>
                    <label>Pay seller (₦) <input name="seller_payout" inputmode="decimal" value="0"></label>
                    <label>Charge seller (₦) <small>added to what they owe</small><input name="seller_charge" inputmode="decimal" value="0"></label>
                  </div>
                  <label>Decision note <small>sent to both parties — explain the evidence and the amounts</small>
                    <textarea name="note" required rows="3"></textarea></label>
                  <button class="btn">Decide and move money</button>
                </form>`}
          </section>`,
        )}

        <section class="card">
          <h2>Money</h2>
          <table class="breakdown">${ledger.map(
            (l) => html`<tr><td>${l.kind} → ${l.counterparty} <small class="muted">${l.provider_ref || ''}</small></td>
              <td>${money(l.amount)} <span class="badge badge-${l.status === 'success' ? 'ok' : l.status === 'failed' ? 'warn' : 'muted'}">${l.status}</span>
              ${l.status === 'failed' ? html`<form method="post" action="/admin/ledger/${l.id}/retry" class="inline">${csrf(req)}<button class="linklike">retry</button></form>` : ''}</td></tr>`,
          )}</table>
          <h2>Timeline</h2>
          ${timeline(events, { showDetail: true })}
          <h2>Messages sent</h2>
          <ul class="small">${messages.map((m) => html`<li><strong>${m.to_phone || m.to_email}</strong>: ${m.body}</li>`)}</ul>
        </section>`,
      ),
    );
  });

  r.post('/disputes/:id/resolve', async (req, res) => {
    const dispute = get(ctx.db, 'SELECT * FROM disputes WHERE id = :id', { id: Number(req.params.id) });
    try {
      await resolveDispute(ctx, Number(req.params.id), req.body);
      req.flash('Decision recorded and transfers sent.');
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      req.flash(err.message);
    }
    res.redirect(dispute ? `/admin/orders/${dispute.order_id}` : '/admin/disputes');
  });

  r.get('/disputes', (req, res) => {
    const rows = all(
      ctx.db,
      `SELECT x.*, o.ref, o.amount FROM disputes x JOIN orders o ON o.id = x.order_id
       ORDER BY x.status = 'open' DESC, x.id DESC LIMIT 200`,
    );
    res.send(
      page(
        req,
        'Disputes',
        html`<h1>Disputes</h1><div class="list">${rows.map(
          (x) => html`<a class="row" href="/admin/orders/${x.order_id}">
            <div><strong>${x.ref}</strong> · ${DISPUTE_CATEGORIES[x.category] || x.category}<br><small class="muted">${x.description.slice(0, 120)}</small></div>
            <div class="right"><span class="badge badge-${x.status === 'open' ? 'warn' : 'muted'}">${x.status}</span><br><small>${date(x.created_at)}</small></div>
          </a>`,
        )}</div>`,
      ),
    );
  });

  // ------------------------------------------------------------ sellers

  r.get('/sellers', (req, res) => {
    const sellers = all(ctx.db, 'SELECT * FROM sellers ORDER BY id DESC');
    res.send(
      page(
        req,
        'Sellers',
        html`<h1>Sellers</h1>
        <div class="list">${sellers.map(
          (s) => html`<div class="row">
            <div><strong>${s.business_name}</strong> (${s.full_name})<br>
              <small class="muted">${s.phone} · ${s.email} · payout ${s.payout_verified_at ? '✓' : '✗'}${s.amount_owed ? ` · owes ${money(s.amount_owed)}` : ''}</small></div>
            <div class="right">
              <form method="post" action="/admin/sellers/${s.id}" class="inline">${csrf(req)}
                ${s.identity_verified_at
                  ? html`<span class="badge badge-ok">ID verified</span>`
                  : html`<button class="btn btn-small" name="action" value="verify">Mark ID verified</button>`}
                ${s.suspended_at
                  ? html`<button class="btn btn-small btn-secondary" name="action" value="unsuspend">Unsuspend</button>`
                  : html`<button class="btn btn-small btn-danger" name="action" value="suspend">Suspend</button>`}
                ${s.amount_owed ? html`<button class="btn btn-small btn-secondary" name="action" value="settled">Debt paid</button>` : ''}
              </form>
            </div>
          </div>`,
        )}</div>`,
      ),
    );
  });

  r.post('/sellers/:id', (req, res) => {
    const id = Number(req.params.id);
    const now = ctx.now().toISOString();
    const fields = {
      verify: { identity_verified_at: now },
      suspend: { suspended_at: now },
      unsuspend: { suspended_at: null },
      settled: { amount_owed: 0 },
    }[req.body.action];
    if (fields && getSeller(ctx, id)) update(ctx.db, 'sellers', id, fields);
    res.redirect('/admin/sellers');
  });

  // ------------------------------------------------------------ outbox & ledger

  r.get('/outbox', (req, res) => {
    const rows = all(ctx.db, 'SELECT * FROM outbox ORDER BY id DESC LIMIT 300');
    res.send(
      page(
        req,
        'Messages',
        html`<h1>Messages sent</h1>
        <p class="muted">SMS/WhatsApp messages the system sent. In test mode they are only recorded here.</p>
        <div class="list">${rows.map(
          (m) => html`<div class="row"><div><small class="muted">${date(m.created_at)} · ${m.to_phone || m.to_email}</small><br>${m.body}</div></div>`,
        )}</div>`,
      ),
    );
  });

  r.get('/ledger', (req, res) => {
    const rows = all(ctx.db, 'SELECT l.*, o.ref FROM ledger l LEFT JOIN orders o ON o.id = l.order_id ORDER BY l.id DESC LIMIT 300');
    const totals = all(ctx.db, "SELECT kind, status, SUM(amount) total FROM ledger GROUP BY kind, status ORDER BY kind");
    const held = get(ctx.db, `SELECT COALESCE(SUM(amount),0) t FROM orders WHERE status IN ('paid','shipping','delivered','disputed')`).t;
    res.send(
      page(
        req,
        'Ledger',
        html`<h1>Ledger</h1>
        <div class="stats"><div class="stat"><span>${money(held)}</span>currently held for open orders</div></div>
        <table class="breakdown">${totals.map((t) => html`<tr><td>${t.kind} (${t.status})</td><td>${money(t.total)}</td></tr>`)}</table>
        <h2>Entries</h2>
        <table class="breakdown">${rows.map(
          (l) => html`<tr><td><a href="/admin/orders/${l.order_id}">${l.ref}</a> · ${l.kind} → ${l.counterparty} <small class="muted">${date(l.created_at)}</small></td>
            <td>${money(l.amount)} <span class="badge badge-muted">${l.status}</span></td></tr>`,
        )}</table>`,
      ),
    );
  });

  r.post('/ledger/:id/retry', async (req, res) => {
    const row = await sendTransfer(ctx, Number(req.params.id));
    req.flash(row ? `Transfer status: ${row.status}` : 'Not found');
    res.redirect(row ? `/admin/orders/${row.order_id}` : '/admin/ledger');
  });

  return r;
}
