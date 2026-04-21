const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const userSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true },
    password: { type: String, default: null, select: false },
    registeredDate: { type: String, required: true },
    lastActive: { type: String, required: true },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    deviceId: { type: String, default: null },
    sessions: { type: Number, default: 0 },
    clientId: { type: String, default: 'CLIENT-001' },
    refreshToken: { type: String, default: null, select: false },
    resetPasswordToken: { type: String, default: null, select: false },
    resetPasswordExpiry: { type: Date, default: null, select: false },
    mustChangePassword: { type: Boolean, default: false },
  },
  { timestamps: true }
);

userSchema.index({ email: 1 });
userSchema.index({ name: 1 });
userSchema.index({ status: 1 });
userSchema.index({ clientId: 1 });
userSchema.index({ registeredDate: 1 });

userSchema.pre('save', async function (next) {
  if (!this.isModified('password') || !this.password) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = async function (candidatePassword) {
  if (!this.password) return false;
  return bcrypt.compare(candidatePassword, this.password);
};

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

userSchema.methods.toAppJSON = function () {
  return {
    id: this.id,
    name: this.name,
    email: this.email,
    deviceId: this.deviceId,
    status: this.status,
    mustChangePassword: this.mustChangePassword,
  };
};

module.exports = mongoose.model('User', userSchema);
