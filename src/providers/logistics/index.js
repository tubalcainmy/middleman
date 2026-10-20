import { createMockLogistics } from './mock.js';
import { createFezLogistics } from './fez.js';

export function createLogistics(deps) {
  switch (deps.config.logisticsProvider) {
    case 'mock':
      return createMockLogistics(deps);
    case 'fez':
      return createFezLogistics(deps);
    default:
      throw new Error(`Unknown LOGISTICS_PROVIDER: ${deps.config.logisticsProvider}`);
  }
}
