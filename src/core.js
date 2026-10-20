import { get, all, run, insert, update, transaction } from './db.js';
import { nairaToKobo, quote, formatNaira } from './money.js';
import { ZONES, zoneById, deliveryFeeKobo } from './zones.js';
import { buildTerms, hashTerms } from './terms.js';
import { namesMatch } from './names.js';
import { randomToken, humanRef, randomPin, encrypt, decrypt, safeEqual } from './security.js';

export class UserError extends Error {}

export const CONDITIONS = [
  'Brand new (sealed)',
  'Brand new (open box)',
  'Used - like new',
  'Used - good condition',
  'Used - fair condition',
];
export const EXPIRY_OPTIONS = [1, 6, 24, 72];
export const BUYER_DISPUTE_CATEGORIES = {
  not_delivered: 'Item not delivered',
  wrong_item: 'Wrong item sent',
  damaged: 'Item damaged',
  not_as_described: 'Not as described',
  counterfeit: 'Item is fake',
  changed_mind: 'I changed my mind',
  other: 'Something else',
};
export const DISPUTE_CATEGORIES = {
  ...BUYER_DISPUTE_CATEGORIES,
  refused_at_door: 'Refused at the door',
  not_shipped: 'Seller did not ship in time',
  seller_issue: 'Raised by seller',
};

const HOUR = 3_600_000;
const iso = (d) => d.toISOString();
const addHours = (d, h) => new Date(d.getTime() + h * HOUR);
const str = (v) => String(v ?? '').trim();

function requireLength(value, label, min, max) {
  const v = str(value);
  if (v.length < min) throw new UserError(`${label} is too short.`);
  if (v.length > max) throw new UserError(`${label} is too long (max ${max} characters).`);
  return v;
}

export function normalisePhone(input) {
  const digits = str(input).replace(/[^\d+]/g, '');
  let m;
  if ((m = digits.match(/^(?:\+?234|0)([789][01]\d{8})$/))) return '+234' + m[1];
  throw new UserError('Enter a valid Nigerian phone number, e.g. 0803 123 4567.');
}

function event(ctx, orderId, actor, type, detail = null) {
  insert(ctx.db, 'order_events', {
    order_id: orderId,
    actor,
    type,
    detail: detail == null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail),
    created_at: iso(ctx.now()),
  });
}

export const getSeller = (ctx, id) => get(ctx.db, 'SELECT * FROM sellers WHERE id = :id', { id });
export const getDeal = (ctx, id) => get(ctx.db, 'SELECT * FROM deals WHERE id = :id', { id });
export const getOrder = (ctx, id) => get(ctx.db, 'SELECT * FROM orders WHERE id = :id', { id });
export const buyerUrl = (ctx, order) => `${ctx.config.baseUrl}/o/${order.buyer_token}`;
export const dealUrl = (ctx, deal) => `${ctx.config.baseUrl}/d/${deal.token}`;

// ---------------------------------------------------------------- sellers

export async function setPayoutAccount(ctx, seller, input) {
  const bankCode = str(input.bank_code);
  const accountNumber = str(input.account_number);
  if (!/^\d{10}$/.test(accountNumber)) throw new UserError('Account number must be 10 digits.');
  const bank = (await ctx.payments.listBanks()).find((b) => b.code === bankCode);
  if (!bank) throw new UserError('Choose your bank.');
  let accountName;
  try {
    ({ accountName } = await ctx.payments.resolveAccount({ bankCode, accountNumber }));
  } catch (err) {
    throw new UserError(`We could not confirm that account: ${err.message}`);
  }
  if (!namesMatch(seller.full_name, accountName)) {
    throw new UserError(
      `That account belongs to "${accountName}", which does not match your registered name "${seller.full_name}". Payouts can only go to an account in your own name.`,
    );
  }
  update(ctx.db, 'sellers', seller.id, {
    payout_bank_code: bankCode,
    payout_bank_name: bank.name,
    payout_account_number: accountNumber,
    payout_account_name: accountName,
    payout_verified_at: iso(ctx.now()),
  });
  return accountName;
}

// ---------------------------------------------------------------- deals

export function createDeal(ctx, seller, input) {
  if (seller.suspended_at) throw new UserError('Your account is suspended. Contact support.');
  if (!seller.payout_verified_at) throw new UserError('Add and verify your payout bank account before creating links.');
  if (seller.amount_owed > 0) {
    throw new UserError(`You owe ${formatNaira(seller.amount_owed)} from a past dispute. Settle it before creating new links.`);
  }

  const itemTitle = requireLength(input.item_title, 'Item name', 3, 120);
  const itemDescription = requireLength(input.item_description, 'Description', 10, 1000);
  const itemCondition = str(input.item_condition);
  if (!CONDITIONS.includes(itemCondition)) throw new UserError('Choose the item condition.');
  const quantity = Number(input.quantity || 1);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) throw new UserError('Quantity must be 1 to 100.');
  const itemPrice = nairaToKobo(input.item_price);
  if (itemPrice == null || itemPrice < 500 * 100) throw new UserError('Price must be at least ₦500.');
  if (itemPrice > ctx.config.maxDealKobo) {
    throw new UserError(`During the pilot, deals are limited to ${formatNaira(ctx.config.maxDealKobo)}.`);
  }
  const pickupAddress = requireLength(input.pickup_address, 'Pickup address', 10, 300);
  const pickupZone = str(input.pickup_zone);
  const deliveryZone = str(input.delivery_zone);
  if (!zoneById(pickupZone)) throw new UserError('Choose your pickup area.');
  if (!zoneById(deliveryZone)) throw new UserError("Choose the buyer's delivery area.");
  const deliveryPayer = str(input.delivery_payer);
  const feePayer = str(input.fee_payer);
  if (!['buyer', 'seller'].includes(deliveryPayer)) throw new UserError('Choose who pays for delivery.');
  if (!['buyer', 'seller', 'split'].includes(feePayer)) throw new UserError('Choose who pays the Middleman fee.');
  const deliveryDays = Number(input.delivery_days || 2);
  if (!Number.isInteger(deliveryDays) || deliveryDays < 1 || deliveryDays > 7) {
    throw new UserError('Ship-within must be 1 to 7 days.');
  }
  const expiresHours = Number(input.expires_hours || 24);
  if (!EXPIRY_OPTIONS.includes(expiresHours)) throw new UserError('Choose when the link expires.');

  const deliveryFee = deliveryFeeKobo(pickupZone, deliveryZone);
  const q = quote({ itemPrice, deliveryFee, deliveryPayer, feePayer }, ctx.config.fee);
  if (q.sellerPayout <= 0) throw new UserError('After delivery and fees you would receive nothing. Adjust the price or who pays.');

  const now = ctx.now();
  return transaction(ctx.db, () => {
    let replacesId = null;
    if (input.replaces) {
      const old = get(ctx.db, 'SELECT * FROM deals WHERE id = :id AND seller_id = :sid', {
        id: Number(input.replaces),
        sid: seller.id,
      });
      if (old && old.status === 'open') {
        update(ctx.db, 'deals', old.id, { status: 'replaced' });
        replacesId = old.id;
      }
    }
    const id = insert(ctx.db, 'deals', {
      token: randomToken(12),
      seller_id: seller.id,
      replaces_deal_id: replacesId,
      item_title: itemTitle,
      item_description: itemDescription,
      item_condition: itemCondition,
      quantity,
      item_price: itemPrice,
      pickup_address: pickupAddress,
      pickup_zone: pickupZone,
      delivery_zone: deliveryZone,
      delivery_fee: deliveryFee,
      delivery_payer: deliveryPayer,
      fee_payer: feePayer,
      platform_fee: q.platformFee,
      buyer_total: q.buyerTotal,
      seller_payout: q.sellerPayout,
      delivery_days: deliveryDays,
      inspection_hours: ctx.config.inspectionHours,
      status: 'open',
      expires_at: iso(addHours(now, expiresHours)),
      created_at: iso(now),
    });
    update(ctx.db, 'sellers', seller.id, { pickup_address: pickupAddress, pickup_zone: pickupZone });
    return getDeal(ctx, id);
  });
}

// Returns the deal with an up-to-date status (expiring it if its time has passed).
export function refreshDeal(ctx, deal) {
  if (deal && deal.status === 'open' && new Date(deal.expires_at) <= ctx.now()) {
    update(ctx.db, 'deals', deal.id, { status: 'expired' });
    return { ...deal, status: 'expired' };
  }
  return deal;
}

export function cancelDeal(ctx, seller, dealId) {
  const deal = get(ctx.db, 'SELECT * FROM deals WHERE id = :id AND seller_id = :sid', { id: dealId, sid: seller.id });
  if (!deal) throw new UserError('Deal not found.');
  if (deal.status !== 'open') throw new UserError('Only an unpaid, open link can be cancelled.');
  update(ctx.db, 'deals', deal.id, { status: 'cancelled' });
}

// ---------------------------------------------------------------- buyer checkout

export function startCheckout(ctx, deal, sessionId) {
  deal = refreshDeal(ctx, deal);
  if (deal.status !== 'open') throw new UserError('This link is no longer available.');
  const seller = getSeller(ctx, deal.seller_id);
  const { json, hash } = hashTerms(buildTerms(deal, seller));
  const id = randomToken(15);
  insert(ctx.db, 'checkouts', {
    id,
    deal_id: deal.id,
    terms_json: json,
    terms_hash: hash,
    session_id: sessionId,
    created_at: iso(ctx.now()),
  });
  return id;
}

export function getCheckout(ctx, deal, checkoutId) {
  const c = get(ctx.db, 'SELECT * FROM checkouts WHERE id = :id AND deal_id = :dealId', {
    id: str(checkoutId),
    dealId: deal.id,
  });
  if (!c || new Date(c.created_at) < addHours(ctx.now(), -2)) return null;
  return c;
}

export async function placeOrder(ctx, { deal, checkout, input }) {
  const buyerName = requireLength(input.buyer_name, 'Full name', 3, 100);
  if (buyerName.split(/\s+/).length < 2) throw new UserError('Enter your full name (first and last name).');
  const buyerPhone = normalisePhone(input.buyer_phone);
  const buyerEmail = str(input.buyer_email).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail)) throw new UserError('Enter a valid email address.');
  const deliveryAddress = requireLength(input.delivery_address, 'Delivery address', 10, 300);
  const deliveryLandmark = str(input.delivery_landmark).slice(0, 200);
  if (input.confirm_area !== 'yes') throw new UserError('Confirm that your address is in the delivery area shown.');
  const bankCode = str(input.refund_bank_code);
  const accountNumber = str(input.refund_account_number);
  if (!/^\d{10}$/.test(accountNumber)) throw new UserError('Refund account number must be 10 digits.');
  const bank = (await ctx.payments.listBanks()).find((b) => b.code === bankCode);
  if (!bank) throw new UserError('Choose the bank for refunds.');

  let accountName;
  try {
    ({ accountName } = await ctx.payments.resolveAccount({ bankCode, accountNumber }));
  } catch (err) {
    throw new UserError(`We could not confirm your refund account: ${err.message}`);
  }
  if (!namesMatch(buyerName, accountName)) {
    throw new UserError(
      `The refund account belongs to "${accountName}". Refunds can only go to an account in your own name — use your own account, or enter your name exactly as your bank has it.`,
    );
  }

  const now = ctx.now();
  const order = transaction(ctx.db, () => {
    const fresh = refreshDeal(ctx, getDeal(ctx, deal.id));
    if (fresh.status !== 'open') throw new UserError('This link is no longer available.');
    const id = insert(ctx.db, 'orders', {
      ref: humanRef('MM'),
      deal_id: deal.id,
      seller_id: deal.seller_id,
      buyer_token: randomToken(18),
      buyer_name: buyerName,
      buyer_phone: buyerPhone,
      buyer_email: buyerEmail,
      delivery_address: deliveryAddress,
      delivery_landmark: deliveryLandmark || null,
      refund_bank_code: bankCode,
      refund_bank_name: bank.name,
      refund_account_enc: encrypt(accountNumber, ctx.config.appSecret),
      refund_account_last4: accountNumber.slice(-4),
      refund_account_name: accountName,
      terms_json: checkout.terms_json,
      terms_hash: checkout.terms_hash,
      terms_accepted_at: checkout.created_at,
      amount: deal.buyer_total,
      status: 'awaiting_payment',
      tx_ref: 'MMTX-' + randomToken(12),
      created_at: iso(now),
    });
    event(ctx, id, 'buyer', 'terms_accepted', { terms_hash: checkout.terms_hash });
    event(ctx, id, 'buyer', 'checkout_started');
    return getOrder(ctx, id);
  });

  const { url } = await ctx.payments.createCheckout({
    order,
    redirectUrl: `${ctx.config.baseUrl}/payments/callback`,
    title: deal.item_title,
  });
  return { order, paymentUrl: url };
}

// Idempotent. Safe to call from the redirect, the webhook and the background job.
export async function confirmPayment(ctx, txRef, actor = 'system') {
  const order = get(ctx.db, 'SELECT * FROM orders WHERE tx_ref = :txRef', { txRef: str(txRef) });
  if (!order) return null;
  if (!['awaiting_payment', 'cancelled'].includes(order.status)) return order;

  const v = await ctx.payments.verify(order.tx_ref);
  if (v.status !== 'successful') {
    if (v.status === 'failed' && order.status === 'awaiting_payment') event(ctx, order.id, actor, 'payment_failed');
    return getOrder(ctx, order.id);
  }
  if (v.currency !== 'NGN' || v.amount < order.amount) {
    event(ctx, order.id, actor, 'payment_mismatch', { expected: order.amount, got: v.amount, currency: v.currency });
    return getOrder(ctx, order.id);
  }

  const deal = getDeal(ctx, order.deal_id);
  const now = ctx.now();
  const alreadyPaid = get(
    ctx.db,
    `SELECT id FROM orders WHERE deal_id = :dealId AND id != :id
     AND status IN ('paid','shipping','delivered','disputed','completed','refunded')`,
    { dealId: deal.id, id: order.id },
  );

  if (alreadyPaid) {
    // Two people (or two tabs) paid the same link. Refund the second payment in full.
    const ledgerId = transaction(ctx.db, () => {
      update(ctx.db, 'orders', order.id, {
        status: 'duplicate_refunded',
        provider_tx_id: v.providerTxId,
        paid_at: iso(now),
        closed_at: iso(now),
      });
      event(ctx, order.id, actor, 'duplicate_payment_refunded');
      insertLedger(ctx, order.id, 'collected', v.amount, 'buyer', 'success');
      return insertLedger(ctx, order.id, 'buyer_refund', v.amount, 'buyer', 'pending');
    });
    await sendTransfer(ctx, ledgerId);
    ctx.notify.send({
      orderId: order.id,
      phone: order.buyer_phone,
      body: `This deal had already been paid for, so your payment of ${formatNaira(v.amount)} is being refunded in full to your ${order.refund_bank_name} account ending ${order.refund_account_last4}.`,
    });
    return getOrder(ctx, order.id);
  }

  const pin = randomPin();
  const shipBy = addHours(now, deal.delivery_days * 24);
  transaction(ctx.db, () => {
    update(ctx.db, 'orders', order.id, {
      status: 'paid',
      provider_tx_id: v.providerTxId,
      paid_at: iso(now),
      delivery_pin_enc: encrypt(pin, ctx.config.appSecret),
      ship_by: iso(shipBy),
    });
    update(ctx.db, 'deals', deal.id, { status: 'paid' });
    insertLedger(ctx, order.id, 'collected', v.amount, 'buyer', 'success');
    event(ctx, order.id, actor, 'payment_received', { amount: v.amount });
  });

  const seller = getSeller(ctx, deal.seller_id);
  ctx.notify.send({
    orderId: order.id,
    phone: seller.phone,
    body: `Middleman: ${formatNaira(order.amount)} for "${deal.item_title}" is secured (order ${order.ref}). Pack the item and book pickup in your dashboard before ${fmtDate(shipBy)}.`,
  });
  ctx.notify.send({
    orderId: order.id,
    phone: order.buyer_phone,
    email: order.buyer_email,
    body: `Middleman: payment received for "${deal.item_title}" (order ${order.ref}). Your money is held until delivery. Your delivery PIN is ${pin} — give it to the rider ONLY after checking the item. Track: ${buyerUrl(ctx, order)}`,
  });
  return getOrder(ctx, order.id);
}

export function revealPin(ctx, order) {
  return order.delivery_pin_enc ? decrypt(order.delivery_pin_enc, ctx.config.appSecret) : null;
}

// ---------------------------------------------------------------- delivery

export async function bookPickup(ctx, seller, orderId, packingNote) {
  const order = get(ctx.db, 'SELECT * FROM orders WHERE id = :id AND seller_id = :sid', { id: orderId, sid: seller.id });
  if (!order) throw new UserError('Order not found.');
  if (order.status !== 'paid') throw new UserError('Pickup can only be booked for a paid order that has not shipped.');
  const note = str(packingNote).slice(0, 500);
  if (note.length < 5) {
    throw new UserError('Add a short packing note (e.g. serial number, colour, what is in the box). It helps if there is a dispute.');
  }
  const deal = getDeal(ctx, order.deal_id);
  const booking = await ctx.logistics.book({ order, deal, seller });
  const now = ctx.now();
  transaction(ctx.db, () => {
    update(ctx.db, 'orders', order.id, {
      status: 'shipping',
      delivery_status: 'booked',
      delivery_ref: booking.deliveryRef,
      rider_token: booking.riderToken || null,
      packing_note: note,
      dispatched_at: iso(now),
    });
    insertLedger(ctx, order.id, 'delivery_cost', deal.delivery_fee, 'courier', 'pending');
    event(ctx, order.id, 'seller', 'pickup_booked', { delivery_ref: booking.deliveryRef, packing_note: note });
  });
  ctx.notify.send({
    orderId: order.id,
    phone: order.buyer_phone,
    body: `Middleman: the seller has packed "${deal.item_title}" and a pickup is booked (order ${order.ref}). Track: ${buyerUrl(ctx, order)}`,
  });
  return booking;
}

const DELIVERY_STEPS = {
  picked_up: { from: ['booked'], label: 'Picked up from seller' },
  out_for_delivery: { from: ['booked', 'picked_up', 'attempt_failed'], label: 'Out for delivery' },
  attempt_failed: { from: ['picked_up', 'out_for_delivery'], label: 'Delivery attempt failed' },
  refused: { from: ['picked_up', 'out_for_delivery', 'attempt_failed'], label: 'Refused by buyer at the door' },
  returned: { from: ['refused'], label: 'Returned to seller' },
};
export const deliveryLabel = (s) =>
  ({ not_booked: 'Not booked', booked: 'Pickup booked', delivered: 'Delivered' })[s] || DELIVERY_STEPS[s]?.label || s;

export function applyDeliveryUpdate(ctx, order, { status, note, actor }) {
  const step = DELIVERY_STEPS[status];
  if (!step) throw new UserError('Unknown delivery update.');
  if (!step.from.includes(order.delivery_status)) {
    throw new UserError(`Cannot mark "${step.label}" while the parcel is "${deliveryLabel(order.delivery_status)}".`);
  }
  const reason = str(note).slice(0, 500);
  if (['attempt_failed', 'refused'].includes(status) && reason.length < 3) {
    throw new UserError('Say what happened.');
  }
  transaction(ctx.db, () => {
    update(ctx.db, 'orders', order.id, { delivery_status: status });
    event(ctx, order.id, actor, 'delivery_' + status, reason || null);
  });
  if (status === 'refused') {
    openDispute(ctx, getOrder(ctx, order.id), {
      by: actor,
      category: 'refused_at_door',
      description: reason,
    });
  }
  if (status === 'out_for_delivery' || status === 'attempt_failed') {
    ctx.notify.send({
      orderId: order.id,
      phone: order.buyer_phone,
      body:
        status === 'out_for_delivery'
          ? `Middleman: order ${order.ref} is out for delivery. Check the item before you give the rider your PIN.`
          : `Middleman: the rider could not deliver order ${order.ref} (${reason}). They will try again.`,
    });
  }
}

export function verifyDeliveryPin(ctx, order, pin, actor) {
  if (order.status !== 'shipping') throw new UserError('This order is not out for delivery.');
  if (order.pin_attempts >= ctx.config.pinMaxAttempts) {
    throw new UserError('Too many wrong PINs. Contact Middleman support to continue.');
  }
  if (!safeEqual(str(pin), revealPin(ctx, order))) {
    run(ctx.db, 'UPDATE orders SET pin_attempts = pin_attempts + 1 WHERE id = :id', { id: order.id });
    event(ctx, order.id, actor, 'wrong_pin');
    const left = ctx.config.pinMaxAttempts - order.pin_attempts - 1;
    throw new UserError(`Wrong PIN. ${left} attempt(s) left.`);
  }
  const deal = getDeal(ctx, order.deal_id);
  const now = ctx.now();
  const ends = addHours(now, deal.inspection_hours);
  transaction(ctx.db, () => {
    update(ctx.db, 'orders', order.id, {
      status: 'delivered',
      delivery_status: 'delivered',
      delivered_at: iso(now),
      inspection_ends_at: iso(ends),
    });
    run(ctx.db, "UPDATE ledger SET status = 'success' WHERE order_id = :id AND kind = 'delivery_cost'", { id: order.id });
    event(ctx, order.id, actor, 'delivered_with_pin');
  });
  const seller = getSeller(ctx, order.seller_id);
  ctx.notify.send({
    orderId: order.id,
    phone: order.buyer_phone,
    body: `Middleman: order ${order.ref} delivered. If something is wrong, report it before ${fmtDate(ends)}: ${buyerUrl(ctx, order)} — otherwise the seller is paid automatically.`,
  });
  ctx.notify.send({
    orderId: order.id,
    phone: seller.phone,
    body: `Middleman: order ${order.ref} was delivered. Your payout is released when the buyer confirms or at ${fmtDate(ends)}, unless they report a problem.`,
  });
}

// ---------------------------------------------------------------- disputes & money out

export function openDispute(ctx, order, { by, category, description }) {
  if (!DISPUTE_CATEGORIES[category]) throw new UserError('Choose what went wrong.');
  const text = str(description);
  if (text.length < 3) throw new UserError('Describe the problem.');
  if (!['paid', 'shipping', 'delivered'].includes(order.status)) {
    throw new UserError('A problem can no longer be reported on this order.');
  }
  if (by === 'buyer' && order.status === 'delivered' && new Date(order.inspection_ends_at) <= ctx.now()) {
    throw new UserError('The inspection period has ended.');
  }
  const id = transaction(ctx.db, () => {
    update(ctx.db, 'orders', order.id, { status: 'disputed' });
    event(ctx, order.id, by, 'dispute_opened', { category, description: text.slice(0, 2000) });
    return insert(ctx.db, 'disputes', {
      order_id: order.id,
      opened_by: by,
      category,
      description: text.slice(0, 2000),
      status: 'open',
      created_at: iso(ctx.now()),
    });
  });
  const seller = getSeller(ctx, order.seller_id);
  const msg = `Middleman: a problem was reported on order ${order.ref} (${DISPUTE_CATEGORIES[category]}). The money stays held while we review. We may contact you for evidence.`;
  ctx.notify.send({ orderId: order.id, phone: order.buyer_phone, body: msg });
  ctx.notify.send({ orderId: order.id, phone: seller.phone, body: msg });
  return id;
}

export async function resolveDispute(ctx, disputeId, input) {
  const dispute = get(ctx.db, 'SELECT * FROM disputes WHERE id = :id', { id: disputeId });
  if (!dispute || dispute.status !== 'open') throw new UserError('Dispute not found or already resolved.');
  const order = getOrder(ctx, dispute.order_id);
  const buyerRefund = nairaToKobo(input.buyer_refund || '0');
  const sellerPayout = nairaToKobo(input.seller_payout || '0');
  const sellerCharge = nairaToKobo(input.seller_charge || '0');
  if ([buyerRefund, sellerPayout, sellerCharge].includes(null)) throw new UserError('Amounts must be numbers.');
  if (buyerRefund + sellerPayout > order.amount) {
    throw new UserError(`Refund plus payout cannot exceed the ${formatNaira(order.amount)} collected.`);
  }
  const note = requireLength(input.note, 'Decision note', 10, 2000);
  const now = ctx.now();
  const retained = order.amount - buyerRefund - sellerPayout;

  const ledgerIds = transaction(ctx.db, () => {
    update(ctx.db, 'disputes', dispute.id, {
      status: 'resolved',
      resolution_note: note,
      buyer_refund: buyerRefund,
      seller_payout: sellerPayout,
      seller_charge: sellerCharge,
      resolved_at: iso(now),
    });
    update(ctx.db, 'orders', order.id, {
      status: sellerPayout > 0 ? 'completed' : 'refunded',
      closed_at: iso(now),
    });
    if (sellerCharge > 0) {
      run(ctx.db, 'UPDATE sellers SET amount_owed = amount_owed + :c WHERE id = :id', {
        c: sellerCharge,
        id: order.seller_id,
      });
    }
    run(ctx.db, "UPDATE ledger SET status = 'success' WHERE order_id = :id AND kind = 'delivery_cost'", { id: order.id });
    event(ctx, order.id, 'admin', 'dispute_resolved', { buyerRefund, sellerPayout, sellerCharge, note });
    const ids = [];
    if (buyerRefund > 0) ids.push(insertLedger(ctx, order.id, 'buyer_refund', buyerRefund, 'buyer', 'pending'));
    if (sellerPayout > 0) ids.push(insertLedger(ctx, order.id, 'seller_payout', sellerPayout, 'seller', 'pending'));
    if (retained > 0) insertLedger(ctx, order.id, 'platform_retained', retained, 'middleman', 'success');
    return ids;
  });
  for (const id of ledgerIds) await sendTransfer(ctx, id);

  const seller = getSeller(ctx, order.seller_id);
  const summary = `Refund to buyer: ${formatNaira(buyerRefund)}. Paid to seller: ${formatNaira(sellerPayout)}.${
    sellerCharge > 0 ? ` Charged to seller: ${formatNaira(sellerCharge)}.` : ''
  } Reason: ${note}`;
  ctx.notify.send({ orderId: order.id, phone: order.buyer_phone, body: `Middleman decision on ${order.ref}. ${summary}` });
  ctx.notify.send({ orderId: order.id, phone: seller.phone, body: `Middleman decision on ${order.ref}. ${summary}` });
}

export async function releaseToSeller(ctx, order, reason) {
  if (order.status !== 'delivered') throw new UserError('Payment can only be released after delivery.');
  const deal = getDeal(ctx, order.deal_id);
  const now = ctx.now();
  const ledgerId = transaction(ctx.db, () => {
    const seller = getSeller(ctx, order.seller_id);
    const recovered = Math.min(seller.amount_owed, deal.seller_payout);
    if (recovered > 0) {
      run(ctx.db, 'UPDATE sellers SET amount_owed = amount_owed - :r WHERE id = :id', { r: recovered, id: seller.id });
      insertLedger(ctx, order.id, 'debt_recovered', recovered, 'seller', 'success');
    }
    update(ctx.db, 'orders', order.id, { status: 'completed', closed_at: iso(now) });
    insertLedger(ctx, order.id, 'platform_fee', deal.platform_fee, 'middleman', 'success');
    event(ctx, order.id, reason === 'buyer_confirmed' ? 'buyer' : 'system', reason);
    const payout = deal.seller_payout - recovered;
    return payout > 0 ? insertLedger(ctx, order.id, 'seller_payout', payout, 'seller', 'pending') : null;
  });
  if (ledgerId) await sendTransfer(ctx, ledgerId);
  const seller = getSeller(ctx, order.seller_id);
  ctx.notify.send({
    orderId: order.id,
    phone: seller.phone,
    body: `Middleman: ${formatNaira(deal.seller_payout)} for order ${order.ref} has been released to your ${seller.payout_bank_name} account.`,
  });
  ctx.notify.send({
    orderId: order.id,
    phone: order.buyer_phone,
    body: `Middleman: order ${order.ref} is complete. Thank you for buying safely.`,
  });
}

function insertLedger(ctx, orderId, kind, amount, counterparty, status) {
  return insert(ctx.db, 'ledger', {
    order_id: orderId,
    kind,
    amount,
    counterparty,
    status,
    created_at: iso(ctx.now()),
  });
}

// Sends one pending/failed ledger row as a bank transfer. Failures are recorded, never thrown,
// so an outage at the provider does not undo a decision; admin can retry.
export async function sendTransfer(ctx, ledgerId) {
  const row = get(ctx.db, 'SELECT * FROM ledger WHERE id = :id', { id: ledgerId });
  if (!row || !['pending', 'failed'].includes(row.status)) return row;
  const order = getOrder(ctx, row.order_id);
  let dest;
  if (row.kind === 'seller_payout') {
    const s = getSeller(ctx, order.seller_id);
    dest = { bankCode: s.payout_bank_code, accountNumber: s.payout_account_number, accountName: s.payout_account_name };
  } else if (row.kind === 'buyer_refund') {
    dest = {
      bankCode: order.refund_bank_code,
      accountNumber: decrypt(order.refund_account_enc, ctx.config.appSecret),
      accountName: order.refund_account_name,
    };
  } else {
    return row;
  }
  try {
    const res = await ctx.payments.transfer({
      ...dest,
      amount: row.amount,
      narration: `Middleman ${order.ref}`,
      reference: `MMT-${row.id}-${randomToken(4)}`,
    });
    update(ctx.db, 'ledger', row.id, { status: res.status === 'success' ? 'success' : 'submitted', provider_ref: res.providerRef });
  } catch (err) {
    update(ctx.db, 'ledger', row.id, { status: 'failed' });
    event(ctx, order.id, 'system', 'transfer_failed', { ledger_id: row.id, error: err.message });
  }
  return get(ctx.db, 'SELECT * FROM ledger WHERE id = :id', { id: ledgerId });
}

// ---------------------------------------------------------------- background jobs

export async function runJobs(ctx) {
  const now = iso(ctx.now());
  const result = { expired: 0, cancelled: 0, released: 0, notShipped: 0 };

  result.expired = Number(
    run(ctx.db, "UPDATE deals SET status = 'expired' WHERE status = 'open' AND expires_at <= :now", { now }).changes,
  );

  const staleBefore = iso(new Date(ctx.now().getTime() - ctx.config.paymentTimeoutMinutes * 2 * 60_000));
  for (const o of all(ctx.db, "SELECT * FROM orders WHERE status = 'awaiting_payment' AND created_at <= :t", { t: staleBefore })) {
    const fresh = await confirmPayment(ctx, o.tx_ref, 'system');
    if (fresh.status === 'awaiting_payment') {
      update(ctx.db, 'orders', o.id, { status: 'cancelled', closed_at: now });
      event(ctx, o.id, 'system', 'checkout_abandoned');
      result.cancelled++;
    }
  }

  for (const o of all(ctx.db, "SELECT * FROM orders WHERE status = 'delivered' AND inspection_ends_at <= :now", { now })) {
    await releaseToSeller(ctx, o, 'auto_released');
    result.released++;
  }

  for (const o of all(ctx.db, "SELECT * FROM orders WHERE status = 'paid' AND ship_by <= :now", { now })) {
    openDispute(ctx, o, {
      by: 'system',
      category: 'not_shipped',
      description: 'The seller did not book pickup within the agreed time.',
    });
    result.notShipped++;
  }
  return result;
}

export function fmtDate(d) {
  return new Date(d).toLocaleString('en-NG', {
    timeZone: 'Africa/Lagos',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export { ZONES, zoneById };
