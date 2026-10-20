import { insert } from '../db.js';

// Every message is stored in the outbox (visible in admin). Plug an SMS or
// WhatsApp provider (e.g. Termii, Twilio, WhatsApp Cloud API) into send().
export function createNotifier({ db, now, log = console.log }) {
  return {
    send({ orderId = null, phone = null, email = null, body }) {
      insert(db, 'outbox', {
        order_id: orderId,
        to_phone: phone,
        to_email: email,
        body,
        created_at: now().toISOString(),
      });
      log(`[notify] to ${phone || email}: ${body}`);
    },
  };
}
