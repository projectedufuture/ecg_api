const { emitToUser, emitToAdmins } = require('./socket');
const Ticket = require('../models/Ticket');
const TicketMessage = require('../models/TicketMessage');
const Notification = require('../models/Notification');

/**
 * Domain events pushed over the real-time channel. Every function here is
 * called by a controller only AFTER its database write has succeeded, and none
 * of them can throw into the request (a socket problem must never fail a REST
 * call that already saved data).
 *
 * Events (all payloads carry stable ids so clients can de-duplicate):
 *
 *  to the app user (room user:<id>)
 *    ticket:created   { ticket }                 — their own new request (other devices)
 *    ticket:message   { ticketId, message, ticket } — admin reply, or their own reply
 *    ticket:updated   { ticket }                 — status/priority changed
 *    notification:new { notification }
 *    notification:deleted { ids }
 *    unread:counts    { notifications?, support? } — authoritative badge values
 *
 *  to admins (admins:all + admins:client:<clientId>)
 *    ticket:created   { ticket }
 *    ticket:message   { ticketId, message, ticket }
 *    ticket:updated   { ticket }
 *    ticket:read      { ticketId }               — an admin read the user's messages
 */

const msgShape = (m) => ({
  id: m.id,
  ticketId: m.ticketId,
  sender: m.sender,
  senderName: m.senderName,
  body: m.body,
  read: !!m.read,
  createdAt: m.createdAt,
  // Echo the sender's own idempotency key so the sending device can match
  // this event to its optimistic bubble instead of showing it twice.
  ...(m.clientMsgId ? { clientMsgId: m.clientMsgId } : {}),
});

/** Ticket summary safe for both sides (matches the REST list item shapes). */
const ticketShape = (t) => ({
  id: t.id,
  ticketNumber: t.ticketNumber,
  userId: t.userId,
  userName: t.userName,
  userEmail: t.userEmail,
  subject: t.subject,
  category: t.category,
  priority: t.priority,
  status: t.status,
  lastMessage: t.lastMessage,
  lastSender: t.lastSender,
  lastActivityAt: t.lastActivityAt,
  messageCount: t.messageCount,
  createdAt: t.createdAt,
});

/** The app must not receive admin-internal fields about other users. */
const ticketForUser = (t) => {
  const s = ticketShape(t);
  delete s.userId;
  delete s.userName;
  delete s.userEmail;
  return s;
};

function safe(fn) {
  return (...args) => {
    try {
      const r = fn(...args);
      if (r && typeof r.catch === 'function') {
        r.catch((e) => console.error('[realtime] event failed:', e.message));
      }
    } catch (e) {
      console.error('[realtime] event failed:', e.message);
    }
  };
}

/** Recompute and push the user's support-reply badge. */
async function pushSupportUnread(userId) {
  const tickets = await Ticket.find({ userId }).select('id').lean();
  const support = await TicketMessage.countDocuments({
    ticketId: { $in: tickets.map((t) => t.id) },
    sender: 'admin',
    read: false,
  });
  emitToUser(userId, 'unread:counts', { support });
}

/** Recompute and push the user's notification badge. */
async function pushNotificationUnread(userId) {
  const notifications = await Notification.countDocuments({ userId, read: false });
  emitToUser(userId, 'unread:counts', { notifications });
}

const ticketCreated = safe((ticket, firstMessage) => {
  const payload = { ticket: ticketShape(ticket), message: msgShape(firstMessage) };
  emitToAdmins(ticket.clientId, 'ticket:created', payload);
  emitToUser(ticket.userId, 'ticket:created', {
    ticket: ticketForUser(ticket),
    message: msgShape(firstMessage),
  });
});

const ticketMessage = safe((ticket, message) => {
  emitToAdmins(ticket.clientId, 'ticket:message', {
    ticketId: ticket.id,
    message: msgShape(message),
    ticket: ticketShape(ticket),
  });
  emitToUser(ticket.userId, 'ticket:message', {
    ticketId: ticket.id,
    message: msgShape(message),
    ticket: ticketForUser(ticket),
  });
  if (message.sender === 'admin') return pushSupportUnread(ticket.userId);
  return null;
});

const ticketUpdated = safe((ticket) => {
  emitToAdmins(ticket.clientId, 'ticket:updated', { ticket: ticketShape(ticket) });
  emitToUser(ticket.userId, 'ticket:updated', { ticket: ticketForUser(ticket) });
});

/** An admin opened the thread → user messages are now read (admin badge). */
const ticketReadByAdmin = safe((ticket) => {
  emitToAdmins(ticket.clientId, 'ticket:read', { ticketId: ticket.id });
});

/** The user opened the thread → their support badge changed (other devices). */
const ticketReadByUser = safe((userId) => pushSupportUnread(userId));

/** One event per recipient; each user only ever receives their own copy. */
const notificationsCreated = safe((docs) => {
  for (const n of docs) {
    emitToUser(n.userId, 'notification:new', {
      notification: {
        id: n.id,
        title: n.title,
        body: n.body,
        type: n.type,
        read: false,
        readAt: null,
        createdAt: n.createdAt,
      },
    });
  }
});

/** rows: [{ id, userId }] that were deleted. */
const notificationsDeleted = safe((rows) => {
  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.userId)) byUser.set(r.userId, []);
    byUser.get(r.userId).push(r.id);
  }
  for (const [userId, ids] of byUser) {
    emitToUser(userId, 'notification:deleted', { ids });
    pushNotificationUnread(userId).catch(() => {});
  }
});

/** The user changed read state (other devices' badges follow). */
const notificationsReadChanged = safe((userId) => pushNotificationUnread(userId));

module.exports = {
  ticketCreated,
  ticketMessage,
  ticketUpdated,
  ticketReadByAdmin,
  ticketReadByUser,
  notificationsCreated,
  notificationsDeleted,
  notificationsReadChanged,
  // exported for tests
  _shapes: { msgShape, ticketShape, ticketForUser },
};
