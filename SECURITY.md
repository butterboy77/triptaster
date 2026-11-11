# Security

## Running it safely

- **Use HTTPS.** Put TripTaster behind a reverse proxy with a certificate. Sessions and passwords
  travel over this connection, and phones won't install the app without it.
- **Set `TRUST_PROXY=true` behind a proxy**, so limits on failed sign-ins apply per visitor. Leave it
  off if TripTaster is reachable directly, or visitors could fake their address.
- **Finish setup straight away.** Until the first admin exists, anyone holding the setup code from
  the logs can claim the server.
- **Use strong passwords.** At least 10 characters are required; longer is better.
- **Back up the data volume**, or use *Settings → Download backup*.

## What it does for you

- Passwords are hashed with scrypt. Session, invite and reset tokens are stored only as SHA-256 hashes.
- Repeated failed sign-ins are slowed down per address and per username.
- Writes are refused from other sites (Origin checks, JSON-only requests, SameSite cookies).
- A strict Content Security Policy is sent with every page.
- Single sign-on uses the authorization code flow with PKCE, with full ID token checks.

## Reporting a problem

Please report vulnerabilities privately through GitHub's
[security advisories](https://github.com/butterboy77/triptaster/security/advisories/new),
not in public issues.
