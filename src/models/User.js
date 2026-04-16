const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    email: { type: String, required: true, lowercase: true },
    registeredDate: { type: String, required: true },
    lastActive: { type: String, required: true },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    deviceId: { type: String, default: null },
    sessions: { type: Number, default: 0 },
    clientId: { type: String, default: 'CLIENT-001' },
  },
  { timestamps: true }
);

userSchema.index({ email: 1 });
userSchema.index({ name: 1 });
userSchema.index({ status: 1 });
userSchema.index({ clientId: 1 });
userSchema.index({ registeredDate: 1 });

userSchema.methods.toFrontend = function () {
  return {
    id: this.id,
    name: this.name,
    email: this.email,
    registeredDate: this.registeredDate,
    lastActive: this.lastActive,
    status: this.status,
    deviceId: this.deviceId,
    sessions: this.sessions,
  };
};

module.exports = mongoose.model('User', userSchema);
