export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at > 0) cookies[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return cookies;
}

export async function readJson(req, maxBytes = 64 * 1024) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) {
    throw new HttpError(415, 'Expected JSON');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, 'Too much data');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value === null || typeof value !== 'object') throw new Error();
    return value;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

// Reads a raw request body into memory, refusing anything over maxBytes.
export async function readBody(req, maxBytes) {
  if (Number(req.headers['content-length']) > maxBytes) throw new HttpError(413, 'That file is too big');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, 'That file is too big');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

export function json(res, status, value, headers = {}) {
  send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
}

export function redirect(res, location, headers = {}) {
  send(res, 302, '', { Location: location, ...headers });
}
