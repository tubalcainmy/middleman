import { get, run, insert } from './db.js';
import { randomToken, safeEqual } from './security.js';

const COOKIE = 'mm_sid';
const TTL_MS = 7 * 24 * 3_600_000;

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionMiddleware(ctx) {
  const secure = ctx.config.baseUrl.startsWith('https://');
  return (req, res, next) => {
    const now = ctx.now();
    const sid = parseCookies(req.headers.cookie)[COOKIE];
    let s = sid && get(ctx.db, 'SELECT * FROM sessions WHERE id = :sid AND expires_at > :now', { sid, now: now.toISOString() });
    if (!s) {
      s = { id: randomToken(24), seller_id: null, is_admin: 0, csrf: randomToken(18), flash: null };
      insert(ctx.db, 'sessions', { ...s, expires_at: new Date(now.getTime() + TTL_MS).toISOString() });
      res.append(
        'Set-Cookie',
        `${COOKIE}=${s.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_MS / 1000}${secure ? '; Secure' : ''}`,
      );
    }
    req.session = s;
    req.setSession = (fields) => {
      Object.assign(s, fields);
      const keys = Object.keys(fields);
      run(ctx.db, `UPDATE sessions SET ${keys.map((k) => `${k} = :${k}`).join(', ')} WHERE id = :__id`, {
        ...fields,
        __id: s.id,
      });
    };
    // Rotate the session id on login/logout to prevent fixation.
    req.rotateSession = (fields) => {
      run(ctx.db, 'DELETE FROM sessions WHERE id = :id', { id: s.id });
      const fresh = { id: randomToken(24), seller_id: null, is_admin: 0, csrf: randomToken(18), flash: null, ...fields };
      insert(ctx.db, 'sessions', { ...fresh, expires_at: new Date(now.getTime() + TTL_MS).toISOString() });
      res.append(
        'Set-Cookie',
        `${COOKIE}=${fresh.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_MS / 1000}${secure ? '; Secure' : ''}`,
      );
      req.session = fresh;
    };
    req.flash = (message) => req.setSession({ flash: message });
    res.locals.flash = s.flash;
    if (s.flash) req.setSession({ flash: null });
    next();
  };
}

export function csrfProtection(req, res, next) {
  if (req.method !== 'POST') return next();
  if (!safeEqual(req.body?._csrf || '', req.session.csrf)) {
    return res.status(403).send('This form expired. Go back, refresh the page and try again.');
  }
  next();
}
