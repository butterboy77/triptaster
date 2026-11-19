// Admin tasks for when you can't get into the app, or for backups too big to upload through a browser, e.g.
//   docker exec -it triptaster node cli.js reset-password alice
//   docker exec triptaster node cli.js export > backup.tar
//   docker exec -i triptaster node cli.js import - < backup.tar
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './src/db.js';
import { sha256, randomToken } from './src/auth.js';
import { createPhotoStore } from './src/photos.js';
import { writeBackup, restoreArchive } from './src/backup.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [command, arg] = process.argv.slice(2);
const dataDir = process.env.DATA_DIR || path.join(HERE, 'data');
const db = openDb(dataDir);
const baseUrl = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

function link(kind, { userId = null, role = null }) {
  const token = randomToken();
  db.prepare('INSERT INTO links (token_hash, kind, role, user_id, expires_at) VALUES (?, ?, ?, ?, ?)').run(
    sha256(token),
    kind,
    role,
    userId,
    Date.now() + 24 * 3600 * 1000,
  );
  return `${baseUrl}/join/${token}`;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

switch (command) {
  case 'list-users': {
    for (const u of db.prepare('SELECT username, display_name, role, password_hash, oidc_sub FROM users ORDER BY username').all()) {
      const methods = [u.password_hash && 'password', u.oidc_sub && 'sso'].filter(Boolean).join('+') || 'none';
      console.log(`${u.username.padEnd(24)} ${u.role.padEnd(7)} ${methods.padEnd(13)} ${u.display_name}`);
    }
    break;
  }
  case 'reset-password': {
    const user = db.prepare('SELECT id FROM users WHERE username = ?').get(arg ?? '');
    if (!user) fail(`No user called "${arg}". Try: node cli.js list-users`);
    console.log(`Password reset link for ${arg}, valid for 24 hours:\n${link('reset', { userId: user.id })}`);
    break;
  }
  case 'invite-admin': {
    console.log(`Admin invite link, valid for 24 hours:\n${link('invite', { role: 'admin' })}`);
    break;
  }
  case 'export': {
    if (process.stdout.isTTY) fail('Redirect the backup to a file, e.g.: node cli.js export > backup.tar');
    await writeBackup(db, createPhotoStore(dataDir), process.stdout);
    break;
  }
  case 'import': {
    if (!arg) fail('Give a backup file, or - to read from standard input');
    const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
    if (!admin) fail('Finish setting up TripTaster first, so restored trips have an owner');
    const source = arg === '-' ? process.stdin : fs.createReadStream(arg);
    try {
      const result = await restoreArchive(
        { db, photos: createPhotoStore(dataDir), importerId: admin.id, photoLimitBytes: 0 },
        source,
      );
      console.log(`Restored ${result.trips} trips, ${result.venues} places and ${result.photos} photos.`);
    } catch (err) {
      fail(`Restore failed: ${err.message}`);
    }
    break;
  }
  default:
    console.log('Usage: node cli.js <list-users | reset-password <username> | invite-admin | export | import <file|->>');
    process.exit(command ? 1 : 0);
}
