import { get, run, insert } from '../../db.js';
import { NIGERIAN_BANKS } from './banks.js';

// Test accounts the mock "bank lookup" knows. Any other number fails to resolve,
// just as a mistyped number would in real life.
export const MOCK_ACCOUNTS = {
  '0000000001': 'ADEBAYO OLUWASEUN JOHN',
  '0000000002': 'CHIOMA NGOZI OKAFOR',
  '0000000003': 'MUSA IBRAHIM BELLO',
  '0000000004': 'FUNMILAYO GRACE ADEYEMI',
  '0000000005': 'EMEKA PETER NWOSU',
};

export function createMockPayments({ db, config, now }) {
  return {
    name: 'mock',
    isTest: true,

    async listBanks() {
      return NIGERIAN_BANKS;
    },

    async resolveAccount({ accountNumber }) {
      const accountName = MOCK_ACCOUNTS[accountNumber];
      if (!accountName) throw new Error('Account not found. In test mode use one of the test account numbers.');
      return { accountName };
    },

    async createCheckout({ order }) {
      run(db, 'DELETE FROM mock_transactions WHERE tx_ref = :ref', { ref: order.tx_ref });
      insert(db, 'mock_transactions', {
        tx_ref: order.tx_ref,
        amount: order.amount,
        status: 'pending',
        created_at: now().toISOString(),
      });
      return { url: `${config.baseUrl}/pay/mock/${encodeURIComponent(order.tx_ref)}` };
    },

    async verify(txRef) {
      const tx = get(db, 'SELECT * FROM mock_transactions WHERE tx_ref = :txRef', { txRef });
      if (!tx) return { status: 'not_found' };
      return { status: tx.status, amount: tx.amount, currency: 'NGN', providerTxId: 'mock-' + txRef };
    },

    // Called by the fake checkout page.
    setMockStatus(txRef, status) {
      run(db, 'UPDATE mock_transactions SET status = :status WHERE tx_ref = :txRef', { txRef, status });
    },

    parseWebhook() {
      return null;
    },

    async transfer({ reference }) {
      return { status: 'success', providerRef: 'mock-transfer-' + reference };
    },
  };
}
