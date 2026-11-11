import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startApp, startIdp, setupAdmin, invite } from './helpers.js';

let idp;
before(async () => {
  idp = await startIdp();
});
after(() => idp.close());
beforeEach(() => {
  idp.claims = { sub: 'sso-1', preferred_username: 'sam', given_name: 'Sam', email: 'sam@example.com' };
  idp.userinfo = {};
  idp.tamper = null;
});

test('SSO-only setup: the first SSO user with the code becomes admin', async () => {
  const app = await startApp({ passwordLogin: false, oidc: { issuer: idp.url } });
  try {
    const c = app.client();
    assert.equal(await c.sso('/auth/oidc/login?setup=WRONG-CODE'), '/?setup=bad-code');
    assert.equal(await c.sso(`/auth/oidc/login?setup=${app.setupCode()}`), '/');
    const me = (await c.json('/api/me')).body.me;
    assert.deepEqual([me.role, me.username, me.has_sso, me.has_password], ['admin', 'sam', true, false]);
    const pw = await c.json('/api/auth/login', { method: 'POST', body: { username: 'sam', password: 'whatever whatever' } });
    assert.equal(pw.status, 403, 'password login is off');
  } finally {
    await app.close();
  }
});

test('SSO users need an invite unless auto-register is on', async () => {
  const app = await startApp({ oidc: { issuer: idp.url } });
  try {
    const admin = await setupAdmin(app);
    const stranger = app.client();
    assert.equal(await stranger.sso('/auth/oidc/login'), '/?signin=no-account');
    assert.equal((await stranger.json('/api/me')).status, 401);

    const token = await invite(admin);
    const guest = app.client();
    assert.equal(await guest.sso(`/auth/oidc/login?invite=${token}`), '/');
    const me = (await guest.json('/api/me')).body.me;
    assert.deepEqual([me.role, me.display_name, me.has_sso], ['member', 'Sam', true]);

    // Same identity, no invite needed any more; invite is used up.
    const later = app.client();
    assert.equal(await later.sso('/auth/oidc/login'), '/');
    idp.claims = { sub: 'sso-2', preferred_username: 'sam' };
    assert.equal(await app.client().sso(`/auth/oidc/login?invite=${token}`), '/?signin=no-account');
  } finally {
    await app.close();
  }
});

test('auto-register, unique usernames, groups from userinfo', async () => {
  const app = await startApp({ oidc: { issuer: idp.url, autoRegister: true, allowedGroups: ['travellers'] } });
  try {
    const admin = await setupAdmin(app, { username: 'sam' });
    idp.userinfo = { groups: ['other'] };
    assert.equal(await app.client().sso('/auth/oidc/login'), '/?signin=not-allowed');

    idp.userinfo = { groups: ['travellers'], name: 'Sam Smith' };
    const c = app.client();
    assert.equal(await c.sso('/auth/oidc/login'), '/');
    const users = (await admin.json('/api/admin/users')).body;
    assert.ok(users.some((u) => u.username === 'sam2'), 'username clash gets a number');
  } finally {
    await app.close();
  }
});

test('bad tokens are rejected', async () => {
  const app = await startApp({ oidc: { issuer: idp.url, autoRegister: true } });
  try {
    await setupAdmin(app);
    const { privateKey: otherKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    for (const tamper of [
      { key: otherKey },
      { claims: { aud: 'someone-else' } },
      { claims: { iss: 'https://evil.example' } },
      { claims: { nonce: 'replayed' } },
      { claims: { exp: 1000 } },
    ]) {
      idp.tamper = tamper;
      const c = app.client();
      assert.equal(await c.sso('/auth/oidc/login'), '/?signin=failed', JSON.stringify(tamper.claims ?? 'wrong key'));
      assert.equal((await c.json('/api/me')).status, 401);
    }
    const forged = await app.client().fetch('/auth/oidc/callback?code=x&state=forged');
    assert.equal(forged.headers.get('location'), '/?signin=failed');
  } finally {
    await app.close();
  }
});

test('password users can link and unlink SSO', async () => {
  const app = await startApp({ oidc: { issuer: idp.url } });
  try {
    const admin = await setupAdmin(app);
    assert.equal(await admin.sso('/auth/oidc/login?link=1'), '/?linked=1');
    assert.equal((await admin.json('/api/me')).body.me.has_sso, true);
    const viaSso = app.client();
    assert.equal(await viaSso.sso('/auth/oidc/login'), '/');
    assert.equal((await viaSso.json('/api/me')).body.me.username, 'alex');

    assert.equal((await admin.json('/api/me/sso', { method: 'DELETE' })).status, 200);
    assert.equal(await app.client().sso('/auth/oidc/login'), '/?signin=no-account');
  } finally {
    await app.close();
  }
});
