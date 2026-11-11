// Admin tasks for when you can't get into the app, e.g.
//   docker exec -it triptaster node cli.js reset-password alice
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './src/db.js';
import { sha256, randomToken } from './src/auth.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [command, username] = process.argv.slice(2);
const db = openDb(process.env.DATA_DIR || path.join(HERE, 'data'));
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

switch (command) {
  case 'list-users': {
    for (const u of db.prepare('SELECT username, display_name, role, password_hash, oidc_sub FROM users ORDER BY username').all()) {
      const methods = [u.password_hash && 'password', u.oidc_sub && 'sso'].filter(Boolean).join('+') || 'none';
      console.log(`${u.username.padEnd(24)} ${u.role.padEnd(7)} ${methods.padEnd(13)} ${u.display_name}`);
    }
    break;
  }
  case 'reset-password': {
    const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username ?? '');
    if (!user) {
      console.error(`No user called "${username}". Try: node cli.js list-users`);
      process.exit(1);
    }
    console.log(`Password reset link for ${username}, valid for 24 hours:\n${link('reset', { userId: user.id })}`);
    break;
  }
  case 'invite-admin': {
    console.log(`Admin invite link, valid for 24 hours:\n${link('invite', { role: 'admin' })}`);
    break;
  }
  default:
    console.log('Usage: node cli.js <list-users | reset-password <username> | invite-admin>');
    process.exit(command ? 1 : 0);
}
