# Changelog

## 1.1.0

- **Photos.** Add photos to places and visits from the camera or gallery, see them as tiles on the
  list, in each place's gallery, in the Diary and on the Lucky Dip result, and swipe through them
  full screen.
- Phones shrink photos to 2048 px before uploading, and camera metadata, including GPS location,
  is removed.
- Photos taken without signal wait on the phone and upload automatically later, even if the app is closed in between.
- People can delete their own photos; admins can delete any.
- Optional `PHOTO_STORAGE_LIMIT_GB`, and photo storage use shown in Settings.
- Backups are now a single `.tar` file, photos included. Version 1.0 `.json` backups still restore.
- New `export` and `import` commands in `cli.js` for backups too big to upload through a browser.

## 1.0.0

First public release, grown out of a private app built for a trip to Bali.

- Places, Lucky Dip and Diary, shared between everyone on the server.
- Multiple trips, each with its own city.
- Username and password sign-in, plus optional single sign-on through any OpenID Connect provider.
- First-run setup code, invite links, password reset links, and admin and member roles.
- JSON backup and restore.
- Installable on phones, works offline, and accepts places shared from Google Maps on Android.
