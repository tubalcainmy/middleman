// Fez Delivery adapter: NOT IMPLEMENTED.
// Fill this in once Fez gives you API credentials and written answers on:
//   - order creation fields, pricing endpoint, webhook events and signatures
//   - whether riders can collect a delivery PIN / OTP at handover
//   - refused-delivery, return-trip and failed-pickup handling and charges
//   - loss/damage claims and settlement timing
// It must return { deliveryRef, riderToken?, riderUrl? } from book(), and status
// updates must be fed into orders.applyDeliveryUpdate().
export function createFezLogistics() {
  return {
    name: 'fez',
    async book() {
      throw new Error('Fez integration is not configured yet. Use LOGISTICS_PROVIDER=mock for the pilot.');
    },
  };
}
