const mongoose = require('mongoose');

/**
 * Beat-level ECG analysis produced by the APP, not the firmware.
 *
 * The app runs its own analyser over the continuous ECG_FILTERED buffer and
 * emits one result per detected beat. Those results land here: ONE DETECTED
 * BEAT = ONE DOCUMENT.
 *
 * ── Why this is a separate collection from Reading.pqrst ──────────────────
 *
 * `Reading.pqrst` holds the FIRMWARE's own PQRST, parsed from the device frame
 * (see utils/rPeakIngest.framePqrst). The two are different measurements from
 * different analysers and must not be conflated:
 *
 *   Reading.pqrst      -> legacy/firmware analysis, per ECG sample row
 *   EcgBeatAnalysis    -> app analysis, per detected beat
 *
 * Storing the app's result on a Reading would also force a choice between
 * writing it to one arbitrary sample row or copying it across all N samples of
 * a frame. The second would multiply one measurement into N and bias anything
 * that averages the column; the first would make the beat's identity depend on
 * which sample happened to be first. A beat is its own thing, so it gets its
 * own document.
 *
 * ── Beat identity ─────────────────────────────────────────────────────────
 *
 * `sessionId + rSampleIndex` identifies a beat uniquely: the index of the R
 * peak within the session's own sample stream. A re-upload of the same beat
 * therefore updates that document rather than adding a second one, which
 * matters because an app that retries after a dropped response would otherwise
 * double every beat in the recording.
 *
 * ── No ECG-derived heart rate ─────────────────────────────────────────────
 *
 * This model deliberately carries NO heart-rate field. Heart rate stays where
 * it already is: `Reading.hr`, from the MAX30102. Deriving a second HR here
 * would create two numbers for one quantity with no rule for which wins.
 */
const ecgBeatAnalysisSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true },
    userId: { type: String, required: true },
    deviceId: { type: String, required: true },
    clientId: { type: String, default: 'CLIENT-001' },

    /**
     * Index of the R peak within the session's ECG sample stream, as the app
     * counted it. Half of the beat's identity - see the class comment.
     */
    rSampleIndex: { type: Number, required: true },

    /**
     * Device SEQ of the R-peak sample, when the app knows it. Null-safe: SEQ
     * comes from the firmware frame, and a frame may arrive without one, in
     * which case the beat is still identified by rSampleIndex.
     */
    rSeq: { type: Number, default: null },

    /**
     * Sample indexes of the OTHER four landmarks, in the same stream and the
     * same counting as rSampleIndex.
     *
     * Stored because an amplitude cannot say WHERE a landmark sits. Without
     * these, a chart replaying a stored session must re-find P/Q/S/T itself
     * from the intervals - a second, weaker detector whose answer can
     * disagree with the numbers stored beside it. With them, the markers land
     * on exactly the samples the intervals were measured from.
     *
     * Individually nullable: the app reports only landmarks it actually
     * located, and a wave it could not find stays absent rather than guessed.
     */
    pSampleIndex: { type: Number, default: null },
    qSampleIndex: { type: Number, default: null },
    sSampleIndex: { type: Number, default: null },
    tSampleIndex: { type: Number, default: null },

    /** Wall-clock instant of the R peak, as the app recorded it. */
    timestamp: { type: String, default: null },

    /**
     * The sample rate the app used to convert sample counts into milliseconds.
     * Stored because it is what makes prMs/qrsMs/qtMs meaningful: the same beat
     * analysed at a different assumed rate yields different intervals, so the
     * rate is part of the result, not context.
     */
    sampleRateHz: { type: Number, default: null },

    /**
     * PQRST as the APP measured it. P/Q/R/S/T are amplitudes in the app's own
     * units; the *Ms fields are milliseconds.
     *
     * Every field defaults to null and stays null when the app reports the
     * beat's morphology as invalid - nothing is fabricated to fill the shape.
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

    /**
     * RR interval to the PREVIOUS beat, in ms. Null on the first beat of a
     * recording and whenever the app reports it as invalid - a beat with no
     * measurable predecessor has no RR, and inventing one would create an
     * interval the analyser never measured.
     */
    rrMs: { type: Number, default: null },

    /**
     * The app's own verdicts. Tri-state: null means the app did not say, false
     * means it said the value is not trustworthy. Collapsing those two would
     * lose the difference between "not reported" and "reported as invalid".
     */
    pqrstValid: { type: Boolean, default: null },
    rrValid: { type: Boolean, default: null },
  },
  { timestamps: true }
);

// Beat identity. Unique, so a retried upload updates the beat instead of
// duplicating it.
ecgBeatAnalysisSchema.index({ sessionId: 1, rSampleIndex: 1 }, { unique: true });
// The read path: every beat of a session, in the order they occurred.
ecgBeatAnalysisSchema.index({ sessionId: 1, timestamp: 1 });
ecgBeatAnalysisSchema.index({ userId: 1 });
ecgBeatAnalysisSchema.index({ clientId: 1 });

module.exports = mongoose.model('EcgBeatAnalysis', ecgBeatAnalysisSchema);
