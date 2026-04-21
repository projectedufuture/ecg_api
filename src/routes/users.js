const express = require('express');
const { param, body } = require('express-validator');
const auth = require('../middleware/auth');
const { applyClientScope } = require('../middleware/rbac');
const { auditLogger } = require('../middleware/auditLogger');
const validate = require('../middleware/validate');
const {
  listUsers,
  getUserById,
  deactivateUser,
  reactivateUser,
  createUser,
  assignDevice,
  unassignDevice,
} = require('../controllers/usersController');

const router = express.Router();

router.use(auth);
router.use(applyClientScope);
router.use(auditLogger);

const idParam = [param('id').isString().trim().notEmpty().withMessage('User id is required.')];
const reasonBody = [body('reason').optional().isString().trim().isLength({ max: 500 })];

router.get('/', listUsers);
router.get('/:id', idParam, validate, getUserById);

router.post(
  '/',
  [
    body('name').trim().notEmpty().withMessage('Name is required.'),
    body('email').isEmail().withMessage('Valid email is required.').normalizeEmail(),
    body('deviceId')
      .optional({ nullable: true, checkFalsy: true })
      .matches(/^ECG-\d{4,5}$/)
      .withMessage('Device ID must be in format ECG-NNNN or ECG-NNNNN.'),
  ],
  validate,
  createUser
);

router.put('/:id/deactivate', idParam, reasonBody, validate, deactivateUser);
router.put('/:id/reactivate', idParam, reasonBody, validate, reactivateUser);

router.post(
  '/:id/assign-device',
  [
    ...idParam,
    body('deviceId')
      .isString()
      .trim()
      .matches(/^ECG-\d{4,5}$/)
      .withMessage('deviceId must be in format ECG-NNNN or ECG-NNNNN.'),
  ],
  validate,
  assignDevice
);

router.delete('/:id/assign-device', idParam, validate, unassignDevice);

module.exports = router;
