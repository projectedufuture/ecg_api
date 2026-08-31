/**
 * Normalisation of the device's per-sample signal fields on an inbound reading.
 *
 * Shared by the two ingest paths (POST /api/app/readings and POST
 * /api/app/sync) so both accept exactly the same payload shape.
 *
 * Device frame (unchanged fields omitted):
 *   ECG:<sample>      -> ecgValue        (handled by the caller)
 *   HR:<bpm>          -> hr              (0 = sentinel, see SENTINELS below)
 *   TEMP:<celsius>    -> temperatureCelsius
 *   LEAD:<0|1>        -> leadOff         (see LEAD_SEMANTICS below)
 *   BEAT:<0|1>        -> beat
 *   SPO2:<percent>    -> spo2            (0 = sentinel)
 *   RR:<ms>           -> rrIntervalMs    (last known RR, NOT a new interval)
 *   QUALITY:<0|1>     -> ecgQuality
 *   IR / RED          -> ppgIr / ppgRed  (raw PPG, when the firmware sends it)
 *
 * JSON equivalents accepted per reading:
 *   { "beat": true, "rPeakTimestamp": 125430, "beatConfidence": 0.94,
 *     "leadOff": false, "rrIntervalMs": 522, "ecgQuality": 1,
 *     "ppgIr": 123456, "ppgRed": 112345 }
 *
 * Everything is optional and additive: firmware that does not send a field
 * leaves it null/false, and the downstream analysis treats it as unavailable
 * rather than as a measurement.
 */

/**
 * LEAD_SEMANTICS — a documented assumption, not a confirmed fact.
 *
 * The sample frame `LEAD:1, BEAT:1` shows a beat being detected while LEAD is 1,
 * which only makes sense if 1 means "electrode connected". A bare `LEAD` field
 * is therefore read as lead-ON. If the firmware actually uses 1 = lead-OFF, flip
 * this one constant and the whole pipeline follows.
 *
 * Unambiguous field names (`leadOff`, `LEAD_OFF`, `leadOn`) always win over the
 * bare `LEAD`, so an integrator can bypass the assumption entirely.
 */
const LEAD_ONE_MEANS_CONNECTED = true;

/**
 * SENTINELS — values the firmware uses to mean "not measured".
 *
 * `HR:0` and `SPO2:0` are not a zero heart rate and not 0% saturation; they mean
 * the sensor had no reading. `RR:-1` likewise. These are stored as null so that
 * no downstream average can be dragged toward zero by them.
 *
 * NOTE: this reflects the documented behaviour of the current firmware sample.
 * Confirm against the firmware source before relying on it for a new device.
 */
const SENTINELS = {
  HR_ZERO: 0,
  SPO2_ZERO: 0,
  RR_NEGATIVE: -1,
};

/**
 * Tri-state flag: true, false, or null for "the firmware did not say".
 *
 * Distinct from toBool, which collapses an absent flag to false. For a validity
 * flag that difference is the whole point: "the device rejected this beat" and
 * "the device did not tell us" must not be stored as the same thing.
 */
function toTriStateBool(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === '1' || v === 'true' || v === 'yes' || v === 'valid') return true;
    if (v === '0' || v === 'false' || v === 'no' || v === 'invalid') return false;
    return null;
  }
  return null;
}

/** Coerce the loose truthy forms firmware uses (1, "1", true) to a boolean. */
function toBool(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true';
  return false;
}

/** Finite, non-negative number or null. */
function toFiniteNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Finite number of any sign, or null. */
function toSignedNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve the lead state from whichever field the firmware supplied.
 * Returns true when the electrode is off / poorly attached.
 */
function resolveLeadOff(r) {
  if (r.leadOff !== undefined) return toBool(r.leadOff);
  if (r.LEAD_OFF !== undefined) return toBool(r.LEAD_OFF);
  if (r.leadOn !== undefined) return !toBool(r.leadOn);
  if (r.LEAD !== undefined || r.lead !== undefined) {
    const one = toBool(r.LEAD ?? r.lead);
    return LEAD_ONE_MEANS_CONNECTED ? !one : one;
  }
  // Nothing reported: assume the electrode was attached, since the sample
  // exists at all. Quality gating still applies downstream.
  return false;
}

/**
 * Extract the beat / signal fields from one inbound reading.
 *
 * @param {object} r One raw reading from the request body.
 * @returns {object} Normalised fields ready to store on a Reading.
 */
function normalizeBeatFields(r) {
  const rPeakTimestamp = toFiniteNumber(r.rPeakTimestamp ?? r.rTime ?? r.R_TIME);

  /**
   * A beat is a NEW R-peak event, not merely a packet that carries an RR value.
   *
   * The device repeats its last known `RR` on every packet, so `BEAT:0, RR:522`
   * must not append another 522 ms interval — doing so would flood the RR
   * sequence with duplicates and corrupt every rhythm and HRV statistic. Only an
   * explicit BEAT flag (or a precise R-peak timestamp) marks a new beat.
   */
  const beat = toBool(r.beat ?? r.BEAT) || rPeakTimestamp !== null;

  const confidence = toFiniteNumber(r.beatConfidence ?? r.confidence);

  // Device-reported RR. Retained for cross-checking and for firmware that sends
  // RR without an R-peak clock; it is NOT itself treated as a new interval.
  const rawRr = toSignedNumber(r.rrIntervalMs ?? r.rr ?? r.RR);
  const rrIntervalMs = rawRr !== null && rawRr > SENTINELS.RR_NEGATIVE && rawRr > 0 ? rawRr : null;

  // Device ECG quality flag. 0 means the firmware considers the ECG unusable.
  const ecgQuality = toSignedNumber(r.ecgQuality ?? r.quality ?? r.QUALITY);

  // Raw PPG. Required for PPG-derived respiration; the SpO2 percentage alone
  // cannot substitute for it.
  const ppgIr = toFiniteNumber(r.ppgIr ?? r.ir ?? r.IR);
  const ppgRed = toFiniteNumber(r.ppgRed ?? r.red ?? r.RED);

  // Packet counter. The one field that makes transmission loss detectable, so
  // it is read from every spelling the firmware might use.
  const seq = toFiniteNumber(r.seq ?? r.SEQ ?? r.sequence ?? r.SEQUENCE);

  // Raw and filtered ECG, kept apart. ecgValue (set by the caller) stays the
  // primary sample; these record which of the two it came from.
  const ecgRaw = toSignedNumber(r.ecgRaw ?? r.ECG_RAW ?? r.ecg_raw);
  const ecgFiltered = toSignedNumber(r.ecgFiltered ?? r.ECG_FILTERED ?? r.ecg_filtered);

  // The device's own verdicts, stored as reported. Tri-state, so "not reported"
  // is never conflated with "reported as invalid".
  const beatValid = toTriStateBool(r.beatValid ?? r.BEAT_VALID);
  const rrValid = toTriStateBool(r.rrValid ?? r.RR_VALID);
  const hrEcgValid = toTriStateBool(r.hrEcgValid ?? r.HR_ECG_VALID);
  const pqrstValid = toTriStateBool(r.pqrstValid ?? r.PQRST_VALID);

  // Instantaneous vs averaged HR. An average hides exactly the beat-to-beat
  // variation the RR analysis exists to measure, so they are not merged.
  const hrInstantRaw = toSignedNumber(r.hrInstant ?? r.HR_INSTANT);
  const hrAvgRaw = toSignedNumber(r.hrAvg ?? r.HR_AVG);

  const rejectReasonRaw = r.rejectReason ?? r.REJECT_REASON ?? r.reject_reason ?? null;
  const rejectReason =
    typeof rejectReasonRaw === 'string' && rejectReasonRaw.trim()
      ? rejectReasonRaw.trim().slice(0, 200)
      : null;

  return {
    beat,
    rPeakTimestamp,
    // Confidence is a 0..1 probability; anything outside that is discarded
    // rather than silently clamped.
    beatConfidence: confidence !== null && confidence <= 1 ? confidence : null,
    leadOff: resolveLeadOff(r),
    rrIntervalMs,
    ecgQuality: ecgQuality !== null && ecgQuality >= 0 ? ecgQuality : null,
    ppgIr,
    ppgRed,

    seq,
    ecgRaw,
    ecgFiltered,
    beatValid,
    rrValid,
    hrEcgValid,
    pqrstValid,
    // HR:0 is the "not measured" sentinel here too.
    hrInstant: hrInstantRaw !== null && hrInstantRaw > SENTINELS.HR_ZERO ? hrInstantRaw : null,
    hrAvg: hrAvgRaw !== null && hrAvgRaw > SENTINELS.HR_ZERO ? hrAvgRaw : null,
    rejectReason,
  };
}

/**
 * Normalise the sentinel-bearing vitals.
 *
 * Returns null for "not measured" so callers can decide whether to store 0 (for
 * backward compatibility with the existing schema defaults) or null.
 */
function normalizeVitals(r) {
  const hrRaw = toSignedNumber(r.hr ?? r.HR);
  const spo2Raw = toSignedNumber(r.spo2 ?? r.SPO2);

  return {
    hr: hrRaw !== null && hrRaw > SENTINELS.HR_ZERO ? hrRaw : null,
    spo2: spo2Raw !== null && spo2Raw > SENTINELS.SPO2_ZERO ? spo2Raw : null,
  };
}

/**
 * Parse one raw device frame into a canonical reading object.
 *
 * The device emits comma-separated KEY:value pairs, e.g.
 *
 *   ECG:1343,HR:0,TEMP:30.84,LEAD:1,BEAT:0,SPO2:0,RR:521,QUALITY:1
 *
 * Accepting the raw line server-side means the frame format is understood in
 * exactly ONE place. The alternative - every app build parsing it - puts a
 * second, divergent parser in the field, and a firmware field rename then
 * silently drops data instead of failing loudly.
 *
 * Tolerates a log prefix ("RX: "), stray whitespace, lower-case keys, and
 * unknown keys (ignored, so new firmware fields never break ingestion).
 * Returns null when there is no parsable ECG sample, since a reading without
 * one is not a reading.
 *
 * @param {string} raw One frame line.
 * @returns {object|null} Canonical reading fields, or null if unparsable.
 */
/**
 * Split one device frame into its field map and its ECG sample block.
 *
 * The current firmware batches ECG: N samples follow a single ECG key,
 * comma-separated, e.g.
 *
 *   N:5,RATE_HZ:128,SEQ_START:10240,ECG_FILTERED:1342,1351,1349,1338,1330,HR:72,...
 *
 * Splitting the frame on commas FIRST is fatal here - samples 2..N are bare
 * numbers with no colon, so a KEY:VALUE loop drops them and keeps only the
 * first. The sample block is therefore lifted out BEFORE the CSV split, by
 * finding the ECG key and taking everything up to the next KEY: token. That
 * also makes the extraction independent of the separator the firmware chooses
 * between samples.
 */
const ECG_KEY_RE = /\b(ECG_FILTERED|ECG_RAW|ECGFILTERED|ECGRAW|ECG_FILT|ECG)\s*:/i;
// The next field key, which is where the sample block ends.
const NEXT_KEY_RE = /[A-Za-z_][A-Za-z0-9_]*\s*:/;
// Anything that cannot be part of a number separates two samples.
const SAMPLE_SEP_RE = /[^0-9eE+\-.]+/;

function splitFrame(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;

  // Drop a leading timestamp/direction prefix such as "[15:50:31.460] RX: ".
  const body = raw
    .replace(/^\s*\[[^\]]*\]\s*/, '')
    .replace(/^\s*(?:RX|TX)\s*:\s*/i, '');

  let remainder = body;
  let ecgKind = null;
  const samples = [];

  const keyMatch = ECG_KEY_RE.exec(body);
  if (keyMatch) {
    const keyName = keyMatch[1].toUpperCase();
    ecgKind = keyName === 'ECG' ? 'legacy' : keyName.includes('FILT') ? 'filtered' : 'raw';

    const valueStart = keyMatch.index + keyMatch[0].length;
    const after = body.slice(valueStart);
    const next = NEXT_KEY_RE.exec(after);
    const valueEnd = next === null ? body.length : valueStart + next.index;
    const block = body.slice(valueStart, valueEnd);

    for (const token of block.split(SAMPLE_SEP_RE)) {
      if (!token) continue;
      const v = Number(token);
      if (Number.isFinite(v)) samples.push(v);
    }

    // Excise the block, key included, so the CSV loop below never sees the
    // bare sample numbers and cannot mis-parse one as a field.
    remainder = body.slice(0, keyMatch.index) + body.slice(valueEnd);
  }

  const fields = {};
  for (const pair of remainder.split(',')) {
    const idx = pair.indexOf(':');
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim().toUpperCase();
    const value = pair.slice(idx + 1).trim();
    if (key) fields[key] = value;
  }

  return { fields, samples, ecgKind };
}

/**
 * Everything a frame says that is NOT the ECG samples themselves.
 *
 * These are per-FRAME values: one HR, one temperature, one BEAT flag covering
 * the whole batch. They are not per-sample measurements and must not be
 * multiplied into one reading per sample as though they were.
 */
function frameMetadata(split) {
  const { fields, samples } = split;

  const declaredCount = toFiniteNumber(fields.N);
  const rateHz = toFiniteNumber(fields.RATE_HZ ?? fields.RATEHZ ?? fields.FS);
  // SEQ_START is the sequence number of the FIRST sample in the batch. A
  // legacy one-sample frame uses a bare SEQ, which means the same thing.
  const seqStart = toFiniteNumber(fields.SEQ_START ?? fields.SEQSTART ?? fields.SEQ);

  return {
    seqStart,
    rateHz,
    declaredCount,
    sampleCount: samples.length,
    // N is a checksum on the extraction, not a truncation rule. Discarding
    // real decoded samples to satisfy a header would be worse than the
    // mismatch, so the disagreement is reported and every sample kept.
    countMismatch:
      declaredCount !== null && samples.length > 0 && declaredCount !== samples.length,
    ecgKind: split.ecgKind,
  };
}

/**
 * PQRST morphology as the device reported it.
 *
 * The firmware leaves the PREVIOUS beat's values in the frame when
 * PQRST_VALID is 0, so the flag has to gate them: without that, a stale
 * complex would be attributed to the current beat.
 */
function framePqrst(fields) {
  const valid = toTriStateBool(fields.PQRST_VALID ?? fields.PQRSTVALID);
  if (valid !== true) return { pqrstValid: valid, pqrst: null };
  return {
    pqrstValid: true,
    pqrst: {
      p: toSignedNumber(fields.P),
      q: toSignedNumber(fields.Q),
      r: toSignedNumber(fields.R),
      s: toSignedNumber(fields.S),
      t: toSignedNumber(fields.T),
      prMs: toSignedNumber(fields.PR),
      qrsMs: toSignedNumber(fields.QRS),
      qtMs: toSignedNumber(fields.QT),
      qtcMs: toSignedNumber(fields.QTC),
    },
  };
}

/** The per-frame fields, mapped onto the canonical reading names. */
function mappedFrameFields(fields, ecgRaw, ecgFiltered, ecgValue) {
  return {
    ecgValue,
    ecgRaw,
    ecgFiltered,
    hr: fields.HR ?? fields.HR_INSTANT,
    HR_INSTANT: fields.HR_INSTANT ?? fields.HR,
    HR_AVG: fields.HR_AVG,
    spo2: fields.SPO2 ?? fields.SP02,
    temperature: fields.TEMP,
    LEAD: fields.LEAD,
    BEAT: fields.BEAT,
    BEAT_VALID: fields.BEAT_VALID,
    RR: fields.RR,
    RR_VALID: fields.RR_VALID,
    HR_ECG_VALID: fields.HR_ECG_VALID,
    PQRST_VALID: fields.PQRST_VALID ?? fields.PQRSTVALID,
    REJECT_REASON: fields.REJECT_REASON ?? fields.REJECT,
    QUALITY: fields.QUALITY,
    IR: fields.IR,
    RED: fields.RED,
    R_TIME: fields.R_TIME ?? fields.RTIME,
    beatConfidence: fields.CONF ?? fields.CONFIDENCE,
  };
}

/**
 * Expand one device frame into ONE READING PER ECG SAMPLE.
 *
 * A batched frame carries N samples but only one set of vitals. Each sample
 * becomes its own row so that:
 *   - every sample gets its own SEQ (SEQ_START + i), which is what makes
 *     transmission gaps detectable per sample rather than per frame, and
 *   - the waveform keeps every sample the device actually sent.
 *
 * Per-sample timestamps are DERIVED from the frame's arrival time and the
 * device's declared RATE_HZ. That is arithmetic on values the device reported,
 * not invented data - but it is also not a measured per-sample clock, so it is
 * only as good as RATE_HZ. Without a rate, every sample in the frame shares
 * the frame timestamp rather than being spread over a guessed interval.
 *
 * The per-frame vitals (HR, TEMP, SPO2, BEAT, RR, PQRST) are attached ONLY to
 * the first sample of the batch. Repeating them on all N rows would multiply
 * one measurement into N and bias every average that reads those columns.
 *
 * @param {string} raw One frame.
 * @param {string} frameTimestamp ISO timestamp for the frame.
 * @returns {Array|null} Reading objects, or null if the frame carried no ECG.
 */
function expandDeviceFrame(raw, frameTimestamp) {
  const split = splitFrame(raw);
  if (!split) return null;

  const { fields, samples } = split;
  const meta = frameMetadata(split);

  if (!samples.length) return null;

  const baseMs = Date.parse(frameTimestamp);
  const haveBase = Number.isFinite(baseMs);
  const stepMs = meta.rateHz && meta.rateHz > 0 ? 1000 / meta.rateHz : 0;

  const rows = [];
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i];

    // Which column the sample belongs in depends on what the device called it.
    const ecgRaw = meta.ecgKind === 'filtered' ? null : sample;
    const ecgFiltered = meta.ecgKind === 'filtered' ? sample : null;

    // Only the first row of a batch carries the frame's vitals and flags.
    const perFrame = i === 0 ? mappedFrameFields(fields, ecgRaw, ecgFiltered, sample) : null;

    const row = {
      ecgValue: sample,
      ecgRaw,
      ecgFiltered,
      seq: meta.seqStart === null ? null : meta.seqStart + i,
      timestamp: haveBase
        ? new Date(baseMs + Math.round(i * stepMs)).toISOString()
        : frameTimestamp,
      sampleRateHz: meta.rateHz,
      frameSampleCount: samples.length,
      frameSampleIndex: i,
    };

    if (perFrame) {
      const vitals = normalizeVitals(perFrame);
      const { pqrstValid, pqrst } = framePqrst(fields);
      Object.assign(row, {
        hr: vitals.hr ?? 0,
        spo2: vitals.spo2 ?? 0,
        temperature: toSignedNumber(fields.TEMP) ?? 0,
        ...normalizeBeatFields(perFrame),
        pqrstValid,
        pqrst,
      });
    } else {
      // A sample with no vitals of its own. Zeros here are the schema's
      // "not reported" defaults, not measurements - the analysis layer
      // already treats 0 in these columns as absent.
      Object.assign(row, {
        hr: 0,
        spo2: 0,
        temperature: 0,
        ...normalizeBeatFields({}),
      });
    }

    // Restored AFTER the spreads: normalizeBeatFields derives seq/ecgRaw/
    // ecgFiltered from the object it is given, which for a batched frame does
    // not carry this sample's own values - so its nulls would overwrite them.
    row.seq = meta.seqStart === null ? null : meta.seqStart + i;
    row.ecgRaw = ecgRaw;
    row.ecgFiltered = ecgFiltered;
    row.ecgValue = sample;

    rows.push(row);
  }

  rows.frameMeta = meta;
  return rows;
}

/**
 * Parse one device frame into a single reading.
 *
 * Kept for callers that want one row: it returns the FIRST sample of the frame.
 * Anything ingesting a batched stream must use expandDeviceFrame instead, or it
 * silently discards samples 2..N.
 *
 * @param {string} raw One frame line.
 * @returns {object|null} Canonical reading fields, or null if unparsable.
 */
function parseDeviceFrame(raw) {
  const rows = expandDeviceFrame(raw, null);
  if (!rows || !rows.length) return null;
  const first = { ...rows[0] };
  // The single-row form has no frame position to report.
  delete first.frameSampleCount;
  delete first.frameSampleIndex;
  delete first.timestamp;
  return first;
}

module.exports = {
  parseDeviceFrame,
  expandDeviceFrame,
  splitFrame,
  frameMetadata,
  normalizeBeatFields,
  toTriStateBool,
  normalizeVitals,
  resolveLeadOff,
  toBool,
  toFiniteNumber,
  toSignedNumber,
  LEAD_ONE_MEANS_CONNECTED,
  SENTINELS,
};
