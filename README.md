# Middleman

Payment protection for Nigerian social-commerce deals (WhatsApp, Instagram, X).
The seller creates a link, the buyer reviews the deal and pays, Middleman holds the money,
the courier delivers, and the seller is paid once the buyer has the item.

> **Status: working pilot build, test mode only.** Payments and the courier are simulated
> by default. Do not take real money until the custody question below is settled.

## Run it

Needs Node.js 22.13 or newer. The only dependency is Express; the database is the SQLite built into Node.

```bash
cd middleman
npm install
npm start          # http://localhost:3000
npm test           # end-to-end journeys + unit tests
```

In development the admin page is `/admin` with password `admin` (set `ADMIN_PASSWORD` in production).
In test mode, use these payout/refund account numbers (any bank) — the name you type must match:

| Account | Name |
|---|---|
| 0000000001 | Adebayo Oluwaseun John |
| 0000000002 | Chioma Ngozi Okafor |
| 0000000003 | Musa Ibrahim Bello |
| 0000000004 | Funmilayo Grace Adeyemi |
| 0000000005 | Emeka Peter Nwosu |

## How a deal flows

1. **Seller** signs up and verifies a payout bank account in their own name (bank name lookup).
2. **Seller creates a link**: item, description, condition, price, private pickup address,
   pickup area, the buyer's delivery area (this sets the delivery fee), ship-within days,
   who pays delivery, who pays the fee (buyer / seller / 50-50), and when the link expires.
   Links can't be edited; "change something" creates a new link and retires the old one.
3. **Buyer, step 1 — review**: sees everything except the pickup address, the full price
   breakdown, the protection rules and the expiry time. "This matches what we agreed" saves an
   exact, hashed copy of the terms.
4. **Buyer, step 2 — details & pay**: name, phone, email, delivery address (confirmed to be
   in the chosen area), and a refund bank account that must be in the buyer's own name.
   The refund account is encrypted and never shown to the seller. Then payment.
5. **Money held**: the buyer gets a 4-digit **delivery PIN**; the seller is told to ship by a deadline.
6. **Seller books pickup** with a packing note (serial number, contents) as evidence.
7. **Rider** uses a private rider link: picked up → out for delivery → enters the buyer's PIN.
   The buyer gives the PIN only after checking the item at the door. A refusal opens a dispute.
8. **Inspection window** (24h by default): the buyer can confirm (seller paid now) or report a
   problem. If they do nothing, the seller is paid automatically.
9. **Disputes**: admin sees both sides, the packing note, the rider's notes and every event,
   then decides the refund, the payout and any charge to the seller. The decision is sent
   to both parties. A seller who owes money can't create links, and the debt is deducted
   from their next payout.

Automatic timers: expire links, cancel abandoned checkouts, release payment after inspection,
and open a dispute if the seller misses the ship-by date. A second payment on an already-paid
link is refunded in full automatically.

## Code map

| Path | What it does |
|---|---|
| `src/core.js` | Business rules: deals, checkout, payment confirmation, delivery, PIN, disputes, payouts, timers |
| `src/money.js` | Kobo amounts and fee maths (`buyerTotal − sellerPayout = delivery + fee`, always) |
| `src/zones.js` | Lagos delivery areas and **placeholder** prices — replace with your courier's rate card |
| `src/terms.js` | The rules shown to buyers and the saved terms snapshot |
| `src/providers/payments/` | `mock` (simulated) and `flutterwave` (v3 API) payment adapters |
| `src/providers/logistics/` | `mock` (manual rider links) and a `fez` stub to fill in |
| `src/providers/notify.js` | SMS/WhatsApp messages — currently saved to the admin "Messages" page |
| `src/routes/` | Seller, buyer, rider, admin and public pages |
| `test/` | Full journeys through the real pages, plus unit tests |

## Before taking real money

1. **Custody.** Collecting into a Flutterwave balance and paying out later is not automatically
   lawful escrow. Get a Nigerian fintech lawyer's opinion and written approval from Flutterwave
   (and the bank) for this exact flow. Keep `ALLOW_LIVE_PAYMENTS=false` until then; the app
   refuses to start with a live Flutterwave key without it.
2. **Flutterwave adapter.** Written against the public v3 docs (`/payments`,
   `/transactions/verify_by_reference`, `/accounts/resolve`, `/banks/NG`, `/transfers`) but not yet
   run against a real account. Test it with `FLWSECK_TEST-` keys and point the webhook at
   `https://your-domain/webhooks/payments` with a secret hash.
3. **Courier.** Replace the zone prices with a written rate card, and implement
   `src/providers/logistics/fez.js` once Fez confirms its API, PIN/OTP handover, and refusal/return
   rules. Until then the manual rider link works for a concierge pilot with your own riders.
4. **Legal review of the rules** in `src/terms.js` (especially deductions when a buyer refuses a
   correct item), plus a privacy notice for the identity, address and bank data you collect.
5. **SMS/WhatsApp.** Plug a provider (Termii, WhatsApp Cloud API, …) into `notify.js` — buyers
   need the PIN and tracking link on their phone.
6. **Operations.** Daily database backups (or move to Postgres), HTTPS, a real `APP_SECRET`, and
   a support channel for disputes.

Not built yet: seller ID document upload (admin marks sellers verified by hand), photo/evidence
uploads on disputes, password reset, rate limiting, and live-provider transfer status webhooks.
