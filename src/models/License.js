const mongoose = require('mongoose');

const licenseSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    licenseKey: { type: String, required: true, unique: true },
    deviceId: { type: String, required: true },
    clientId: { type: String, required: true },
    status: { type: String, enum: ['active', 'inactive', 'expired'], default: 'inactive' },
    activationDate: { type: String, required: true },
    expiryDate: { type: String, required: true },
  },
  { timestamps: true }
);

licenseSchema.index({ deviceId: 1 });
licenseSchema.index({ clientId: 1 });
licenseSchema.index({ status: 1 });

licenseSchema.methods.toFrontend = function () {
  return {
    id: this.id,
    licenseKey: this.licenseKey,
    deviceId: this.deviceId,
    clientId: this.clientId,
    status: this.status,
    activationDate: this.activationDate,
    expiryDate: this.expiryDate,
  };
};

module.exports = mongoose.model('License', licenseSchema);
