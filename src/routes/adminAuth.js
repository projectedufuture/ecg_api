const express = require('express');
const { body } = require('express-validator');
const { login, refreshToken, logout } = require('../controllers/adminAuthController');
const { loginLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

router.post(
  '/login',
  loginLimiter,
  [
    body('email').isEmail().withMessage('Valid email is required.').normalizeEmail(),
    body('password').notEmpty().withMessage('Password is required.'),
  ],
  login
);

router.post('/token/refresh', refreshToken);

router.post('/logout', logout);

module.exports = router;
