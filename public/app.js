const KINDS = {
  restaurant: { label: 'Restaurant', emoji: '🍽️' },
  street_food: { label: 'Street food', emoji: '🍜' },
  cafe: { label: 'Café', emoji: '☕' },
  bakery: { label: 'Bakery', emoji: '🥐' },
  bar: { label: 'Bar', emoji: '🍸' },
  beach_club: { label: 'Beach club', emoji: '🏖️' },
};
const MOMENTS = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', drinks: 'Drinks', snacks: 'Snacks' };
const SIGNIN_ERRORS = {
  failed: 'That sign-in didn’t work. Please try again.',
  'no-account': 'There’s no account for you yet. Ask whoever runs this TripTaster for an invite link.',
  'not-allowed': 'Your account isn’t in a group that’s allowed to use TripTaster.',
  taken: 'That single sign-on account is already linked to someone else.',
};
const POLL_MS = 30_000;
const TRIP_KEY = 'triptaster.trip';

const app = document.getElementById('app');
const sheet = document.getElementById('sheet');
const toastEl = document.getElementById('toast');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const state = {
  me: null,
  users: [],
  config: { passwordLogin: true, oidc: null },
  trips: [],
  tripId: Number(localStorage.getItem(TRIP_KEY)) || null,
  venues: [],
  offline: false,
  tab: 'places',
  search: '',
  listFilter: 'to-try',
  dipMoment: 'any',
  dipIncludeBeen: false,
  dipVetoes: new Set(),
  dipSpinning: false,
  dipWinner: null,
};
let openVenueId = null;
let lastSnapshot = null;

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// An open modal sheet sits in the top layer, so the toast has to live inside it to be seen.
function placeToast() {
  (sheet.open ? sheet : document.body).append(toastEl);
}

function toast(message) {
  placeToast();
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => toastEl.classList.remove('show'), 3200);
}

class SignedOut extends Error {}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    if (state.me) {
      state.me = null;
      showSignIn();
    }
    throw new SignedOut('Please sign in again');
  }
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

async function mutate(path, options, successMessage) {
  try {
    const result = await api(path, options);
    await refresh();
    if (successMessage) toast(successMessage);
    return result ?? {};
  } catch (err) {
    if (!(err instanceof SignedOut)) toast(navigator.onLine ? err.message : "You're offline. Try again when you have signal.");
    return null;
  }
}

async function refresh() {
  const [who, trips] = await Promise.all([api('/api/me'), api('/api/trips')]);
  if (!trips.some((t) => t.id === state.tripId)) setTrip(trips[0]?.id ?? null);
  const venues = state.tripId ? await api(`/api/trips/${state.tripId}/venues`) : [];
  const offline = !navigator.onLine;
  // Polling must not redraw an unchanged screen: it would replay animations and lose scroll position.
  const snapshot = JSON.stringify([who, trips, venues, offline, state.tripId]);
  if (snapshot === lastSnapshot) return;
  lastSnapshot = snapshot;
  Object.assign(state, { me: who.me, users: who.users, config: who.config, trips, venues, offline });
  if (state.dipWinner) state.dipWinner = venues.find((v) => v.id === state.dipWinner.id) ?? null;
  render();
  if (openVenueId !== null && sheet.open && !sheet.querySelector('form')) renderDetail(openVenueId);
}

function setTrip(id) {
  state.tripId = id;
  state.dipWinner = null;
  state.dipVetoes.clear();
  if (id) localStorage.setItem(TRIP_KEY, String(id));
  else localStorage.removeItem(TRIP_KEY);
}

// Helpers for displaying venues

const currentTrip = () => state.trips.find((t) => t.id === state.tripId) ?? null;
const venueById = (id) => state.venues.find((v) => v.id === id);
const userName = (id) => (id === state.me?.id ? 'You' : state.users.find((u) => u.id === id)?.display_name ?? 'Someone');
const tried = (venue) => venue.visits.length > 0;
const priceText = (price) => (price ? '$'.repeat(price) : '');
const starText = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);

function metaLine(venue) {
  return [KINDS[venue.kind]?.label, venue.cuisine, priceText(venue.price), venue.area].filter(Boolean).join(' · ');
}

function averageStars(venue) {
  if (!venue.ratings.length) return null;
  return venue.ratings.reduce((sum, r) => sum + r.stars, 0) / venue.ratings.length;
}

function mapsLink(venue) {
  const where = [venue.name, venue.area, currentTrip()?.city].filter(Boolean).join(', ');
  return venue.maps_url || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(where)}`;
}

function formatDate(iso) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

function todayIso() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

const initials = (name) => (name || '?').trim().charAt(0).toUpperCase();

// Signed-out screens: setup, sign in, and invite or reset links

function authShell(inner) {
  app.innerHTML = `
    <main class="auth">
      <img class="auth-flower" src="/icons/icon.svg" alt="">
      <h1>TripTaster</h1>
      ${inner}
    </main>`;
}

const field = (label, name, attrs = '') =>
  `<label class="field"><span>${label}</span><input name="${name}" ${attrs}></label>`;

function ssoButton(href, label) {
  return `<a class="btn sso" href="${esc(href)}">Continue with ${esc(label)}</a>`;
}

async function showSignIn() {
  let status;
  try {
    status = await api('/api/auth/status');
  } catch {
    return authShell('<p class="auth-lead">Can’t reach the server. Check your connection and try again.</p>');
  }
  state.config = status;
  const params = new URLSearchParams(location.search);
  const error = SIGNIN_ERRORS[params.get('signin')];

  if (status.setupRequired) {
    const badCode = params.get('setup') === 'bad-code';
    authShell(`
      <p class="auth-lead">Welcome! Let’s get you set up.</p>
      <form class="auth-card" data-form="setup">
        <p class="hint">Your setup code is in the server logs, e.g. <code>docker logs triptaster</code>.</p>
        ${field('Setup code', 'code', 'required autocomplete="off" autocapitalize="characters" placeholder="XXXX-XXXX-XXXX-XXXX"')}
        ${status.passwordLogin ? `
          ${field('Your name', 'display_name', 'required maxlength="60" autocomplete="given-name"')}
          ${field('Username', 'username', 'required minlength="2" maxlength="32" autocomplete="username" autocapitalize="none"')}
          ${field('Password', 'password', 'type="password" required minlength="10" autocomplete="new-password"')}
          <button class="btn block">Create admin account</button>` : ''}
        ${status.oidc ? `<button class="btn block ${status.passwordLogin ? 'secondary' : ''}" type="button" data-action="setup-sso">Continue with ${esc(status.oidc.label)}</button>` : ''}
        ${badCode ? '<p class="form-error" role="alert">That setup code isn’t right.</p>' : ''}
      </form>`);
    return;
  }

  authShell(`
    <p class="auth-lead">Your food diary for the trip.</p>
    <div class="auth-card">
      ${status.passwordLogin ? `
        <form data-form="login">
          ${field('Username', 'username', 'required autocomplete="username" autocapitalize="none"')}
          ${field('Password', 'password', 'type="password" required autocomplete="current-password"')}
          <button class="btn block">Sign in</button>
        </form>` : ''}
      ${status.passwordLogin && status.oidc ? '<div class="or">or</div>' : ''}
      ${status.oidc ? ssoButton('/auth/oidc/login', status.oidc.label) : ''}
      ${error ? `<p class="form-error" role="alert">${esc(error)}</p>` : ''}
    </div>`);
}

async function showJoin(token) {
  let link;
  try {
    link = await api(`/api/links/${encodeURIComponent(token)}`);
  } catch (err) {
    authShell(`<div class="auth-card"><p>${esc(err.message)}</p><a class="btn block" href="/">Go to sign in</a></div>`);
    return;
  }
  if (link.kind === 'reset') {
    authShell(`
      <p class="auth-lead">Choose a new password, ${esc(link.display_name)}.</p>
      <form class="auth-card" data-form="join" data-token="${esc(token)}">
        <input type="hidden" name="username" value="${esc(link.username)}" autocomplete="username">
        ${field('New password', 'password', 'type="password" required minlength="10" autocomplete="new-password"')}
        <button class="btn block">Save and sign in</button>
      </form>`);
    return;
  }
  authShell(`
    <p class="auth-lead">You’re invited! Join the trip.</p>
    <div class="auth-card">
      ${link.passwordLogin ? `
        <form data-form="join" data-token="${esc(token)}">
          ${field('Your name', 'display_name', 'required maxlength="60" autocomplete="given-name"')}
          ${field('Username', 'username', 'required minlength="2" maxlength="32" autocomplete="username" autocapitalize="none"')}
          ${field('Password', 'password', 'type="password" required minlength="10" autocomplete="new-password"')}
          <button class="btn block">Join</button>
        </form>` : ''}
      ${link.passwordLogin && link.oidc ? '<div class="or">or</div>' : ''}
      ${link.oidc ? ssoButton(`/auth/oidc/login?invite=${encodeURIComponent(token)}`, link.oidc.label) : ''}
    </div>`);
}

// Main screens

function venueCard(venue) {
  const kind = KINDS[venue.kind];
  const avg = averageStars(venue);
  return `
    <button class="venue-card" data-action="open-venue" data-id="${venue.id}">
      <span class="venue-emoji tint-${esc(venue.kind)}" aria-hidden="true">${kind?.emoji ?? '🍴'}</span>
      <span class="venue-text">
        <span class="venue-name">${esc(venue.name)}</span><br>
        <span class="venue-meta">${esc(metaLine(venue))}</span>
      </span>
      <span class="venue-side">
        ${avg !== null ? `<span class="score">★ ${avg.toFixed(1)}</span><br>` : ''}
        ${tried(venue) ? '<span class="tried">Been</span>' : ''}
      </span>
    </button>`;
}

function placesResults() {
  const total = state.venues.length;
  const term = state.search.trim().toLowerCase();
  const shown = state.venues.filter((venue) => {
    if (state.listFilter === 'to-try' && tried(venue)) return false;
    if (state.listFilter === 'been' && !tried(venue)) return false;
    return !term || `${venue.name} ${venue.cuisine} ${venue.area} ${venue.must_try} ${venue.notes}`.toLowerCase().includes(term);
  });
  if (!total) {
    return `<div class="empty">
      <div class="empty-art" aria-hidden="true">🌺</div>
      <h2>Nothing on the list yet</h2>
      <p>Add the first place you’re dying to try.</p>
      <button class="btn" data-action="add-venue">Add a place</button>
    </div>`;
  }
  if (!shown.length) {
    const message = state.listFilter === 'to-try' && !term ? 'You’ve been everywhere on the list. Time to add more!' : 'Nothing matches that.';
    return `<div class="empty"><div class="empty-art" aria-hidden="true">🍹</div><p>${message}</p></div>`;
  }
  return `<div class="cards">${shown.map(venueCard).join('')}</div>`;
}

function placesView() {
  const trip = currentTrip();
  const total = state.venues.length;
  const been = state.venues.filter(tried).length;
  const filters = [['to-try', 'To try'], ['been', 'Been'], ['all', 'All']]
    .map(([id, label]) => `<button class="chip" data-action="list-filter" data-id="${id}" aria-pressed="${state.listFilter === id}">${label}</button>`)
    .join('');
  return `
    <h1 class="page-title">${greeting()}, ${esc(state.me.display_name)}</h1>
    <p class="page-sub">What’s on the menu in ${esc(trip.city)}?</p>
    ${total ? `<div class="progress">
      <div class="progress-track"><div class="progress-fill" data-progress="${(been / total) * 100}"></div></div>
      <span>${been} of ${total} tried</span>
    </div>` : ''}
    <input class="search" type="search" placeholder="Search names, cuisines, notes…" aria-label="Search places" data-input="search" value="${esc(state.search)}">
    <div class="chips">${filters}</div>
    <div id="results">${placesResults()}</div>`;
}

function dipPool() {
  return state.venues.filter((venue) => {
    if (state.dipVetoes.has(venue.id)) return false;
    if (!state.dipIncludeBeen && tried(venue)) return false;
    return state.dipMoment === 'any' || venue.moments.includes(state.dipMoment);
  });
}

function dipView() {
  const pool = dipPool();
  const chips = [['any', 'Anything'], ...Object.entries(MOMENTS)]
    .map(([id, label]) => `<button class="chip" data-action="dip-moment" data-id="${id}" aria-pressed="${state.dipMoment === id}" ${state.dipSpinning ? 'disabled' : ''}>${label}</button>`)
    .join('');
  const count = pool.length;
  const note = count ? `Choosing from ${count} ${count === 1 ? 'place' : 'places'}` : 'Nothing fits. Try loosening the filters or adding a place.';
  const winner = state.dipWinner;

  return `
    <section class="dip-hero">
      <div class="dip-sun" aria-hidden="true"></div>
      <h1>Lucky Dip</h1>
      <p>Can’t decide? Let ${esc(currentTrip().city)} choose.</p>
      <svg class="dip-wave" viewBox="0 0 400 36" preserveAspectRatio="none" aria-hidden="true"><path d="M0 18c50-16 100-16 150 0s100 16 150 0 70-12 100-6v24H0z"/></svg>
    </section>
    <div class="dip-panel">
      <p class="dip-label">What are we after?</p>
      <div class="chips">${chips}</div>
      <label class="toggle">
        <input type="checkbox" data-input="dip-been" ${state.dipIncludeBeen ? 'checked' : ''}>
        Include places we’ve already been
      </label>
      ${winner ? '' : `<button class="spin-btn" data-action="spin" ${count && !state.dipSpinning ? '' : 'disabled'}>${state.dipSpinning ? 'Spinning…' : 'Spin 🌺'}</button>
      <p class="pool-note">${note}</p>`}
      ${state.dipVetoes.size && !state.dipSpinning ? `<div class="vetoes"><button class="link-btn" data-action="reset-vetoes">Bring back ${state.dipVetoes.size} skipped</button></div>` : ''}
      ${state.dipSpinning ? '<div class="reel" id="reel" aria-live="off"></div>' : ''}
      ${winner ? resultCard(winner, count) : ''}
    </div>`;
}

function resultCard(venue, remaining) {
  return `
    <article class="result" aria-live="polite">
      <div class="result-kicker">The dip has spoken</div>
      <h2>${esc(venue.name)}</h2>
      <p class="result-meta">${esc(metaLine(venue))}</p>
      ${venue.must_try ? `<p class="result-try"><strong>Must try:</strong> ${esc(venue.must_try)}</p>` : ''}
      <div class="result-actions">
        <a class="btn block" href="${esc(mapsLink(venue))}" target="_blank" rel="noopener">Let’s go! Open in Maps</a>
        <div class="result-row">
          <button class="btn secondary" data-action="veto" data-id="${venue.id}" ${remaining > 1 ? '' : 'disabled'}>Nope, again</button>
          <button class="btn lagoon" data-action="log-visit" data-id="${venue.id}">We went!</button>
        </div>
        <button class="link-btn" data-action="dip-done">Start over</button>
      </div>
    </article>`;
}

function diaryView() {
  const entries = state.venues
    .flatMap((venue) => venue.visits.map((visit) => ({ visit, venue })))
    .sort((a, b) => b.visit.visited_on.localeCompare(a.visit.visited_on) || b.visit.id - a.visit.id);

  if (!entries.length) {
    return `
      <h1 class="page-title">Diary</h1>
      <p class="page-sub">Every meal worth remembering.</p>
      <div class="empty">
        <div class="empty-art" aria-hidden="true">📖</div>
        <h2>No memories yet</h2>
        <p>Open a place and tap “We went!” to start your diary.</p>
      </div>`;
  }

  let lastDate = null;
  const rows = entries.map(({ visit, venue }) => {
    const heading = visit.visited_on !== lastDate ? `<div class="diary-date">${esc(formatDate(visit.visited_on))}</div>` : '';
    lastDate = visit.visited_on;
    const stars = venue.ratings.map((r) => `${esc(userName(r.user_id))} <span class="stars">${'★'.repeat(r.stars)}</span>`).join(' · ');
    return `${heading}
      <button class="diary-entry" data-action="open-venue" data-id="${venue.id}">
        <span class="venue-name">${esc(venue.name)}</span>
        ${stars ? `<br><span class="diary-stars">${stars}</span>` : ''}
        ${visit.note ? `<p class="diary-note">${esc(visit.note)}</p>` : ''}
      </button>`;
  }).join('');
  return `
    <h1 class="page-title">Diary</h1>
    <p class="page-sub">${entries.length} ${entries.length === 1 ? 'meal' : 'meals'} worth remembering.</p>
    ${rows}`;
}

function firstTripView() {
  return `
    <h1 class="page-title">${greeting()}, ${esc(state.me.display_name)}</h1>
    <p class="page-sub">Where are you off to?</p>
    <form class="empty trip-start" data-form="trip">
      <div class="empty-art" aria-hidden="true">🧳</div>
      <h2>Start your first trip</h2>
      ${field('Trip name', 'name', 'required maxlength="80" placeholder="Bali 2027"')}
      ${field('City', 'city', 'required maxlength="80" placeholder="Sanur"')}
      <button class="btn block">Let’s go</button>
    </form>`;
}

function render() {
  if (!state.me) return;
  const trip = currentTrip();
  const focused = document.activeElement?.dataset?.input === 'search';
  const caret = focused ? document.activeElement.selectionStart : 0;
  const view = !trip ? firstTripView() : { places: placesView, dip: dipView, diary: diaryView }[state.tab]();
  const navItem = (id, emoji, label) =>
    `<button data-action="tab" data-id="${id}" ${state.tab === id ? 'aria-current="page"' : ''}><span aria-hidden="true">${emoji}</span><span>${label}</span></button>`;
  const onDip = trip && state.tab === 'dip';
  app.innerHTML = `
    <header class="topbar ${onDip ? 'on-hero' : ''}">
      ${trip ? `<button class="trip-switch" data-action="trips" aria-label="Switch trip">🧳 <span>${esc(trip.name)}</span> ▾</button>` : '<span></span>'}
      <button class="avatar" data-action="settings" aria-label="Settings">${esc(initials(state.me.display_name))}</button>
    </header>
    <main class="page ${onDip ? 'page-dip' : ''}">
      ${state.offline ? '<p class="offline">You’re offline, so this is the last saved list.</p>' : ''}
      ${view}
    </main>
    ${trip && state.tab !== 'dip' ? '<button class="fab" data-action="add-venue">+ Add a place</button>' : ''}
    ${trip ? `<nav class="nav" aria-label="Main">
      ${navItem('places', '🌴', 'Places')}
      ${navItem('dip', '🌺', 'Lucky Dip')}
      ${navItem('diary', '📖', 'Diary')}
    </nav>` : ''}`;
  for (const bar of app.querySelectorAll('[data-progress]')) bar.style.width = `${bar.dataset.progress}%`;
  if (focused) {
    const input = app.querySelector('[data-input="search"]');
    input?.focus();
    input?.setSelectionRange(caret, caret);
  }
}

// Lucky dip

function pickRandom(list) {
  return list[crypto.getRandomValues(new Uint32Array(1))[0] % list.length];
}

async function spin() {
  const pool = dipPool();
  if (!pool.length || state.dipSpinning) return;
  const winner = pickRandom(pool);
  state.dipWinner = null;
  state.dipSpinning = true;
  render();

  if (!reducedMotion) {
    navigator.vibrate?.(12);
    document.getElementById('reel')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    let index = Math.floor(Math.random() * pool.length);
    for (let tick = 0; tick < 22; tick += 1) {
      const reel = document.getElementById('reel');
      if (reel) reel.innerHTML = `<span>${esc(pool[index++ % pool.length].name)}</span>`;
      navigator.vibrate?.(4);
      await new Promise((resolve) => setTimeout(resolve, 55 + (8 * tick ** 1.5) / 4));
    }
  }

  state.dipSpinning = false;
  state.dipWinner = winner;
  render();
  app.querySelector('.result')?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
  navigator.vibrate?.([30, 40, 60]);
  petalShower();
}

function petalShower() {
  if (reducedMotion) return;
  for (let i = 0; i < 26; i += 1) {
    const petal = document.createElement('div');
    petal.className = 'petal';
    petal.style.left = `${Math.random() * 100}vw`;
    petal.style.setProperty('--delay', `${Math.random() * 0.7}s`);
    petal.style.setProperty('--fall', `${2 + Math.random() * 1.4}s`);
    petal.style.setProperty('--drift', `${(Math.random() - 0.5) * 140}px`);
    petal.style.setProperty('--spin', `${200 + Math.random() * 500}deg`);
    petal.addEventListener('animationend', () => petal.remove());
    document.body.append(petal);
  }
}

// Sheets. Each one adds a history entry so Android's back button closes it.

function showSheet(html) {
  sheet.innerHTML = `<div class="sheet-inner"><div class="sheet-grip" aria-hidden="true"></div>${html}</div>`;
  if (!sheet.open) {
    sheet.showModal();
    history.pushState({ sheet: true }, '');
  }
  placeToast();
  sheet.scrollTop = 0;
}

function closeSheet() {
  if (!sheet.open) return;
  sheet.close();
  placeToast();
  openVenueId = null;
  if (history.state?.sheet) history.back();
}

addEventListener('popstate', () => {
  if (sheet.open) {
    sheet.close();
    placeToast();
    openVenueId = null;
  }
});
sheet.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeSheet();
});
sheet.addEventListener('click', (event) => {
  if (event.target === sheet) closeSheet();
});

const sheetHead = (title, back) => `
  <div class="sheet-head">
    ${back ? `<button class="close" data-action="${back}" aria-label="Back">‹</button>` : ''}
    <h2>${esc(title)}</h2>
    <button class="close" data-action="close-sheet" aria-label="Close">✕</button>
  </div>`;

function venueForm(venue = {}) {
  const kind = venue.kind ?? 'restaurant';
  const moments = venue.moments ?? [];
  const kinds = Object.entries(KINDS)
    .map(([id, k]) => `<input type="radio" name="kind" id="kind-${id}" value="${id}" ${id === kind ? 'checked' : ''}><label for="kind-${id}">${k.emoji} ${k.label}</label>`)
    .join('');
  const momentChecks = Object.entries(MOMENTS)
    .map(([id, label]) => `<input type="checkbox" name="moments" id="m-${id}" value="${id}" ${moments.includes(id) ? 'checked' : ''}><label for="m-${id}">${label}</label>`)
    .join('');
  const prices = [['', 'Not sure'], [1, '$'], [2, '$$'], [3, '$$$'], [4, '$$$$']]
    .map(([value, label]) => `<input type="radio" name="price" id="p-${value}" value="${value}" ${(venue.price ?? '') === value ? 'checked' : ''}><label for="p-${value}">${label}</label>`)
    .join('');

  showSheet(`
    ${sheetHead(venue.id ? 'Edit place' : 'Add a place')}
    <form data-form="venue" ${venue.id ? `data-id="${venue.id}"` : ''}>
      <label class="field"><span>Name</span><input name="name" required maxlength="120" value="${esc(venue.name)}" autocomplete="off"></label>
      <fieldset><legend class="legend">What kind of place?</legend><div class="check-row">${kinds}</div></fieldset>
      <fieldset><legend class="legend">Good for</legend><div class="check-row">${momentChecks}</div></fieldset>
      <label class="field"><span>Cuisine</span><input name="cuisine" maxlength="120" placeholder="Seafood, ramen, tapas…" value="${esc(venue.cuisine)}"></label>
      <fieldset><legend class="legend">Price</legend><div class="check-row">${prices}</div></fieldset>
      <label class="field"><span>Whereabouts</span><input name="area" maxlength="120" placeholder="Street, neighbourhood or landmark" value="${esc(venue.area)}"></label>
      <label class="field"><span>Google Maps link</span><input name="maps_url" type="url" maxlength="2000" placeholder="https://maps.app.goo.gl/…" value="${esc(venue.maps_url)}"></label>
      <label class="field"><span>Must try</span><input name="must_try" maxlength="500" placeholder="The dish everyone raves about" value="${esc(venue.must_try)}"></label>
      <label class="field"><span>Notes</span><textarea name="notes" rows="3" maxlength="2000" placeholder="Who recommended it, book ahead, sunset only…">${esc(venue.notes)}</textarea></label>
      <button class="btn block">${venue.id ? 'Save changes' : 'Add to our list'}</button>
    </form>`);
}

function renderDetail(id) {
  const venue = venueById(id);
  if (!venue) return closeSheet();
  openVenueId = id;
  const mine = venue.ratings.find((r) => r.user_id === state.me.id)?.stars ?? 0;
  const myStars = [1, 2, 3, 4, 5]
    .map((n) => `<button class="${n <= mine ? 'on' : ''}" data-action="rate" data-id="${id}" data-stars="${n === mine ? 0 : n}" aria-label="Rate ${n} of 5">★</button>`)
    .join('');
  const otherRatings = venue.ratings
    .filter((r) => r.user_id !== state.me.id)
    .map((r) => `<div class="rate-row"><strong>${esc(userName(r.user_id))}</strong><span class="stars" aria-label="${r.stars} of 5">${starText(r.stars)}</span></div>`)
    .join('');
  const visits = venue.visits
    .map((visit) => `
      <div class="visit-row">
        <div>
          <strong>${esc(formatDate(visit.visited_on))}</strong>
          <small>Logged by ${esc(userName(visit.user_id))}</small>
          ${visit.note ? `<div class="visit-note">${esc(visit.note)}</div>` : ''}
        </div>
        <button class="row-delete" data-action="delete-visit" data-id="${visit.id}" aria-label="Remove this visit">✕</button>
      </div>`)
    .join('');

  showSheet(`
    ${sheetHead(venue.name)}
    <p class="detail-meta">${esc(metaLine(venue))}</p>
    ${venue.moments.length ? `<div class="tags">${venue.moments.map((m) => `<span class="tag">${esc(MOMENTS[m] ?? m)}</span>`).join('')}</div>` : ''}
    ${venue.must_try ? `<div class="detail-block"><b>Must try</b>${esc(venue.must_try)}</div>` : ''}
    ${venue.notes ? `<div class="detail-block"><b>Notes</b>${esc(venue.notes)}</div>` : ''}
    <div class="detail-actions">
      <a class="btn secondary" href="${esc(mapsLink(venue))}" target="_blank" rel="noopener">📍 Maps</a>
      <button class="btn lagoon" data-action="log-visit" data-id="${id}">We went!</button>
    </div>
    <h3 class="section-title">Ratings</h3>
    <div class="rate-row"><strong>You</strong><span class="star-input">${myStars}</span></div>
    ${otherRatings}
    <h3 class="section-title">Visits</h3>
    ${visits || '<p class="page-sub">Not yet. Soon!</p>'}
    <div class="danger-zone">
      <button class="btn quiet" data-action="delete-venue" data-id="${id}">Delete</button>
      <button class="btn secondary" data-action="edit-venue" data-id="${id}">Edit details</button>
    </div>`);
}

function visitForm(id) {
  const venue = venueById(id);
  if (!venue) return;
  openVenueId = id;
  showSheet(`
    ${sheetHead(`How was ${venue.name}?`)}
    <form data-form="visit" data-id="${id}">
      <label class="field"><span>When</span><input name="visited_on" type="date" required value="${todayIso()}" max="${todayIso()}"></label>
      <label class="field"><span>What was good?</span><textarea name="note" rows="4" maxlength="2000" placeholder="The dish you’ll still be talking about at home…"></textarea></label>
      <button class="btn block lagoon">Save to our diary</button>
    </form>`);
}

// Trips sheet

function tripsSheet() {
  const rows = state.trips
    .map((trip) => `
      <div class="list-row ${trip.id === state.tripId ? 'current' : ''}">
        <button class="list-main" data-action="pick-trip" data-id="${trip.id}">
          <strong>${esc(trip.name)}</strong>
          <small>${esc(trip.city)} · ${trip.been_count} of ${trip.venue_count} tried</small>
        </button>
        <button class="row-delete" data-action="edit-trip" data-id="${trip.id}" aria-label="Edit ${esc(trip.name)}">✎</button>
      </div>`)
    .join('');
  showSheet(`
    ${sheetHead('Trips')}
    ${rows}
    <h3 class="section-title">New trip</h3>
    <form data-form="trip">
      ${field('Trip name', 'name', 'required maxlength="80" placeholder="Tokyo in spring"')}
      ${field('City', 'city', 'required maxlength="80" placeholder="Tokyo"')}
      <button class="btn block">Add trip</button>
    </form>`);
}

function tripForm(id) {
  const trip = state.trips.find((t) => t.id === id);
  if (!trip) return tripsSheet();
  showSheet(`
    ${sheetHead('Edit trip', 'trips')}
    <form data-form="trip" data-id="${id}">
      ${field('Trip name', 'name', `required maxlength="80" value="${esc(trip.name)}"`)}
      ${field('City', 'city', `required maxlength="80" value="${esc(trip.city)}"`)}
      <button class="btn block">Save</button>
    </form>
    <div class="danger-zone">
      <button class="btn quiet" data-action="delete-trip" data-id="${id}">Delete trip</button>
    </div>`);
}

// Settings sheet

async function settingsSheet() {
  const me = state.me;
  const isAdmin = me.role === 'admin';
  const { passwordLogin, oidc } = state.config;
  let people = '';
  if (isAdmin) {
    try {
      const [users, invites] = await Promise.all([api('/api/admin/users'), api('/api/admin/invites')]);
      people = `
        <h3 class="section-title">People</h3>
        ${users.map((u) => `
          <div class="list-row">
            <div class="list-main">
              <strong>${esc(u.display_name)}${u.id === me.id ? ' (you)' : ''}</strong>
              <small>@${esc(u.username)} · ${u.role === 'admin' ? 'Admin' : 'Member'} · ${[u.has_password && 'password', u.has_sso && esc(oidc?.label ?? 'SSO')].filter(Boolean).join(' + ') || 'no sign-in yet'}</small>
            </div>
            ${u.id === me.id ? '' : `<button class="row-delete" data-action="person" data-id="${u.id}" data-name="${esc(u.display_name)}" data-role="${u.role}" aria-label="Manage ${esc(u.display_name)}">⋯</button>`}
          </div>`).join('')}
        ${invites.map((i) => `
          <div class="list-row pending">
            <div class="list-main"><strong>Invite link</strong><small>${i.role === 'admin' ? 'Admin' : 'Member'} · expires ${esc(new Date(i.expires_at).toLocaleDateString())}</small></div>
            <button class="row-delete" data-action="revoke-invite" data-id="${i.id}" aria-label="Cancel invite">✕</button>
          </div>`).join('')}
        <div class="detail-actions">
          <button class="btn lagoon" data-action="invite" data-role="member">Invite someone</button>
          <button class="btn secondary" data-action="invite" data-role="admin">Invite an admin</button>
        </div>
        <h3 class="section-title">Backup</h3>
        <div class="detail-actions">
          <button class="btn secondary" data-action="export">Download backup</button>
          <label class="btn secondary file-btn">Restore trips<input type="file" accept="application/json,.json" data-input="import"></label>
        </div>
        <p class="hint">Restoring adds the trips in the file as new trips. Nothing is overwritten.</p>`;
    } catch (err) {
      people = `<p class="hint">${esc(err.message)}</p>`;
    }
  }

  showSheet(`
    ${sheetHead('Settings')}
    <h3 class="section-title">You</h3>
    <form data-form="profile">
      ${field('Your name', 'display_name', `required maxlength="60" value="${esc(me.display_name)}"`)}
      <p class="hint">Signed in as @${esc(me.username)}</p>
      <button class="btn secondary block">Save name</button>
    </form>
    ${passwordLogin ? `
      <h3 class="section-title">${me.has_password ? 'Change password' : 'Add a password'}</h3>
      <form data-form="password">
        <input type="hidden" name="username" value="${esc(me.username)}" autocomplete="username">
        ${me.has_password ? field('Current password', 'current', 'type="password" required autocomplete="current-password"') : ''}
        ${field('New password', 'password', 'type="password" required minlength="10" autocomplete="new-password"')}
        <button class="btn secondary block">Save password</button>
      </form>` : ''}
    ${oidc ? `
      <h3 class="section-title">${esc(oidc.label)}</h3>
      ${me.has_sso
        ? `<p class="hint">Linked. You can sign in with ${esc(oidc.label)}.</p>
           ${passwordLogin && me.has_password ? '<button class="btn quiet" data-action="unlink-sso">Unlink</button>' : ''}`
        : `<a class="btn secondary block" href="/auth/oidc/login?link=1">Link ${esc(oidc.label)}</a>`}` : ''}
    ${people}
    <div class="danger-zone">
      <a class="btn quiet" href="https://github.com/butterboy77/triptaster" target="_blank" rel="noopener">About TripTaster</a>
      <button class="btn secondary" data-action="logout">Sign out</button>
    </div>`);
}

function personSheet(el) {
  const { id, name, role } = el.dataset;
  showSheet(`
    ${sheetHead(name, 'settings')}
    <div class="stack">
      <button class="btn secondary block" data-action="set-role" data-id="${id}" data-role="${role === 'admin' ? 'member' : 'admin'}">
        ${role === 'admin' ? 'Make a member' : 'Make an admin'}
      </button>
      ${state.config.passwordLogin ? `<button class="btn secondary block" data-action="reset-link" data-id="${id}">Create a password reset link</button>` : ''}
      <button class="btn quiet block" data-action="remove-person" data-id="${id}" data-name="${esc(name)}">Remove ${esc(name)}</button>
    </div>`);
}

function linkSheet(title, url, explainer) {
  showSheet(`
    ${sheetHead(title, 'settings')}
    <p>${esc(explainer)}</p>
    <div class="link-box">${esc(url)}</div>
    <div class="detail-actions">
      <button class="btn secondary" data-action="copy" data-url="${esc(url)}">Copy</button>
      ${navigator.share ? `<button class="btn lagoon" data-action="share" data-url="${esc(url)}">Share</button>` : ''}
    </div>
    <p class="hint">Works once and expires in 7 days. You won’t be able to see it again.</p>`);
}

// Android's share sheet opens the app with ?title=&text=&url=. Google Maps sends
// the place name and address as lines of text followed by its link.
function handleShareTarget() {
  const params = new URLSearchParams(location.search);
  const title = params.get('title') ?? '';
  const text = params.get('text') ?? '';
  const sharedUrl = params.get('url') ?? '';
  if (!title && !text && !sharedUrl) return;
  history.replaceState(null, '', '/');
  if (!currentTrip()) return toast('Start a trip first, then share the place again.');
  const link = `${text}\n${sharedUrl}`.match(/https?:\/\/\S+/)?.[0] ?? '';
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line && !/^https?:\/\//.test(line));
  venueForm({ name: (title || lines[0] || '').slice(0, 120), area: title ? lines[0] ?? '' : lines[1] ?? '', maps_url: link });
}

function handleRedirectNotices() {
  const params = new URLSearchParams(location.search);
  if (params.has('linked')) {
    history.replaceState(null, '', '/');
    toast('Single sign-on is linked 🎉');
  } else if (params.has('signin')) {
    const message = SIGNIN_ERRORS[params.get('signin')];
    history.replaceState(null, '', '/');
    if (message) toast(message);
  }
}

// Events

const actions = {
  tab(el) {
    state.tab = el.dataset.id;
    render();
    scrollTo(0, 0);
  },
  'list-filter'(el) {
    state.listFilter = el.dataset.id;
    render();
  },
  'add-venue': () => venueForm(),
  'open-venue': (el) => renderDetail(Number(el.dataset.id)),
  'edit-venue': (el) => venueForm(venueById(Number(el.dataset.id))),
  'close-sheet': closeSheet,
  'log-visit': (el) => visitForm(Number(el.dataset.id)),
  async rate(el) {
    await mutate(`/api/venues/${el.dataset.id}/rating`, { method: 'PUT', body: { stars: Number(el.dataset.stars) } });
  },
  async 'delete-visit'(el) {
    if (confirm('Remove this visit?')) await mutate(`/api/visits/${el.dataset.id}`, { method: 'DELETE' }, 'Visit removed');
  },
  async 'delete-venue'(el) {
    const venue = venueById(Number(el.dataset.id));
    if (!confirm(`Delete ${venue.name}, along with its visits and ratings?`)) return;
    if (await mutate(`/api/venues/${venue.id}`, { method: 'DELETE' }, 'Place deleted')) closeSheet();
  },
  'dip-moment'(el) {
    state.dipMoment = el.dataset.id;
    state.dipWinner = null;
    render();
  },
  spin,
  veto(el) {
    state.dipVetoes.add(Number(el.dataset.id));
    spin();
  },
  'reset-vetoes'() {
    state.dipVetoes.clear();
    render();
  },
  'dip-done'() {
    state.dipWinner = null;
    state.dipVetoes.clear();
    render();
    scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
  },
  trips: tripsSheet,
  async 'pick-trip'(el) {
    setTrip(Number(el.dataset.id));
    closeSheet();
    lastSnapshot = null;
    await refresh().catch(() => {});
    scrollTo(0, 0);
  },
  'edit-trip': (el) => tripForm(Number(el.dataset.id)),
  async 'delete-trip'(el) {
    const trip = state.trips.find((t) => t.id === Number(el.dataset.id));
    if (!confirm(`Delete ${trip.name} and every place, visit and rating in it? This can’t be undone.`)) return;
    if (await mutate(`/api/trips/${trip.id}`, { method: 'DELETE' }, 'Trip deleted')) tripsSheet();
  },
  settings: settingsSheet,
  person: personSheet,
  async 'set-role'(el) {
    if (await mutate(`/api/admin/users/${el.dataset.id}`, { method: 'PATCH', body: { role: el.dataset.role } }, 'Updated')) settingsSheet();
  },
  async 'reset-link'(el) {
    const result = await mutate(`/api/admin/users/${el.dataset.id}/reset`, { method: 'POST', body: {} });
    if (result) linkSheet('Password reset link', result.url, 'Send this to them. It lets them choose a new password.');
  },
  async 'remove-person'(el) {
    if (!confirm(`Remove ${el.dataset.name}? Their places stay, but their ratings go.`)) return;
    if (await mutate(`/api/admin/users/${el.dataset.id}`, { method: 'DELETE' }, `${el.dataset.name} removed`)) settingsSheet();
  },
  async invite(el) {
    const role = el.dataset.role;
    const result = await mutate('/api/admin/invites', { method: 'POST', body: { role } });
    if (result) linkSheet(role === 'admin' ? 'Admin invite' : 'Invite', result.url, 'Send this link to the person you’re inviting.');
  },
  async 'revoke-invite'(el) {
    if (await mutate(`/api/admin/invites/${el.dataset.id}`, { method: 'DELETE' }, 'Invite cancelled')) settingsSheet();
  },
  async copy(el) {
    try {
      await navigator.clipboard.writeText(el.dataset.url);
      toast('Copied');
    } catch {
      toast('Couldn’t copy. Press and hold the link instead.');
    }
  },
  share(el) {
    navigator.share({ title: 'Join me on TripTaster', url: el.dataset.url }).catch(() => {});
  },
  async export() {
    try {
      const res = await fetch('/api/admin/export');
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(blob),
        download: `triptaster-${todayIso()}.json`,
      });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } catch {
      toast('Couldn’t download the backup');
    }
  },
  async 'unlink-sso'() {
    if (await mutate('/api/me/sso', { method: 'DELETE' }, 'Unlinked')) settingsSheet();
  },
  async logout() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    // Cached data must not outlive the session on this phone.
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        if (new URL(request.url).pathname.startsWith('/api/')) await cache.delete(request);
      }
    }
    location.href = '/';
  },
  'setup-sso'(el) {
    const code = el.form.elements.code.value.trim();
    if (!code) return toast('Enter the setup code first');
    location.href = `/auth/oidc/login?setup=${encodeURIComponent(code)}`;
  },
};

document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-action]');
  if (el && !el.disabled) actions[el.dataset.action]?.(el);
});

document.addEventListener('input', (event) => {
  if (event.target.dataset.input === 'search') {
    // Only the results are redrawn: replacing the input would break Android keyboard composition.
    state.search = event.target.value;
    document.getElementById('results').innerHTML = placesResults();
  }
});

document.addEventListener('change', async (event) => {
  const input = event.target.dataset.input;
  if (input === 'dip-been') {
    state.dipIncludeBeen = event.target.checked;
    state.dipWinner = null;
    render();
  } else if (input === 'import') {
    const file = event.target.files[0];
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      return toast('That file isn’t a TripTaster backup');
    }
    const result = await mutate('/api/admin/import', { method: 'POST', body: data });
    if (result) toast(`Restored ${result.trips} ${result.trips === 1 ? 'trip' : 'trips'} with ${result.venues} places`);
  }
});

const forms = {
  async setup(data) {
    await api('/api/auth/setup', {
      method: 'POST',
      body: { code: data.get('code'), display_name: data.get('display_name'), username: data.get('username'), password: data.get('password') },
    });
    location.replace('/');
  },
  async login(data) {
    await api('/api/auth/login', { method: 'POST', body: { username: data.get('username'), password: data.get('password') } });
    location.replace('/');
  },
  async join(data, form) {
    await api(`/api/links/${encodeURIComponent(form.dataset.token)}`, {
      method: 'POST',
      body: { display_name: data.get('display_name'), username: data.get('username'), password: data.get('password') },
    });
    location.replace('/');
  },
  async venue(data, form) {
    const id = form.dataset.id;
    const price = data.get('price');
    const body = {
      name: data.get('name'),
      kind: data.get('kind'),
      moments: data.getAll('moments'),
      cuisine: data.get('cuisine'),
      area: data.get('area'),
      price: price ? Number(price) : null,
      maps_url: data.get('maps_url'),
      must_try: data.get('must_try'),
      notes: data.get('notes'),
    };
    const path = id ? `/api/venues/${id}` : `/api/trips/${state.tripId}/venues`;
    const done = await mutate(path, { method: id ? 'PUT' : 'POST', body }, id ? 'Saved' : `${body.name} is on the list 🌺`);
    if (done) id ? renderDetail(Number(id)) : closeSheet();
  },
  async visit(data, form) {
    const id = Number(form.dataset.id);
    const done = await mutate(`/api/venues/${id}/visits`, {
      method: 'POST',
      body: { visited_on: data.get('visited_on'), note: data.get('note') },
    }, 'Added to your diary 📖');
    if (done) {
      state.dipWinner = null;
      renderDetail(id);
    }
  },
  async trip(data, form) {
    const id = form.dataset.id;
    const body = { name: data.get('name'), city: data.get('city') };
    const result = await mutate(id ? `/api/trips/${id}` : '/api/trips', { method: id ? 'PUT' : 'POST', body }, id ? 'Trip saved' : `${body.name} is ready ✈️`);
    if (!result) return;
    if (!id) {
      setTrip(result.id);
      state.tab = 'places';
      lastSnapshot = null;
      await refresh().catch(() => {});
      closeSheet();
    } else {
      tripsSheet();
    }
  },
  async profile(data) {
    await mutate('/api/me', { method: 'PATCH', body: { display_name: data.get('display_name') } }, 'Name saved');
  },
  async password(data, form) {
    const done = await mutate('/api/me/password', { method: 'POST', body: { current: data.get('current'), password: data.get('password') } }, 'Password saved');
    if (done) {
      form.reset();
      settingsSheet();
    }
  },
};

document.addEventListener('submit', async (event) => {
  const form = event.target;
  const handler = forms[form.dataset.form];
  if (!handler) return;
  event.preventDefault();
  const button = form.querySelector('button.btn:not([type="button"])');
  if (button) button.disabled = true;
  try {
    await handler(new FormData(form), form);
  } catch (err) {
    // Only the signed-out forms throw; the rest report through mutate().
    const error = form.querySelector('.form-error') ?? Object.assign(document.createElement('p'), { className: 'form-error', role: 'alert' });
    error.textContent = err.message;
    form.append(error);
  }
  if (button) button.disabled = false;
});

// Keep everyone's phones in step without needing a refresh.
const quietRefresh = () => {
  if (state.me && !state.dipSpinning && document.visibilityState === 'visible') refresh().catch(() => {});
};
setInterval(quietRefresh, POLL_MS);
document.addEventListener('visibilitychange', quietRefresh);
addEventListener('online', quietRefresh);
addEventListener('offline', () => {
  state.offline = true;
  render();
});

async function start() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  const join = location.pathname.match(/^\/join\/([\w-]+)$/);
  if (join) return showJoin(join[1]);
  try {
    await refresh();
    handleRedirectNotices();
    handleShareTarget();
  } catch {
    if (!state.me) showSignIn();
  }
}

start();
