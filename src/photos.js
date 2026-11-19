import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Phones shrink photos to about 2048px before uploading, so these are generous.
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
export const MAX_THUMB_BYTES = 1024 * 1024;
export const PHOTO_MIME = { jpeg: 'image/jpeg', webp: 'image/webp' };
const EXT = { jpeg: 'jpg', webp: 'webp' };
const FILE_PATTERN = /^([0-9a-f]{32})(-t)?\.(jpg|webp)$/;

// Identifies an image by its first bytes rather than trusting the declared type.
export function imageType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

export function createPhotoStore(dataDir) {
  const dir = path.join(dataDir, 'photos');
  fs.mkdirSync(dir, { recursive: true });

  const paths = (file, type) => ({
    full: path.join(dir, `${file}.${EXT[type]}`),
    thumb: path.join(dir, `${file}-t.${EXT[type]}`),
  });

  async function writeAtomic(target, data) {
    const temp = `${target}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.promises.writeFile(temp, data);
    await fs.promises.rename(temp, target);
  }

  return {
    dir,
    paths,
    async save(full, thumb, type) {
      const file = crypto.randomBytes(16).toString('hex');
      const target = paths(file, type);
      await writeAtomic(target.thumb, thumb);
      await writeAtomic(target.full, full);
      return file;
    },

    remove(rows) {
      for (const { file, type } of rows) {
        const target = paths(file, type);
        fs.rmSync(target.full, { force: true });
        fs.rmSync(target.thumb, { force: true });
      }
    },

    // Deletes files with no database row (e.g. left by a crash mid-upload) and stray temp files.
    sweep(knownFiles) {
      let removed = 0;
      for (const name of fs.readdirSync(dir)) {
        const match = name.match(FILE_PATTERN);
        if ((match && !knownFiles.has(match[1])) || name.endsWith('.tmp')) {
          fs.rmSync(path.join(dir, name), { force: true });
          removed += 1;
        }
      }
      return removed;
    },
  };
}
