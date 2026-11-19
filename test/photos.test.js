import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApp, setupAdmin, invite, fakeJpeg, uploadPhoto } from './helpers.js';

let app, admin, member, tripId, venueId;
const photoFiles = () => fs.readdirSync(path.join(app.dataDir, 'photos')).filter((f) => !f.endsWith('.tmp'));
const venue = async (id = venueId) => (await admin.json(`/api/trips/${tripId}/venues`)).body.find((v) => v.id === id);

before(async () => {
  app = await startApp();
  admin = await setupAdmin(app);
  const token = await invite(admin);
  member = app.client();
  await member.json(`/api/links/${token}`, { method: 'POST', body: { username: 'sam', display_name: 'Sam', password: 'long enough pw' } });
  tripId = (await admin.json('/api/trips', { method: 'POST', body: { name: 'Bali', city: 'Sanur' } })).body.id;
  venueId = (await admin.json(`/api/trips/${tripId}/venues`, { method: 'POST', body: { name: 'Warung', kind: 'street_food' } })).body.id;
});
after(() => app.close());

test('upload a photo, see it listed, and download both sizes', async () => {
  const full = fakeJpeg(6000);
  const thumb = fakeJpeg(600);
  const res = await uploadPhoto(member, venueId, { full, thumb });
  assert.equal(res.status, 201);
  const [photo] = (await venue()).photos;
  assert.equal(photo.id, res.body.id);
  assert.deepEqual([photo.width, photo.height], [2048, 1536]);

  const got = await admin.fetch(`/api/photos/${photo.id}/full`);
  assert.equal(got.headers.get('content-type'), 'image/jpeg');
  assert.match(got.headers.get('cache-control'), /private/);
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), full);
  const small = await admin.fetch(`/api/photos/${photo.id}/thumb`);
  assert.deepEqual(Buffer.from(await small.arrayBuffer()), thumb);
  assert.equal((await app.client().fetch(`/api/photos/${photo.id}/full`)).status, 401, 'signed-out people can’t see photos');
});

test('photos can belong to a visit, and survive the visit being deleted', async () => {
  const visitId = (await member.json(`/api/venues/${venueId}/visits`, { method: 'POST', body: { visited_on: '2026-11-02' } })).body.id;
  const { body } = await uploadPhoto(member, venueId, { visit: visitId });
  assert.equal((await venue()).photos.find((p) => p.id === body.id).visit_id, visitId);

  const otherVenue = (await admin.json(`/api/trips/${tripId}/venues`, { method: 'POST', body: { name: 'Bar', kind: 'bar' } })).body.id;
  assert.equal((await uploadPhoto(member, otherVenue, { visit: visitId })).status, 400, 'visit must match the place');

  await member.json(`/api/visits/${visitId}`, { method: 'DELETE' });
  assert.equal((await venue()).photos.find((p) => p.id === body.id).visit_id, null);
  const late = await uploadPhoto(member, venueId, { visit: visitId });
  assert.equal(late.status, 201, 'a photo queued for a since-deleted visit still uploads, to the place');
});

test('only real JPEG or WebP images are accepted', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(100)]);
  assert.equal((await uploadPhoto(member, venueId, { full: png, thumb: png })).status, 415);
  assert.equal((await uploadPhoto(member, venueId, { full: svg, thumb: fakeJpeg() })).status, 415);
  assert.equal((await uploadPhoto(member, venueId, { full: webp, thumb: fakeJpeg() })).status, 415, 'thumbnail and photo must match');
  assert.equal((await uploadPhoto(member, venueId, { type: 'image/svg+xml' })).status, 415);
  assert.equal((await uploadPhoto(member, venueId, { full: webp, thumb: webp, type: 'image/webp' })).status, 201);

  const raw = Buffer.concat([fakeJpeg(100), fakeJpeg(100)]);
  const bad = (headers) =>
    member.json(`/api/venues/${venueId}/photos`, { method: 'POST', raw, headers: { 'Content-Type': 'image/jpeg', ...headers } });
  assert.equal((await bad({})).status, 400, 'missing thumbnail length');
  assert.equal((await bad({ 'X-Thumb-Length': String(raw.length) })).status, 400, 'no room for the photo');
  assert.equal((await uploadPhoto(member, 999999)).status, 404);
  assert.equal((await uploadPhoto(member, venueId, { full: fakeJpeg(9 * 1024 * 1024) })).status, 413);
});

test('people delete their own photos; admins can delete any', async () => {
  const mine = (await uploadPhoto(member, venueId)).body.id;
  const theirs = (await uploadPhoto(admin, venueId)).body.id;
  const before = photoFiles().length;
  assert.equal((await member.json(`/api/photos/${theirs}`, { method: 'DELETE' })).status, 403);
  assert.equal((await member.json(`/api/photos/${mine}`, { method: 'DELETE' })).status, 200);
  assert.equal((await admin.json(`/api/photos/${theirs}`, { method: 'DELETE' })).status, 200);
  assert.equal(photoFiles().length, before - 4, 'both sizes of both photos are gone from disk');
  assert.equal((await admin.fetch(`/api/photos/${mine}/full`)).status, 404);
});

test('deleting a place or a trip removes its photo files', async () => {
  const place = (await admin.json(`/api/trips/${tripId}/venues`, { method: 'POST', body: { name: 'Temp', kind: 'cafe' } })).body.id;
  await uploadPhoto(admin, place);
  const count = photoFiles().length;
  await admin.json(`/api/venues/${place}`, { method: 'DELETE' });
  assert.equal(photoFiles().length, count - 2);

  const trip = (await admin.json('/api/trips', { method: 'POST', body: { name: 'Gone', city: 'X' } })).body.id;
  const inTrip = (await admin.json(`/api/trips/${trip}/venues`, { method: 'POST', body: { name: 'P', kind: 'bar' } })).body.id;
  await uploadPhoto(admin, inTrip);
  await uploadPhoto(admin, inTrip);
  await admin.json(`/api/trips/${trip}`, { method: 'DELETE' });
  assert.equal(photoFiles().length, count - 2);
});

test('admins see storage use', async () => {
  const { body } = await admin.json('/api/admin/storage');
  assert.ok(body.photo_bytes > 0 && body.photo_count > 0);
  assert.equal(body.photo_limit_bytes, null);
  assert.equal((await member.json('/api/admin/storage')).status, 403);
});

test('backups include photos and restore them on another server', async () => {
  const visitId = (await admin.json(`/api/venues/${venueId}/visits`, { method: 'POST', body: { visited_on: '2026-11-03', note: 'Nasi' } })).body.id;
  const full = fakeJpeg(7000);
  await uploadPhoto(admin, venueId, { full, visit: visitId });

  const res = await admin.fetch('/api/admin/export');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/x-tar');
  assert.match(res.headers.get('content-disposition'), /triptaster-\d{4}-\d{2}-\d{2}\.tar/);
  const tar = Buffer.from(await res.arrayBuffer());
  assert.equal(tar.length % 512, 0);

  const other = await startApp();
  try {
    const otherAdmin = await setupAdmin(other);
    const restored = await otherAdmin.json('/api/admin/import', {
      method: 'POST',
      raw: tar,
      headers: { 'Content-Type': 'application/x-tar' },
    });
    assert.equal(restored.status, 201);
    const sourcePhotos = (await venue()).photos.length;
    assert.equal(restored.body.photos, sourcePhotos);

    const trip = (await otherAdmin.json('/api/trips')).body.find((t) => t.name === 'Bali');
    const copy = (await otherAdmin.json(`/api/trips/${trip.id}/venues`)).body.find((v) => v.name === 'Warung');
    assert.equal(copy.photos.length, sourcePhotos);
    const linked = copy.photos.filter((p) => p.visit_id !== null);
    assert.equal(linked.length, 1, 'the photo is still attached to its visit');
    assert.equal(copy.visits.find((v) => v.id === linked[0].visit_id).note, 'Nasi');
    const downloaded = await otherAdmin.fetch(`/api/photos/${linked[0].id}/full`);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), full);

    const garbage = await otherAdmin.json('/api/admin/import', {
      method: 'POST',
      raw: Buffer.from('definitely not a tar file'.repeat(40)),
      headers: { 'Content-Type': 'application/x-tar' },
    });
    assert.equal(garbage.status, 400);
    assert.deepEqual(fs.readdirSync(path.join(other.dataDir, 'photos')).filter((f) => f.endsWith('.tmp')), [], 'upload temp file cleaned up');
  } finally {
    await other.close();
  }
});

test('photo storage limit', async () => {
  const small = await startApp({ photoLimitBytes: 20_000 });
  try {
    const a = await setupAdmin(small);
    const t = (await a.json('/api/trips', { method: 'POST', body: { name: 'T', city: 'C' } })).body.id;
    const v = (await a.json(`/api/trips/${t}/venues`, { method: 'POST', body: { name: 'V', kind: 'bar' } })).body.id;
    assert.equal((await uploadPhoto(a, v, { full: fakeJpeg(12_000) })).status, 201);
    assert.equal((await uploadPhoto(a, v, { full: fakeJpeg(12_000) })).status, 507);
    assert.equal((await a.json('/api/admin/storage')).body.photo_limit_bytes, 20_000);
  } finally {
    await small.close();
  }
});

test('leftover photo files are cleaned up on restart, real ones kept', async () => {
  const instance = await startApp();
  const a = await setupAdmin(instance);
  const t = (await a.json('/api/trips', { method: 'POST', body: { name: 'T', city: 'C' } })).body.id;
  const v = (await a.json(`/api/trips/${t}/venues`, { method: 'POST', body: { name: 'V', kind: 'bar' } })).body.id;
  const id = (await uploadPhoto(a, v)).body.id;
  const dir = path.join(instance.dataDir, 'photos');
  fs.writeFileSync(path.join(dir, `${'a'.repeat(32)}.jpg`), 'orphan');
  fs.writeFileSync(path.join(dir, 'half-written.tmp'), 'partial');
  await instance.close({ keepData: true });

  const restarted = await startApp({ dataDir: instance.dataDir });
  try {
    assert.match(restarted.logs.join('\n'), /Removed 2 leftover photo files/);
    assert.deepEqual(fs.readdirSync(dir).length, 2, 'the real photo and its thumbnail remain');
    const again = restarted.client();
    await again.json('/api/auth/login', { method: 'POST', body: { username: 'alex', password: 'correct horse battery' } });
    assert.equal((await again.fetch(`/api/photos/${id}/thumb`)).status, 200);
  } finally {
    await restarted.close();
  }
});
