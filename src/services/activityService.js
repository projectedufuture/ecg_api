/**
 * Pure helpers for the activities resource. Kept free of Express/Mongoose so
 * they can be unit-tested directly with node:test (the house pattern — see
 * tests/sessionDuration.test.js), and so the controller recomputes derived
 * metrics server-side rather than blindly trusting the client.
 */

const ACTIVITY_TYPES = [
  'walking',
  'running',
  'cycling',
  'hiking',
  'training',
  'recovery_walk',
  'interval_run',
  'other',
];

function isValidActivityType(type) {
  return ACTIVITY_TYPES.includes(type);
}

function normalizeActivityType(type) {
  return isValidActivityType(type) ? type : 'other';
}

/** Non-negative finite number, or `fallback` (default 0). */
function nonNeg(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/**
 * Average speed (m/s) from distance + active seconds. Returns 0 when there is
 * no meaningful movement/time (never NaN/Infinity).
 */
function deriveAverageSpeedMps(distanceMeters, activeSeconds) {
  const d = nonNeg(distanceMeters);
  const t = nonNeg(activeSeconds);
  if (t <= 0 || d <= 0) return 0;
  return d / t;
}

/**
 * Average pace (seconds per km) from distance + active seconds. Returns null
 * when it would not be meaningful (no distance, or implausibly slow), so the
 * client never has to render Infinity / 0:00.
 */
function derivePaceSecPerKm(distanceMeters, activeSeconds) {
  const d = nonNeg(distanceMeters);
  const t = nonNeg(activeSeconds);
  if (d < 1 || t <= 0) return null;
  const pace = (t / d) * 1000; // sec per km
  if (!Number.isFinite(pace) || pace <= 0 || pace > 6 * 3600) return null;
  return Math.round(pace);
}

/**
 * Keep only structurally valid route points and normalise their shape. Drops
 * points without finite lat/lng or with out-of-range coordinates.
 */
function sanitizeRoutePoints(points) {
  if (!Array.isArray(points)) return [];
  const out = [];
  for (const p of points) {
    if (!p || typeof p !== 'object') continue;
    const lat = Number(p.latitude);
    const lng = Number(p.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
    out.push({
      latitude: lat,
      longitude: lng,
      timestamp: p.timestamp != null ? String(p.timestamp) : null,
      accuracy: Number.isFinite(Number(p.accuracy)) ? Number(p.accuracy) : null,
      altitude: Number.isFinite(Number(p.altitude)) ? Number(p.altitude) : null,
      speed: Number.isFinite(Number(p.speed)) ? Number(p.speed) : null,
    });
  }
  return out;
}

/** Keep only valid HR samples ({ bpm > 0, t >= 0 }). */
function sanitizeHeartRateSamples(samples) {
  if (!Array.isArray(samples)) return [];
  const out = [];
  for (const s of samples) {
    if (!s || typeof s !== 'object') continue;
    const bpm = Number(s.bpm);
    const t = Number(s.t);
    if (!Number.isFinite(bpm) || bpm <= 0) continue;
    out.push({ bpm: Math.round(bpm), t: Number.isFinite(t) ? Math.round(t) : 0 });
  }
  return out;
}

/** Keep only valid generic metric samples ({ v: finite, t >= 0 }). */
function sanitizeMetricSamples(samples) {
  if (!Array.isArray(samples)) return [];
  const out = [];
  for (const s of samples) {
    if (!s || typeof s !== 'object') continue;
    const v = Number(s.v);
    const t = Number(s.t);
    if (!Number.isFinite(v)) continue;
    out.push({ v, t: Number.isFinite(t) ? Math.round(t) : 0 });
  }
  return out;
}

/** Optional positive integer (HR, HRV), else null. */
function optPosInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

module.exports = {
  ACTIVITY_TYPES,
  isValidActivityType,
  normalizeActivityType,
  nonNeg,
  deriveAverageSpeedMps,
  derivePaceSecPerKm,
  sanitizeRoutePoints,
  sanitizeHeartRateSamples,
  sanitizeMetricSamples,
  optPosInt,
};
