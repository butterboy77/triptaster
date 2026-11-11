import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, setupAdmin, invite } from './helpers.js';

let app;
before(async () => {
  app = await startApp();
});
after(() => app.close());

test('first run: setup needs the code from the logs, and only works once', async () => {
  const visitor = app.client();
  assert.equal((await visitor.json('/api/auth/status')).body.setupRequired, true);
  assert.ok(app.setupCode(), 'setup code is logged');
  assert.equal((await visitor.json('/api/me')).status, 401);

  const wrong = await visitor.json('/api/auth/setup', {
    method: 'POST',
    body: { code: 'AAAA-AAAA-AAAA-AAAA', username: 'mallory', display_name: 'M', password: 'long enough pw' },
  });
  assert.equal(wrong.status, 403);

  const admin = await setupAdmin(app);
  const me = await admin.json('/api/me');
  assert.equal(me.body.me.role, 'admin');
  assert.equal((await visitor.json('/api/auth/status')).body.setupRequired, false);

  const again = await visitor.json('/api/auth/setup', {
    method: 'POST',
    body: { code: app.setupCode(), username: 'mallory', display_name: 'M', password: 'long enough pw' },
  });
  assert.equal(again.status, 409);
});

test('password login, wrong passwords, and slowing down guessing', async () => {
  const c = app.client();
  const login = (password, username = 'alex') => c.json('/api/auth/login', { method: 'POST', body: { username, password } });
  assert.equal((await login('correct horse battery', 'ALEX')).status, 200, 'usernames are case-insensitive');
  assert.equal((await c.json('/api/me')).body.me.username, 'alex');

  const guesser = app.client();
  for (let i = 0; i < 8; i += 1) {
    const res = await guesser.json('/api/auth/login', { method: 'POST', body: { username: 'victim', password: `guess ${i}` } });
    assert.equal(res.status, 401);
  }
  const blocked = await guesser.json('/api/auth/login', { method: 'POST', body: { username: 'victim', password: 'guess 9' } });
  assert.equal(blocked.status, 429);
  assert.equal((await login('nope nope nope', 'nobody')).status, 401, 'unknown users get the same answer');
});

test('invites create members who can sign in; links work once', async () => {
  const admin = await loginAdmin();
  const token = await invite(admin);
  const guest = app.client();
  const info = await guest.json(`/api/links/${token}`);
  assert.equal(info.body.kind, 'invite');

  const short = await guest.json(`/api/links/${token}`, { method: 'POST', body: { username: 'sam', display_name: 'Sam', password: 'short' } });
  assert.equal(short.status, 400);
  const taken = await guest.json(`/api/links/${token}`, { method: 'POST', body: { username: 'Alex', display_name: 'Sam', password: 'long enough pw' } });
  assert.equal(taken.status, 409);
  const ok = await guest.json(`/api/links/${token}`, { method: 'POST', body: { username: 'sam', display_name: 'Sam', password: 'long enough pw' } });
  assert.equal(ok.status, 200);
  assert.equal((await guest.json('/api/me')).body.me.role, 'member');

  const reused = await app.client().json(`/api/links/${token}`, { method: 'POST', body: { username: 'sam2', display_name: 'S', password: 'long enough pw' } });
  assert.equal(reused.status, 404);
  assert.equal((await app.client().json('/api/links/not-a-real-token')).status, 404);
});

test('members cannot use admin tools', async () => {
  const member = await login('sam', 'long enough pw');
  assert.equal((await member.json('/api/admin/users')).status, 403);
  assert.equal((await member.json('/api/admin/invites', { method: 'POST', body: {} })).status, 403);
  assert.equal((await member.json('/api/admin/export')).status, 403);
});

test('admins can reset passwords, which signs the person out everywhere', async () => {
  const admin = await loginAdmin();
  const member = await login('sam', 'long enough pw');
  const users = (await admin.json('/api/admin/users')).body;
  const sam = users.find((u) => u.username === 'sam');
  const { body } = await admin.json(`/api/admin/users/${sam.id}/reset`, { method: 'POST', body: {} });
  const token = new URL(body.url).pathname.split('/').pop();

  const info = await app.client().json(`/api/links/${token}`);
  assert.deepEqual([info.body.kind, info.body.username], ['reset', 'sam']);
  const reset = app.client();
  assert.equal((await reset.json(`/api/links/${token}`, { method: 'POST', body: { password: 'brand new password' } })).status, 200);
  assert.equal((await member.json('/api/me')).status, 401, 'old session ended');
  assert.equal((await reset.json('/api/me')).body.me.username, 'sam');
  await login('sam', 'brand new password');
});

test('changing your own password needs the current one', async () => {
  const sam = await login('sam', 'brand new password');
  const wrong = await sam.json('/api/me/password', { method: 'POST', body: { current: 'nope', password: 'another new password' } });
  assert.equal(wrong.status, 403);
  const ok = await sam.json('/api/me/password', { method: 'POST', body: { current: 'brand new password', password: 'another new password' } });
  assert.equal(ok.status, 200);
  assert.equal((await sam.json('/api/me')).status, 200, 'this session stays signed in');
});

test('there is always an admin, and you cannot remove yourself', async () => {
  const admin = await loginAdmin();
  const users = (await admin.json('/api/admin/users')).body;
  const me = users.find((u) => u.username === 'alex');
  assert.equal((await admin.json(`/api/admin/users/${me.id}`, { method: 'PATCH', body: { role: 'member' } })).status, 400);
  assert.equal((await admin.json(`/api/admin/users/${me.id}`, { method: 'DELETE' })).status, 400);
});

test('cross-site writes are refused and sign-out ends the session', async () => {
  const admin = await loginAdmin();
  const forged = await admin.fetch('/api/trips', { method: 'POST', body: { name: 'x', city: 'y' }, headers: { origin: 'https://evil.example' } });
  assert.equal(forged.status, 403);
  const plain = await admin.fetch('/api/trips', { method: 'POST', headers: { 'Content-Type': 'text/plain' } });
  assert.equal(plain.status, 415);
  const before = { ...admin.cookies };
  await admin.fetch('/api/auth/logout', { method: 'POST' });
  admin.cookies = before;
  assert.equal((await admin.json('/api/me')).status, 401);
});

test('pages are served for invite links but other paths 404', async () => {
  const c = app.client();
  assert.equal((await c.fetch('/join/abc_DEF-123')).status, 200);
  assert.equal((await c.fetch('/../server.js')).status, 404);
  assert.equal((await c.fetch('/src/app.js')).status, 404);
});

async function login(username, password) {
  const c = app.client();
  const res = await c.json('/api/auth/login', { method: 'POST', body: { username, password } });
  assert.equal(res.status, 200, `${username} can sign in`);
  return c;
}
const loginAdmin = () => login('alex', 'correct horse battery');
