const http = require('http');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const mongoSanitize = require('express-mongo-sanitize');
const connectDB = require('./config/db');
const config = require('./config/env');
const { generalLimiter, ingestLimiter } = require('./middleware/rateLimiter');

// Route imports
const adminAuthRoutes = require('./routes/adminAuth');
const usersRoutes = require('./routes/users');
const sessionsRoutes = require('./routes/sessions');
const devicesRoutes = require('./routes/devices');
const licensesRoutes = require('./routes/licenses');
const dashboardRoutes = require('./routes/dashboard');
const exportRoutes = require('./routes/export');
const notificationsRoutes = require('./routes/notifications');
const ticketsRoutes = require('./routes/tickets');
const alertsRoutes = require('./routes/alerts');
const summarySchedulesRoutes = require('./routes/summarySchedules');
const { startScheduler } = require('./services/summaryScheduler');
const { initRealtime } = require('./realtime/socket');

// App (mobile) route imports
const appAuthRoutes = require('./routes/app/auth');
const appUsersRoutes = require('./routes/app/users');
const appReportsRoutes = require('./routes/app/reports');
const appEcgBeatsRoutes = require('./routes/app/ecgBeats');
const appDevicesRoutes = require('./routes/app/devices');
const appSessionsRoutes = require('./routes/app/sessions');
const appAnalyticsRoutes = require('./routes/app/analytics');
const appReadingsRoutes = require('./routes/app/readings');
const appSyncRoutes = require('./routes/app/sync');
const appLicensesRoutes = require('./routes/app/licenses');
const appNotificationsRoutes = require('./routes/app/notifications');
const appTicketsRoutes = require('./routes/app/tickets');

const app = express();

// When running behind a reverse proxy (nginx, Render, etc.) so req.ip and
// rate-limit key resolve to the real client address.
app.set('trust proxy', 1);

// Helmet with strict CSP tuned for an API server (no inline scripts served).
const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:', 'https:'],
  connectSrc: ["'self'"],
  fontSrc: ["'self'", 'https:', 'data:'],
  objectSrc: ["'none'"],
  frameAncestors: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
};
if (config.server.nodeEnv === 'production') {
  cspDirectives.upgradeInsecureRequests = [];
}

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: cspDirectives,
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts:
      config.server.nodeEnv === 'production'
        ? { maxAge: 31536000, includeSubDomains: true, preload: true }
        : false,
  })
);

// CORS: permissive — echo back whatever Origin the request came with. This
// allows any frontend (Netlify, localhost, Netlify deploy-previews, etc.) to
// call the API while still permitting cookies (credentials: true). Browsers
// forbid the wildcard "*" when credentials are required, so we reflect the
// caller's origin instead.
app.use(
  cors({
    origin: (origin, callback) => callback(null, origin || true),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);
app.use(mongoSanitize());
app.use(generalLimiter);

// gzip responses. ECG/readings JSON is large and highly compressible
// (repetitive numeric arrays), so this cuts the session-detail payload
// several-fold over the wire. Safe/transparent: clients that send
// Accept-Encoding: gzip get a compressed body, others get plain JSON.
// No response fields change. threshold:1024 skips tiny bodies.
app.use(compression({ threshold: 1024 }));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Health check
app.get('/api/health', (req, res) => {
  res.json({ success: true, data: { status: 'ok', timestamp: new Date().toISOString() }, error: null });
});

// Routes
app.use('/api/admin', adminAuthRoutes);
app.use('/api/admin/users', usersRoutes);
app.use('/api/admin/readings', sessionsRoutes);
app.use('/api/admin/devices', devicesRoutes);
app.use('/api/admin/licenses', licensesRoutes);
app.use('/api/admin/dashboard', dashboardRoutes);
app.use('/api/admin/export', exportRoutes);
app.use('/api/admin/notifications', notificationsRoutes);
app.use('/api/admin/tickets', ticketsRoutes);
app.use('/api/admin/alerts', alertsRoutes);
app.use('/api/admin/summary-schedules', summarySchedulesRoutes);

// Mobile app routes
app.use('/api/app/auth', appAuthRoutes);
app.use('/api/app/users', appUsersRoutes);
app.use('/api/app/devices', appDevicesRoutes);
app.use('/api/app/sessions', appSessionsRoutes);
// Analytics — read-only aggregation of existing activity sessions (general limiter).
// GPS activities are now part of the unified Session record (activityType),
// so the standalone /api/app/activities resource has been removed.
app.use('/api/app/analytics', appAnalyticsRoutes);
// High-frequency ingest endpoints, hit continuously for the length of a live
// recording - given their own, much more generous limiter (see rateLimiter.js)
// instead of the general one, which is sized for occasional browsing traffic
// and would 429 almost any live session on its own.
app.use('/api/app/readings', ingestLimiter, appReadingsRoutes);
app.use('/api/app/reports', appReportsRoutes);
app.use('/api/app/ecg-beats', ingestLimiter, appEcgBeatsRoutes);
app.use('/api/app/sync', ingestLimiter, appSyncRoutes);
app.use('/api/app/licenses', appLicensesRoutes);
app.use('/api/app/notifications', appNotificationsRoutes);
app.use('/api/app/tickets', appTicketsRoutes);

app.get("/", (req, res) => {
  res.send("Backend running 🚀");
});
// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, data: null, error: 'Endpoint not found.' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
});

// Start server
const start = async () => {
  await connectDB();
  // Start the in-process summary-email scheduler (ticks every minute, sends
  // due digests). Safe to run once DB is connected.
  startScheduler();
  // One HTTP server for both REST and the real-time Socket.IO channel
  // (support chat + notifications), so they share the port, TLS and proxy.
  const server = http.createServer(app);
  initRealtime(server);
  server.listen(config.server.port, () => {
    console.log(`Server running on port ${config.server.port} in ${config.server.nodeEnv} mode (REST + realtime)`);
  });
};

start();

module.exports = app;
