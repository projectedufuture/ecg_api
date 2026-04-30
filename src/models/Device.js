const mongoose = require('mongoose');

const deviceSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    userId: { type: String, default: null },
    userName: { type: String, default: 'Unassigned' },
    lastSeen: { type: String, required: true },
    firmware: { type: String, required: true },
    hardwareVersion: { type: String, default: 'HW-2.0' },
    licenseStatus: { type: String, enum: ['active', 'inactive', 'expired'], default: 'inactive' },
    batteryLevel: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    clientId: { type: String, default: 'CLIENT-001' },
    // Set the first time a user successfully completes /api/app/devices/pair.
    // Null = device has not yet been paired by its owner via the mobile app.
    pairedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

deviceSchema.index({ userId: 1 });
deviceSchema.index({ licenseStatus: 1 });
deviceSchema.index({ firmware: 1 });
deviceSchema.index({ lastSeen: 1 });
deviceSchema.index({ clientId: 1 });

deviceSchema.methods.toFrontend = function () {
  return {
    id: this.id,
    userId: this.userId,
    userName: this.userName,
    lastSeen: this.lastSeen,
    firmware: this.firmware,
    hardwareVersion: this.hardwareVersion,
    licenseStatus: this.licenseStatus,
    batteryLevel: this.batteryLevel,
  };
};

module.exports = mongoose.model('Device', deviceSchema);
