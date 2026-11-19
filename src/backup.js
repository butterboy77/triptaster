// Backups are a tar file holding data.json plus every photo, so one file restores a whole server.
// People are referred to by username, so backups move cleanly between servers.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { transaction } from './db.js';
import { HttpError } from './http.js';
import { imageType, MAX_PHOTO_BYTES, MAX_THUMB_BYTES } from './photos.js';
import { listTrips, listVenues, insertVenue, insertPhoto, photoBytesUsed } from './store.js';
import { tarHeader, tarPadding, tarEnd, readTarIndex } from './tar.js';
import { validateTrip, validateVenue, validDate, shortText } from './validate.js';

const EXT = { jpeg: 'jpg', webp: 'webp' };
const MAX_DATA_BYTES = 50 * 1024 * 1024;
const list = (value) => (Array.isArray(value) ? value : []);
const dimension = (value) => (Number.isInteger(value) && value > 0 && value <= 20000 ? value : null);

function collect(db, photos) {
  const usernames = new Map(db.prepare('SELECT id, username FROM users').all().map((u) => [u.id, u.username]));
  const by = (id) => usernames.get(id) ?? null;
  const photoRows = db.prepare('SELECT * FROM photos WHERE venue_id = ? ORDER BY id');
  const files = [];
  const trips = listTrips(db).map((trip) => ({
    name: trip.name,
    city: trip.city,
    venues: listVenues(db, trip.id).map((v) => {
      const visitIndex = new Map(v.visits.map((visit, i) => [visit.id, i]));
      return {
        name: v.name,
        kind: v.kind,
        moments: v.moments,
        cuisine: v.cuisine,
        area: v.area,
        price: v.price,
        maps_url: v.maps_url,
        must_try: v.must_try,
        notes: v.notes,
        added_by: by(v.added_by),
        visits: v.visits.map((x) => ({ visited_on: x.visited_on, note: x.note, by: by(x.user_id) })),
        ratings: v.ratings.map((r) => ({ stars: r.stars, by: by(r.user_id) })),
        photos: photoRows.all(v.id).flatMap((p) => {
          const target = photos.paths(p.file, p.type);
          let fullSize, thumbSize;
          try {
            fullSize = fs.statSync(target.full).size;
            thumbSize = fs.statSync(target.thumb).size;
          } catch {
            return []; // A missing file shouldn't spoil the whole backup.
          }
          const name = `photos/${p.file}`;
          files.push({ name: `${name}.${EXT[p.type]}`, path: target.full, size: fullSize });
          files.push({ name: `${name}-t.${EXT[p.type]}`, path: target.thumb, size: thumbSize });
          return [{
            file: `${name}.${EXT[p.type]}`,
            thumb: `${name}-t.${EXT[p.type]}`,
            width: p.width,
            height: p.height,
            by: by(p.user_id),
            visit: visitIndex.get(p.visit_id) ?? null,
          }];
        }),
      };
    }),
  }));
  return { data: { app: 'triptaster', format: 2, exported_at: new Date().toISOString(), trips }, files };
}

export async function writeBackup(db, photos, out) {
  const { data, files } = collect(db, photos);
  const json = Buffer.from(JSON.stringify(data, null, 1));
  await pipeline(async function* () {
    yield tarHeader('data.json', json.length);
    yield json;
    yield tarPadding(json.length);
    for (const file of files) {
      yield tarHeader(file.name, file.size);
      for await (const chunk of fs.createReadStream(file.path)) yield chunk;
      yield tarPadding(file.size);
    }
    yield tarEnd();
  }, out);
}

// Restores from a tar backup arriving as a stream (an upload or a file).
export async function restoreArchive(ctx, source) {
  const temp = path.join(ctx.photos.dir, `restore-${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    await pipeline(source, fs.createWriteStream(temp));
    const handle = await fs.promises.open(temp, 'r');
    try {
      let entries;
      try {
        entries = await readTarIndex(handle);
      } catch {
        throw new HttpError(400, 'That file isn’t a TripTaster backup');
      }
      const read = async (name) => {
        const entry = typeof name === 'string' ? entries.get(name) : null;
        if (!entry) return null;
        if (entry.size > Math.max(MAX_PHOTO_BYTES, MAX_DATA_BYTES)) throw new HttpError(400, `${name} is too big`);
        const buffer = Buffer.alloc(entry.size);
        await handle.read(buffer, 0, entry.size, entry.offset);
        return buffer;
      };
      let data;
      try {
        data = JSON.parse((await read('data.json')).toString('utf8'));
      } catch {
        throw new HttpError(400, 'That file isn’t a TripTaster backup');
      }
      return await restore(ctx, data, read);
    } finally {
      await handle.close();
    }
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

// Restores a JSON backup from TripTaster 1.0, which had no photos.
export const restoreJson = (ctx, data) => restore(ctx, data, null);

async function restore({ db, photos, importerId, photoLimitBytes }, data, readFile) {
  if (data?.app !== 'triptaster' || ![1, 2].includes(data.format) || !Array.isArray(data.trips)) {
    throw new HttpError(400, 'That file isn’t a TripTaster backup');
  }

  // Check everything before changing anything.
  const plan = data.trips.map((rawTrip) => ({
    trip: validateTrip(rawTrip),
    venues: list(rawTrip.venues).map((raw) => ({
      raw,
      venue: validateVenue(raw),
      visits: list(raw.visits).map((visit) => {
        if (!validDate(visit.visited_on)) throw new HttpError(400, `A visit to ${raw.name} has an invalid date`);
        return { visited_on: visit.visited_on, note: shortText(visit.note, 'Visit note', 2000), by: visit.by };
      }),
      ratings: list(raw.ratings),
      photos: readFile ? list(raw.photos) : [],
      saved: [],
    })),
  }));

  const written = [];
  try {
    let bytes = 0;
    const used = photoBytesUsed(db);
    for (const { venues } of plan) {
      for (const item of venues) {
        for (const photo of item.photos) {
          const full = await readFile(photo.file);
          const thumb = await readFile(photo.thumb);
          if (!full || !thumb) throw new HttpError(400, `A photo of ${item.venue.name} is missing from the backup`);
          const type = imageType(full);
          if (!type || imageType(thumb) !== type || full.length > MAX_PHOTO_BYTES || thumb.length > MAX_THUMB_BYTES) {
            throw new HttpError(400, `A photo of ${item.venue.name} isn’t a valid image`);
          }
          bytes += full.length + thumb.length;
          if (photoLimitBytes && used + bytes > photoLimitBytes) {
            throw new HttpError(507, 'There isn’t enough photo storage left to restore this backup');
          }
          const file = await photos.save(full, thumb, type);
          written.push({ file, type });
          item.saved.push({
            file,
            type,
            bytes: full.length + thumb.length,
            width: dimension(photo.width),
            height: dimension(photo.height),
            by: photo.by,
            visit: Number.isInteger(photo.visit) ? photo.visit : null,
          });
        }
      }
    }

    const findUser = db.prepare('SELECT id FROM users WHERE username = ?');
    const userId = (username) => (typeof username === 'string' ? (findUser.get(username)?.id ?? null) : null);
    const counts = { trips: plan.length, venues: 0, photos: written.length };
    transaction(db, () => {
      for (const { trip, venues } of plan) {
        const tripId = Number(
          db.prepare('INSERT INTO trips (name, city, created_by) VALUES (?, ?, ?)').run(trip.name, trip.city, importerId).lastInsertRowid,
        );
        for (const item of venues) {
          const venueId = insertVenue(db, item.venue, { tripId, userId: userId(item.raw.added_by) });
          counts.venues += 1;
          const visitIds = item.visits.map((visit) =>
            Number(
              db.prepare('INSERT INTO visits (venue_id, visited_on, note, user_id) VALUES (?, ?, ?, ?)').run(
                venueId,
                visit.visited_on,
                visit.note,
                userId(visit.by),
              ).lastInsertRowid,
            ),
          );
          for (const rating of item.ratings) {
            const raterId = userId(rating.by);
            if (raterId && [1, 2, 3, 4, 5].includes(rating.stars)) {
              db.prepare('INSERT OR REPLACE INTO ratings (venue_id, user_id, stars) VALUES (?, ?, ?)').run(venueId, raterId, rating.stars);
            }
          }
          for (const photo of item.saved) {
            insertPhoto(db, { ...photo, venueId, visitId: visitIds[photo.visit] ?? null, userId: userId(photo.by) });
          }
        }
      }
    });
    return counts;
  } catch (err) {
    photos.remove(written);
    throw err;
  }
}
