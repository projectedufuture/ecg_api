const express = require('express');
const { body } = require('express-validator');
const {
  login,
  refresh,
  logout,
  changePassword,
  forgotPassword,
  resetPassword,
} = require('../../controllers/app/authController');
const appAuth = require('../../middleware/appAuth');
const { loginLimiter, forgotPasswordLimiter } = require('../../middleware/rateLimiter');

const router = express.Router();

// Self-register has been removed. App users are created exclusively by an admin
// via POST /api/admin/users — credentials are emailed to the user, and they are
// forced to change the temp password on their first login (mustChangePassword
// flag in the login response).

router.post(
  '/login',
  loginLimiter,
  [
    body('email').isEmail().withMessage('Valid email is required.').normalizeEmail(),
    body('password').isString().notEmpty().withMessage('Password is required.'),
  ],
  login
);

router.post('/refresh', refresh);

router.post('/logout', appAuth, logout);

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
      .withMessage('Password must be at least 8 characters.')
      .matches(/[A-Z]/)
      .withMessage('Password must contain at least one uppercase letter.')
      .matches(/[a-z]/)
      .withMessage('Password must contain at least one lowercase letter.')
      .matches(/[0-9]/)
      .withMessage('Password must contain at least one number.')
      .matches(/[^A-Za-z0-9]/)
      .withMessage('Password must contain at least one special character.'),
  ],
  resetPassword
);

router.put(
  '/change-password',
  appAuth,
  [
    body('newPassword')
      .isLength({ min: 8 })
      .withMessage('New password must be at least 8 characters.')
      .matches(/[A-Z]/)
      .withMessage('New password must contain at least one uppercase letter.')
      .matches(/[a-z]/)
      .withMessage('New password must contain at least one lowercase letter.')
      .matches(/[0-9]/)
      .withMessage('New password must contain at least one number.')
      .matches(/[^A-Za-z0-9]/)
      .withMessage('New password must contain at least one special character.'),
    body('confirmPassword').notEmpty().withMessage('Confirm password is required.'),
  ],
  changePassword
);

module.exports = router;
