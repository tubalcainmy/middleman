import { openDb } from './db.js';
import { createPayments } from './providers/payments/index.js';
import { createLogistics } from './providers/logistics/index.js';
import { createNotifier } from './providers/notify.js';

export function createContext(config, { now = () => new Date(), log } = {}) {
  const db = openDb(config.dbPath);
  const ctx = { config, db, now };
  ctx.payments = createPayments(ctx);
  ctx.logistics = createLogistics(ctx);
  ctx.notify = createNotifier({ db, now, log });
  return ctx;
}
