const rateLimit = require('express-rate-limit');
const config = require('../config/env');

// Paths that carry their own dedicated limiter (see ingestLimiter below) and
// must not also be counted against the general budget - otherwise a device
// streaming readings for a multi-hour session exhausts generalLimiter's small
// allowance long before ingestLimiter's own, much larger one ever matters.
const INGEST_PATH_PREFIXES = ['/api/app/readings', '/api/app/ecg-beats', '/api/app/sync'];
const isIngestPath = (path) => INGEST_PATH_PREFIXES.some((p) => path.startsWith(p));

const generalLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => isIngestPath(req.path),
  message: {
    success: false,
    data: null,
    error: 'Too many requests. Please try again later.',
  },
});

/**
 * A separate, much more generous limiter for the high-frequency ingest
 * endpoints: readings upload, ECG-beat upload, and sync - all hit continuously
 * for the length of a live recording (which can run for hours), not
 * occasionally like the rest of the API. generalLimiter's 100-per-15-minutes
 * budget was sized for browsing/dashboard traffic and 429s almost any live
 * session on its own; this limiter exists so ingest traffic is bounded
 * (still protects against a genuinely runaway client) without throttling a
 * normal recording.
 *
 * ~3.3 requests/second sustained, per IP - comfortably above any real batching
 * cadence the app uses, while still capping abuse.
 */
const ingestLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    data: null,
    error: 'Too many requests. Please try again later.',
  },
});

const loginLimiter = rateLimit({
  windowMs: config.rateLimit.loginWindowMs,
  max: config.rateLimit.loginMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    data: null,
    error: 'Too many login attempts. Please try again later.',
  },
});

const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    data: null,
    error: 'Too many password reset requests. Please try again in an hour.',
  },
});

module.exports = { generalLimiter, ingestLimiter, loginLimiter, forgotPasswordLimiter };
