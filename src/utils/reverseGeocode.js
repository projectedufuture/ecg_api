const config = require('../config/env');
const GeocodeCache = require('../models/GeocodeCache');

// ---------------------------------------------------------------------------
// Reverse geocoding: coordinates -> human-readable place name.
//
// The device/app posts coordinates only (e.g. 17.4351, 78.4520). Admins want a
// name. Resolving that needs an outbound request to a geocoding service, so
// this module exists to do it ONCE per place and never again:
//
//   1. round the coordinates to a ~11 m grid and look for a cached answer
//   2. only on a miss, ask the upstream provider
//   3. store the result (including "there is no place here") for reuse
//
// Nothing here sits on the request-critical path - see services/locationService
// for how a miss is resolved in the background so the app's POST stays fast.
// ---------------------------------------------------------------------------

// 4 decimal places is about 11 m at the equator: fine enough that two readings
// sharing a key really are the same street corner, coarse enough that GPS
// jitter while standing still does not trigger a fresh lookup every time.
const GEO_KEY_DECIMALS = 4;

const PROVIDER = {
  NOMINATIM: 'nominatim',
  GOOGLE: 'google',
  NONE: 'none',
};

function isEnabled() {
  const p = config.geocoding.provider;
  if (p === PROVIDER.NONE) return false;
  if (p === PROVIDER.GOOGLE) return Boolean(config.geocoding.googleApiKey);
  return p === PROVIDER.NOMINATIM;
}

// Only real numbers, or strings that are entirely a number, count. This is
// deliberately strict because Number(null), Number('') and Number(false) are
// all 0 - and an unset latitude must never be mistaken for the equator, which
// would send us geocoding the Gulf of Guinea for every user who has no
// location stored (lastLocation.lat defaults to null).
function isNumeric(v) {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string' && v.trim() !== '') return Number.isFinite(Number(v));
  return false;
}

function isValidCoord(lat, lng) {
  if (!isNumeric(lat) || !isNumeric(lng)) return false;
  const la = Number(lat);
  const ln = Number(lng);
  return la >= -90 && la <= 90 && ln >= -180 && ln <= 180;
}

function cacheKey(lat, lng) {
  // toFixed then Number normalises "17.43510" and collapses "-0" to "0".
  const la = Number(Number(lat).toFixed(GEO_KEY_DECIMALS));
  const ln = Number(Number(lng).toFixed(GEO_KEY_DECIMALS));
  return la + ',' + ln;
}

// --- label building --------------------------------------------------------

// OpenStreetMap often prefixes a locality with the administrative unit that
// contains it - "Ward 97 Somajiguda", "Zone 4 Kondapur". The number is council
// bookkeeping and means nothing to a person reading a table, so drop it when a
// real place name remains behind it.
const ADMIN_PREFIX =
  /^(?:ward|zone|block|sector|division|circle)\s+(?:no\.?\s*)?\d+\s+(?=\S)/i;

function stripAdminPrefix(value) {
  if (typeof value !== 'string') return value;
  const cleaned = value.replace(ADMIN_PREFIX, '').trim();
  // Keep the original when stripping leaves nothing useful, e.g. a locality
  // genuinely called "Sector 17" with no name attached.
  return cleaned.length >= 3 ? cleaned : value.trim();
}

// Some localities are nothing but an administrative designator - "L Ward",
// "Ward 12", "Mumbai Zone 5". These name a council district, not a place anyone
// would recognise, so they are skipped entirely and the label falls through to
// the city and region instead ("Mumbai, Maharashtra" beats "L Ward, Mumbai").
//
// "sector" is deliberately absent: "Sector 17" is the genuine name of a place
// in Chandigarh, not bookkeeping, and dropping it would lose real information.
const ADMIN_UNIT = 'ward|zone|block|division|circle';
const ADMIN_ONLY = new RegExp(
  // leading form:  "L Ward", "4 Zone"
  `^(?:[a-z0-9]{1,3}\\s+(?:${ADMIN_UNIT})` +
    // trailing form: "Ward 12", "Ward No. 12", "Mumbai Zone 5"
    `|.*\\b(?:${ADMIN_UNIT})\\s+(?:no\\.?\\s*)?[a-z0-9]{1,3})$`,
  'i'
);

function isAdminOnly(value) {
  return typeof value === 'string' && ADMIN_ONLY.test(value.trim());
}

// First usable value among a list of candidate keys. A purely administrative
// designator is not usable, so the search continues past it.
function firstOf(obj, keys) {
  for (const k of keys) {
    const v = obj && obj[k];
    if (typeof v === 'string' && v.trim()) {
      if (isAdminOnly(v)) continue;
      return stripAdminPrefix(v);
    }
    if (typeof v === 'number') return String(v);
  }
  return null;
}

// Build a SHORT label. The admin users table gives location one narrow column,
// so a full postal address ("Road No. 12, Banjara Hills, Hyderabad, Telangana,
// 500034, India") does not fit and reads worse than the two parts that actually
// identify the place. Locality plus city is what a person recognises.
function buildLabel(parts) {
  const out = [];
  for (const p of parts) {
    if (!p) continue;
    const v = String(p).trim();
    if (!v) continue;
    // Skip a part that merely repeats one already present, which upstream
    // services do often (suburb "Hyderabad" inside city "Hyderabad").
    if (out.some((existing) => existing.toLowerCase() === v.toLowerCase())) continue;
    out.push(v);
  }
  // The schema caps address at 500 chars. A label this short never comes close,
  // but clamp anyway so an odd upstream response cannot fail validation.
  return out.join(', ').slice(0, 500) || null;
}

function labelFromNominatim(address) {
  if (!address) return null;
  const locality = firstOf(address, [
    'neighbourhood',
    'suburb',
    'quarter',
    'residential',
    'city_district',
    'hamlet',
    'village',
    'town',
  ]);
  const city = firstOf(address, [
    'city',
    'town',
    'village',
    'municipality',
    'county',
    'state_district',
  ]);
  const region = firstOf(address, ['state', 'province', 'region']);
  const country = firstOf(address, ['country']);

  return chooseLabel({ locality, city, region, country });
}

// The fallback ladder, shared by both providers so they cannot drift apart.
// Each rung is the most specific pair still available, and country is added
// only when there is no city to anchor the label - "Mumbai, Maharashtra" reads
// better than "Mumbai, Maharashtra, India", but a bare "Telangana" does not.
function chooseLabel({ locality, city, region, country }) {
  if (locality && city) {
    const pair = buildLabel([locality, city]);
    // Only accept the two-part label if dedup actually left two parts. When the
    // suburb and the city carry the same name it collapses to a bare city name,
    // which is too vague on its own - fall through to city + region instead.
    if (pair && pair.includes(', ')) return pair;
  }
  if (city) return buildLabel([city, region]) || buildLabel([city]);
  if (locality) return buildLabel([locality, region]) || buildLabel([locality]);
  return buildLabel([region, country]);
}

const GOOGLE_TYPE_PRIORITY = {
  locality: ['neighborhood', 'sublocality', 'sublocality_level_1'],
  city: ['locality', 'postal_town', 'administrative_area_level_2'],
  region: ['administrative_area_level_1'],
  country: ['country'],
};

function labelFromGoogle(result) {
  const components = (result && result.address_components) || [];
  // Same admin-name handling as the Nominatim path, so the two providers
  // cannot produce differently-shaped labels for the same place.
  const pick = (types) => {
    for (const t of types) {
      const hit = components.find((c) => Array.isArray(c.types) && c.types.includes(t));
      if (hit && hit.long_name) {
        if (isAdminOnly(hit.long_name)) continue;
        return stripAdminPrefix(hit.long_name);
      }
    }
    return null;
  };
  const locality = pick(GOOGLE_TYPE_PRIORITY.locality);
  const city = pick(GOOGLE_TYPE_PRIORITY.city);
  const region = pick(GOOGLE_TYPE_PRIORITY.region);
  const country = pick(GOOGLE_TYPE_PRIORITY.country);

  return (
    chooseLabel({ locality, city, region, country }) ||
    (result && result.formatted_address) ||
    null
  );
}

// --- rate limiting ---------------------------------------------------------

// Requests are serialised through a single promise chain with a minimum gap.
// Nominatim's policy is one request per second and exceeding it can get the
// whole deployment blocked, so this is a correctness constraint, not manners.
let chain = Promise.resolve();
let lastRequestAt = 0;

function schedule(task) {
  const run = chain.then(async () => {
    const gap = config.geocoding.minIntervalMs - (Date.now() - lastRequestAt);
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    lastRequestAt = Date.now();
    return task();
  });
  // Keep the chain alive when a task rejects, otherwise one failure poisons
  // every lookup queued behind it.
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

// --- providers -------------------------------------------------------------

async function fetchJson(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.geocoding.timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      const err = new Error('Geocoding provider returned HTTP ' + res.status);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function queryNominatim(lat, lng) {
  // zoom 14 is roughly suburb level - enough detail to name a locality without
  // returning a house number we would only throw away.
  const url =
    config.geocoding.nominatimUrl +
    '?format=jsonv2&lat=' +
    encodeURIComponent(lat) +
    '&lon=' +
    encodeURIComponent(lng) +
    '&zoom=14&addressdetails=1';
  const data = await fetchJson(url, {
    'User-Agent': config.geocoding.userAgent,
    'Accept-Language': config.geocoding.language,
    Accept: 'application/json',
  });
  // Nominatim signals "nothing here" with an error field, not an HTTP error.
  if (!data || data.error || !data.address) {
    return { status: 'not_found', address: null, displayName: null, components: null };
  }
  return {
    status: 'ok',
    address: labelFromNominatim(data.address),
    displayName: data.display_name || null,
    components: data.address,
  };
}

async function queryGoogle(lat, lng) {
  const url =
    'https://maps.googleapis.com/maps/api/geocode/json?latlng=' +
    encodeURIComponent(lat + ',' + lng) +
    '&language=' +
    encodeURIComponent(config.geocoding.language) +
    '&key=' +
    encodeURIComponent(config.geocoding.googleApiKey);
  const data = await fetchJson(url, { Accept: 'application/json' });
  if (!data) throw new Error('Empty response from Google geocoding');
  if (data.status === 'ZERO_RESULTS') {
    return { status: 'not_found', address: null, displayName: null, components: null };
  }
  if (data.status !== 'OK' || !Array.isArray(data.results) || !data.results.length) {
    // OVER_QUERY_LIMIT / REQUEST_DENIED must NOT be cached as "no such place",
    // so surface them as errors and let the caller retry later.
    throw new Error('Google geocoding status ' + (data.status || 'UNKNOWN'));
  }
  const best = data.results[0];
  return {
    status: 'ok',
    address: labelFromGoogle(best),
    displayName: best.formatted_address || null,
    components: best.address_components || null,
  };
}

function queryProvider(lat, lng) {
  if (config.geocoding.provider === PROVIDER.GOOGLE) return queryGoogle(lat, lng);
  return queryNominatim(lat, lng);
}

// --- public API ------------------------------------------------------------

// Cache-only lookup. Never touches the network, so it is safe to call from a
// request handler that has to stay fast.
async function lookupCachedAddress(lat, lng) {
  if (!isValidCoord(lat, lng)) return null;
  try {
    const hit = await GeocodeCache.findOne({ key: cacheKey(lat, lng) }).lean();
    return hit && hit.status === 'ok' ? hit.address || null : null;
  } catch (error) {
    console.error('Geocode cache lookup failed:', error.message);
    return null;
  }
}

// Transient failures (provider down, rate limited, timed out) are held off in
// memory rather than cached in Mongo, so a blip does not persist as a wrong
// "no such place" answer for the whole TTL.
const FAILURE_COOLDOWN_MS = 10 * 60 * 1000;
const recentFailures = new Map();

function inCooldown(key) {
  const until = recentFailures.get(key);
  if (!until) return false;
  if (Date.now() > until) {
    recentFailures.delete(key);
    return false;
  }
  return true;
}

// Resolve coordinates to a place name, consulting the cache first and the
// provider only on a miss. Returns null when geocoding is disabled, the
// coordinates are unusable, the provider has no place there, or it failed.
async function resolveAddress(lat, lng) {
  if (!isEnabled() || !isValidCoord(lat, lng)) return null;

  const key = cacheKey(lat, lng);
  let cached = null;
  try {
    cached = await GeocodeCache.findOne({ key }).lean();
  } catch (error) {
    console.error('Geocode cache read failed:', error.message);
  }
  if (cached) return cached.status === 'ok' ? cached.address || null : null;
  if (inCooldown(key)) return null;

  let result;
  try {
    result = await schedule(() => queryProvider(Number(lat), Number(lng)));
  } catch (error) {
    recentFailures.set(key, Date.now() + FAILURE_COOLDOWN_MS);
    console.error('Reverse geocoding failed for ' + key + ':', error.message);
    return null;
  }

  const ttlMs = config.geocoding.cacheTtlDays * 24 * 60 * 60 * 1000;
  try {
    await GeocodeCache.updateOne(
      { key },
      {
        $set: {
          key,
          lat: Number(Number(lat).toFixed(GEO_KEY_DECIMALS)),
          lng: Number(Number(lng).toFixed(GEO_KEY_DECIMALS)),
          address: result.address,
          displayName: result.displayName,
          components: result.components,
          provider: config.geocoding.provider,
          status: result.status,
          fetchedAt: new Date(),
          expiresAt: new Date(Date.now() + ttlMs),
        },
      },
      { upsert: true }
    );
  } catch (error) {
    // A cache write failure must not lose an answer we already paid for.
    console.error('Geocode cache write failed:', error.message);
  }

  return result.status === 'ok' ? result.address || null : null;
}

module.exports = {
  resolveAddress,
  lookupCachedAddress,
  cacheKey,
  isEnabled,
  isValidCoord,
  buildLabel,
  labelFromNominatim,
  labelFromGoogle,
  GEO_KEY_DECIMALS,
  PROVIDER,
};
