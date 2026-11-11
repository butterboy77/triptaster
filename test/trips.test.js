import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, setupAdmin, invite } from './helpers.js';

let app, admin, member;
before(async () => {
  app = await startApp();
  admin = await setupAdmin(app);
  const token = await invite(admin);
  member = app.client();
  await member.json(`/api/links/${token}`, { method: 'POST', body: { username: 'sam', display_name: 'Sam', password: 'long enough pw' } });
});
after(() => app.close());

test('trips keep their places separate, and everyone shares them', async () => {
  const bali = (await admin.json('/api/trips', { method: 'POST', body: { name: 'Bali', city: 'Sanur' } })).body.id;
  const tokyo = (await member.json('/api/trips', { method: 'POST', body: { name: 'Tokyo', city: 'Tokyo' } })).body.id;
  const add = (trip, body) => admin.json(`/api/trips/${trip}/venues`, { method: 'POST', body });

  const created = await add(bali, { name: '  Warung Test ', kind: 'street_food', moments: ['lunch'], price: 1, maps_url: 'https://maps.app.goo.gl/abc' });
  assert.equal(created.status, 201);
  await add(tokyo, { name: 'Ramen Test', kind: 'restaurant' });

  const baliVenues = (await member.json(`/api/trips/${bali}/venues`)).body;
  assert.deepEqual(baliVenues.map((v) => v.name), ['Warung Test']);
  const trips = (await member.json('/api/trips')).body;
  assert.deepEqual(trips.map((t) => [t.name, t.venue_count]).sort(), [['Bali', 1], ['Tokyo', 1]]);

  const id = created.body.id;
  await admin.json(`/api/venues/${id}/rating`, { method: 'PUT', body: { stars: 5 } });
  await member.json(`/api/venues/${id}/rating`, { method: 'PUT', body: { stars: 3 } });
  await member.json(`/api/venues/${id}/visits`, { method: 'POST', body: { visited_on: '2026-11-02', note: 'Sate!' } });
  const [venue] = (await admin.json(`/api/trips/${bali}/venues`)).body;
  assert.deepEqual(venue.ratings.map((r) => r.stars).sort(), [3, 5]);
  assert.equal(venue.visits[0].note, 'Sate!');
  assert.equal((await admin.json('/api/trips')).body.find((t) => t.id === bali).been_count, 1);

  assert.equal((await admin.json(`/api/trips/${tokyo}`, { method: 'DELETE' })).status, 200);
  assert.equal((await admin.json(`/api/trips/${tokyo}/venues`)).status, 404);
});

test('validation rejects bad input', async () => {
  assert.equal((await admin.json('/api/trips', { method: 'POST', body: { name: 'No city' } })).status, 400);
  const trip = (await admin.json('/api/trips', { method: 'POST', body: { name: 'V', city: 'V' } })).body.id;
  const venue = { name: 'x', kind: 'bar' };
  for (const bad of [
    { ...venue, name: ' ' },
    { ...venue, kind: 'nightclub' },
    { ...venue, moments: ['brunch'] },
    { ...venue, price: 9 },
    { ...venue, maps_url: 'javascript:alert(1)' },
  ]) {
    assert.equal((await admin.json(`/api/trips/${trip}/venues`, { method: 'POST', body: bad })).status, 400, JSON.stringify(bad));
  }
  const { id } = (await admin.json(`/api/trips/${trip}/venues`, { method: 'POST', body: venue })).body;
  assert.equal((await admin.json(`/api/venues/${id}/visits`, { method: 'POST', body: { visited_on: '2026-02-31' } })).status, 400);
  assert.equal((await admin.json(`/api/venues/${id}/rating`, { method: 'PUT', body: { stars: 6 } })).status, 400);
  assert.equal((await admin.json('/api/trips/99999/venues', { method: 'POST', body: venue })).status, 404);
});

test('export and import round-trip, matching people by username', async () => {
  const exported = await admin.json('/api/admin/export');
  assert.equal(exported.status, 200);
  const bali = exported.body.trips.find((t) => t.name === 'Bali');
  assert.deepEqual(bali.venues[0].ratings.map((r) => r.by).sort(), ['alex', 'sam']);

  const other = await startApp();
  try {
    const otherAdmin = await setupAdmin(other);
    const result = await otherAdmin.json('/api/admin/import', { method: 'POST', body: exported.body });
    assert.equal(result.status, 201);
    const trips = (await otherAdmin.json('/api/trips')).body;
    const imported = trips.find((t) => t.name === 'Bali');
    const [venue] = (await otherAdmin.json(`/api/trips/${imported.id}/venues`)).body;
    assert.equal(venue.ratings.length, 1, 'only alex exists here, so only alex’s rating comes across');
    assert.equal(venue.visits[0].note, 'Sate!');

    const bad = await otherAdmin.json('/api/admin/import', { method: 'POST', body: { app: 'something-else' } });
    assert.equal(bad.status, 400);
    const broken = structuredClone(exported.body);
    broken.trips[0].venues.push({ name: 'Bad', kind: 'nope' });
    const before = (await otherAdmin.json('/api/trips')).body.length;
    assert.equal((await otherAdmin.json('/api/admin/import', { method: 'POST', body: broken })).status, 400);
    assert.equal((await otherAdmin.json('/api/trips')).body.length, before, 'a failed import changes nothing');
  } finally {
    await other.close();
  }
});
