const express = require('express');
const { body, param } = require('express-validator');
const appAuth = require('../../middleware/appAuth');
const validate = require('../../middleware/validate');
const { messageLimiter } = require('../../middleware/rateLimiter');
const {
  createTicket, listMyTickets, getUnreadCount, getMyTicket, replyMyTicket, closeMyTicket,
} = require('../../controllers/app/ticketsController');

const router = express.Router();

router.use(appAuth);

const idParam = [param('id').isString().trim().notEmpty().withMessage('Ticket id is required.')];

// Optional idempotency key for a send (see TicketMessage.clientMsgId).
const clientMsgId = body('clientMsgId')
  .optional()
  .isString()
  .matches(/^[A-Za-z0-9_-]{8,64}$/)
  .withMessage('Invalid clientMsgId.');

router.get('/', listMyTickets);
router.get('/unread-count', getUnreadCount);

router.post(
  '/',
  messageLimiter,
  [
    body('subject').trim().notEmpty().withMessage('Subject is required.').isLength({ max: 160 }),
    body('message').trim().notEmpty().withMessage('Message is required.').isLength({ max: 4000 }),
    body('category').optional().isIn(['general', 'technical', 'device', 'billing', 'account', 'other']),
    body('priority').optional().isIn(['low', 'medium', 'high', 'urgent']),
    clientMsgId,
  ],
  validate,
  createTicket
);

router.get('/:id', idParam, validate, getMyTicket);
router.post(
  '/:id/reply',
  messageLimiter,
  [...idParam, body('body').trim().notEmpty().withMessage('Message is required.').isLength({ max: 4000 }), clientMsgId],
  validate,
  replyMyTicket
);
router.put('/:id/close', idParam, validate, closeMyTicket);

module.exports = router;
