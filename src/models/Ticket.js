const mongoose = require('mongoose');

/**
 * A support ticket raised by an app user. The conversation lives in
 * `TicketMessage` documents keyed by `ticketId`; this doc carries the ticket's
 * metadata and a denormalized snapshot of the last activity for fast listing.
 */
const ticketSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    // Human-readable reference, e.g. TKT-00042.
    ticketNumber: { type: String, required: true, unique: true },
    userId: { type: String, required: true, index: true },
    userName: { type: String, default: '' },
    userEmail: { type: String, default: '' },
    subject: { type: String, required: true },
    category: {
      type: String,
      enum: ['general', 'technical', 'device', 'billing', 'account', 'other'],
      default: 'general',
    },
    priority: { type: String, enum: ['low', 'medium', 'high', 'urgent'], default: 'medium' },
    status: { type: String, enum: ['open', 'pending', 'resolved', 'closed'], default: 'open' },
    // Denormalized last-activity snapshot for the ticket list.
    lastMessage: { type: String, default: '' },
    lastSender: { type: String, enum: ['admin', 'user', null], default: null },
    lastActivityAt: { type: Date, default: Date.now },
    messageCount: { type: Number, default: 0 },
    assignedAdminId: { type: String, default: null },
    clientId: { type: String, default: 'CLIENT-001', index: true },
  },
  { timestamps: true }
);

ticketSchema.index({ clientId: 1, status: 1, lastActivityAt: -1 });
ticketSchema.index({ userId: 1, lastActivityAt: -1 });

ticketSchema.methods.toShape = function () {
  return {
    id: this.id,
    ticketNumber: this.ticketNumber,
    userId: this.userId,
    userName: this.userName,
    userEmail: this.userEmail,
    subject: this.subject,
    category: this.category,
    priority: this.priority,
    status: this.status,
    lastMessage: this.lastMessage,
    lastSender: this.lastSender,
    lastActivityAt: this.lastActivityAt,
    messageCount: this.messageCount,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

module.exports = mongoose.model('Ticket', ticketSchema);
