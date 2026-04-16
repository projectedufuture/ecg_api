const dotenv = require('dotenv');
dotenv.config();

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
  origin: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(",")
    : ["http://localhost:3000"],
},
  email: {
    apiKey: process.env.BREVO_API_KEY || '',
    senderName: process.env.BREVO_SENDER_NAME || 'ECG Admin Panel',
    senderEmail: process.env.BREVO_SENDER_EMAIL || '',
    frontendUrl: process.env.FRONTEND_URL || 'https://admin-ecg.netlify.app',
  },
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 100,
    loginWindowMs: parseInt(process.env.LOGIN_RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,
    loginMax: parseInt(process.env.LOGIN_RATE_LIMIT_MAX, 10) || 10,
  },
};
