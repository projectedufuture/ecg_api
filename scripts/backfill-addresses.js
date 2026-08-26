/**
 * Fill in place names for coordinates that were stored before reverse
 * geocoding existed (or while it was disabled / the provider was down).
 *
 *   node scripts/backfill-addresses.js --dry-run   # report only, no writes
 *   node scripts/backfill-addresses.js             # resolve and save
 *   node scripts/backfill-addresses.js --limit 50  # cap upstream lookups
 *   node scripts/backfill-addresses.js --force     # also redo existing ones
 *
 * Only documents whose address is null are touched, unless --force is given.
 * Coordinates are never modified. Lookups go through the shared cache and the
 * one-request-per-second limiter, so distinct places take ~1s each; repeated
 * places are free.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const config = require('../src/config/env');
const User = require('../src/models/User');
const Session = require('../src/models/Session');
const { resolveAddress, isEnabled, isValidCoord, cacheKey } = require('../src/utils/reverseGeocode');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  if (i === -1) return Infinity;
  const n = parseInt(args[i + 1], 10);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
})();

// Distinct places seen this run, so the console output makes the cost obvious.
const seen = new Set();
let lookups = 0;

async function addressFor(lat, lng) {
  const key = cacheKey(lat, lng);
  if (!seen.has(key)) {
    if (lookups >= LIMIT) return { address: null, capped: true };
    seen.add(key);
    lookups += 1;
  }
  return { address: await resolveAddress(lat, lng), capped: false };
}

async function backfillUsers() {
  const filter = FORCE
    ? { 'lastLocation.lat': { $ne: null } }
    : { 'lastLocation.lat': { $ne: null }, 'lastLocation.address': null };
  const users = await User.find(filter).select('id name lastLocation');

  let updated = 0;
  let unresolved = 0;
  let capped = 0;

  for (const u of users) {
    const { lat, lng } = u.lastLocation || {};
    if (!isValidCoord(lat, lng)) continue;
    const res = await addressFor(lat, lng);
    if (res.capped) {
      capped += 1;
      continue;
    }
    if (!res.address) {
      unresolved += 1;
      console.log(`  user    ${u.id}  ${lat}, ${lng}  -> (no place name)`);
      continue;
    }
    console.log(`  user    ${u.id}  ${lat}, ${lng}  -> ${res.address}`);
    if (!DRY_RUN) {
      await User.updateOne({ _id: u._id }, { $set: { 'lastLocation.address': res.address } });
    }
    updated += 1;
  }
  return { total: users.length, updated, unresolved, capped };
}

async function backfillSessions() {
  const filter = FORCE
    ? { 'location.lat': { $ne: null } }
    : { 'location.lat': { $ne: null }, 'location.address': null };
  const sessions = await Session.find(filter).select('id location');

  let updated = 0;
  let unresolved = 0;
  let capped = 0;

  for (const s of sessions) {
    const { lat, lng } = s.location || {};
    if (!isValidCoord(lat, lng)) continue;
    const res = await addressFor(lat, lng);
    if (res.capped) {
      capped += 1;
      continue;
    }
    if (!res.address) {
      unresolved += 1;
      continue;
    }
    console.log(`  session ${s.id}  ${lat}, ${lng}  -> ${res.address}`);
    if (!DRY_RUN) {
      await Session.updateOne({ _id: s._id }, { $set: { 'location.address': res.address } });
    }
    updated += 1;
  }
  return { total: sessions.length, updated, unresolved, capped };
}

(async () => {
  if (!isEnabled()) {
    console.error(
      `Reverse geocoding is disabled (GEOCODING_PROVIDER=${config.geocoding.provider}` +
        (config.geocoding.provider === 'google' && !config.geocoding.googleApiKey
          ? ', and GOOGLE_MAPS_API_KEY is not set'
          : '') +
        '). Nothing to do.'
    );
    process.exit(1);
  }

  await mongoose.connect(config.mongo.uri);
  console.log(`Provider: ${config.geocoding.provider}${DRY_RUN ? '   (DRY RUN - no writes)' : ''}`);
  if (LIMIT !== Infinity) console.log(`Lookup cap: ${LIMIT} distinct places`);
  console.log('');

  const users = await backfillUsers();
  const sessions = await backfillSessions();

  console.log('');
  console.log(`Users     : ${users.updated}/${users.total} named` +
    (users.unresolved ? `, ${users.unresolved} with no place name` : '') +
    (users.capped ? `, ${users.capped} skipped by --limit` : ''));
  console.log(`Sessions  : ${sessions.updated}/${sessions.total} named` +
    (sessions.unresolved ? `, ${sessions.unresolved} with no place name` : '') +
    (sessions.capped ? `, ${sessions.capped} skipped by --limit` : ''));
  console.log(`Upstream  : ${lookups} lookup(s) for ${seen.size} distinct place(s)`);
  if (DRY_RUN) console.log('\nDRY RUN - nothing was written.');

  await mongoose.disconnect();
})().catch(async (error) => {
  console.error('Backfill failed:', error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
