const DEV_SECRET = 'dev-only-insecure-secret-change-me';

export function loadConfig(overrides = {}) {
  const env = process.env;
  const production = env.NODE_ENV === 'production';
  const port = Number(env.PORT || 3000);

  const config = {
    production,
    port,
    baseUrl: (env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, ''),
    dbPath: env.DATABASE_PATH || 'data/middleman.db',
    appSecret: env.APP_SECRET || '',
    adminPassword: env.ADMIN_PASSWORD || '',
    paymentProvider: env.PAYMENT_PROVIDER || 'mock',
    logisticsProvider: env.LOGISTICS_PROVIDER || 'mock',
    flutterwave: {
      secretKey: env.FLW_SECRET_KEY || '',
      webhookHash: env.FLW_WEBHOOK_HASH || '',
      apiBase: env.FLW_API_BASE || 'https://api.flutterwave.com/v3',
    },
    // Live money stays off until custody is settled with a lawyer, the bank and the provider.
    allowLivePayments: env.ALLOW_LIVE_PAYMENTS === 'true',
    fee: {
      percent: Number(env.FEE_PERCENT || 1.5),
      minKobo: Number(env.FEE_MIN_NAIRA || 100) * 100,
      capKobo: Number(env.FEE_CAP_NAIRA || 2000) * 100,
    },
    maxDealKobo: Number(env.MAX_DEAL_NAIRA || 300000) * 100,
    inspectionHours: Number(env.INSPECTION_HOURS || 24),
    paymentTimeoutMinutes: Number(env.PAYMENT_TIMEOUT_MINUTES || 60),
    pinMaxAttempts: 5,
    jobsIntervalMs: Number(env.JOBS_INTERVAL_MS || 60_000),
    ...overrides,
  };

  if (!config.appSecret) {
    if (production) throw new Error('APP_SECRET must be set in production');
    config.appSecret = DEV_SECRET;
  }
  if (!config.adminPassword) {
    if (production) throw new Error('ADMIN_PASSWORD must be set in production');
    config.adminPassword = 'admin';
  }
  return config;
}
