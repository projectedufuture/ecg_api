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

// Security middleware
app.use(helmet());
app.use(cors({
  origin: config.cors.origin,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
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
