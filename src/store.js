// Queries shared by the routes, backups and the CLI.

export function listTrips(db) {
  return db
    .prepare(
      `SELECT t.*,
         (SELECT COUNT(*) FROM venues v WHERE v.trip_id = t.id) AS venue_count,
         (SELECT COUNT(DISTINCT v.id) FROM venues v JOIN visits x ON x.venue_id = v.id WHERE v.trip_id = t.id) AS been_count
       FROM trips t ORDER BY t.created_at DESC, t.id DESC`,
    )
    .all();
}

export function listVenues(db, tripId) {
  const visits = db
    .prepare('SELECT x.* FROM visits x JOIN venues v ON v.id = x.venue_id WHERE v.trip_id = ? ORDER BY visited_on DESC, x.id DESC')
    .all(tripId);
  const ratings = db.prepare('SELECT r.* FROM ratings r JOIN venues v ON v.id = r.venue_id WHERE v.trip_id = ?').all(tripId);
  const photos = db
    .prepare(
      `SELECT p.id, p.venue_id, p.visit_id, p.user_id, p.width, p.height, p.created_at
       FROM photos p JOIN venues v ON v.id = p.venue_id WHERE v.trip_id = ? ORDER BY p.id`,
    )
    .all(tripId);
  return db
    .prepare('SELECT * FROM venues WHERE trip_id = ? ORDER BY created_at DESC, id DESC')
    .all(tripId)
    .map((venue) => ({
      ...venue,
      moments: JSON.parse(venue.moments),
      visits: visits.filter((v) => v.venue_id === venue.id),
      ratings: ratings.filter((r) => r.venue_id === venue.id),
      photos: photos.filter((p) => p.venue_id === venue.id),
    }));
}

// `v` must already be validated (see validateVenue).
export function insertVenue(db, v, { tripId, userId }) {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO venues (trip_id, name, kind, moments, cuisine, area, price, maps_url, must_try, notes, added_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(tripId, v.name, v.kind, v.moments, v.cuisine, v.area, v.price, v.maps_url, v.must_try, v.notes, userId);
  return Number(lastInsertRowid);
}

export function updateVenue(db, v, venueId) {
  db.prepare(
    `UPDATE venues SET name = ?, kind = ?, moments = ?, cuisine = ?, area = ?, price = ?, maps_url = ?, must_try = ?, notes = ?
     WHERE id = ?`,
  ).run(v.name, v.kind, v.moments, v.cuisine, v.area, v.price, v.maps_url, v.must_try, v.notes, venueId);
}

export function insertPhoto(db, { venueId, visitId = null, userId, file, type, width, height, bytes }) {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO photos (venue_id, visit_id, user_id, file, type, width, height, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(venueId, visitId, userId, file, type, width ?? null, height ?? null, bytes);
  return Number(lastInsertRowid);
}

export const photoBytesUsed = (db) => db.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM photos').get().n;

// Photo rows that a venue or trip delete would cascade away, so their files can be removed too.
export const photosOfVenue = (db, venueId) => db.prepare('SELECT file, type FROM photos WHERE venue_id = ?').all(venueId);
export const photosOfTrip = (db, tripId) =>
  db.prepare('SELECT p.file, p.type FROM photos p JOIN venues v ON v.id = p.venue_id WHERE v.trip_id = ?').all(tripId);
