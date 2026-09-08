const dotenv = require('dotenv');
dotenv.config();

// Build CORS whitelist from FRONTEND_URL (canonical) and CORS_ORIGIN (legacy).
const buildOriginList = () => {
  const raw = [process.env.FRONTEND_URL, process.env.CORS_ORIGIN]
    .filter(Boolean)
    .join(',');
  if (!raw) return ['http://localhost:3000'];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
};

module.exports = {
  mongo: {
    uri: process.env.MONGO_URI,
  },
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'dev-access-secret',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret',
    accessExpiry: process.env.JWT_ACCESS_EXPIRY || '30m',
    refreshExpiry: process.env.JWT_REFRESH_EXPIRY || '7d',
  },
  server: {
    port: parseInt(process.env.PORT, 10) || 3001,
    nodeEnv: process.env.NODE_ENV || 'development',
  },
  cors: {
    origin: buildOriginList(),
  },
  email: {
    apiKey: process.env.BREVO_API_KEY || '',
    senderName: process.env.BREVO_SENDER_NAME || 'ECG Admin Panel',
    senderEmail: process.env.BREVO_SENDER_EMAIL || '',
    frontendUrl: process.env.FRONTEND_URL || 'https://admin-ecg.netlify.app',
  },
  reports: {
    // A recording shorter than this generates no reports. Short recordings
    // cannot support the analysis: HRV conventions want minutes of data, the
    // respiratory band bottoms out at 0.1 Hz (a 10 s cycle), and a baseline
    // needs enough history to be a baseline at all.
    minSessionDurationSec: parseInt(process.env.MIN_REPORT_SESSION_SEC, 10) || 120,
  },
  geocoding: {
    // 'nominatim' (OpenStreetMap, no API key) | 'google' (needs a key) | 'none'.
    // Set to 'none' to disable outbound reverse-geocoding entirely; stored
    // coordinates are then shown as raw numbers, exactly as before.
    provider: (process.env.GEOCODING_PROVIDER || 'nominatim').toLowerCase(),
    googleApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
    nominatimUrl: process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org/reverse',
    // Nominatim's usage policy REQUIRES an identifying User-Agent with a way
    // to make contact. Requests without one are blocked.
    userAgent:
      process.env.GEOCODING_USER_AGENT ||
      'BiotexAdmin/1.0 (+https://admin-ecg.netlify.app)',
    // Nominatim asks for a maximum of one request per second, absolute.
    minIntervalMs: parseInt(process.env.GEOCODING_MIN_INTERVAL_MS, 10) || 1100,
    timeoutMs: parseInt(process.env.GEOCODING_TIMEOUT_MS, 10) || 6000,
    cacheTtlDays: parseInt(process.env.GEOCODING_CACHE_TTL_DAYS, 10) || 90,
    language: process.env.GEOCODING_LANGUAGE || 'en',
  },
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 100,
    loginWindowMs: parseInt(process.env.LOGIN_RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,
    loginMax: parseInt(process.env.LOGIN_RATE_LIMIT_MAX, 10) || 5,
  },
};
