// Just enough of the tar format (ustar) for backups: regular files only.
// Tar has no 4 GB archive limit, and Windows, macOS and Linux can all open it.

const BLOCK = 512;

export function tarHeader(name, size, mtime = Date.now()) {
  const header = Buffer.alloc(BLOCK);
  const field = (value, offset, length) => header.write(value, offset, length, 'ascii');
  const octal = (value, length) => value.toString(8).padStart(length - 1, '0') + '\0';
  if (Buffer.byteLength(name) > 100) throw new Error(`Tar entry name too long: ${name}`);
  field(name, 0, 100);
  field(octal(0o644, 8), 100, 8);
  field(octal(0, 8), 108, 8);
  field(octal(0, 8), 116, 8);
  field(octal(size, 12), 124, 12);
  field(octal(Math.floor(mtime / 1000), 12), 136, 12);
  field('        ', 148, 8); // Checksum is calculated with this field as spaces.
  field('0', 156, 1);
  field('ustar\0', 257, 6);
  field('00', 263, 2);
  let sum = 0;
  for (const byte of header) sum += byte;
  field(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return header;
}

export const tarPadding = (size) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);
export const tarEnd = () => Buffer.alloc(BLOCK * 2);

// Lists the regular files in a tar file on disk: Map of name -> { offset, size }.
export async function readTarIndex(handle) {
  const entries = new Map();
  const header = Buffer.alloc(BLOCK);
  let position = 0;
  for (;;) {
    const { bytesRead } = await handle.read(header, 0, BLOCK, position);
    if (bytesRead < BLOCK || header.every((byte) => byte === 0)) break;
    let sum = 0;
    for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 32 : header[i];
    if (sum !== parseInt(header.toString('ascii', 148, 156).replace(/\0.*$/s, '').trim(), 8)) {
      throw new Error('This file isn’t a valid tar archive');
    }
    const text = (start, length) => header.toString('utf8', start, start + length).replace(/\0.*$/s, '');
    const prefix = text(345, 155);
    const name = (prefix ? `${prefix}/` : '') + text(0, 100);
    const size = parseInt(text(124, 12).trim() || '0', 8);
    const type = text(156, 1);
    if (type === '0' || type === '') entries.set(name.replace(/^\.\//, ''), { offset: position + BLOCK, size });
    position += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return entries;
}
