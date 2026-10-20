import { sha256 } from './security.js';
import { zoneById } from './zones.js';

export const TERMS_VERSION = '2026-10-pilot-1';

// The exact deal and rules the buyer sees and accepts. Stored with the order,
// hashed, and never changed afterwards.
export function buildTerms(deal, seller) {
  return {
    version: TERMS_VERSION,
    deal_token: deal.token,
    seller: {
      business_name: seller.business_name,
      identity_verified: Boolean(seller.identity_verified_at),
    },
    item: {
      title: deal.item_title,
      description: deal.item_description,
      condition: deal.item_condition,
      quantity: deal.quantity,
    },
    money: {
      item_price: deal.item_price,
      delivery_fee: deal.delivery_fee,
      delivery_payer: deal.delivery_payer,
      platform_fee: deal.platform_fee,
      fee_payer: deal.fee_payer,
      buyer_total: deal.buyer_total,
    },
    delivery: {
      area: zoneById(deal.delivery_zone)?.name || deal.delivery_zone,
      ship_within_days: deal.delivery_days,
    },
    inspection_hours: deal.inspection_hours,
    rules: RULES(deal),
  };
}

export const RULES = (deal) => [
  'Your payment is held by Middleman. The seller is not paid until the item is delivered and the inspection period ends.',
  'Check the item at the door. Only give the rider your 4-digit delivery PIN if it matches this description.',
  `After delivery you have ${deal.inspection_hours} hours to report a hidden problem. If you report nothing, the seller is paid automatically.`,
  `If the seller does not hand the item to the courier within ${deal.delivery_days} day(s), you get a full refund.`,
  'Wrong, fake, damaged or not-as-described item: the item goes back to the seller and you get a full refund.',
  'If you refuse a correct item, the cost of delivery and return may be deducted from your refund. Every deduction is shown to you in writing.',
  'Disputes are decided by Middleman staff using evidence from both sides and the courier. You can appeal once by replying to the decision.',
];

export function hashTerms(terms) {
  const json = JSON.stringify(terms);
  return { json, hash: sha256(json) };
}
