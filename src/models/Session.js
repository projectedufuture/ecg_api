const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    userEmail: { type: String, required: true },
    userName: { type: String, required: true },
    deviceId: { type: String, required: true },
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
    duration: { type: Number, required: true },
    dataPoints: { type: Number, required: true },
    dataSource: { type: String, enum: ['live', 'stored', 'mixed'], required: true },
    avgTemp: { type: String, required: true },
    avgHR: { type: Number, required: true },
    minHR: { type: Number, required: true },
    maxHR: { type: Number, required: true },
    clientId: { type: String, default: 'CLIENT-001' },
    location: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
      accuracy: { type: Number, default: null },
      address: { type: String, default: null },
    },
  },
  { timestamps: true }
);

sessionSchema.index({ userId: 1 });
sessionSchema.index({ deviceId: 1 });
sessionSchema.index({ startTime: 1 });
sessionSchema.index({ clientId: 1 });
sessionSchema.index({ userId: 1, startTime: -1 });

sessionSchema.methods.toFrontend = function () {
  return {
    id: this.id,
    userId: this.userId,
    userEmail: this.userEmail,
    userName: this.userName,
    deviceId: this.deviceId,
    startTime: this.startTime,
    endTime: this.endTime,
    duration: this.duration,
    dataPoints: this.dataPoints,
    dataSource: this.dataSource,
    avgTemp: this.avgTemp,
    avgHR: this.avgHR,
    minHR: this.minHR,
    maxHR: this.maxHR,
    location: this.location || null,
  };
};

module.exports = mongoose.model('Session', sessionSchema);
