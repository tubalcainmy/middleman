import { createMockPayments } from './mock.js';
import { createFlutterwavePayments } from './flutterwave.js';

export function createPayments(deps) {
  switch (deps.config.paymentProvider) {
    case 'mock':
      return createMockPayments(deps);
    case 'flutterwave':
      return createFlutterwavePayments(deps);
    default:
      throw new Error(`Unknown PAYMENT_PROVIDER: ${deps.config.paymentProvider}`);
  }
}
