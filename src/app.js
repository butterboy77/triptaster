import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, transaction } from './db.js';
import { HttpError, parseCookies, readJson, readBody, json, send, redirect } from './http.js';
import {
  sha256,
  randomToken,
  hashPassword,
  verifyPassword,
  setupCode as newSetupCode,
  sameSecret,
  createLimiter,
  createOidcClient,
} from './auth.js';
import {
  ROLES,
  validateUsername,
  validatePassword,
  validateDisplayName,
  validateTrip,
  validateVenue,
  validDate,
  shortText,
} from './validate.js';
import { createPhotoStore, imageType, MAX_PHOTO_BYTES, MAX_THUMB_BYTES, PHOTO_MIME } from './photos.js';
import { writeBackup, restoreArchive, restoreJson } from './backup.js';
import {
  listTrips,
  listVenues,
  insertVenue,
  updateVenue,
  insertPhoto,
  photoBytesUsed,
  photosOfVenue,
  photosOfTrip,
} from './store.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const SESSION_COOKIE = 'triptaster_session';
const OIDC_COOKIE = 'triptaster_oidc';
const SESSION_DAYS = 180; // Long enough that nobody has to sign in again mid-trip.
const LINK_DAYS = 7;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};
const CSP = "default-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

function loadStatic() {
  const files = new Map();
  for (const entry of fs.readdirSync(PUBLIC_DIR, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    const route = '/' + path.relative(PUBLIC_DIR, full).split(path.sep).join('/');
    files.set(route, { body: fs.readFileSync(full), type: MIME[path.extname(entry.name)] || 'application/octet-stream' });
  }
  return files;
}

/**
 * config: {
 *   baseUrl, dataDir, passwordLogin, trustProxy,
 *   oidc: null | { issuer, clientId, clientSecret, label, autoRegister, allowedGroups },
 *   photoLimitBytes (0 for no limit), scryptN (password hashing cost), log
 * }
 */
export function createApp(config) {
  const db = openDb(config.dataDir);
  const staticFiles = loadStatic();
  const log = config.log ?? console.log;
  const photos = createPhotoStore(config.dataDir);
  const swept = photos.sweep(new Set(db.prepare('SELECT file FROM photos').all().map((p) => p.file)));
  if (swept) log(`Removed ${swept} leftover photo files`);
  const scryptN = config.scryptN ?? 2 ** 17;
  const secureCookies = config.baseUrl.startsWith('https://');
  const appOrigin = new URL(config.baseUrl).origin;
  const oidc = config.oidc
    ? createOidcClient({ ...config.oidc, redirectUri: `${config.baseUrl}/auth/oidc/callback` })
    : null;
  const loginByIp = createLimiter({ limit: 20, windowMs: 15 * 60 * 1000 });
  const loginByName = createLimiter({ limit: 8, windowMs: 15 * 60 * 1000 });
  const setupByIp = createLimiter({ limit: 10, windowMs: 15 * 60 * 1000 });
  let setupCode = null;

  const cookie = (name, value, maxAge) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`;
  const clientIp = (req) => {
    if (config.trustProxy) {
      // The last hop is the one added by our own proxy; earlier entries are client-supplied.
      const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (forwarded.length) return forwarded.at(-1);
    }
    return req.socket.remoteAddress;
  };

  const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  function ensureSetupCode() {
    if (setupCode || userCount() > 0) return;
    setupCode = newSetupCode();
    log(`\n  TripTaster needs setting up. Open ${config.baseUrl} and enter this one-time code:\n\n      ${setupCode}\n`);
  }
  ensureSetupCode();

  const publicConfig = () => ({
    passwordLogin: config.passwordLogin,
    oidc: oidc ? { label: config.oidc.label || 'Single sign-on' } : null,
  });

  // Sessions and users

  function startSession(userId) {
    const token = randomToken();
    const maxAge = SESSION_DAYS * 86400;
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, Date.now() + maxAge * 1000);
    return cookie(SESSION_COOKIE, token, maxAge);
  }

  function currentUser(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return null;
    return (
      db
        .prepare(
          `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = ? AND s.expires_at > ?`,
        )
        .get(sha256(token), Date.now()) ?? null
    );
  }

  const describeUser = (u) => ({
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    role: u.role,
    has_password: Boolean(u.password_hash),
    has_sso: Boolean(u.oidc_sub),
  });

  function createUser({ username, displayName, passwordHash = null, oidcSub = null, role }) {
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'That username is taken');
    const { lastInsertRowid } = db
      .prepare('INSERT INTO users (username, display_name, password_hash, oidc_sub, role) VALUES (?, ?, ?, ?, ?)')
      .run(username, displayName, passwordHash, oidcSub, role);
    return Number(lastInsertRowid);
  }

  // Turns an SSO identity into a free username like "sam" or "sam2".
  function freeUsername(claims) {
    const base =
      String(claims.preferred_username || claims.email?.split('@')[0] || 'traveller')
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, '')
        .slice(0, 28) || 'traveller';
    const padded = base.length < 2 ? `${base}-user` : base;
    for (let n = 1; ; n += 1) {
      const candidate = n === 1 ? padded : `${padded}${n}`;
      if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get(candidate)) return candidate;
    }
  }

  function adminCount() {
    return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
  }

  // Invite and password reset links. Only a hash is stored; the link is shown once.

  function createLink({ kind, role = null, userId = null, createdBy }) {
    const token = randomToken();
    db.prepare('DELETE FROM links WHERE expires_at < ?').run(Date.now());
    if (kind === 'reset') db.prepare("DELETE FROM links WHERE kind = 'reset' AND user_id = ?").run(userId);
    db.prepare('INSERT INTO links (token_hash, kind, role, user_id, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      sha256(token),
      kind,
      role,
      userId,
      createdBy,
      Date.now() + LINK_DAYS * 86400 * 1000,
    );
    return `${config.baseUrl}/join/${token}`;
  }

  function findLink(token) {
    if (typeof token !== 'string' || !token) return null;
    return db.prepare('SELECT * FROM links WHERE token_hash = ? AND expires_at > ?').get(sha256(token), Date.now()) ?? null;
  }

  // Trips and venues

  function requireTrip(id) {
    const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(id);
    if (!trip) throw new HttpError(404, 'That trip no longer exists');
    return trip;
  }

  function requireVenue(id) {
    const venue = db.prepare('SELECT * FROM venues WHERE id = ?').get(id);
    if (!venue) throw new HttpError(404, 'That place no longer exists');
    return venue;
  }

  function requirePhoto(id) {
    const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
    if (!photo) throw new HttpError(404, 'That photo no longer exists');
    return photo;
  }

  const backupContext = (user) => ({ db, photos, importerId: user.id, photoLimitBytes: config.photoLimitBytes || 0 });

  // Routes. Each is [method, pattern, access, handler]; access is 'public', 'user' or 'admin'.

  const routes = [];
  const route = (method, pattern, access, handler) => routes.push({ method, pattern, access, handler });

  route('GET', '/healthz', 'public', ({ res }) => json(res, 200, { ok: true }));

  route('GET', '/api/auth/status', 'public', ({ res }) => {
    ensureSetupCode();
    json(res, 200, { setupRequired: userCount() === 0, ...publicConfig() });
  });

  route('POST', '/api/auth/setup', 'public', async ({ req, res }) => {
    const body = await readJson(req);
    if (userCount() > 0) throw new HttpError(409, 'TripTaster is already set up');
    if (!config.passwordLogin) throw new HttpError(403, 'Password sign-in is turned off. Use single sign-on to finish setup.');
    const ip = clientIp(req);
    if (setupByIp.blocked(ip)) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    if (!setupCode || !sameSecret(String(body.code ?? '').trim().toUpperCase(), setupCode)) {
      setupByIp.fail(ip);
      throw new HttpError(403, 'That setup code isn’t right. Check the server logs.');
    }
    const username = validateUsername(body.username);
    const displayName = validateDisplayName(body.display_name);
    const passwordHash = await hashPassword(validatePassword(body.password), scryptN);
    if (userCount() > 0) throw new HttpError(409, 'TripTaster is already set up');
    const id = createUser({ username, displayName, passwordHash, role: 'admin' });
    setupCode = null;
    json(res, 201, { ok: true }, { 'Set-Cookie': startSession(id) });
  });

  route('POST', '/api/auth/login', 'public', async ({ req, res }) => {
    if (!config.passwordLogin) throw new HttpError(403, 'Password sign-in is turned off');
    const body = await readJson(req);
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const ip = clientIp(req);
    if (loginByIp.blocked(ip) || loginByName.blocked(username)) {
      throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    }
    const user = username ? db.prepare('SELECT * FROM users WHERE username = ?').get(username) : null;
    if (!(await verifyPassword(password, user?.password_hash, scryptN))) {
      loginByIp.fail(ip);
      loginByName.fail(username);
      throw new HttpError(401, 'Wrong username or password');
    }
    loginByName.clear(username);
    json(res, 200, { ok: true }, { 'Set-Cookie': startSession(user.id) });
  });

  route('POST', '/api/auth/logout', 'public', ({ req, res }) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    json(res, 200, { ok: true }, { 'Set-Cookie': cookie(SESSION_COOKIE, '', 0) });
  });

  route('GET', /^\/api\/links\/([\w-]+)$/, 'public', ({ res, params }) => {
    const link = findLink(params[0]);
    if (!link) throw new HttpError(404, 'This link has expired or already been used. Ask for a new one.');
    const user = link.user_id ? db.prepare('SELECT username, display_name FROM users WHERE id = ?').get(link.user_id) : null;
    json(res, 200, { kind: link.kind, username: user?.username, display_name: user?.display_name, ...publicConfig() });
  });

  route('POST', /^\/api\/links\/([\w-]+)$/, 'public', async ({ req, res, params }) => {
    const body = await readJson(req);
    const link = findLink(params[0]);
    if (!link) throw new HttpError(404, 'This link has expired or already been used. Ask for a new one.');
    if (!config.passwordLogin) throw new HttpError(403, 'Password sign-in is turned off. Use single sign-on instead.');
    const passwordHash = await hashPassword(validatePassword(body.password), scryptN);
    let userId;
    if (link.kind === 'invite') {
      const username = validateUsername(body.username);
      const displayName = validateDisplayName(body.display_name);
      userId = transaction(db, () => {
        if (!findLink(params[0])) throw new HttpError(404, 'This link has already been used');
        db.prepare('DELETE FROM links WHERE id = ?').run(link.id);
        return createUser({ username, displayName, passwordHash, role: link.role });
      });
    } else {
      userId = link.user_id;
      transaction(db, () => {
        db.prepare('DELETE FROM links WHERE id = ?').run(link.id);
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      });
    }
    json(res, 200, { ok: true }, { 'Set-Cookie': startSession(userId) });
  });

  route('GET', '/auth/oidc/login', 'public', async ({ req, res, url }) => {
    if (!oidc) throw new HttpError(404, 'Single sign-on is not set up');
    const query = url.searchParams;
    let intent = { kind: 'login', invite: query.get('invite') || null };
    if (query.has('setup')) {
      const ip = clientIp(req);
      if (setupByIp.blocked(ip)) return redirect(res, '/?signin=failed');
      if (userCount() > 0 || !setupCode || !sameSecret(query.get('setup').trim().toUpperCase(), setupCode)) {
        setupByIp.fail(ip);
        return redirect(res, '/?setup=bad-code');
      }
      intent = { kind: 'setup' };
    } else if (query.has('link')) {
      const user = currentUser(req);
      if (!user) return redirect(res, '/');
      intent = { kind: 'link', userId: user.id };
    }
    const { url: target, state, maxAge } = await oidc.start(intent);
    redirect(res, target, { 'Set-Cookie': cookie(OIDC_COOKIE, state, maxAge) });
  });

  route('GET', '/auth/oidc/callback', 'public', async ({ req, res, url }) => {
    if (!oidc) throw new HttpError(404, 'Single sign-on is not set up');
    const clear = cookie(OIDC_COOKIE, '', 0);
    const fail = (reason, detail) => {
      log(`Single sign-on failed: ${detail}`);
      redirect(res, `/?signin=${reason}`, { 'Set-Cookie': clear });
    };
    let claims, intent;
    try {
      ({ claims, intent } = await oidc.finish(url.searchParams, parseCookies(req.headers.cookie)[OIDC_COOKIE]));
    } catch (err) {
      return fail('failed', err.message);
    }
    const allowed = config.oidc.allowedGroups ?? [];
    const groups = Array.isArray(claims.groups) ? claims.groups : [];
    if (allowed.length && !groups.some((g) => allowed.includes(g))) return fail('not-allowed', `${claims.sub} is not in an allowed group`);

    const displayName = String(claims.given_name || claims.name || claims.preferred_username || claims.email || 'Traveller').slice(0, 60);
    const existing = db.prepare('SELECT * FROM users WHERE oidc_sub = ?').get(claims.sub);
    let userId;

    if (intent.kind === 'setup') {
      if (userCount() > 0) return fail('failed', 'setup was already completed');
      userId = createUser({ username: freeUsername(claims), displayName, oidcSub: claims.sub, role: 'admin' });
      setupCode = null;
    } else if (intent.kind === 'link') {
      const user = currentUser(req);
      if (!user || user.id !== intent.userId) return fail('failed', 'link started by a different session');
      if (existing && existing.id !== user.id) return fail('taken', 'that SSO identity belongs to another user');
      db.prepare('UPDATE users SET oidc_sub = ? WHERE id = ?').run(claims.sub, user.id);
      return redirect(res, '/?linked=1', { 'Set-Cookie': clear });
    } else if (existing) {
      userId = existing.id;
    } else {
      const link = findLink(intent.invite);
      if (link?.kind === 'invite') {
        userId = transaction(db, () => {
          db.prepare('DELETE FROM links WHERE id = ?').run(link.id);
          return createUser({ username: freeUsername(claims), displayName, oidcSub: claims.sub, role: link.role });
        });
      } else if (config.oidc.autoRegister) {
        userId = createUser({ username: freeUsername(claims), displayName, oidcSub: claims.sub, role: 'member' });
      } else {
        return fail('no-account', `${claims.sub} has no account and no invite`);
      }
    }
    redirect(res, '/', { 'Set-Cookie': [clear, startSession(userId)] });
  });

  // You

  route('GET', '/api/me', 'user', ({ res, user }) => {
    json(res, 200, {
      me: describeUser(user),
      users: db.prepare('SELECT id, display_name FROM users ORDER BY display_name').all(),
      config: publicConfig(),
    });
  });

  route('PATCH', '/api/me', 'user', async ({ req, res, user }) => {
    const body = await readJson(req);
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(validateDisplayName(body.display_name), user.id);
    json(res, 200, { ok: true });
  });

  route('POST', '/api/me/password', 'user', async ({ req, res, user }) => {
    if (!config.passwordLogin) throw new HttpError(403, 'Password sign-in is turned off');
    const body = await readJson(req);
    if (user.password_hash && !(await verifyPassword(String(body.current ?? ''), user.password_hash, scryptN))) {
      throw new HttpError(403, 'Your current password isn’t right');
    }
    const passwordHash = await hashPassword(validatePassword(body.password), scryptN);
    const keep = sha256(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    transaction(db, () => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(user.id, keep);
    });
    json(res, 200, { ok: true });
  });

  route('DELETE', '/api/me/sso', 'user', ({ res, user }) => {
    if (!user.password_hash || !config.passwordLogin) throw new HttpError(400, 'Set a password first, or you’d be locked out');
    db.prepare('UPDATE users SET oidc_sub = NULL WHERE id = ?').run(user.id);
    json(res, 200, { ok: true });
  });

  // Admin: people, invites, backups

  route('GET', '/api/admin/users', 'admin', ({ res }) => {
    json(res, 200, db.prepare('SELECT * FROM users ORDER BY display_name').all().map(describeUser));
  });

  route('PATCH', /^\/api\/admin\/users\/(\d+)$/, 'admin', async ({ req, res, params }) => {
    const { role } = await readJson(req);
    if (!ROLES.includes(role)) throw new HttpError(400, 'Unknown role');
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(params[0]));
    if (!target) throw new HttpError(404, 'No such person');
    if (target.role === 'admin' && role !== 'admin' && adminCount() === 1) throw new HttpError(400, 'There must always be at least one admin');
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, target.id);
    json(res, 200, { ok: true });
  });

  route('DELETE', /^\/api\/admin\/users\/(\d+)$/, 'admin', ({ res, params, user }) => {
    const id = Number(params[0]);
    if (id === user.id) throw new HttpError(400, 'You can’t remove yourself');
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    json(res, 200, { ok: true });
  });

  route('POST', /^\/api\/admin\/users\/(\d+)\/reset$/, 'admin', ({ res, params, user }) => {
    const target = db.prepare('SELECT id FROM users WHERE id = ?').get(Number(params[0]));
    if (!target) throw new HttpError(404, 'No such person');
    if (!config.passwordLogin) throw new HttpError(400, 'Password sign-in is turned off');
    json(res, 201, { url: createLink({ kind: 'reset', userId: target.id, createdBy: user.id }) });
  });

  route('GET', '/api/admin/invites', 'admin', ({ res }) => {
    json(
      res,
      200,
      db
        .prepare(
          `SELECT l.id, l.role, l.expires_at, u.display_name AS created_by FROM links l LEFT JOIN users u ON u.id = l.created_by
           WHERE l.kind = 'invite' AND l.expires_at > ? ORDER BY l.expires_at`,
        )
        .all(Date.now()),
    );
  });

  route('POST', '/api/admin/invites', 'admin', async ({ req, res, user }) => {
    const { role = 'member' } = await readJson(req);
    if (!ROLES.includes(role)) throw new HttpError(400, 'Unknown role');
    json(res, 201, { url: createLink({ kind: 'invite', role, createdBy: user.id }) });
  });

  route('DELETE', /^\/api\/admin\/invites\/(\d+)$/, 'admin', ({ res, params }) => {
    db.prepare("DELETE FROM links WHERE id = ? AND kind = 'invite'").run(Number(params[0]));
    json(res, 200, { ok: true });
  });

  route('GET', '/api/admin/export', 'admin', async ({ res }) => {
    res.writeHead(200, {
      'Content-Type': 'application/x-tar',
      'Content-Disposition': `attachment; filename="triptaster-${new Date().toISOString().slice(0, 10)}.tar"`,
      'Cache-Control': 'no-store',
    });
    await writeBackup(db, photos, res);
  });

  route('POST', '/api/admin/import', 'admin', async ({ req, res, user }) => {
    const type = req.headers['content-type'] || '';
    if (type.startsWith('application/json')) {
      return json(res, 201, await restoreJson(backupContext(user), await readJson(req, 10 * 1024 * 1024)));
    }
    if (!type.startsWith('application/x-tar') && !type.startsWith('application/octet-stream')) {
      throw new HttpError(415, 'Choose a TripTaster backup (.tar, or .json from version 1.0)');
    }
    json(res, 201, await restoreArchive(backupContext(user), req));
  });

  route('GET', '/api/admin/storage', 'admin', ({ res }) => {
    json(res, 200, {
      photo_bytes: photoBytesUsed(db),
      photo_count: db.prepare('SELECT COUNT(*) AS n FROM photos').get().n,
      photo_limit_bytes: config.photoLimitBytes || null,
    });
  });

  // Trips

  route('GET', '/api/trips', 'user', ({ res }) => json(res, 200, listTrips(db)));

  route('POST', '/api/trips', 'user', async ({ req, res, user }) => {
    const trip = validateTrip(await readJson(req));
    const { lastInsertRowid } = db.prepare('INSERT INTO trips (name, city, created_by) VALUES (?, ?, ?)').run(trip.name, trip.city, user.id);
    json(res, 201, { id: Number(lastInsertRowid) });
  });

  route('PUT', /^\/api\/trips\/(\d+)$/, 'user', async ({ req, res, params }) => {
    const id = Number(params[0]);
    requireTrip(id);
    const trip = validateTrip(await readJson(req));
    db.prepare('UPDATE trips SET name = ?, city = ? WHERE id = ?').run(trip.name, trip.city, id);
    json(res, 200, { ok: true });
  });

  route('DELETE', /^\/api\/trips\/(\d+)$/, 'user', ({ res, params }) => {
    const id = Number(params[0]);
    const files = photosOfTrip(db, id);
    db.prepare('DELETE FROM trips WHERE id = ?').run(id);
    photos.remove(files);
    json(res, 200, { ok: true });
  });

  route('GET', /^\/api\/trips\/(\d+)\/venues$/, 'user', ({ res, params }) => {
    const id = Number(params[0]);
    requireTrip(id);
    json(res, 200, listVenues(db, id));
  });

  route('POST', /^\/api\/trips\/(\d+)\/venues$/, 'user', async ({ req, res, params, user }) => {
    const tripId = Number(params[0]);
    requireTrip(tripId);
    const id = insertVenue(db, validateVenue(await readJson(req)), { tripId, userId: user.id });
    json(res, 201, { id });
  });

  // Venues, visits, ratings

  route('PUT', /^\/api\/venues\/(\d+)$/, 'user', async ({ req, res, params }) => {
    const venueId = Number(params[0]);
    requireVenue(venueId);
    updateVenue(db, validateVenue(await readJson(req)), venueId);
    json(res, 200, { ok: true });
  });

  route('DELETE', /^\/api\/venues\/(\d+)$/, 'user', ({ res, params }) => {
    const id = Number(params[0]);
    const files = photosOfVenue(db, id);
    db.prepare('DELETE FROM venues WHERE id = ?').run(id);
    photos.remove(files);
    json(res, 200, { ok: true });
  });

  // Photos. The phone uploads the thumbnail and the full photo in one request:
  // thumbnail bytes first, then the photo, with X-Thumb-Length marking the split.

  route('POST', /^\/api\/venues\/(\d+)\/photos$/, 'user', async ({ req, res, url, params, user }) => {
    const venueId = Number(params[0]);
    requireVenue(venueId);
    if (!Object.values(PHOTO_MIME).includes(req.headers['content-type'])) throw new HttpError(415, 'Photos must be JPEG or WebP');
    const thumbLength = Number(req.headers['x-thumb-length']);
    const body = await readBody(req, MAX_PHOTO_BYTES + MAX_THUMB_BYTES);
    if (!Number.isInteger(thumbLength) || thumbLength < 1 || thumbLength > MAX_THUMB_BYTES || thumbLength >= body.length) {
      throw new HttpError(400, 'The photo upload was incomplete');
    }
    const thumb = body.subarray(0, thumbLength);
    const full = body.subarray(thumbLength);
    if (full.length > MAX_PHOTO_BYTES) throw new HttpError(413, 'That photo is too big');
    const type = imageType(full);
    if (!type || imageType(thumb) !== type) throw new HttpError(415, 'Photos must be JPEG or WebP');

    let visitId = null;
    if (url.searchParams.has('visit')) {
      visitId = Number(url.searchParams.get('visit'));
      const visit = db.prepare('SELECT venue_id FROM visits WHERE id = ?').get(visitId);
      if (!visit) visitId = null; // The visit was deleted while the photo waited to upload.
      else if (visit.venue_id !== venueId) throw new HttpError(400, 'That visit belongs to a different place');
    }
    const size = (name) => {
      const value = Number(req.headers[name]);
      return Number.isInteger(value) && value > 0 && value <= 20000 ? value : null;
    };
    if (config.photoLimitBytes && photoBytesUsed(db) + body.length > config.photoLimitBytes) {
      throw new HttpError(507, 'Photo storage is full. Ask an admin to make room.');
    }
    const file = await photos.save(full, thumb, type);
    const id = insertPhoto(db, {
      venueId,
      visitId,
      userId: user.id,
      file,
      type,
      width: size('x-width'),
      height: size('x-height'),
      bytes: body.length,
    });
    json(res, 201, { id });
  });

  route('GET', /^\/api\/photos\/(\d+)\/(full|thumb)$/, 'user', ({ req, res, params }) => {
    const photo = requirePhoto(Number(params[0]));
    const target = photos.paths(photo.file, photo.type)[params[1]];
    let size;
    try {
      size = fs.statSync(target).size;
    } catch {
      throw new HttpError(404, 'That photo is missing');
    }
    res.writeHead(200, {
      'Content-Type': PHOTO_MIME[photo.type],
      'Content-Length': size,
      // Photos never change, so phones can keep them.
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(target).pipe(res);
  });

  route('DELETE', /^\/api\/photos\/(\d+)$/, 'user', ({ res, params, user }) => {
    const photo = requirePhoto(Number(params[0]));
    if (photo.user_id !== user.id && user.role !== 'admin') throw new HttpError(403, 'Only the person who added a photo can delete it');
    db.prepare('DELETE FROM photos WHERE id = ?').run(photo.id);
    photos.remove([photo]);
    json(res, 200, { ok: true });
  });

  route('POST', /^\/api\/venues\/(\d+)\/visits$/, 'user', async ({ req, res, params, user }) => {
    const id = Number(params[0]);
    requireVenue(id);
    const body = await readJson(req);
    if (!validDate(body.visited_on)) throw new HttpError(400, 'Please pick a valid date');
    const { lastInsertRowid } = db
      .prepare('INSERT INTO visits (venue_id, visited_on, note, user_id) VALUES (?, ?, ?, ?)')
      .run(id, body.visited_on, shortText(body.note, 'Note', 2000), user.id);
    json(res, 201, { id: Number(lastInsertRowid) });
  });

  route('DELETE', /^\/api\/visits\/(\d+)$/, 'user', ({ res, params }) => {
    db.prepare('DELETE FROM visits WHERE id = ?').run(Number(params[0]));
    json(res, 200, { ok: true });
  });

  route('PUT', /^\/api\/venues\/(\d+)\/rating$/, 'user', async ({ req, res, params, user }) => {
    const id = Number(params[0]);
    requireVenue(id);
    const { stars } = await readJson(req);
    if (![0, 1, 2, 3, 4, 5].includes(stars)) throw new HttpError(400, 'Rating must be 0 to 5');
    if (stars === 0) {
      db.prepare('DELETE FROM ratings WHERE venue_id = ? AND user_id = ?').run(id, user.id);
    } else {
      db.prepare(
        `INSERT INTO ratings (venue_id, user_id, stars) VALUES (?, ?, ?)
         ON CONFLICT(venue_id, user_id) DO UPDATE SET stars = excluded.stars`,
      ).run(id, user.id, stars);
    }
    json(res, 200, { ok: true });
  });

  function matchRoute(method, pathname) {
    let pathMatched = false;
    for (const r of routes) {
      const params = typeof r.pattern === 'string' ? (r.pattern === pathname ? [] : null) : pathname.match(r.pattern)?.slice(1);
      if (!params) continue;
      pathMatched = true;
      if (r.method === method) return { route: r, params };
    }
    return pathMatched ? { notAllowed: true } : null;
  }

  async function handle(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const { pathname } = url;
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');

    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin && req.headers.origin !== appOrigin) {
      throw new HttpError(403, 'Cross-site request refused');
    }

    const match = matchRoute(req.method === 'HEAD' ? 'GET' : req.method, pathname);
    if (match?.notAllowed) throw new HttpError(405, 'Method not allowed');
    if (match) {
      const { route: r, params } = match;
      const user = r.access === 'public' ? null : currentUser(req);
      if (r.access !== 'public' && !user) throw new HttpError(401, 'Please sign in');
      if (r.access === 'admin' && user.role !== 'admin') throw new HttpError(403, 'Only admins can do that');
      return await r.handler({ req, res, url, params, user });
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const isPage = pathname === '/' || /^\/join\/[\w-]+$/.test(pathname);
      const file = staticFiles.get(isPage ? '/index.html' : pathname);
      if (file) {
        const headers = { 'Content-Type': file.type, 'Cache-Control': 'no-cache' };
        if (pathname.startsWith('/fonts/')) headers['Cache-Control'] = 'public, max-age=31536000, immutable';
        if (isPage) headers['Referrer-Policy'] = 'no-referrer'; // Keep invite tokens out of Referer headers.
        return send(res, 200, req.method === 'HEAD' ? '' : file.body, headers);
      }
    }
    throw new HttpError(404, 'Not found');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err.status ?? 500;
      if (status === 500) console.error(err);
      if (res.headersSent) return res.end();
      json(res, status, { error: status === 500 ? 'Something went wrong' : err.message });
    });
  });
  server.on('close', () => db.close());
  return server;
}
