const express = require('express');
const { body, param } = require('express-validator');
const auth = require('../middleware/auth');
const { applyClientScope } = require('../middleware/rbac');
const { auditLogger } = require('../middleware/auditLogger');
const validate = require('../middleware/validate');
const { listTickets, getTicket, replyTicket, updateTicket } = require('../controllers/ticketsController');

const router = express.Router();

router.use(auth);
router.use(applyClientScope);
router.use(auditLogger);

const idParam = [param('id').isString().trim().notEmpty().withMessage('Ticket id is required.')];

router.get('/', listTickets);
router.get('/:id', idParam, validate, getTicket);

router.post(
  '/:id/reply',
  [...idParam, body('body').trim().notEmpty().withMessage('Message is required.').isLength({ max: 4000 })],
  validate,
  replyTicket
);

router.put(
  '/:id',
  [
    ...idParam,
    body('status').optional().isIn(['open', 'pending', 'resolved', 'closed']).withMessage('Invalid status.'),
    body('priority').optional().isIn(['low', 'medium', 'high', 'urgent']).withMessage('Invalid priority.'),
  ],
  validate,
  updateTicket
);

module.exports = router;
