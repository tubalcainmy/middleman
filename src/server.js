import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { createApp } from './app.js';
import { runJobs } from './core.js';

const config = loadConfig();
const ctx = createContext(config);
const app = createApp(ctx);

if (!config.production && config.appSecret.startsWith('dev-only')) {
  console.warn('WARNING: using the development APP_SECRET and admin password "admin". Set APP_SECRET and ADMIN_PASSWORD.');
}

app.listen(config.port, () => {
  console.log(`Middleman running at ${config.baseUrl} (payments: ${ctx.payments.name}, courier: ${ctx.logistics.name})`);
});

// Timers: expire links, cancel abandoned checkouts, auto-release after inspection, flag late shipping.
let running = false;
setInterval(async () => {
  if (running) return;
  running = true;
  try {
    await runJobs(ctx);
  } catch (err) {
    console.error('jobs failed', err);
  } finally {
    running = false;
  }
}, config.jobsIntervalMs).unref();
