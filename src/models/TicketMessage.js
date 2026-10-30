const mongoose = require('mongoose');

/** One reply in a support ticket thread. `read` tracks whether the OTHER side has seen it. */
const ticketMessageSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    ticketId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    sender: { type: String, enum: ['admin', 'user'], required: true },
    senderId: { type: String, default: null },
    senderName: { type: String, default: null },
    body: { type: String, required: true },
    read: { type: Boolean, default: false },
    readAt: { type: Date, default: null },
    clientId: { type: String, default: 'CLIENT-001', index: true },
    // Optional sender-generated id for idempotent sends: a retry after a lost
    // response (timeout, reconnect) carries the same value and returns the
    // already-saved message instead of inserting a duplicate. NOT the tenant
    // `clientId` above.
    clientMsgId: { type: String, default: undefined },
  },
  { timestamps: true }
);

// Unique per ticket, only for messages that carry a clientMsgId (old rows and
// clients that don't send one are unaffected).
ticketMessageSchema.index(
  { ticketId: 1, clientMsgId: 1 },
  { unique: true, partialFilterExpression: { clientMsgId: { $type: 'string' } } }
);
// Lookup for an idempotent "create ticket" retry (the first message).
ticketMessageSchema.index(
  { senderId: 1, clientMsgId: 1 },
  { partialFilterExpression: { clientMsgId: { $type: 'string' } } }
);
ticketMessageSchema.index({ ticketId: 1, createdAt: 1 });
ticketMessageSchema.index({ ticketId: 1, sender: 1, read: 1 });

ticketMessageSchema.methods.toShape = function () {
  return {
    id: this.id,
    ticketId: this.ticketId,
    sender: this.sender,
    senderName: this.senderName,
    body: this.body,
    read: this.read,
    readAt: this.readAt || null,
    createdAt: this.createdAt,
  };
};

module.exports = mongoose.model('TicketMessage', ticketMessageSchema);
