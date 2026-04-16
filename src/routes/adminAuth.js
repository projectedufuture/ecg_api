const express = require('express');
const { body } = require('express-validator');
const { login, refreshToken, logout, forgotPassword, resetPassword, changePassword } = require('../controllers/adminAuthController');
const { loginLimiter, forgotPasswordLimiter } = require('../middleware/rateLimiter');
const auth = require('../middleware/auth');

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

router.post(
  '/forgot-password',
  forgotPasswordLimiter,
  [body('email').isEmail().withMessage('Valid email is required.').normalizeEmail()],
  forgotPassword
);

router.post(
  '/reset-password',
  [
    body('token').notEmpty().withMessage('Reset token is required.'),
    body('newPassword')
      .isLength({ min: 8 })
      .withMessage('Password must be at least 8 characters.'),
  ],
  resetPassword
);

router.post(
  '/change-password',
  auth,
  [
    body('current_password').notEmpty().withMessage('Current password is required.'),
    body('new_password')
      .isLength({ min: 8 }).withMessage('New password must be at least 8 characters.')
      .matches(/[A-Z]/).withMessage('New password must contain at least one uppercase letter.')
      .matches(/[a-z]/).withMessage('New password must contain at least one lowercase letter.')
      .matches(/[0-9]/).withMessage('New password must contain at least one number.')
      .matches(/[^A-Za-z0-9]/).withMessage('New password must contain at least one special character.'),
  ],
  changePassword
);

module.exports = router;
