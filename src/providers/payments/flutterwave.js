import { safeEqual } from '../../security.js';
import { NIGERIAN_BANKS } from './banks.js';

// Flutterwave v3 adapter. Endpoints follow Flutterwave's public v3 docs; check each
// against the current docs and your account's approved products before relying on it.
// IMPORTANT: collecting into your Flutterwave balance and paying out later is NOT
// automatically a lawful escrow. Get written approval for this flow first.
export function createFlutterwavePayments({ config }) {
  const { secretKey, webhookHash, apiBase } = config.flutterwave;
  if (!secretKey) throw new Error('FLW_SECRET_KEY is required when PAYMENT_PROVIDER=flutterwave');
  const isTest = secretKey.startsWith('FLWSECK_TEST');
  if (!isTest && !config.allowLivePayments) {
    throw new Error('Live Flutterwave key detected. Set ALLOW_LIVE_PAYMENTS=true only after custody is approved.');
  }

  async function call(method, path, body) {
    const res = await fetch(apiBase + path, {
      method,
      headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.status === 'error') {
      throw new Error(`Flutterwave ${method} ${path} failed: ${json.message || res.status}`);
    }
    return json.data;
  }

  return {
    name: 'flutterwave',
    isTest,

    async listBanks() {
      try {
        const data = await call('GET', '/banks/NG');
        return data.map((b) => ({ code: b.code, name: b.name })).sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        return NIGERIAN_BANKS;
      }
    },

    async resolveAccount({ bankCode, accountNumber }) {
      const data = await call('POST', '/accounts/resolve', { account_number: accountNumber, account_bank: bankCode });
      return { accountName: data.account_name };
    },

    async createCheckout({ order, redirectUrl, title }) {
      const data = await call('POST', '/payments', {
        tx_ref: order.tx_ref,
        amount: order.amount / 100,
        currency: 'NGN',
        redirect_url: redirectUrl,
        customer: { email: order.buyer_email, phonenumber: order.buyer_phone, name: order.buyer_name },
        customizations: { title: 'Middleman', description: title },
        meta: { order_ref: order.ref },
        session_duration: config.paymentTimeoutMinutes,
        max_retry_attempt: 3,
      });
      return { url: data.link };
    },

    async verify(txRef) {
      try {
        const data = await call('GET', `/transactions/verify_by_reference?tx_ref=${encodeURIComponent(txRef)}`);
        return {
          status: data.status === 'successful' ? 'successful' : data.status === 'failed' ? 'failed' : 'pending',
          amount: Math.round(Number(data.amount) * 100),
          currency: data.currency,
          providerTxId: String(data.id),
        };
      } catch {
        return { status: 'not_found' };
      }
    },

    // Returns the tx_ref to re-verify, or null. Never trust the webhook body itself.
    parseWebhook(req) {
      if (!webhookHash || !safeEqual(req.get('verif-hash') || '', webhookHash)) return null;
      const txRef = req.body?.data?.tx_ref;
      return txRef ? { txRef } : null;
    },

    async transfer({ amount, bankCode, accountNumber, narration, reference }) {
      const data = await call('POST', '/transfers', {
        account_bank: bankCode,
        account_number: accountNumber,
        amount: amount / 100,
        currency: 'NGN',
        debit_currency: 'NGN',
        narration,
        reference,
      });
      // Transfers settle asynchronously; final status arrives by webhook (transfer.completed).
      return { status: 'pending', providerRef: String(data.id) };
    },
  };
}
