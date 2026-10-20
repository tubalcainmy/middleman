import { Router } from 'express';
import { html } from '../views/html.js';
import { layout } from '../views/layout.js';
import { confirmPayment } from '../core.js';

export function publicRoutes(ctx) {
  const r = Router();
  const page = (req, title, body) => layout(req, { title, body });

  r.get('/', (req, res) => {
    res.send(
      page(
        req,
        'Pay safely for online deals',
        html`<section class="hero">
          <h1>Sell on WhatsApp &amp; Instagram.<br>Get paid without the trust wahala.</h1>
          <p>Send your buyer one Middleman link. They pay, we hold the money, the courier delivers, and you get paid once the buyer has the item. No pay-on-delivery runarounds, no “send money first” fear.</p>
          <p><a class="btn" href="/seller/signup">Create a free seller account</a> <a class="btn btn-secondary" href="/how-it-works">How it works</a></p>
        </section>
        <section class="three">
          <div class="card"><h3>1. You create a link</h3><p>Item, price, condition, who pays delivery and fees — exactly as you agreed in the chat.</p></div>
          <div class="card"><h3>2. Buyer reviews &amp; pays</h3><p>No account needed. They check every detail, add their address and pay. The money is held, not sent to you yet.</p></div>
          <div class="card"><h3>3. Deliver, then get paid</h3><p>The rider only marks it delivered with the buyer’s PIN. After a short inspection window, your money is released.</p></div>
        </section>`,
      ),
    );
  });

  r.get('/how-it-works', (req, res) => {
    res.send(
      page(
        req,
        'How it works',
        html`<section class="card">
          <h1>How Middleman protects both sides</h1>
          <h2>For buyers</h2>
          <ul>
            <li>You see the exact item, condition, price, delivery fee and rules before you pay. That version is saved and can’t be changed.</li>
            <li>Your money is held until the item reaches you. You get a 4-digit delivery PIN — only give it to the rider after checking the item.</li>
            <li>After delivery you have a short inspection window to report hidden problems.</li>
            <li>Wrong, fake or damaged item? It goes back and you’re refunded to your own bank account.</li>
          </ul>
          <h2>For sellers</h2>
          <ul>
            <li>You only ship once the buyer’s money is secured.</li>
            <li>No more buyers refusing to pay at the door: delivery is confirmed with the buyer’s PIN.</li>
            <li>If the buyer goes quiet after delivery, you are paid automatically when the inspection window ends.</li>
            <li>Your packing note and the courier’s records are evidence if there is a dispute.</li>
          </ul>
          <h2>Fees</h2>
          <p>${ctx.config.fee.percent}% of the item price (minimum ₦${ctx.config.fee.minKobo / 100}, maximum ₦${(ctx.config.fee.capKobo / 100).toLocaleString()}). You and the buyer agree who pays it — it’s shown on the link.</p>
        </section>`,
      ),
    );
  });

  // Payment provider webhook. We only use it as a hint and re-verify with the provider's API.
  r.post('/webhooks/payments', async (req, res) => {
    const hint = ctx.payments.parseWebhook(req);
    if (!hint) return res.status(401).end();
    await confirmPayment(ctx, hint.txRef, 'webhook');
    res.status(200).end();
  });

  r.get('/healthz', (req, res) => res.json({ ok: true }));
  return r;
}
