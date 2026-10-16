const mongoose = require('mongoose');

/**
 * A single notification delivered to ONE app user.
 *
 * A broadcast or multi-recipient send creates one document per recipient (they
 * share a `batchId`), so each user carries their own read state. The admin UI
 * groups rows back together by `batchId` to show one "sent notification".
 */
const notificationSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    // Groups all recipient rows created by a single admin send.
    batchId: { type: String, required: true, index: true },
    // Recipient (app user) id.
    userId: { type: String, required: true, index: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    type: {
      type: String,
      enum: ['info', 'success', 'warning', 'alert'],
      default: 'info',
    },
    // 'all' = broadcast to every user, 'selected' = a chosen subset.
    audience: { type: String, enum: ['all', 'selected'], default: 'selected' },
    read: { type: Boolean, default: false },
    readAt: { type: Date, default: null },
    createdByAdminId: { type: String, default: null },
    createdByName: { type: String, default: 'Admin' },
    clientId: { type: String, default: 'CLIENT-001', index: true },
  },
  { timestamps: true }
);

notificationSchema.index({ userId: 1, read: 1 });
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ clientId: 1, createdAt: -1 });

notificationSchema.methods.toAppJSON = function () {
  return {
    id: this.id,
    title: this.title,
    body: this.body,
    type: this.type,
    read: this.read,
    readAt: this.readAt || null,
    createdAt: this.createdAt,
  };
};

module.exports = mongoose.model('Notification', notificationSchema);
