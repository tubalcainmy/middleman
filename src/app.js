import express from 'express';
import { fileURLToPath } from 'node:url';
import { sessionMiddleware, csrfProtection } from './session.js';
import { publicRoutes } from './routes/public.js';
import { sellerRoutes } from './routes/seller.js';
import { buyerRoutes } from './routes/buyer.js';
import { adminRoutes } from './routes/admin.js';
import { html } from './views/html.js';
import { layout } from './views/layout.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

export function createApp(ctx) {
  const app = express();
  app.locals.ctx = ctx;
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; form-action 'self' https://checkout.flutterwave.com https://*.flutterwave.com; frame-ancestors 'none'",
    });
    next();
  });
  app.use('/static', express.static(PUBLIC_DIR, { maxAge: '1h' }));

  // Webhooks come from the provider: JSON body, no session or CSRF.
  app.use('/webhooks', express.json({ limit: '100kb' }));

  app.use(express.urlencoded({ extended: false, limit: '50kb' }));
  app.use((req, res, next) => (req.path.startsWith('/webhooks/') ? next() : sessionMiddleware(ctx)(req, res, next)));
  app.use((req, res, next) => (req.path.startsWith('/webhooks/') ? next() : csrfProtection(req, res, next)));

  app.use('/', publicRoutes(ctx));
  app.use('/seller', sellerRoutes(ctx));
  app.use('/admin', adminRoutes(ctx));
  app.use('/', buyerRoutes(ctx));

  app.use((req, res) => {
    res.status(404).send(layout(req, { title: 'Not found', body: html`<section class="card narrow"><h1>Page not found</h1></section>` }));
  });

  app.use((err, req, res, next) => {
    console.error(err);
    if (res.headersSent) return next(err);
    res.status(500).send('Something went wrong on our side. Your money is safe — please try again in a moment.');
  });
  return app;
}
