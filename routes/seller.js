import { Router } from 'express';
import { get, all, insert } from '../db.js';
import { hashPassword, verifyPassword } from '../security.js';
import { html } from '../views/html.js';
import { layout, csrf, money, date, dealBadge, orderBadge, timeline, errorBox } from '../views/layout.js';
import { quote } from '../money.js';
import {
  UserError,
  CONDITIONS,
  EXPIRY_OPTIONS,
  ZONES,
  zoneById,
  normalisePhone,
  setPayoutAccount,
  createDeal,
  cancelDeal,
  refreshDeal,
  bookPickup,
  getSeller,
  dealUrl,
  deliveryLabel,
} from '../core.js';

export function sellerRoutes(ctx) {
  const r = Router();

  r.use((req, res, next) => {
    req.seller = req.session.seller_id ? getSeller(ctx, req.session.seller_id) : null;
    next();
  });
  const requireSeller = (req, res, next) => (req.seller ? next() : res.redirect('/seller/login'));
  const page = (req, title, body) => layout(req, { title, body, area: 'seller' });

  // ------------------------------------------------------------ auth

  const signupForm = (req, v = {}, error) =>
    page(
      req,
      'Create seller account',
      html`<section class="card narrow">
        <h1>Create your seller account</h1>
        <p class="muted">Buyers never need an account — only sellers sign up.</p>
        ${errorBox(error)}
        <form method="post" action="/seller/signup" class="form">
          ${csrf(req)}
          <label>Full name <small>exactly as on your bank account</small>
            <input name="full_name" required value="${v.full_name || ''}" autocomplete="name"></label>
          <label>Business / page name <small>what buyers know you as</small>
            <input name="business_name" required value="${v.business_name || ''}"></label>
          <label>Phone (WhatsApp)
            <input name="phone" required inputmode="tel" value="${v.phone || ''}" autocomplete="tel"></label>
          <label>Email <input name="email" type="email" required value="${v.email || ''}" autocomplete="email"></label>
          <label>Password <small>at least 8 characters</small>
            <input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
          <button class="btn">Create account</button>
        </form>
        <p class="muted">Already have an account? <a href="/seller/login">Log in</a></p>
      </section>`,
    );

  r.get('/signup', (req, res) => res.send(signupForm(req)));
  r.post('/signup', (req, res) => {
    const v = req.body;
    try {
      const fullName = String(v.full_name || '').trim();
      if (fullName.split(/\s+/).length < 2) throw new UserError('Enter your full name (first and last name).');
      const business = String(v.business_name || '').trim();
      if (business.length < 2) throw new UserError('Enter your business name.');
      const phone = normalisePhone(v.phone);
      const email = String(v.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new UserError('Enter a valid email.');
      if (String(v.password || '').length < 8) throw new UserError('Password must be at least 8 characters.');
      if (get(ctx.db, 'SELECT id FROM sellers WHERE email = :email', { email })) {
        throw new UserError('An account with that email already exists.');
      }
      const id = insert(ctx.db, 'sellers', {
        full_name: fullName,
        business_name: business,
        phone,
        email,
        password_hash: hashPassword(v.password),
        created_at: ctx.now().toISOString(),
      });
      req.rotateSession({ seller_id: id, flash: 'Account created. Next: add the bank account you want to be paid into.' });
      res.redirect('/seller/settings');
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      res.status(400).send(signupForm(req, v, err.message));
    }
  });

  const loginForm = (req, email = '', error) =>
    page(
      req,
      'Seller login',
      html`<section class="card narrow">
        <h1>Seller login</h1>
        ${errorBox(error)}
        <form method="post" action="/seller/login" class="form">
          ${csrf(req)}
          <label>Email <input name="email" type="email" required value="${email}" autocomplete="email"></label>
          <label>Password <input name="password" type="password" required autocomplete="current-password"></label>
          <button class="btn">Log in</button>
        </form>
        <p class="muted">New here? <a href="/seller/signup">Create an account</a></p>
      </section>`,
    );

  r.get('/login', (req, res) => res.send(loginForm(req)));
  r.post('/login', (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const seller = get(ctx.db, 'SELECT * FROM sellers WHERE email = :email', { email });
    if (!seller || !verifyPassword(String(req.body.password || ''), seller.password_hash)) {
      return res.status(401).send(loginForm(req, email, 'Wrong email or password.'));
    }
    req.rotateSession({ seller_id: seller.id });
    res.redirect('/seller');
  });

  r.post('/logout', (req, res) => {
    req.rotateSession({});
    res.redirect('/');
  });

  // ------------------------------------------------------------ dashboard

  r.get('/', requireSeller, (req, res) => {
    const s = req.seller;
    const orders = all(
      ctx.db,
      `SELECT o.*, d.item_title, d.seller_payout FROM orders o JOIN deals d ON d.id = o.deal_id
       WHERE o.seller_id = :id AND o.status NOT IN ('awaiting_payment', 'cancelled')
       ORDER BY o.id DESC LIMIT 50`,
      { id: s.id },
    );
    const deals = all(ctx.db, "SELECT * FROM deals WHERE seller_id = :id AND status IN ('open','expired') ORDER BY id DESC LIMIT 20", {
      id: s.id,
    }).map((d) => refreshDeal(ctx, d));
    const held = orders.filter((o) => ['paid', 'shipping', 'delivered', 'disputed'].includes(o.status));
    const toShip = orders.filter((o) => o.status === 'paid');

    res.send(
      page(
        req,
        'Dashboard',
        html`<h1>Hi ${s.business_name}</h1>
        ${!s.payout_verified_at
          ? html`<div class="callout warn">Add your payout bank account before you can create payment links. <a href="/seller/settings">Add it now →</a></div>`
          : ''}
        ${s.amount_owed > 0 ? html`<div class="callout warn">You owe ${money(s.amount_owed)} from a past dispute. It will be deducted from your next payout.</div>` : ''}
        <div class="stats">
          <div class="stat"><span>${toShip.length}</span>to pack &amp; ship</div>
          <div class="stat"><span>${money(held.reduce((a, o) => a + o.seller_payout, 0))}</span>held for you</div>
          <div class="stat"><span>${orders.filter((o) => o.status === 'completed').length}</span>completed</div>
        </div>
        <p><a class="btn" href="/seller/deals/new">+ Create a payment link</a></p>

        <h2>Orders</h2>
        ${orders.length
          ? html`<div class="list">${orders.map(
              (o) => html`<a class="row" href="/seller/orders/${o.id}">
                <div><strong>${o.item_title}</strong><br><small class="muted">${o.ref} · ${o.buyer_name} · ${date(o.paid_at)}</small></div>
                <div class="right">${orderBadge(o.status)}<br><small>${money(o.seller_payout)} to you</small></div>
              </a>`,
            )}</div>`
          : html`<p class="muted">No paid orders yet.</p>`}

        <h2>Links waiting for payment</h2>
        ${deals.length
          ? html`<div class="list">${deals.map(
              (d) => html`<a class="row" href="/seller/deals/${d.id}">
                <div><strong>${d.item_title}</strong><br><small class="muted">Buyer pays ${money(d.buyer_total)} · expires ${date(d.expires_at)}</small></div>
                <div class="right">${dealBadge(d.status)}</div>
              </a>`,
            )}</div>`
          : html`<p class="muted">No open links.</p>`}`,
      ),
    );
  });

  // ------------------------------------------------------------ payout settings

  const settingsPage = async (req, error) => {
    const s = req.seller;
    const banks = await ctx.payments.listBanks();
    return page(
      req,
      'Settings',
      html`<section class="card narrow">
        <h1>Payout account</h1>
        <p class="muted">Where we send your money. It must be in your own name: <strong>${s.full_name}</strong>.</p>
        ${s.payout_verified_at
          ? html`<div class="callout ok">✓ ${s.payout_bank_name} · ${s.payout_account_number} · ${s.payout_account_name}</div>`
          : ''}
        ${errorBox(error)}
        <form method="post" action="/seller/settings/payout" class="form">
          ${csrf(req)}
          <label>Bank
            <select name="bank_code" required>
              <option value="">Choose your bank</option>
              ${banks.map((b) => html`<option value="${b.code}" ${b.code === s.payout_bank_code ? 'selected' : ''}>${b.name}</option>`)}
            </select></label>
          <label>Account number <input name="account_number" required inputmode="numeric" pattern="\\d{10}" maxlength="10"></label>
          ${ctx.payments.name === 'mock' ? testAccountsHint() : ''}
          <button class="btn">${s.payout_verified_at ? 'Change' : 'Verify and save'} account</button>
        </form>
      </section>
      <section class="card narrow">
        <h2>Identity</h2>
        ${s.identity_verified_at
          ? html`<p class="callout ok">✓ Identity verified on ${date(s.identity_verified_at)}. Buyers see a verified badge.</p>`
          : html`<p>Not verified yet. During the pilot, Middleman verifies sellers manually (ID card + a short call).
              Buyers see “Identity not yet verified” on your links until then.</p>`}
      </section>`,
    );
  };

  r.get('/settings', requireSeller, async (req, res) => res.send(await settingsPage(req)));
  r.post('/settings/payout', requireSeller, async (req, res) => {
    try {
      const name = await setPayoutAccount(ctx, req.seller, req.body);
      req.flash(`Payout account verified: ${name}.`);
      res.redirect('/seller');
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      res.status(400).send(await settingsPage(req, err.message));
    }
  });

  // ------------------------------------------------------------ deals

  const dealForm = (req, v, error) => {
    const s = req.seller;
    const zoneOptions = (selected) =>
      ZONES.map((z) => html`<option value="${z.id}" ${z.id === selected ? 'selected' : ''}>${z.name}</option>`);
    const radio = (name, value, label) =>
      html`<label class="choice"><input type="radio" name="${name}" value="${value}" ${v[name] === value ? 'checked' : ''} required> ${label}</label>`;
    return page(
      req,
      'New payment link',
      html`<section class="card">
        <h1>${v.replaces ? 'Revise payment link' : 'New payment link'}</h1>
        <p class="muted">Fill this in exactly as you agreed with the buyer on WhatsApp/Instagram. The buyer will see all of it before paying, and it can’t be changed afterwards.</p>
        ${errorBox(error)}
        <form method="post" action="/seller/deals" class="form">
          ${csrf(req)}
          ${v.replaces ? html`<input type="hidden" name="replaces" value="${v.replaces}">` : ''}
          <fieldset><legend>The item</legend>
            <label>Item name <input name="item_title" required maxlength="120" value="${v.item_title || ''}" placeholder="Nike Tech Fleece sneakers, size 42, blue"></label>
            <label>Full description <small>colour, size, model, what’s in the box, any defects</small>
              <textarea name="item_description" required rows="4" maxlength="1000">${v.item_description || ''}</textarea></label>
            <div class="grid2">
              <label>Condition
                <select name="item_condition" required>
                  <option value="">Choose</option>
                  ${CONDITIONS.map((c) => html`<option ${c === v.item_condition ? 'selected' : ''}>${c}</option>`)}
                </select></label>
              <label>Quantity <input name="quantity" type="number" min="1" max="100" value="${v.quantity || 1}" required></label>
            </div>
            <label>Item price (₦) <input name="item_price" required inputmode="decimal" value="${v.item_price || ''}" placeholder="45000"></label>
          </fieldset>
          <fieldset><legend>Delivery</legend>
            <label>Your pickup address <small>private — only the courier sees it</small>
              <textarea name="pickup_address" required rows="2" maxlength="300">${v.pickup_address ?? s.pickup_address ?? ''}</textarea></label>
            <div class="grid2">
              <label>Your pickup area <select name="pickup_zone" required><option value="">Choose</option>${zoneOptions(v.pickup_zone ?? s.pickup_zone)}</select></label>
              <label>Buyer’s delivery area <select name="delivery_zone" required><option value="">Choose</option>${zoneOptions(v.delivery_zone)}</select></label>
            </div>
            <p class="muted small">The buyer types their exact address on the payment page. It must be inside the area you choose here, because that sets the delivery price.</p>
            <label>You will hand the item to the courier within
              <select name="delivery_days">${[1, 2, 3, 5, 7].map((n) => html`<option value="${n}" ${String(n) === String(v.delivery_days ?? 2) ? 'selected' : ''}>${n} day${n > 1 ? 's' : ''}</option>`)}</select></label>
          </fieldset>
          <fieldset><legend>Who pays what (as agreed)</legend>
            <p class="label">Delivery fee</p>
            <div class="choices">${radio('delivery_payer', 'buyer', 'Buyer pays')}${radio('delivery_payer', 'seller', 'I pay')}</div>
            <p class="label">Middleman fee (${ctx.config.fee.percent}%, min ${money(ctx.config.fee.minKobo)}, max ${money(ctx.config.fee.capKobo)})</p>
            <div class="choices">${radio('fee_payer', 'buyer', 'Buyer pays')}${radio('fee_payer', 'seller', 'I pay')}${radio('fee_payer', 'split', 'Split 50/50')}</div>
          </fieldset>
          <label>Link expires if not paid within
            <select name="expires_hours">${EXPIRY_OPTIONS.map((h) => html`<option value="${h}" ${String(h) === String(v.expires_hours ?? 24) ? 'selected' : ''}>${h < 24 ? h + ' hour' + (h > 1 ? 's' : '') : h / 24 + ' day' + (h > 24 ? 's' : '')}</option>`)}</select></label>
          <button class="btn">Create link</button>
        </form>
      </section>`,
    );
  };

  r.get('/deals/new', requireSeller, (req, res) => {
    if (!req.seller.payout_verified_at) {
      req.flash('Add your payout bank account first.');
      return res.redirect('/seller/settings');
    }
    let v = {};
    if (req.query.revise) {
      const d = get(ctx.db, 'SELECT * FROM deals WHERE id = :id AND seller_id = :sid', { id: Number(req.query.revise), sid: req.seller.id });
      if (d) v = { ...d, item_price: d.item_price / 100, replaces: d.status === 'open' ? d.id : '' };
    }
    res.send(dealForm(req, v));
  });

  r.post('/deals', requireSeller, (req, res) => {
    try {
      const deal = createDeal(ctx, req.seller, req.body);
      res.redirect(`/seller/deals/${deal.id}?new=1`);
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      res.status(400).send(dealForm(req, req.body, err.message));
    }
  });

  r.get('/deals/:id', requireSeller, (req, res) => {
    let d = get(ctx.db, 'SELECT * FROM deals WHERE id = :id AND seller_id = :sid', { id: Number(req.params.id), sid: req.seller.id });
    if (!d) return res.status(404).send(page(req, 'Not found', html`<p>Link not found.</p>`));
    d = refreshDeal(ctx, d);
    const url = dealUrl(ctx, d);
    const q = quote(
      { itemPrice: d.item_price, deliveryFee: d.delivery_fee, deliveryPayer: d.delivery_payer, feePayer: d.fee_payer },
      ctx.config.fee,
    );
    const order = get(ctx.db, "SELECT id FROM orders WHERE deal_id = :id AND status NOT IN ('awaiting_payment','cancelled','duplicate_refunded')", { id: d.id });
    const waText = `Hi! Here is the secure payment link for ${d.item_title}. Your money is held by Middleman until you receive the item: ${url}`;
    res.send(
      page(
        req,
        d.item_title,
        html`<section class="card">
          ${req.query.new ? html`<div class="callout ok">Link created. Send it to your buyer.</div>` : ''}
          <div class="spread"><h1>${d.item_title}</h1>${dealBadge(d.status)}</div>
          ${d.status === 'open'
            ? html`<div class="share">
                <input readonly value="${url}" aria-label="Payment link">
                <button type="button" class="btn" data-copy="${url}">Copy link</button>
                <a class="btn btn-wa" href="https://wa.me/?text=${encodeURIComponent(waText)}" target="_blank" rel="noopener">Share on WhatsApp</a>
              </div>
              <p class="muted small">Expires ${date(d.expires_at)} if not paid.</p>`
            : ''}
          ${order ? html`<p><a class="btn" href="/seller/orders/${order.id}">View the order →</a></p>` : ''}
          <h2>Money</h2>
          <table class="breakdown">
            <tr><td>Item price</td><td>${money(q.itemPrice)}</td></tr>
            <tr><td>Delivery (${zoneById(d.pickup_zone)?.name} → ${zoneById(d.delivery_zone)?.name}) — paid by ${d.delivery_payer === 'buyer' ? 'buyer' : 'you'}</td><td>${money(q.deliveryFee)}</td></tr>
            <tr><td>Middleman fee — paid by ${{ buyer: 'buyer', seller: 'you', split: 'both, 50/50' }[d.fee_payer]}</td><td>${money(q.platformFee)}</td></tr>
            <tr class="total"><td>Buyer pays</td><td>${money(q.buyerTotal)}</td></tr>
            <tr class="total"><td>You receive after delivery</td><td>${money(q.sellerPayout)}</td></tr>
          </table>
          <h2>Details shown to the buyer</h2>
          <p><strong>Condition:</strong> ${d.item_condition} · <strong>Quantity:</strong> ${d.quantity}</p>
          <p class="pre">${d.item_description}</p>
          <p><strong>Ships within:</strong> ${d.delivery_days} day(s)</p>
          ${d.status === 'open'
            ? html`<div class="actions">
                <a class="btn btn-secondary" href="/seller/deals/new?revise=${d.id}">Change something (makes a new link)</a>
                <form method="post" action="/seller/deals/${d.id}/cancel">${csrf(req)}<button class="btn btn-danger">Cancel link</button></form>
              </div>`
            : d.status === 'expired'
              ? html`<p><a class="btn btn-secondary" href="/seller/deals/new?revise=${d.id}">Create a fresh link with the same details</a></p>`
              : ''}
        </section>`,
      ),
    );
  });

  r.post('/deals/:id/cancel', requireSeller, (req, res) => {
    try {
      cancelDeal(ctx, req.seller, Number(req.params.id));
      req.flash('Link cancelled. The buyer can no longer pay it.');
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      req.flash(err.message);
    }
    res.redirect(`/seller/deals/${req.params.id}`);
  });

  // ------------------------------------------------------------ orders

  r.get('/orders/:id', requireSeller, (req, res) => {
    const o = get(ctx.db, 'SELECT * FROM orders WHERE id = :id AND seller_id = :sid', { id: Number(req.params.id), sid: req.seller.id });
    if (!o) return res.status(404).send(page(req, 'Not found', html`<p>Order not found.</p>`));
    const d = get(ctx.db, 'SELECT * FROM deals WHERE id = :id', { id: o.deal_id });
    const events = all(ctx.db, 'SELECT * FROM order_events WHERE order_id = :id ORDER BY id', { id: o.id });
    const dispute = get(ctx.db, 'SELECT * FROM disputes WHERE order_id = :id ORDER BY id DESC', { id: o.id });
    res.send(
      page(
        req,
        `Order ${o.ref}`,
        html`<section class="card">
          <div class="spread"><h1>Order ${o.ref}</h1>${orderBadge(o.status)}</div>
          <p><strong>${d.item_title}</strong> · ${money(d.seller_payout)} to you after delivery</p>
          <p class="muted">Buyer: ${o.buyer_name} · Delivery area: ${zoneById(d.delivery_zone)?.name}</p>
          ${o.status === 'paid'
            ? html`<div class="callout info">
                <strong>The buyer’s money is secured.</strong> Pack the item and book pickup before ${date(o.ship_by)}, or the buyer is refunded.
                <form method="post" action="/seller/orders/${o.id}/book" class="form">
                  ${csrf(req)}
                  <label>Packing note <small>serial/IMEI, colour, size, what’s in the box — this is your evidence if there is a dispute</small>
                    <textarea name="packing_note" required rows="3" maxlength="500"></textarea></label>
                  <button class="btn">Item is packed — book pickup</button>
                </form>
              </div>`
            : ''}
          ${o.status === 'shipping' ? html`<p>Parcel status: <strong>${deliveryLabel(o.delivery_status)}</strong></p>` : ''}
          ${o.status === 'delivered' ? html`<p>Delivered ${date(o.delivered_at)}. You will be paid when the buyer confirms or at ${date(o.inspection_ends_at)}.</p>` : ''}
          ${dispute
            ? html`<div class="callout ${dispute.status === 'open' ? 'warn' : 'info'}">
                <strong>${dispute.status === 'open' ? 'Under review' : 'Decided'}:</strong> ${dispute.description}
                ${dispute.resolution_note ? html`<br><strong>Decision:</strong> ${dispute.resolution_note} (paid to you: ${money(dispute.seller_payout || 0)})` : ''}
                ${dispute.status === 'open' ? html`<br><small>Send photos, packing video or chat screenshots to Middleman support quoting ${o.ref}.</small>` : ''}
              </div>`
            : ''}
          <h2>Timeline</h2>
          ${timeline(events)}
        </section>`,
      ),
    );
  });

  r.post('/orders/:id/book', requireSeller, async (req, res) => {
    try {
      await bookPickup(ctx, req.seller, Number(req.params.id), req.body.packing_note);
      req.flash('Pickup booked. The buyer has been notified.');
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      req.flash(err.message);
    }
    res.redirect(`/seller/orders/${req.params.id}`);
  });

  return r;
}

export function testAccountsHint() {
  return html`<details class="hint"><summary>Test mode: use a test account number</summary>
    <ul>
      <li>0000000001 — Adebayo Oluwaseun John</li>
      <li>0000000002 — Chioma Ngozi Okafor</li>
      <li>0000000003 — Musa Ibrahim Bello</li>
      <li>0000000004 — Funmilayo Grace Adeyemi</li>
      <li>0000000005 — Emeka Peter Nwosu</li>
    </ul>
    <p>Pick any bank. The name you registered with must match.</p>
  </details>`;
}

