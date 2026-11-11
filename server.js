import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './src/app.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function fail(message) {
  console.error(`TripTaster can't start: ${message}`);
  process.exit(1);
}

const flag = (name, fallback) => {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

const baseUrl = (process.env.BASE_URL || '').replace(/\/$/, '');
if (!baseUrl) fail('set BASE_URL to the address people use to reach it, e.g. https://food.example.com');
try {
  new URL(baseUrl);
} catch {
  fail(`BASE_URL "${baseUrl}" is not a valid URL`);
}

const oidc = process.env.OIDC_ISSUER
  ? {
      issuer: process.env.OIDC_ISSUER,
      clientId: process.env.OIDC_CLIENT_ID || fail('OIDC_ISSUER is set, so OIDC_CLIENT_ID is required'),
      clientSecret: process.env.OIDC_CLIENT_SECRET || '',
      label: process.env.OIDC_LABEL || 'Single sign-on',
      autoRegister: flag('OIDC_AUTO_REGISTER', false),
      allowedGroups: (process.env.OIDC_ALLOWED_GROUPS || '').split(',').map((g) => g.trim()).filter(Boolean),
    }
  : null;
const passwordLogin = flag('PASSWORD_LOGIN', true);
if (!passwordLogin && !oidc) fail('PASSWORD_LOGIN is off and OIDC is not configured, so nobody could sign in');

const port = Number(process.env.PORT || 3000);
const server = createApp({
  baseUrl,
  dataDir: process.env.DATA_DIR || path.join(HERE, 'data'),
  passwordLogin,
  trustProxy: flag('TRUST_PROXY', false),
  oidc,
});
server.listen(port, () => {
  const methods = [passwordLogin && 'passwords', oidc && `OIDC (${oidc.issuer})`].filter(Boolean).join(' and ');
  console.log(`TripTaster is listening on port ${port} for ${baseUrl}, signing in with ${methods}`);
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
