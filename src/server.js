const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const mongoSanitize = require('express-mongo-sanitize');
const connectDB = require('./config/db');
const config = require('./config/env');
const { generalLimiter } = require('./middleware/rateLimiter');

// Route imports
const adminAuthRoutes = require('./routes/adminAuth');
const usersRoutes = require('./routes/users');
const sessionsRoutes = require('./routes/sessions');
const devicesRoutes = require('./routes/devices');
const licensesRoutes = require('./routes/licenses');
const dashboardRoutes = require('./routes/dashboard');
const exportRoutes = require('./routes/export');

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

// CORS: whitelist only the configured frontend origin(s). FRONTEND_URL is the
// canonical env var; CORS_ORIGIN is kept as a back-compat alias.
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow same-origin/tools (no Origin header) and the configured list.
      if (!origin) return callback(null, true);
      if (config.cors.origin.includes(origin)) return callback(null, true);
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);
app.use(mongoSanitize());
app.use(generalLimiter);

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
  app.listen(config.server.port, () => {
    console.log(`Server running on port ${config.server.port} in ${config.server.nodeEnv} mode`);
  });
};

start();

module.exports = app;
