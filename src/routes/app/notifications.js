const express = require('express');
const { param } = require('express-validator');
const appAuth = require('../../middleware/appAuth');
const validate = require('../../middleware/validate');
const { getNotifications, getUnreadCount, markRead, markAllRead } = require('../../controllers/app/notificationsController');

const router = express.Router();

router.get('/', appAuth, getNotifications);
router.get('/unread-count', appAuth, getUnreadCount);
router.put('/read-all', appAuth, markAllRead);
router.put('/:id/read', appAuth, [param('id').isString().trim().notEmpty()], validate, markRead);

module.exports = router;
