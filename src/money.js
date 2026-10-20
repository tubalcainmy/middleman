// All amounts are integer kobo (₦1 = 100 kobo) to avoid floating-point errors.

export function nairaToKobo(input) {
  const s = String(input ?? '').replace(/[,\s₦]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

export function formatNaira(kobo) {
  const naira = kobo / 100;
  return '₦' + naira.toLocaleString('en-NG', {
    minimumFractionDigits: kobo % 100 ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

export function platformFee(itemPriceKobo, fee) {
  const raw = Math.round((itemPriceKobo * fee.percent) / 100);
  return Math.min(fee.capKobo, Math.max(fee.minKobo, raw));
}

// Who pays what. Invariant: buyerTotal - sellerPayout = deliveryFee + platformFee.
export function quote({ itemPrice, deliveryFee, deliveryPayer, feePayer }, fee) {
  const pf = platformFee(itemPrice, fee);
  const buyerFeeShare = feePayer === 'buyer' ? pf : feePayer === 'split' ? Math.ceil(pf / 2) : 0;
  const sellerFeeShare = pf - buyerFeeShare;
  const buyerDelivery = deliveryPayer === 'buyer' ? deliveryFee : 0;
  const sellerDelivery = deliveryFee - buyerDelivery;
  return {
    itemPrice,
    deliveryFee,
    platformFee: pf,
    buyerFeeShare,
    sellerFeeShare,
    buyerDelivery,
    sellerDelivery,
    buyerTotal: itemPrice + buyerDelivery + buyerFeeShare,
    sellerPayout: itemPrice - sellerDelivery - sellerFeeShare,
  };
}
