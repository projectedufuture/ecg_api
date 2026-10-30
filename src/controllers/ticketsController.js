const crypto = require('crypto');
const Ticket = require('../models/Ticket');
const TicketMessage = require('../models/TicketMessage');
const Admin = require('../models/Admin');
const realtime = require('../realtime/events');

const genMsgId = () => `tmsg_${crypto.randomBytes(8).toString('hex')}`;

const STATUSES = ['open', 'pending', 'resolved', 'closed'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

/**
 * GET /admin/tickets
 * Ticket list with filters (status, priority, category, search) + unread-from-user count.
 */
async function listTickets(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));

    const filter = {};
    if (req.clientScope) filter.clientId = req.clientScope;
    if (req.query.status && STATUSES.includes(req.query.status)) filter.status = req.query.status;
    if (req.query.priority && PRIORITIES.includes(req.query.priority)) filter.priority = req.query.priority;
    if (req.query.category) filter.category = req.query.category;
    if (req.query.search) {
      const rx = new RegExp(req.query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ subject: rx }, { ticketNumber: rx }, { userName: rx }, { userEmail: rx }];
    }

    const total = await Ticket.countDocuments(filter);
    const tickets = await Ticket.find(filter).sort({ lastActivityAt: -1 }).skip((page - 1) * limit).limit(limit).lean();

    // Unread (user → admin) per ticket, in one pass.
    const ids = tickets.map((t) => t.id);
    const unreadAgg = await TicketMessage.aggregate([
      { $match: { ticketId: { $in: ids }, sender: 'user', read: false } },
      { $group: { _id: '$ticketId', unread: { $sum: 1 } } },
    ]);
    const unreadMap = Object.fromEntries(unreadAgg.map((u) => [u._id, u.unread]));

    const data = tickets.map((t) => ({
      id: t.id, ticketNumber: t.ticketNumber, userId: t.userId, userName: t.userName, userEmail: t.userEmail,
      subject: t.subject, category: t.category, priority: t.priority, status: t.status,
      lastMessage: t.lastMessage, lastSender: t.lastSender, lastActivityAt: t.lastActivityAt,
      messageCount: t.messageCount, unread: unreadMap[t.id] || 0, createdAt: t.createdAt,
    }));

    // Status tallies for the dashboard cards (respect the same scope, ignore other filters).
    const scopeOnly = req.clientScope ? { clientId: req.clientScope } : {};
    const byStatus = await Ticket.aggregate([{ $match: scopeOnly }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
    const counts = { open: 0, pending: 0, resolved: 0, closed: 0, total: 0 };
    byStatus.forEach((s) => { counts[s._id] = s.n; counts.total += s.n; });

    return res.json({
      success: true,
      data: { items: data, counts },
      error: null,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
    });
  } catch (error) {
    console.error('List tickets error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

/** GET /admin/tickets/:id — ticket + full thread. Marks user messages read. */
async function getTicket(req, res) {
  try {
    const filter = { id: req.params.id };
    if (req.clientScope) filter.clientId = req.clientScope;
    const ticket = await Ticket.findOne(filter).lean();
    if (!ticket) return res.status(404).json({ success: false, data: null, error: 'Ticket not found.' });

    const marked = await TicketMessage.updateMany({ ticketId: ticket.id, sender: 'user', read: false }, { $set: { read: true, readAt: new Date() } });
    // Other admin tabs/devices update their unread badge.
    if (marked.modifiedCount > 0) realtime.ticketReadByAdmin(ticket);
    const messages = await TicketMessage.find({ ticketId: ticket.id }).sort({ createdAt: 1 }).lean();

    return res.json({
      success: true,
      data: {
        ticket: {
          id: ticket.id, ticketNumber: ticket.ticketNumber, userId: ticket.userId, userName: ticket.userName,
          userEmail: ticket.userEmail, subject: ticket.subject, category: ticket.category, priority: ticket.priority,
          status: ticket.status, messageCount: ticket.messageCount, createdAt: ticket.createdAt, lastActivityAt: ticket.lastActivityAt,
        },
        messages: messages.map((m) => ({ id: m.id, sender: m.sender, senderName: m.senderName, body: m.body, read: m.read, createdAt: m.createdAt })),
      },
      error: null,
    });
  } catch (error) {
    console.error('Get ticket error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

/** POST /admin/tickets/:id/reply   Body: { body } — admin replies; ticket moves to 'pending'. */
async function replyTicket(req, res) {
  try {
    const filter = { id: req.params.id };
    if (req.clientScope) filter.clientId = req.clientScope;
    const ticket = await Ticket.findOne(filter);
    if (!ticket) return res.status(404).json({ success: false, data: null, error: 'Ticket not found.' });

    const clientMsgId = req.body.clientMsgId || undefined;
    const reply = (m, status) => ({
      success: true,
      data: { message: { id: m.id, sender: 'admin', senderName: m.senderName, body: m.body, read: !!m.read, createdAt: m.createdAt }, status },
      error: null,
    });

    // Idempotent retry of the same send → return the saved message.
    if (clientMsgId) {
      const prior = await TicketMessage.findOne({ ticketId: ticket.id, clientMsgId }).lean();
      if (prior) return res.status(200).json(reply(prior, ticket.status));
    }

    const adminDoc = await Admin.findOne({ id: req.admin.id }).select('name').lean();
    const senderName = adminDoc?.name || 'Support';

    let msg;
    try {
      msg = await TicketMessage.create({
        id: genMsgId(), ticketId: ticket.id, userId: ticket.userId, sender: 'admin',
        senderId: req.admin.id, senderName, body: req.body.body, read: false, clientId: ticket.clientId, clientMsgId,
      });
    } catch (e) {
      if (e && e.code === 11000 && clientMsgId) {
        const prior = await TicketMessage.findOne({ ticketId: ticket.id, clientMsgId }).lean();
        if (prior) return res.status(200).json(reply(prior, ticket.status));
      }
      throw e;
    }

    ticket.lastMessage = req.body.body;
    ticket.lastSender = 'admin';
    ticket.lastActivityAt = new Date();
    ticket.messageCount = (ticket.messageCount || 0) + 1;
    if (ticket.status === 'open' || ticket.status === 'closed') ticket.status = 'pending';
    ticket.assignedAdminId = ticket.assignedAdminId || req.admin.id;
    await ticket.save();

    // Saved → deliver to the user's app immediately (and to other admins).
    realtime.ticketMessage(ticket, msg);

    return res.status(201).json(reply(msg, ticket.status));
  } catch (error) {
    console.error('Reply ticket error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

/** PUT /admin/tickets/:id   Body: { status?, priority? } */
async function updateTicket(req, res) {
  try {
    const filter = { id: req.params.id };
    if (req.clientScope) filter.clientId = req.clientScope;
    const update = {};
    if (req.body.status && STATUSES.includes(req.body.status)) update.status = req.body.status;
    if (req.body.priority && PRIORITIES.includes(req.body.priority)) update.priority = req.body.priority;
    if (Object.keys(update).length === 0) return res.status(400).json({ success: false, data: null, error: 'Nothing to update.' });

    const ticket = await Ticket.findOneAndUpdate(filter, { $set: update }, { new: true }).lean();
    if (!ticket) return res.status(404).json({ success: false, data: null, error: 'Ticket not found.' });
    realtime.ticketUpdated(ticket);
    return res.json({ success: true, data: { id: ticket.id, status: ticket.status, priority: ticket.priority }, error: null });
  } catch (error) {
    console.error('Update ticket error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

/** GET /admin/tickets/unread-count — unread user messages in the admin's scope (top-bar bell). */
async function getUnreadCount(req, res) {
  try {
    const filter = { sender: 'user', read: false };
    if (req.clientScope) filter.clientId = req.clientScope;
    const [unreadCount, ticketsWithUnread] = await Promise.all([
      TicketMessage.countDocuments(filter),
      TicketMessage.distinct('ticketId', filter).then((ids) => ids.length),
    ]);
    return res.json({ success: true, data: { unreadCount, ticketsWithUnread }, error: null });
  } catch (error) {
    console.error('Admin ticket unread error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

module.exports = { listTickets, getTicket, replyTicket, updateTicket, getUnreadCount };
