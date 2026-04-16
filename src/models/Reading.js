const mongoose = require('mongoose');

const readingSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    sessionId: { type: String, required: true },
    userId: { type: String, required: true },
    timestamp: { type: String, required: true },
    ecgValue: { type: Number, required: true },
    temperatureCelsius: { type: Number, required: true },
    deviceId: { type: String, required: true },
    clientId: { type: String, default: 'CLIENT-001' },
  },
  { timestamps: true }
);

readingSchema.index({ sessionId: 1, timestamp: 1 });
readingSchema.index({ userId: 1 });
readingSchema.index({ deviceId: 1 });
readingSchema.index({ clientId: 1 });

readingSchema.methods.toFrontend = function () {
  return {
    id: this.id,
    sessionId: this.sessionId,
    userId: this.userId,
    timestamp: this.timestamp,
    ecgValue: this.ecgValue,
    temperatureCelsius: this.temperatureCelsius,
    deviceId: this.deviceId,
  };
};

module.exports = mongoose.model('Reading', readingSchema);
