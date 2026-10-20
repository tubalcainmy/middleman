import { randomToken } from '../../security.js';

// "Concierge" courier: a rider (or you) opens the private rider link to update
// the parcel and enter the buyer's delivery PIN. Good enough for a manual pilot.
export function createMockLogistics({ config }) {
  return {
    name: 'manual',
    async book({ order }) {
      const riderToken = randomToken(15);
      return {
        deliveryRef: 'MAN-' + order.ref,
        riderToken,
        riderUrl: `${config.baseUrl}/r/${riderToken}`,
      };
    },
  };
}
