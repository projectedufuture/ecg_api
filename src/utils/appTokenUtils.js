const jwt = require('jsonwebtoken');
const config = require('../config/env');

function generateAppAccessToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      email: user.email,
      type: 'app',
    },
    config.jwt.accessSecret,
    { expiresIn: config.jwt.accessExpiry }
  );
}

function generateAppRefreshToken(user) {
  return jwt.sign(
    { userId: user.id, type: 'app' },
    config.jwt.refreshSecret,
    { expiresIn: config.jwt.refreshExpiry }
  );
}

function verifyAppAccessToken(token) {
  return jwt.verify(token, config.jwt.accessSecret);
}

function verifyAppRefreshToken(token) {
  return jwt.verify(token, config.jwt.refreshSecret);
}

module.exports = {
  generateAppAccessToken,
  generateAppRefreshToken,
  verifyAppAccessToken,
  verifyAppRefreshToken,
};
