const crypto = require('crypto');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Admin = require('../models/Admin');
const realtime = require('../realtime/events');

const genId = () => `ntf_${crypto.randomBytes(8).toString('hex')}`;
const genBatch = () => `bat_${crypto.randomBytes(8).toString('hex')}`;

/**
 * GET /admin/notifications
 * Sent notifications grouped by batch (one row per admin "send"), newest first.
 */
async function listNotifications(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

    const match = {};
    if (req.clientScope) match.clientId = req.clientScope;
    if (req.query.type && ['info', 'success', 'warning', 'alert'].includes(req.query.type)) {
      match.type = req.query.type;
    }

    const batches = await Notification.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$batchId',
          title: { $first: '$title' },
          body: { $first: '$body' },
          type: { $first: '$type' },
          audience: { $first: '$audience' },
          createdByName: { $first: '$createdByName' },
          createdAt: { $first: '$createdAt' },
          recipientCount: { $sum: 1 },
          readCount: { $sum: { $cond: ['$read', 1, 0] } },
        },
      },
      { $sort: { createdAt: -1 } },
      { $skip: (page - 1) * limit },
      { $limit: limit },
    ]);

    const totalAgg = await Notification.aggregate([
      { $match: match },
      { $group: { _id: '$batchId' } },
      { $count: 'total' },
    ]);
    const total = totalAgg[0]?.total || 0;

    const data = batches.map((b) => ({
      batchId: b._id,
      title: b.title,
      body: b.body,
      type: b.type,
      audience: b.audience,
      createdByName: b.createdByName,
      recipientCount: b.recipientCount,
      readCount: b.readCount,
      createdAt: b.createdAt,
    }));

    return res.json({
      success: true,
      data,
      error: null,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
    });
  } catch (error) {
    console.error('List notifications error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

/**
 * POST /admin/notifications
 * Body: { title, body, type?, broadcast?, userIds? }
 * Creates one Notification per recipient (broadcast = all active users in scope).
 */
async function sendNotification(req, res) {
  try {
    const { title, body, type = 'info', broadcast = false, userIds = [] } = req.body;

    const userFilter = {};
    if (req.clientScope) userFilter.clientId = req.clientScope;

    let recipients;
    if (broadcast) {
      userFilter.status = 'active';
      recipients = await User.find(userFilter).select('id clientId').lean();
    } else {
      if (!Array.isArray(userIds) || userIds.length === 0) {
        return res.status(400).json({ success: false, data: null, error: 'Select at least one recipient.' });
      }
      userFilter.id = { $in: userIds };
      recipients = await User.find(userFilter).select('id clientId').lean();
    }

    if (recipients.length === 0) {
      return res.status(400).json({ success: false, data: null, error: 'No matching recipients found.' });
    }

    const adminDoc = await Admin.findOne({ id: req.admin.id }).select('name').lean();
    const createdByName = adminDoc?.name || req.admin.email || 'Admin';
    const batchId = genBatch();
    const now = new Date();

    const docs = recipients.map((u) => ({
      id: genId(),
      batchId,
      userId: u.id,
      title,
      body,
      type,
      audience: broadcast ? 'all' : 'selected',
      read: false,
      createdByAdminId: req.admin.id,
      createdByName,
      clientId: u.clientId || 'CLIENT-001',
      createdAt: now,
    }));

    await Notification.insertMany(docs, { ordered: false });

    // Saved → push to each recipient's own room (connected devices only;
    // offline users get it from GET /api/app/notifications on reconnect).
    realtime.notificationsCreated(docs);

    return res.status(201).json({
      success: true,
      data: { batchId, recipientCount: docs.length, audience: broadcast ? 'all' : 'selected' },
      error: null,
    });
  } catch (error) {
    console.error('Send notification error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

/**
 * DELETE /admin/notifications/:batchId
 * Removes every recipient row for that send.
 */
async function deleteNotification(req, res) {
  try {
    const filter = { batchId: req.params.batchId };
    if (req.clientScope) filter.clientId = req.clientScope;
    const affected = await Notification.find(filter).select('id userId').lean();
    const result = await Notification.deleteMany(filter);
    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, data: null, error: 'Notification not found.' });
    }
    realtime.notificationsDeleted(affected);
    return res.json({ success: true, data: { deletedCount: result.deletedCount }, error: null });
  } catch (error) {
    console.error('Delete notification error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

module.exports = { listNotifications, sendNotification, deleteNotification };
