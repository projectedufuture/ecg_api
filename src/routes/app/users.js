const express = require('express');
const { body } = require('express-validator');
const appAuth = require('../../middleware/appAuth');
const { getMe, updateMe, updateLocation } = require('../../controllers/app/usersController');

const router = express.Router();

router.get('/me', appAuth, getMe);

router.put(
  '/me',
  appAuth,
  [
    body('name').optional().trim().notEmpty().withMessage('Name cannot be empty.'),
    body('email').optional().isEmail().withMessage('Valid email is required.').normalizeEmail(),
    body('age').optional({ nullable: true }).isInt({ min: 0, max: 120 }).withMessage('Age must be 0-120.'),
    body('sex').optional({ nullable: true }).isIn(['male', 'female', 'other']).withMessage('Invalid sex.'),
    body('heightCm').optional({ nullable: true }).isInt({ min: 30, max: 272 }).withMessage('Height must be 30-272 cm.'),
    body('weightKg').optional({ nullable: true }).isFloat({ min: 2, max: 500 }).withMessage('Weight must be 2-500 kg.'),
    body('fitnessGoal').optional({ nullable: true }).isString().trim().isLength({ max: 120 }),
    body('activeMinutesGoal').optional({ nullable: true }).isInt({ min: 0, max: 1440 }).withMessage('Goal must be 0-1440 min.'),
  ],
  updateMe
);

router.put(
  '/me/location',
  appAuth,
  [
    body('lat').isFloat({ min: -90, max: 90 }).withMessage('lat must be between -90 and 90.'),
    body('lng').isFloat({ min: -180, max: 180 }).withMessage('lng must be between -180 and 180.'),
    body('accuracy').optional().isFloat({ min: 0 }).withMessage('accuracy must be a positive number.'),
    body('address').optional().isString().trim().isLength({ max: 500 }),
  ],
  updateLocation
);

module.exports = router;
