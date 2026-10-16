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
  },
  { timestamps: true }
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
