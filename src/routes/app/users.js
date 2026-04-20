const express = require('express');
const { body } = require('express-validator');
const appAuth = require('../../middleware/appAuth');
const { getMe, updateMe } = require('../../controllers/app/usersController');

const router = express.Router();

router.get('/me', appAuth, getMe);

router.put(
  '/me',
  appAuth,
  [
    body('name').optional().trim().notEmpty().withMessage('Name cannot be empty.'),
    body('email').optional().isEmail().withMessage('Valid email is required.').normalizeEmail(),
  ],
  updateMe
);

module.exports = router;
