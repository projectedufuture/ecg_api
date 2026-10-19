const express = require('express');
const { body, param } = require('express-validator');
const auth = require('../middleware/auth');
const { applyClientScope } = require('../middleware/rbac');
const { auditLogger } = require('../middleware/auditLogger');
const validate = require('../middleware/validate');
const {
  listSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  sendNow,
} = require('../controllers/summarySchedulesController');

const router = express.Router();

router.use(auth);
router.use(applyClientScope);
router.use(auditLogger);

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const createValidators = [
  body('name').trim().notEmpty().withMessage('Name is required.').isLength({ max: 120 }),
  body('recipientEmail').trim().isEmail().withMessage('A valid recipient email is required.').normalizeEmail(),
  body('frequency').isIn(['daily', 'weekly']).withMessage('Frequency must be daily or weekly.'),
  body('timeOfDay').matches(HHMM).withMessage('Time must be in HH:MM (24h) format.'),
  body('weekday').optional().isInt({ min: 0, max: 6 }).withMessage('Weekday must be 0–6.'),
  body('timezone').optional().isString().isLength({ max: 64 }),
  body('enabled').optional().isBoolean(),
];

const updateValidators = [
  param('id').isString().trim().notEmpty(),
  body('name').optional().trim().notEmpty().isLength({ max: 120 }),
  body('recipientEmail').optional().trim().isEmail().normalizeEmail(),
  body('frequency').optional().isIn(['daily', 'weekly']),
  body('timeOfDay').optional().matches(HHMM).withMessage('Time must be in HH:MM (24h) format.'),
  body('weekday').optional().isInt({ min: 0, max: 6 }),
  body('timezone').optional().isString().isLength({ max: 64 }),
  body('enabled').optional().isBoolean(),
];

router.get('/', listSchedules);
router.post('/', createValidators, validate, createSchedule);
router.put('/:id', updateValidators, validate, updateSchedule);
router.delete('/:id', [param('id').isString().trim().notEmpty()], validate, deleteSchedule);
router.post('/:id/send-now', [param('id').isString().trim().notEmpty()], validate, sendNow);

module.exports = router;
