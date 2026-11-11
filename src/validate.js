import { HttpError } from './http.js';

export const KINDS = ['restaurant', 'street_food', 'cafe', 'bakery', 'bar', 'beach_club'];
export const MOMENTS = ['breakfast', 'lunch', 'dinner', 'drinks', 'snacks'];
export const ROLES = ['admin', 'member'];

export function shortText(value, field, max = 120) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be text`);
  const text = value.trim();
  if (text.length > max) throw new HttpError(400, `${field} is too long`);
  return text;
}

function requiredText(value, field, max) {
  const text = shortText(value, field, max);
  if (!text) throw new HttpError(400, `${field} is required`);
  return text;
}

export function validateUsername(value) {
  if (typeof value !== 'string' || !/^[a-z0-9._-]{2,32}$/i.test(value.trim())) {
    throw new HttpError(400, 'Usernames are 2 to 32 letters, numbers, dots, dashes or underscores');
  }
  return value.trim();
}

export function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 10) throw new HttpError(400, 'Passwords need at least 10 characters');
  if (value.length > 200) throw new HttpError(400, 'That password is too long');
  return value;
}

export const validateDisplayName = (value) => requiredText(value, 'Name', 60);

export function validateTrip(input) {
  return { name: requiredText(input.name, 'Trip name', 80), city: requiredText(input.city, 'City', 80) };
}

export function validateVenue(input) {
  const name = requiredText(input.name, 'Name', 120);
  if (!KINDS.includes(input.kind)) throw new HttpError(400, 'Unknown venue type');
  const moments = Array.isArray(input.moments) ? input.moments : [];
  if (moments.some((m) => !MOMENTS.includes(m))) throw new HttpError(400, 'Unknown meal');
  const price = input.price === null || input.price === undefined || input.price === '' ? null : input.price;
  if (price !== null && ![1, 2, 3, 4].includes(price)) throw new HttpError(400, 'Price must be 1 to 4');
  const mapsUrl = shortText(input.maps_url, 'Maps link', 2000);
  if (mapsUrl) {
    let protocol;
    try {
      protocol = new URL(mapsUrl).protocol;
    } catch {
      throw new HttpError(400, 'Maps link is not a valid URL');
    }
    if (protocol !== 'https:' && protocol !== 'http:') throw new HttpError(400, 'Maps link must be a web link');
  }
  return {
    name,
    kind: input.kind,
    moments: JSON.stringify([...new Set(moments)]),
    cuisine: shortText(input.cuisine, 'Cuisine'),
    area: shortText(input.area, 'Location'),
    price,
    maps_url: mapsUrl,
    must_try: shortText(input.must_try, 'Must try', 500),
    notes: shortText(input.notes, 'Notes', 2000),
  };
}

export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}
