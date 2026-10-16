const express = require('express');
const { body, param } = require('express-validator');
const auth = require('../middleware/auth');
const { applyClientScope } = require('../middleware/rbac');
const { auditLogger } = require('../middleware/auditLogger');
const validate = require('../middleware/validate');
const { listNotifications, sendNotification, deleteNotification } = require('../controllers/notificationsController');

const router = express.Router();

router.use(auth);
router.use(applyClientScope);
router.use(auditLogger);

router.get('/', listNotifications);

router.post(
  '/',
  [
    body('title').trim().notEmpty().withMessage('Title is required.').isLength({ max: 120 }),
    body('body').trim().notEmpty().withMessage('Message is required.').isLength({ max: 1000 }),
    body('type').optional().isIn(['info', 'success', 'warning', 'alert']).withMessage('Invalid type.'),
    body('broadcast').optional().isBoolean(),
    body('userIds').optional().isArray().withMessage('userIds must be an array.'),
  ],
  validate,
  sendNotification
);

router.delete('/:batchId', [param('batchId').isString().trim().notEmpty()], validate, deleteNotification);

module.exports = router;
