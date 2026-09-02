const mongoose = require('mongoose');

const readingSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    sessionId: { type: String, required: true },
    userId: { type: String, required: true },
    timestamp: { type: String, required: true },
    ecgValue: { type: Number, required: true },
    temperatureCelsius: { type: Number, required: true },
    hr: { type: Number, default: 0 },
    spo2: { type: Number, default: 0 },
    deviceId: { type: String, required: true },
    clientId: { type: String, default: 'CLIENT-001' },

    // ── R-peak / beat detection (ECG/RR analysis) ──────────────────
    // The firmware raises these on the sample where its detector fired. They are
    // additive and optional: readings uploaded by older firmware simply leave
    // `beat` false and are ignored by the RR pipeline.

    // True when the device reported an R peak at this sample (device BEAT flag).
    beat: { type: Boolean, default: false },

    /**
     * R-peak instant on the device's own monotonic millisecond clock (device
     * R_TIME field). RR intervals are differences of this value, so they are
     * immune to the wall-clock jitter and rounding that `timestamp` carries.
     * Null when the firmware reports a beat without a precise peak time - the
     * RR pipeline then falls back to `timestamp`.
     */
    rPeakTimestamp: { type: Number, default: null },

    // Detector confidence 0..1, when the firmware provides one.
    beatConfidence: { type: Number, default: null },

    // Device LEAD status: true = electrode off/poor contact, so any beat
    // detected on this sample is not trustworthy.
    leadOff: { type: Boolean, default: false },

    /**
     * RR interval the device reported on this packet (device RR field).
     *
     * The firmware repeats its last known RR on every packet, so this is NOT a
     * new interval per sample — only a reading with `beat: true` marks a new
     * beat. Kept for cross-checking and for firmware that reports RR without an
     * R-peak clock. Null when the device sent the -1 sentinel.
     */
    rrIntervalMs: { type: Number, default: null },

    /**
     * Device ECG quality flag (device QUALITY field). 0 means the firmware
     * considers this ECG sample unusable. Null when not reported.
     */
    ecgQuality: { type: Number, default: null },

    // ── Raw PPG ────────────────────────────────────────────────────
    // Required for PPG-derived respiration: the final SpO2 percentage carries
    // no waveform and cannot substitute for these. Null when the firmware does
    // not stream raw photoplethysmography.
    ppgIr: { type: Number, default: null },
    ppgRed: { type: Number, default: null },

    // ── Transmission sequence ──────────────────────────────────────
    /**
     * Device packet counter (SEQ). This is the ONLY evidence of what actually
     * arrived over the radio: a missing SEQ proves samples were lost, and a
     * repeated one proves a packet was delivered twice. Nothing downstream may
     * invent a sample to fill a hole.
     *
     * Null for firmware that does not number its packets, in which case
     * continuity cannot be verified at all.
     */
    seq: { type: Number, default: null },

    // ── Raw vs filtered ECG ────────────────────────────────────────
    /**
     * The device reports both. They are stored separately and never conflated:
     * the raw sample is the measurement, the filtered one is the device's
     * interpretation of it. Analysis that needs to know what the sensor
     * actually saw must be able to reach the raw value.
     *
     * `ecgValue` above remains the primary sample for backward compatibility
     * and carries the raw value when both are present.
     */
    ecgRaw: { type: Number, default: null },
    ecgFiltered: { type: Number, default: null },

    // ── Device-reported validity flags ─────────────────────────────
    // The firmware's own verdicts, stored as reported. The backend does not
    // overwrite them: it adds its own transmission-integrity view alongside.
    // Null means the firmware did not report that flag.
    beatValid: { type: Boolean, default: null },
    rrValid: { type: Boolean, default: null },
    hrEcgValid: { type: Boolean, default: null },
    pqrstValid: { type: Boolean, default: null },

    // Instantaneous (beat-to-beat) and averaged heart rate, kept apart because
    // an average hides exactly the variation the RR analysis exists to measure.
    hrInstant: { type: Number, default: null },
    hrAvg: { type: Number, default: null },

    /**
     * Why the device rejected this beat or sample, verbatim. Preserved rather
     * than normalised: a firmware reason we do not recognise is still the most
     * informative thing available about why a beat was dropped.
     */
    rejectReason: { type: String, default: null },

    /**
     * The device's declared ECG sample rate (RATE_HZ) for the frame this
     * sample came from.
     *
     * Stored per sample because it IS the chart's horizontal axis: a trace
     * drawn at an assumed 50 Hz while the device runs at 128 Hz is stretched
     * 2.56x, so every interval read off it is wrong by that factor. There is
     * deliberately no default - null means "the device did not say", and a
     * renderer must then decline to claim a time base rather than guess one.
     */
    sampleRateHz: { type: Number, default: null },

    /**
     * PQRST morphology exactly as the device reported it, on the sample that
     * carried the frame's beat. Only present when the firmware set
     * PQRST_VALID:1 - the device leaves the PREVIOUS beat's values in the
     * frame otherwise, so an ungated copy would attribute a stale complex to
     * this beat.
     *
     * P/Q/R/S/T are AMPLITUDES in an unconfirmed unit; the intervals are ms.
     * The amplitudes cannot say WHERE a landmark sits on the trace, so a
     * renderer must locate landmarks in the samples and use only the
     * intervals to bound its search.
     */
    pqrst: {
      p: { type: Number, default: null },
      q: { type: Number, default: null },
      r: { type: Number, default: null },
      s: { type: Number, default: null },
      t: { type: Number, default: null },
      prMs: { type: Number, default: null },
      qrsMs: { type: Number, default: null },
      qtMs: { type: Number, default: null },
      qtcMs: { type: Number, default: null },
    },
  },
  { timestamps: true }
);

readingSchema.index({ sessionId: 1, timestamp: 1 });
// Supports the RR pipeline's "all R peaks for this session, in order" query.
readingSchema.index({ sessionId: 1, beat: 1, rPeakTimestamp: 1 });
// Supports the SEQ continuity scan, which must read packets in arrival order.
readingSchema.index({ sessionId: 1, seq: 1 });
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
    hr: this.hr || 0,
    spo2: this.spo2 || 0,
    deviceId: this.deviceId,
    beat: this.beat === true,
    rPeakTimestamp: this.rPeakTimestamp ?? null,
    beatConfidence: this.beatConfidence ?? null,
    leadOff: this.leadOff === true,
    seq: this.seq ?? null,
    ecgRaw: this.ecgRaw ?? null,
    ecgFiltered: this.ecgFiltered ?? null,
    beatValid: this.beatValid ?? null,
    rrValid: this.rrValid ?? null,
    hrEcgValid: this.hrEcgValid ?? null,
    pqrstValid: this.pqrstValid ?? null,
    hrInstant: this.hrInstant ?? null,
    hrAvg: this.hrAvg ?? null,
    rejectReason: this.rejectReason ?? null,
  };
};

module.exports = mongoose.model('Reading', readingSchema);
