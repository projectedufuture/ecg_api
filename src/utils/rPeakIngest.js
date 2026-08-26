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
function parseDeviceFrame(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;

  // Drop a leading timestamp/direction prefix such as "[15:50:31.460] RX: ".
  const body = raw
    .replace(/^\s*\[[^\]]*\]\s*/, '')
    .replace(/^\s*(?:RX|TX)\s*:\s*/i, '');

  const fields = {};
  for (const pair of body.split(',')) {
    const idx = pair.indexOf(':');
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim().toUpperCase();
    const value = pair.slice(idx + 1).trim();
    if (key) fields[key] = value;
  }

  // ECG is the one field a reading cannot do without.
  const ecgValue = toSignedNumber(fields.ECG);
  if (ecgValue === null) return null;

  // Map the frame onto the canonical field names the ingest path already uses,
  // then let the existing normalisers apply the sentinel and lead rules - so a
  // raw frame and an equivalent JSON body reach the database identically.
  const mapped = {
    ecgValue,
    hr: fields.HR,
    spo2: fields.SPO2,
    temperature: fields.TEMP,
    LEAD: fields.LEAD,
    BEAT: fields.BEAT,
    RR: fields.RR,
    QUALITY: fields.QUALITY,
    IR: fields.IR,
    RED: fields.RED,
    R_TIME: fields.R_TIME ?? fields.RTIME,
    beatConfidence: fields.CONF ?? fields.CONFIDENCE,
  };

  const vitals = normalizeVitals(mapped);
  const temperature = toSignedNumber(fields.TEMP);

  return {
    ecgValue,
    // Vitals keep the 0 = not-measured convention of the stored schema; the
    // analysis layer converts those to null when loading.
    hr: vitals.hr ?? 0,
    spo2: vitals.spo2 ?? 0,
    temperature: temperature !== null ? temperature : 0,
    ...normalizeBeatFields(mapped),
  };
}

module.exports = {
  parseDeviceFrame,
  normalizeBeatFields,
  normalizeVitals,
  resolveLeadOff,
  toBool,
  toFiniteNumber,
  toSignedNumber,
  LEAD_ONE_MEANS_CONNECTED,
  SENTINELS,
};
