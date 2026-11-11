import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const KEY_LENGTH = 32;

export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
export const randomToken = () => crypto.randomBytes(32).toString('base64url');

// Stored as scrypt$N$r$p$salt$key, so the cost can be raised later without breaking old hashes.
export async function hashPassword(password, N) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { N, r: 8, p: 1, maxmem: 256 * N * 8 + 1024 * 1024 });
  return `scrypt$${N}$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password, stored, dummyN) {
  if (!stored) {
    // Spend the same time as a real check, so response times don't reveal which usernames exist.
    await hashPassword(password, dummyN);
    return false;
  }
  const [scheme, n, r, p, salt, key] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(key, 'base64url');
  const N = Number(n);
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64url'), expected.length, {
    N,
    r: Number(r),
    p: Number(p),
    maxmem: 256 * N * Number(r) + 1024 * 1024,
  });
  return crypto.timingSafeEqual(actual, expected);
}

// Readable one-time code for first-run setup: no 0/O or 1/I to confuse.
export function setupCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(16);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  return chars.match(/.{4}/g).join('-');
}

export function sameSecret(a, b) {
  const left = Buffer.from(sha256(String(a)));
  const right = Buffer.from(sha256(String(b)));
  return crypto.timingSafeEqual(left, right);
}

// Counts failures per key in a fixed window. In memory, so a restart forgives everyone.
export function createLimiter({ limit, windowMs }) {
  const failures = new Map();
  return {
    blocked(key) {
      const entry = failures.get(key);
      return Boolean(entry && entry.resetAt > Date.now() && entry.count >= limit);
    },
    fail(key) {
      const now = Date.now();
      if (failures.size > 10_000) {
        for (const [k, entry] of failures) if (entry.resetAt <= now) failures.delete(k);
      }
      const entry = failures.get(key);
      if (!entry || entry.resetAt <= now) failures.set(key, { count: 1, resetAt: now + windowMs });
      else entry.count += 1;
    },
    clear(key) {
      failures.delete(key);
    },
  };
}

function verifyIdToken(idToken, jwks, { issuer, clientId, nonce }) {
  const [rawHeader, rawPayload, rawSignature] = String(idToken).split('.');
  if (!rawSignature) throw new Error('Malformed ID token');
  const header = JSON.parse(Buffer.from(rawHeader, 'base64url'));
  const algorithms = { RS256: 'RSA-SHA256', RS384: 'RSA-SHA384', RS512: 'RSA-SHA512', ES256: 'SHA256', ES384: 'SHA384' };
  if (!algorithms[header.alg]) throw new Error(`Unsupported ID token algorithm ${header.alg}`);
  const candidates = jwks.keys.filter((key) => (header.kid ? key.kid === header.kid : true) && key.use !== 'enc');
  if (!candidates.length) throw new Error('No matching signing key');
  const data = Buffer.from(`${rawHeader}.${rawPayload}`);
  const signature = Buffer.from(rawSignature, 'base64url');
  const valid = candidates.some((jwk) => {
    try {
      const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
      const options = header.alg.startsWith('ES') ? { key, dsaEncoding: 'ieee-p1363' } : key;
      return crypto.verify(algorithms[header.alg], data, options, signature);
    } catch {
      return false;
    }
  });
  if (!valid) throw new Error('Bad ID token signature');
  const claims = JSON.parse(Buffer.from(rawPayload, 'base64url'));
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== issuer) throw new Error('Wrong ID token issuer');
  if (!audience.includes(clientId)) throw new Error('Wrong ID token audience');
  if (claims.nonce !== nonce) throw new Error('Wrong ID token nonce');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now() - 60_000) throw new Error('Expired ID token');
  if (!claims.sub) throw new Error('ID token has no subject');
  return claims;
}

// A generic OpenID Connect client: authorization code flow with PKCE.
export function createOidcClient({ issuer, clientId, clientSecret, redirectUri }) {
  const pending = new Map();
  const PENDING_TTL_MS = 10 * 60 * 1000;
  let discovery = null;

  async function getJson(url, options = {}) {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    return res.json();
  }

  async function getDiscovery() {
    discovery ??= await getJson(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
    return discovery;
  }

  return {
    // `intent` travels with the login: { kind: 'login' | 'setup' | 'link', invite?, userId? }.
    async start(intent) {
      const oidc = await getDiscovery();
      const now = Date.now();
      for (const [key, login] of pending) if (login.expires < now) pending.delete(key);
      const state = randomToken();
      const nonce = randomToken();
      const verifier = randomToken();
      pending.set(state, { nonce, verifier, intent, expires: now + PENDING_TTL_MS });
      const url = new URL(oidc.authorization_endpoint);
      for (const [key, value] of Object.entries({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: 'openid profile email groups',
        state,
        nonce,
        code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      })) {
        url.searchParams.set(key, value);
      }
      return { url: url.href, state, maxAge: PENDING_TTL_MS / 1000 };
    },

    // Returns { claims, intent }, or throws.
    async finish(query, cookieState) {
      const state = query.get('state');
      const login = state ? pending.get(state) : null;
      if (state) pending.delete(state);
      if (!login || login.expires < Date.now() || cookieState !== state) throw new Error('Unknown or expired sign-in attempt');
      if (query.get('error') || !query.get('code')) throw new Error(query.get('error') || 'No code returned');

      const oidc = await getDiscovery();
      if (query.get('iss') && query.get('iss') !== oidc.issuer) throw new Error('Wrong issuer in response');
      const form = new URLSearchParams({
        grant_type: 'authorization_code',
        code: query.get('code'),
        redirect_uri: redirectUri,
        code_verifier: login.verifier,
      });
      const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
      const methods = oidc.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
      if (!clientSecret) {
        form.set('client_id', clientId);
      } else if (methods.includes('client_secret_basic')) {
        const encode = (value) => encodeURIComponent(value).replace(/%20/g, '+');
        headers.Authorization = `Basic ${Buffer.from(`${encode(clientId)}:${encode(clientSecret)}`).toString('base64')}`;
      } else {
        form.set('client_id', clientId);
        form.set('client_secret', clientSecret);
      }
      const tokens = await getJson(oidc.token_endpoint, { method: 'POST', headers, body: form });
      const claims = verifyIdToken(tokens.id_token, await getJson(oidc.jwks_uri), {
        issuer: oidc.issuer,
        clientId,
        nonce: login.nonce,
      });
      // Some providers keep profile details and groups out of the ID token.
      if (oidc.userinfo_endpoint && tokens.access_token) {
        try {
          const info = await getJson(oidc.userinfo_endpoint, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
          if (info.sub === claims.sub) return { claims: { ...info, ...claims }, intent: login.intent };
        } catch {
          // The ID token alone is enough to sign in.
        }
      }
      return { claims, intent: login.intent };
    },
  };
}
