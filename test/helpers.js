// Test helpers: a real app on a free port, a fake OIDC provider that signs real tokens,
// and a tiny cookie-keeping client.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';

export const CLIENT_ID = 'triptaster-test';
export const CLIENT_SECRET = 'secret with spaces & symbols';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

async function freePort() {
  const probe = http.createServer();
  await listen(probe);
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

export async function startIdp() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const codes = new Map();
  const idp = {
    claims: { sub: 'sso-1', preferred_username: 'sam', given_name: 'Sam', email: 'sam@example.com' },
    userinfo: {},
    tamper: null,
    url: null,
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, idp.url);
    const send = (value, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return send({
        issuer: idp.url,
        authorization_endpoint: `${idp.url}/authorize`,
        token_endpoint: `${idp.url}/token`,
        userinfo_endpoint: `${idp.url}/userinfo`,
        jwks_uri: `${idp.url}/jwks`,
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      });
    }
    if (url.pathname === '/jwks') return send({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig' }] });
    if (url.pathname === '/authorize') {
      const code = crypto.randomUUID();
      codes.set(code, Object.fromEntries(url.searchParams));
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { Location: back.href });
      return res.end();
    }
    if (url.pathname === '/token') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      const request = codes.get(form.get('code'));
      const [id, secret] = Buffer.from((req.headers.authorization || '').replace(/^Basic /, ''), 'base64')
        .toString()
        .split(':')
        .map((part) => decodeURIComponent(part.replace(/\+/g, ' ')));
      const challenge = crypto.createHash('sha256').update(form.get('code_verifier') || '').digest('base64url');
      if (!request || id !== CLIENT_ID || secret !== CLIENT_SECRET || challenge !== request.code_challenge) {
        return send({ error: 'invalid_grant' }, 400);
      }
      const claims = {
        iss: idp.url,
        aud: CLIENT_ID,
        nonce: request.nonce,
        exp: Math.floor(Date.now() / 1000) + 300,
        ...idp.claims,
        ...idp.tamper?.claims,
      };
      const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const body = `${encode({ alg: 'RS256', kid: 'k1' })}.${encode(claims)}`;
      const signature = crypto.sign('RSA-SHA256', Buffer.from(body), idp.tamper?.key ?? privateKey).toString('base64url');
      return send({ id_token: `${body}.${signature}`, access_token: 'at-' + idp.claims.sub });
    }
    if (url.pathname === '/userinfo') return send({ sub: idp.claims.sub, ...idp.userinfo });
    res.writeHead(404);
    res.end();
  });
  idp.url = await listen(server);
  idp.close = () => new Promise((resolve) => server.close(resolve));
  return idp;
}

export async function startApp({ oidc = null, passwordLogin = true } = {}) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triptaster-test-'));
  const logs = [];
  const server = createApp({
    baseUrl: url,
    dataDir,
    passwordLogin,
    trustProxy: false,
    oidc: oidc && { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, label: 'Test SSO', ...oidc },
    scryptN: 2 ** 10, // Fast hashing for tests only.
    log: (line) => logs.push(line),
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url,
    logs,
    setupCode: () => logs.join('\n').match(/[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/)?.[0],
    client: () => new Client(url),
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export class Client {
  constructor(base) {
    this.base = base;
    this.cookies = {};
  }

  async fetch(target, { method = 'GET', body, headers = {} } = {}) {
    const url = target.startsWith('http') ? target : this.base + target;
    const ours = url.startsWith(this.base);
    const res = await fetch(url, {
      method,
      redirect: 'manual',
      headers: {
        ...(ours && Object.keys(this.cookies).length ? { cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (ours) {
      for (const raw of res.headers.getSetCookie()) {
        const [pair] = raw.split(';');
        const at = pair.indexOf('=');
        const value = pair.slice(at + 1);
        if (value && !/Max-Age=0/.test(raw)) this.cookies[pair.slice(0, at)] = value;
        else delete this.cookies[pair.slice(0, at)];
      }
    }
    return res;
  }

  async json(target, options) {
    const res = await this.fetch(target, options);
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  // Follows an SSO round trip and returns where the app finally sends the browser.
  async sso(startPath) {
    let res = await this.fetch(startPath);
    for (let hops = 0; hops < 5 && res.status === 302; hops += 1) {
      const next = new URL(res.headers.get('location'), this.base).href;
      if (next.startsWith(this.base) && !next.includes('/auth/oidc/')) return new URL(next).pathname + new URL(next).search;
      res = await this.fetch(next);
    }
    throw new Error(`SSO flow did not finish (status ${res.status})`);
  }
}

// Completes first-run setup with a password and returns the signed-in admin client.
export async function setupAdmin(app, { username = 'alex', password = 'correct horse battery' } = {}) {
  const admin = app.client();
  const res = await admin.json('/api/auth/setup', {
    method: 'POST',
    body: { code: app.setupCode(), username, display_name: 'Alex', password },
  });
  if (res.status !== 201) throw new Error(`Setup failed: ${JSON.stringify(res.body)}`);
  return admin;
}

export async function invite(admin, role = 'member') {
  const { body } = await admin.json('/api/admin/invites', { method: 'POST', body: { role } });
  return new URL(body.url).pathname.split('/').pop();
}
