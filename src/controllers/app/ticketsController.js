const crypto = require('crypto');
const Ticket = require('../../models/Ticket');
const TicketMessage = require('../../models/TicketMessage');
const User = require('../../models/User');

const genTicketId = () => `tkt_${crypto.randomBytes(8).toString('hex')}`;
const genMsgId = () => `tmsg_${crypto.randomBytes(8).toString('hex')}`;

const CATEGORIES = ['general', 'technical', 'device', 'billing', 'account', 'other'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

async function nextTicketNumber() {
  const count = await Ticket.estimatedDocumentCount();
  return `TKT-${String(count + 1).padStart(5, '0')}`;
}

/** POST /api/app/tickets   Body: { subject, category?, priority?, message } — open a new ticket. */
async function createTicket(req, res) {
  try {
    const userId = req.user.userId;
    const user = await User.findOne({ id: userId }).select('id name email clientId').lean();
    if (!user) return res.status(404).json({ success: false, data: null, error: 'User not found.' });

    const { subject, message } = req.body;
    const category = CATEGORIES.includes(req.body.category) ? req.body.category : 'general';
    const priority = PRIORITIES.includes(req.body.priority) ? req.body.priority : 'medium';

    const ticketNumber = await nextTicketNumber();
    const now = new Date();
    const ticket = await Ticket.create({
      id: genTicketId(), ticketNumber, userId, userName: user.name, userEmail: user.email,
      subject, category, priority, status: 'open', lastMessage: message, lastSender: 'user',
      lastActivityAt: now, messageCount: 1, clientId: user.clientId || 'CLIENT-001',
    });
    await TicketMessage.create({
      id: genMsgId(), ticketId: ticket.id, userId, sender: 'user', senderId: userId,
      senderName: user.name, body: message, read: false, clientId: ticket.clientId,
    });

    return res.status(201).json({ success: true, data: ticket.toShape(), error: null });
  } catch (error) {
    console.error('App createTicket error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

/** GET /api/app/tickets — the user's own tickets, newest activity first. */
async function listMyTickets(req, res) {
  try {
    const tickets = await Ticket.find({ userId: req.user.userId }).sort({ lastActivityAt: -1 }).lean();
    const ids = tickets.map((t) => t.id);
    const unreadAgg = await TicketMessage.aggregate([
      { $match: { ticketId: { $in: ids }, sender: 'admin', read: false } },
      { $group: { _id: '$ticketId', unread: { $sum: 1 } } },
    ]);
    const unreadMap = Object.fromEntries(unreadAgg.map((u) => [u._id, u.unread]));
    return res.json({
      success: true,
      data: tickets.map((t) => ({
        id: t.id, ticketNumber: t.ticketNumber, subject: t.subject, category: t.category, priority: t.priority,
        status: t.status, lastMessage: t.lastMessage, lastSender: t.lastSender, lastActivityAt: t.lastActivityAt,
        messageCount: t.messageCount, unread: unreadMap[t.id] || 0, createdAt: t.createdAt,
      })),
      error: null,
    });
  } catch (error) {
    console.error('App listMyTickets error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

/** GET /api/app/tickets/unread-count — unread admin replies across the user's tickets. */
async function getUnreadCount(req, res) {
  try {
    const tickets = await Ticket.find({ userId: req.user.userId }).select('id').lean();
    const unreadCount = await TicketMessage.countDocuments({ ticketId: { $in: tickets.map((t) => t.id) }, sender: 'admin', read: false });
    return res.json({ success: true, data: { unreadCount }, error: null });
  } catch (error) {
    console.error('App ticket unread error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

/** GET /api/app/tickets/:id — one ticket + thread (only the owner). Marks admin replies read. */
async function getMyTicket(req, res) {
  try {
    const ticket = await Ticket.findOne({ id: req.params.id, userId: req.user.userId }).lean();
    if (!ticket) return res.status(404).json({ success: false, data: null, error: 'Ticket not found.' });
    await TicketMessage.updateMany({ ticketId: ticket.id, sender: 'admin', read: false }, { $set: { read: true, readAt: new Date() } });
    const messages = await TicketMessage.find({ ticketId: ticket.id }).sort({ createdAt: 1 }).lean();
    return res.json({
      success: true,
      data: {
        ticket: {
          id: ticket.id, ticketNumber: ticket.ticketNumber, subject: ticket.subject, category: ticket.category,
          priority: ticket.priority, status: ticket.status, createdAt: ticket.createdAt, lastActivityAt: ticket.lastActivityAt,
        },
        messages: messages.map((m) => ({ id: m.id, sender: m.sender, senderName: m.senderName, body: m.body, read: m.read, createdAt: m.createdAt })),
      },
      error: null,
    });
  } catch (error) {
    console.error('App getMyTicket error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

/** POST /api/app/tickets/:id/reply   Body: { body } — user replies; a resolved/closed ticket reopens. */
async function replyMyTicket(req, res) {
  try {
    const ticket = await Ticket.findOne({ id: req.params.id, userId: req.user.userId });
    if (!ticket) return res.status(404).json({ success: false, data: null, error: 'Ticket not found.' });
    const user = await User.findOne({ id: req.user.userId }).select('name').lean();
    const msg = await TicketMessage.create({
      id: genMsgId(), ticketId: ticket.id, userId: ticket.userId, sender: 'user', senderId: ticket.userId,
      senderName: user?.name || 'User', body: req.body.body, read: false, clientId: ticket.clientId,
    });
    ticket.lastMessage = req.body.body;
    ticket.lastSender = 'user';
    ticket.lastActivityAt = new Date();
    ticket.messageCount = (ticket.messageCount || 0) + 1;
    if (ticket.status === 'resolved' || ticket.status === 'closed' || ticket.status === 'pending') ticket.status = 'open';
    await ticket.save();
    return res.status(201).json({ success: true, data: { message: { id: msg.id, sender: 'user', senderName: msg.senderName, body: msg.body, createdAt: msg.createdAt }, status: ticket.status }, error: null });
  } catch (error) {
    console.error('App replyMyTicket error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

/** PUT /api/app/tickets/:id/close — the user closes their own ticket. */
async function closeMyTicket(req, res) {
  try {
    const ticket = await Ticket.findOneAndUpdate({ id: req.params.id, userId: req.user.userId }, { $set: { status: 'closed', lastActivityAt: new Date() } }, { new: true }).lean();
    if (!ticket) return res.status(404).json({ success: false, data: null, error: 'Ticket not found.' });
    return res.json({ success: true, data: { id: ticket.id, status: ticket.status }, error: null });
  } catch (error) {
    console.error('App closeMyTicket error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

module.exports = { createTicket, listMyTickets, getUnreadCount, getMyTicket, replyMyTicket, closeMyTicket };
