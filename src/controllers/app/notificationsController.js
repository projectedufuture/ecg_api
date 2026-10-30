const Notification = require('../../models/Notification');
const realtime = require('../../realtime/events');

/** GET /api/app/notifications — the signed-in user's notifications, newest first. */
async function getNotifications(req, res) {
  try {
    const userId = req.user.userId;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));

    const [items, total, unreadCount] = await Promise.all([
      Notification.find({ userId }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Notification.countDocuments({ userId }),
      Notification.countDocuments({ userId, read: false }),
    ]);

    return res.json({
      success: true,
      data: {
        items: items.map((n) => ({
          id: n.id, title: n.title, body: n.body, type: n.type,
          read: n.read, readAt: n.readAt || null, createdAt: n.createdAt,
        })),
        unreadCount,
      },
      error: null,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
    });
  } catch (error) {
    console.error('App getNotifications error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

/** GET /api/app/notifications/unread-count — badge count. */
async function getUnreadCount(req, res) {
  try {
    const unreadCount = await Notification.countDocuments({ userId: req.user.userId, read: false });
    return res.json({ success: true, data: { unreadCount }, error: null });
  } catch (error) {
    console.error('App unread count error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

/** PUT /api/app/notifications/:id/read */
async function markRead(req, res) {
  try {
    const n = await Notification.findOneAndUpdate(
      { id: req.params.id, userId: req.user.userId },
      { $set: { read: true, readAt: new Date() } },
      { new: true }
    ).lean();
    if (!n) return res.status(404).json({ success: false, data: null, error: 'Notification not found.' });
    realtime.notificationsReadChanged(req.user.userId); // other devices' badges
    return res.json({ success: true, data: { id: n.id, read: true }, error: null });
  } catch (error) {
    console.error('App markRead error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

/** PUT /api/app/notifications/read-all */
async function markAllRead(req, res) {
  try {
    const r = await Notification.updateMany(
      { userId: req.user.userId, read: false },
      { $set: { read: true, readAt: new Date() } }
    );
    if (r.modifiedCount > 0) realtime.notificationsReadChanged(req.user.userId);
    return res.json({ success: true, data: { updated: r.modifiedCount || 0 }, error: null });
  } catch (error) {
    console.error('App markAllRead error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

module.exports = { getNotifications, getUnreadCount, markRead, markAllRead };
