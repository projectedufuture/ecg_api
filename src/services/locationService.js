const User = require('../models/User');
const Session = require('../models/Session');
const {
  resolveAddress,
  lookupCachedAddress,
  isEnabled,
  isValidCoord,
} = require('../utils/reverseGeocode');

// ---------------------------------------------------------------------------
// Turning stored coordinates into place names, without making the app wait.
//
// The wearable app posts its location when it opens. That request must stay
// fast and must not fail because a third-party geocoding service is slow or
// down, so the flow is:
//
//   on write  - attach an address only if one is already cached (no network)
//   after     - resolve any miss in the background and write it back
//
// The admin UI polls with SWR, so a background-resolved name appears within a
// few seconds without the user doing anything.
// ---------------------------------------------------------------------------

// Cache-only. Safe to await inside a request handler: no outbound request.
async function attachCachedAddress(location) {
  if (!location || !isValidCoord(location.lat, location.lng)) return location;
  if (location.address) return location;
  const address = await lookupCachedAddress(location.lat, location.lng);
  return address ? { ...location, address } : location;
}

// Run work after the response has been sent. Errors are logged, never thrown -
// a geocoding failure must never turn into a failed location update.
function runDetached(label, fn) {
  setImmediate(() => {
    Promise.resolve()
      .then(fn)
      .catch((error) => {
        console.error(`Background ${label} failed:`, error.message);
      });
  });
}

// Resolve the address for a coordinate pair and write it onto whichever
// documents were recorded at that spot. Only fills a null address; an address
// the client supplied itself is left alone.
async function resolveAndStore({ userId, sessionId, lat, lng }) {
  if (!isEnabled() || !isValidCoord(lat, lng)) return null;

  const address = await resolveAddress(lat, lng);
  if (!address) return null;

  if (userId) {
    await User.updateOne(
      { id: userId, 'lastLocation.address': null, 'lastLocation.lat': lat, 'lastLocation.lng': lng },
      { $set: { 'lastLocation.address': address } }
    );
  }
  if (sessionId) {
    await Session.updateOne(
      { id: sessionId, 'location.address': null },
      { $set: { 'location.address': address } }
    );
  }
  return address;
}

// Fire-and-forget wrapper used by the request handlers.
function queueResolve({ userId, sessionId, lat, lng }) {
  if (!isEnabled() || !isValidCoord(lat, lng)) return;
  runDetached('reverse geocode', () => resolveAndStore({ userId, sessionId, lat, lng }));
}

module.exports = {
  attachCachedAddress,
  resolveAndStore,
  queueResolve,
};
