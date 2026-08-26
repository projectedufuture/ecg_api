const config = require('../config/env');
const Reading = require('../models/Reading');
const Session = require('../models/Session');
const EcgRrAnalysis = require('../models/EcgRrAnalysis');
const EcgRrEvent = require('../models/EcgRrEvent');
const HrvAnalysis = require('../models/HrvAnalysis');
const RhythmAnalysis = require('../models/RhythmAnalysis');
const RhythmEvent = require('../models/RhythmEvent');
const RespirationAnalysis = require('../models/RespirationAnalysis');
const { analyseEcgRr, prepareNnSequence } = require('../utils/ecgRrAnalysis');
const { analyseHrv, HRV_THRESHOLDS } = require('../utils/hrvAnalysis');
const Spo2Analysis = require('../models/Spo2Analysis');
const Spo2Event = require('../models/Spo2Event');
const TemperatureAnalysis = require('../models/TemperatureAnalysis');
const TemperatureEvent = require('../models/TemperatureEvent');
const CombinedAnalysis = require('../models/CombinedAnalysis');
const { screenRhythm } = require('../utils/rhythmScreening');
const { analyseRespiration } = require('../utils/respirationAnalysis');
const { analyseSpo2 } = require('../utils/spo2Analysis');
const { analyseTemperature } = require('../utils/temperatureAnalysis');
const { analyseCombined } = require('../utils/combinedAnalysis');

/**
 * Orchestration layer between the stored readings and the pure analysis engine.
 *
 * Split of responsibility:
 *   utils/ecgRrAnalysis.js - all maths, no I/O (unit tested).
 *   this file              - load R peaks, persist the result, serve the report.
 */

/**
 * Load the session's R peaks in recording order.
 *
 * Only readings the device flagged as a beat are fetched, which is a small
 * fraction of the sample stream (roughly one row per heartbeat), so this stays
 * cheap even for long recordings.
 *
 * `rPeakTimestamp` is the device's monotonic clock. When the firmware reports a
 * beat without one, the reading's own ISO timestamp is converted to epoch ms so
 * the beat still contributes an interval - this reuses the existing session
 * timestamp architecture rather than inventing a second clock.
 */
async function loadRPeaks(sessionId) {
  const rows = await Reading.find({ sessionId, beat: true })
    .select('timestamp rPeakTimestamp beatConfidence leadOff')
    .sort({ rPeakTimestamp: 1, timestamp: 1 })
    .lean();

  return rows.map((row) => {
    let peakMs = row.rPeakTimestamp;

    if (peakMs === null || peakMs === undefined) {
      const parsed = row.timestamp ? new Date(row.timestamp).getTime() : NaN;
      peakMs = Number.isFinite(parsed) ? parsed : null;
    }

    return {
      rPeakTimestamp: peakMs,
      timestamp: row.timestamp || null,
      confidence: row.beatConfidence ?? null,
      leadOff: row.leadOff === true,
    };
  });
}

/**
 * Load the session's raw PPG waveform, if the firmware recorded one.
 *
 * PPG-derived respiration needs the IR/RED sample stream; the stored SpO2
 * percentage carries no waveform and is deliberately not used as a substitute.
 * Returns an empty array when no raw PPG exists, which the respiration engine
 * reports as an explicit unavailable reason.
 */
async function loadPpgSamples(sessionId) {
  const rows = await Reading.find({ sessionId, ppgIr: { $ne: null } })
    .select('timestamp ppgIr')
    .sort({ timestamp: 1 })
    .limit(200000)
    .lean();

  if (!rows.length) return [];

  const base = new Date(rows[0].timestamp).getTime();
  return rows
    .map((row) => {
      const ms = new Date(row.timestamp).getTime();
      if (!Number.isFinite(ms)) return null;
      return { t: (ms - base) / 1000, value: row.ppgIr };
    })
    .filter(Boolean);
}

/**
 * Load the session's vitals rows — one entry per reading, in time order.
 *
 * SpO2 and temperature live on the reading rows themselves rather than on the
 * R-peak subset, so they need their own loader. Loaded ONCE and shared by the
 * SpO2, temperature and combined analyses, so all three describe the same rows.
 *
 * `t` is seconds from the first reading, matching the offset convention the
 * other modules use. Sentinel values are left as-is here and filtered by each
 * engine, so each one can report its own exclusion count.
 */
async function loadVitalsRows(sessionId) {
  const rows = await Reading.find({ sessionId })
    .select('timestamp spo2 temperatureCelsius hr ecgQuality leadOff')
    .sort({ timestamp: 1 })
    .limit(200000)
    .lean();

  if (!rows.length) return [];

  const base = new Date(rows[0].timestamp).getTime();
  return rows
    .map((row) => {
      const ms = new Date(row.timestamp).getTime();
      if (!Number.isFinite(ms)) return null;
      return {
        t: (ms - base) / 1000,
        timestamp: row.timestamp,
        // SPO2:0 is the "not measured" sentinel, so it becomes null here.
        spo2: Number.isFinite(row.spo2) && row.spo2 > 0 ? row.spo2 : null,
        tempC: Number.isFinite(row.temperatureCelsius) ? row.temperatureCelsius : null,
        ecgQuality: row.ecgQuality ?? null,
        leadOff: row.leadOff === true,
      };
    })
    .filter(Boolean);
}

/**
 * Recalculate and persist the ECG/RR analysis for one session.
 *
 * Idempotent (PART 30): the analysis document is upserted on its unique
 * sessionId and the session's events are replaced wholesale, so running this
 * twice on unchanged readings produces the same stored state.
 *
 * @param {string} sessionId
 * @param {object} [sessionDoc] Pre-fetched session, to save a round trip.
 * @returns {Promise<object|null>} The persisted analysis document, or null when
 *   the session does not exist.
 */
async function recalculateSessionAnalysis(sessionId, sessionDoc = null) {
  const session = sessionDoc || (await Session.findOne({ id: sessionId }).lean());
  if (!session) return null;

  const rPeaks = await loadRPeaks(sessionId);

  // The session's own duration (stored in whole minutes) is the authoritative
  // recording length when it is set; otherwise the engine measures the span
  // between the first and last R peak.
  const durationSec = session.duration > 0 ? session.duration * 60 : undefined;

  // Validate the heartbeat sequence ONCE and feed both reports from it, so the
  // ECG/RR and HRV numbers can never describe different sets of beats.
  const prepared = prepareNnSequence(rPeaks);
  const result = analyseEcgRr(prepared, { recordingDurationSec: durationSec });

  const doc = {
    sessionId,
    userId: session.userId,
    deviceId: session.deviceId,
    clientId: session.clientId || 'CLIENT-001',

    available: result.available,
    unavailableReason: result.unavailableReason,
    unavailableMessage: result.unavailableMessage,

    recordingDurationSec: result.recordingDurationSec ?? null,

    beatsDetected: result.counts.beatsDetected,
    validBeats: result.counts.validBeats,
    invalidBeats: result.counts.invalidBeats,
    usableBeatPercentage: result.counts.usablePercentage,

    meanRR: result.rr?.meanRR ?? null,
    minRR: result.rr?.minRR ?? null,
    maxRR: result.rr?.maxRR ?? null,
    rrStandardDeviation: result.rr?.sdRR ?? null,
    rrCoefficientVariation: result.rr?.cvPercent ?? null,

    meanHR: result.hr?.meanHR ?? null,
    minHR: result.hr?.minHR ?? null,
    maxHR: result.hr?.maxHR ?? null,

    meanAbsRrDifference: result.beatToBeat?.meanAbsDiffMs ?? null,
    maxAbsRrDifference: result.beatToBeat?.maxAbsDiffMs ?? null,
    beatToBeatVariation: result.beatToBeat?.variation || 'Unavailable',

    rhythmRegularity: result.rhythm?.regularity || 'Unavailable',
    longRREventCount: result.rhythm?.longRrEventCount ?? 0,

    signalQuality: result.signalQuality.status,

    patientSummary: result.patientSummary ?? null,
    technicalSummary: result.technicalSummary ?? null,

    series: result.series || [],
    analysedAt: new Date(),
  };

  const analysis = await EcgRrAnalysis.findOneAndUpdate({ sessionId }, doc, {
    new: true,
    upsert: true,
    setDefaultsOnInsert: true,
  }).lean();

  // Replace this session's events so a recalculation never accumulates
  // duplicates from a previous run.
  await EcgRrEvent.deleteMany({ sessionId });
  if (result.events.length) {
    await EcgRrEvent.insertMany(
      result.events.map((event) => ({
        sessionId,
        userId: session.userId,
        deviceId: session.deviceId,
        clientId: session.clientId || 'CLIENT-001',
        timestamp: event.timestamp,
        rPeakTimestamp: event.rPeakTimestamp,
        eventType: event.eventType,
        durationMs: event.durationMs,
        rrValue: event.rrValue,
        quality: event.quality,
        description: event.description,
      })),
      { ordered: false }
    );
  }

  // Every derived report consumes the same prepared sequence and is persisted in
  // the same pass, so they can never describe different sets of beats.
  await persistHrvAnalysis(session, prepared, durationSec);
  const rhythm = await persistRhythmAnalysis(session, prepared, durationSec, result.events || []);
  await persistRespirationAnalysis(session, prepared, durationSec);

  // Vitals rows are loaded once and shared by the three signal modules, so the
  // SpO2, temperature and combined reports all describe the same readings.
  const vitalsRows = await loadVitalsRows(sessionId);
  const spo2 = await persistSpo2Analysis(session, vitalsRows, durationSec);
  const temperature = await persistTemperatureAnalysis(session, vitalsRows, durationSec);
  await persistCombinedAnalysis(session, {
    vitalsRows,
    prepared,
    durationSec,
    spo2Events: spo2?.events || [],
    temperatureEvents: temperature?.events || [],
    rhythmEvents: rhythm?.events || [],
  });

  return analysis;
}

/**
 * The user's prior valid HRV results, newest first, for personal-baseline
 * comparison.
 *
 * Only successful analyses from *earlier* sessions of the same user are used —
 * never a population norm, and never the session being analysed.
 */
async function loadHrvBaselineSessions(session) {
  const priorSessions = await Session.find({
    userId: session.userId,
    id: { $ne: session.id },
    startTime: { $lt: session.startTime },
  })
    .select('id')
    .sort({ startTime: -1 })
    .limit(HRV_THRESHOLDS.BASELINE_MAX_SESSIONS * 3)
    .lean();

  if (!priorSessions.length) return [];

  const rows = await HrvAnalysis.find({
    sessionId: { $in: priorSessions.map((s) => s.id) },
    status: 'success',
  })
    .select('sessionId rmssdMs sdnnMs')
    .lean();

  // Preserve recency order from the session list.
  const bySession = new Map(rows.map((r) => [r.sessionId, r]));
  return priorSessions
    .map((s) => bySession.get(s.id))
    .filter(Boolean)
    .map((r) => ({ rmssdMs: r.rmssdMs, sdnnMs: r.sdnnMs }));
}

/** Compute and upsert the HRV result for a session from an already-prepared NN sequence. */
async function persistHrvAnalysis(session, prepared, recordingDurationSec) {
  const priorSessions = await loadHrvBaselineSessions(session);

  const hrv = analyseHrv(prepared, { recordingDurationSec, priorSessions });

  const doc = {
    sessionId: session.id,
    userId: session.userId,
    deviceId: session.deviceId,
    clientId: session.clientId || 'CLIENT-001',

    status: hrv.status,
    message: hrv.message,

    recordingDurationSec: hrv.recording.recordingDurationSec ?? null,
    analysisDurationSec: hrv.recording.analysisDurationSec ?? null,
    shortRecording: hrv.recording.shortRecording === true,
    ultraShortRecording: hrv.recording.ultraShortRecording === true,

    totalRRIntervals: hrv.counts.totalRRIntervals,
    validNNIntervals: hrv.counts.validNNIntervals,
    excludedIntervals: hrv.counts.excludedIntervals,
    usablePercentage: hrv.counts.usablePercentage,
    artifactPercentage: hrv.counts.artifactPercentage,
    successivePairs: hrv.counts.successivePairs || 0,
    successivePairsSkipped: hrv.counts.successivePairsSkipped || 0,

    meanNNMs: hrv.metrics?.meanNNMs ?? null,
    minNNMs: hrv.metrics?.minNNMs ?? null,
    maxNNMs: hrv.metrics?.maxNNMs ?? null,
    sdnnMs: hrv.metrics?.sdnnMs ?? null,
    rmssdMs: hrv.metrics?.rmssdMs ?? null,
    pnn50Percent: hrv.metrics?.pnn50Percent ?? null,

    quality: hrv.quality,
    ecgSignalQuality: hrv.ecgSignalQuality ?? null,

    personalBaselineAvailable: hrv.baseline?.available === true,
    baselineSessionsUsed: hrv.baseline?.sessionsUsed ?? 0,
    baselineRmssdMs: hrv.baseline?.baselineRmssdMs ?? null,
    baselineSdnnMs: hrv.baseline?.baselineSdnnMs ?? null,
    rmssdChangePercent: hrv.baseline?.rmssdChangePercent ?? null,
    baselineComparison: hrv.baseline?.comparison ?? null,

    patientSummary: hrv.patientSummary,
    technicalSummary: hrv.technicalSummary,

    series: hrv.series || [],
    analysedAt: new Date(),
  };

  return HrvAnalysis.findOneAndUpdate({ sessionId: session.id }, doc, {
    new: true,
    upsert: true,
    setDefaultsOnInsert: true,
  }).lean();
}

/** Compute and upsert rhythm screening from an already-prepared NN sequence. */
async function persistRhythmAnalysis(session, prepared, recordingDurationSec, ecgRrEvents) {
  const rhythm = screenRhythm(prepared, { recordingDurationSec, ecgRrEvents });

  const doc = {
    sessionId: session.id,
    userId: session.userId,
    deviceId: session.deviceId,
    clientId: session.clientId || 'CLIENT-001',

    status: rhythm.status,
    message: rhythm.message,

    rhythmPattern: rhythm.summary?.rhythmPattern || 'Unavailable',
    classificationConfidence: rhythm.summary?.classificationConfidence ?? null,
    rrCvPercent: rhythm.summary?.rrCvPercent ?? null,

    averageHR: rhythm.summary?.averageHR ?? null,
    minimumHR: rhythm.summary?.minimumHR ?? null,
    maximumHR: rhythm.summary?.maximumHR ?? null,

    analysedBeats: rhythm.summary?.analysedBeats ?? 0,
    recordingDurationSec: rhythm.summary?.recordingDurationSec ?? null,

    elevatedHRPeriods: rhythm.screening?.elevatedHRPeriods ?? 0,
    lowHRPeriods: rhythm.screening?.lowHRPeriods ?? 0,
    irregularRRPeriods: rhythm.screening?.irregularRRPeriods ?? 0,
    possibleLongRREvents: rhythm.screening?.possibleLongRREvents ?? 0,
    possibleMissedBeats: rhythm.screening?.possibleMissedBeats ?? 0,
    possibleDoubleDetections: rhythm.screening?.possibleDoubleDetections ?? 0,

    signalQuality: rhythm.signalQuality.status,
    usablePercentage: rhythm.signalQuality.usablePercentage,
    beatsDetected: rhythm.signalQuality.beatsDetected,
    validBeats: rhythm.signalQuality.validBeats,
    invalidBeats: rhythm.signalQuality.invalidBeats,

    patientSummary: rhythm.patientSummary,
    technicalSummary: rhythm.technicalSummary,
    analysedAt: new Date(),
  };

  const stored = await RhythmAnalysis.findOneAndUpdate({ sessionId: session.id }, doc, {
    new: true,
    upsert: true,
    setDefaultsOnInsert: true,
  }).lean();

  // Replace the session's rhythm events so a recalculation never duplicates.
  await RhythmEvent.deleteMany({ sessionId: session.id });
  if (rhythm.events.length) {
    await RhythmEvent.insertMany(
      rhythm.events.map((event) => ({
        sessionId: session.id,
        userId: session.userId,
        deviceId: session.deviceId,
        clientId: session.clientId || 'CLIENT-001',
        ...event,
      })),
      { ordered: false }
    );
  }

  // Events are returned alongside the stored document so the combined analysis
  // can look for concurrency without re-reading them.
  return { ...stored, events: rhythm.events };
}

/** Compute and upsert respiration from the prepared NN sequence plus raw PPG. */
async function persistRespirationAnalysis(session, prepared, recordingDurationSec) {
  const ppgSamples = await loadPpgSamples(session.id);
  const resp = analyseRespiration(prepared, { recordingDurationSec, ppgSamples });

  const edr = resp.ecgEstimate;
  const ppg = resp.ppgEstimate;

  const doc = {
    sessionId: session.id,
    userId: session.userId,
    deviceId: session.deviceId,
    clientId: session.clientId || 'CLIENT-001',

    status: resp.status,
    message: resp.message,

    finalRespirationRate: resp.summary.respirationRateBpm,
    unit: resp.summary.unit,
    confidence: resp.summary.confidence,
    basis: resp.summary.basis,
    withinPlausibleRange: resp.summary.plausibleRange,

    ecgRespirationRate: edr.available ? edr.rateBpm : null,
    ecgFreqHz: edr.available ? edr.freqHz : null,
    ecgProminence: edr.available ? edr.prominence : null,
    ecgQuality: edr.available ? edr.quality : 'Unavailable',
    ecgIntervalsUsed: edr.available ? edr.intervalsUsed : null,
    ecgUnavailableReason: edr.available ? null : edr.reason,
    ecgUnavailableDetail: edr.available ? null : edr.detail,

    ppgRespirationRate: ppg.available ? ppg.rateBpm : null,
    ppgFreqHz: ppg.available ? ppg.freqHz : null,
    ppgProminence: ppg.available ? ppg.prominence : null,
    ppgQuality: ppg.available ? ppg.quality : 'Unavailable',
    ppgSamplesUsed: ppg.available ? ppg.samplesUsed : null,
    ppgUnavailableReason: ppg.available ? null : ppg.reason,
    ppgUnavailableDetail: ppg.available ? null : ppg.detail,

    differenceBpm: resp.crossCheck.differenceBpm,
    agreementStatus: resp.crossCheck.status,

    recordingDurationSec: resp.recording.durationSec,
    analysedDurationSec: resp.recording.analysedDurationSec,
    artifactPercentage: resp.artifactPercentage,
    spectralResolutionBpm: edr.available ? edr.resolutionBpm : null,

    trend: resp.trend || [],

    patientSummary: resp.patientSummary,
    technicalSummary: resp.technicalSummary,
    analysedAt: new Date(),
  };

  return RespirationAnalysis.findOneAndUpdate({ sessionId: session.id }, doc, {
    new: true,
    upsert: true,
    setDefaultsOnInsert: true,
  }).lean();
}

/** Compute and upsert the SpO2 analysis from the shared vitals rows. */
async function persistSpo2Analysis(session, vitalsRows, recordingDurationSec) {
  const samples = vitalsRows.map((r) => ({ t: r.t, spo2: r.spo2, timestamp: r.timestamp }));
  const result = analyseSpo2(samples, { recordingDurationSec });

  const doc = {
    sessionId: session.id,
    userId: session.userId,
    deviceId: session.deviceId,
    clientId: session.clientId || 'CLIENT-001',

    status: result.status,
    message: result.message,

    meanPct: result.summary?.meanPct ?? null,
    medianPct: result.summary?.medianPct ?? null,
    minPct: result.summary?.minPct ?? null,
    maxPct: result.summary?.maxPct ?? null,
    sdPct: result.summary?.sdPct ?? null,

    desaturationEvents: result.summary?.desaturationEvents ?? 0,
    strictDesaturationEvents: result.summary?.strictDesaturationEvents ?? 0,
    recoveredDesaturations: result.summary?.recoveredDesaturations ?? 0,
    lowSaturationPeriods: result.summary?.lowSaturationPeriods ?? 0,

    timeBelow90Sec: result.summary?.timeBelow90Sec ?? null,
    timeBelow90Percent: result.summary?.timeBelow90Percent ?? null,
    timeBelow88Sec: result.summary?.timeBelow88Sec ?? null,
    timeBelow88Percent: result.summary?.timeBelow88Percent ?? null,

    stability: result.stability,

    totalSamples: result.counts.totalSamples,
    usableSamples: result.counts.usableSamples,
    excludedSamples: result.counts.excludedSamples,
    coveragePct: result.counts.coveragePct,
    analysedDurationSec: result.counts.analysedDurationSec,
    recordingDurationSec: result.counts.recordingDurationSec,

    patientSummary: result.patientSummary,
    technicalSummary: result.technicalSummary,
    series: result.series || [],
    analysedAt: new Date(),
  };

  const stored = await Spo2Analysis.findOneAndUpdate({ sessionId: session.id }, doc, {
    new: true,
    upsert: true,
    setDefaultsOnInsert: true,
  }).lean();

  await Spo2Event.deleteMany({ sessionId: session.id });
  if (result.events.length) {
    await Spo2Event.insertMany(
      result.events.map((event) => ({
        sessionId: session.id,
        userId: session.userId,
        deviceId: session.deviceId,
        clientId: session.clientId || 'CLIENT-001',
        ...event,
      })),
      { ordered: false }
    );
  }

  return { ...stored, events: result.events };
}

/** Compute and upsert the temperature analysis from the shared vitals rows. */
async function persistTemperatureAnalysis(session, vitalsRows, recordingDurationSec) {
  const samples = vitalsRows.map((r) => ({ t: r.t, tempC: r.tempC, timestamp: r.timestamp }));
  const result = analyseTemperature(samples, { recordingDurationSec });

  const doc = {
    sessionId: session.id,
    userId: session.userId,
    deviceId: session.deviceId,
    clientId: session.clientId || 'CLIENT-001',

    status: result.status,
    message: result.message,

    meanC: result.summary?.meanC ?? null,
    medianC: result.summary?.medianC ?? null,
    minC: result.summary?.minC ?? null,
    maxC: result.summary?.maxC ?? null,
    sdC: result.summary?.sdC ?? null,
    startC: result.summary?.startC ?? null,
    endC: result.summary?.endC ?? null,
    totalChangeC: result.summary?.totalChangeC ?? null,
    driftCPerMin: result.summary?.driftCPerMin ?? null,

    elevationEvents: result.summary?.elevationEvents ?? 0,
    depressionEvents: result.summary?.depressionEvents ?? 0,

    regime: result.regime,
    trend: result.trend,
    stability: result.stability,

    totalSamples: result.counts.totalSamples,
    usableSamples: result.counts.usableSamples,
    excludedSamples: result.counts.excludedSamples,
    coveragePct: result.counts.coveragePct,
    analysedDurationSec: result.counts.analysedDurationSec,
    recordingDurationSec: result.counts.recordingDurationSec,

    patientSummary: result.patientSummary,
    technicalSummary: result.technicalSummary,
    series: result.series || [],
    analysedAt: new Date(),
  };

  const stored = await TemperatureAnalysis.findOneAndUpdate({ sessionId: session.id }, doc, {
    new: true,
    upsert: true,
    setDefaultsOnInsert: true,
  }).lean();

  await TemperatureEvent.deleteMany({ sessionId: session.id });
  if (result.events.length) {
    await TemperatureEvent.insertMany(
      result.events.map((event) => ({
        sessionId: session.id,
        userId: session.userId,
        deviceId: session.deviceId,
        clientId: session.clientId || 'CLIENT-001',
        ...event,
      })),
      { ordered: false }
    );
  }

  return { ...stored, events: result.events };
}

/**
 * Compute and upsert the combined analysis.
 *
 * Takes the already-computed events from the other modules rather than
 * recomputing anything, so concurrency is judged against exactly the findings
 * those reports show.
 */
async function persistCombinedAnalysis(
  session,
  { vitalsRows, prepared, durationSec, spo2Events, temperatureEvents, rhythmEvents }
) {
  // HR at each accepted beat, timed from the first R peak.
  const firstRPeak = prepared.firstRPeak;
  const hrSeries =
    firstRPeak === null
      ? []
      : prepared.nn.map((entry) => ({
          t: (entry.rPeakTimestamp - firstRPeak) / 1000,
          hr: 60000 / entry.nnMs,
        }));

  const result = analyseCombined(
    {
      rows: vitalsRows,
      hrSeries,
      spo2Events,
      rhythmEvents,
      tempEvents: temperatureEvents,
    },
    { recordingDurationSec: durationSec }
  );

  const doc = {
    sessionId: session.id,
    userId: session.userId,
    deviceId: session.deviceId,
    clientId: session.clientId || 'CLIENT-001',

    status: result.status,
    message: result.message,

    relationships: result.relationships || [],
    concurrentEvents: result.concurrentEvents || [],

    rows: result.counts.rows,
    hrPresent: result.counts.hrPresent,
    spo2Present: result.counts.spo2Present,
    tempPresent: result.counts.tempPresent,
    analysedDurationSec: result.counts.analysedDurationSec,
    recordingDurationSec: result.counts.recordingDurationSec,

    patientSummary: result.patientSummary,
    technicalSummary: result.technicalSummary,
    series: result.series || [],
    analysedAt: new Date(),
  };

  return CombinedAnalysis.findOneAndUpdate({ sessionId: session.id }, doc, {
    new: true,
    upsert: true,
    setDefaultsOnInsert: true,
  }).lean();
}

/**
 * Mark a session's analysis as stale by dropping the stored result.
 *
 * Called when new readings arrive for a session that was already analysed (the
 * app can keep uploading batches after the recording was stopped). Dropping the
 * document is cheaper than re-analysing on every batch, and the next report
 * request recomputes from the complete set of readings.
 *
 * Failures are logged and swallowed - an upload must not fail because a cached
 * report could not be cleared.
 */
/**
 * Delete every stored report for a session, events included.
 *
 * Events are deleted alongside the analyses: leaving them behind would strand
 * rows that describe beats no analysis vouches for any more.
 */
async function deleteStoredReports(sessionId) {
  // All reports come from the same beats, so they all go stale together.
  await Promise.all([
    EcgRrAnalysis.deleteOne({ sessionId }),
    HrvAnalysis.deleteOne({ sessionId }),
    RhythmAnalysis.deleteOne({ sessionId }),
    RespirationAnalysis.deleteOne({ sessionId }),
    Spo2Analysis.deleteOne({ sessionId }),
    TemperatureAnalysis.deleteOne({ sessionId }),
    CombinedAnalysis.deleteOne({ sessionId }),
    EcgRrEvent.deleteMany({ sessionId }),
    RhythmEvent.deleteMany({ sessionId }),
    Spo2Event.deleteMany({ sessionId }),
    TemperatureEvent.deleteMany({ sessionId }),
  ]);
}

async function invalidateSessionAnalysis(sessionId) {
  try {
    await deleteStoredReports(sessionId);
    // The stored reports are gone, so generation is due again. Without this the
    // session would keep claiming "ready" while holding no reports at all.
    await Session.updateOne(
      { id: sessionId },
      { $set: { reportStatus: 'pending', reportGeneratedAt: null, reportError: null } }
    );
  } catch (error) {
    console.error(`Failed to invalidate derived analysis for session ${sessionId}:`, error);
  }
}

/**
 * Fire-and-forget recalculation for the ingest path.
 *
 * A failure here must never fail the request that triggered it (stopping a
 * recording, uploading readings), so it is logged and swallowed.
 */
async function recalculateSessionAnalysisSafe(sessionId, sessionDoc = null) {
  try {
    return await recalculateSessionAnalysis(sessionId, sessionDoc);
  } catch (error) {
    console.error(`ECG/RR analysis failed for session ${sessionId}:`, error);
    return null;
  }
}

/**
 * Generate every report for a finished session, recording the outcome on the
 * session itself.
 *
 * The plain "Safe" wrapper above swallows failures, which is right for keeping
 * a recording stoppable but leaves no trace: a generation crash then looks
 * exactly like "there was nothing to report". This records the state instead,
 * so the UI can distinguish the two and an operator can find the failures.
 *
 * Reports whose own data is insufficient still count as a SUCCESSFUL
 * generation - "ready" means the pipeline ran, not that every module produced
 * numbers. Whether an individual report is usable stays that report's own
 * `available`/`status` field.
 */
/**
 * True elapsed length of a recording, in seconds.
 *
 * Session.duration is stored in WHOLE MINUTES, so it cannot be used for this:
 * a 4 m 40 s recording rounds to 5 and would slip past a five-minute gate. The
 * start and end timestamps are the only honest source.
 *
 * Returns null when the timestamps are unusable, which is treated as "unknown"
 * rather than "zero" - refusing to generate on a parse failure would hide real
 * recordings.
 */
function sessionDurationSec(session) {
  if (!session) return null;
  const start = Date.parse(session.startTime);
  const end = Date.parse(session.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const sec = (end - start) / 1000;
  return sec >= 0 ? sec : null;
}

/**
 * Whether a recording is too short for reports to be generated at all.
 *
 * This is a product rule, not a statistical one: below this length the numbers
 * would be arithmetically computable but not meaningful, and showing them
 * invites a reader to trust a two-minute snapshot. A recording of unknown
 * length is NOT treated as too short - see sessionDurationSec.
 */
function isSessionTooShort(session) {
  const sec = sessionDurationSec(session);
  if (sec === null) return false;
  return sec < config.reports.minSessionDurationSec;
}

/**
 * Human-readable recording length, e.g. "2m 30s".
 */
function formatDurationShort(sec) {
  if (sec === null || sec === undefined) return 'unknown';
  const whole = Math.max(0, Math.round(sec));
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  if (m === 0) return `${s}s`;
  if (s === 0) return `${m}m`;
  return `${m}m ${s}s`;
}

/**
 * The response body for a recording too short to report on.
 *
 * Returned with HTTP 200, not an error: nothing went wrong, the recording is
 * simply below the length at which these reports mean anything. Sending a 500
 * here is what produced the "Unable to load" state that reads like a fault.
 *
 * It carries the same session identity fields as a real report so the UI can
 * render the page header without special-casing, plus the numbers needed to
 * explain the rule: how long this recording was, and how long it needed to be.
 */
function tooShortReportPayload(session) {
  const sec = sessionDurationSec(session);
  const minimum = config.reports.minSessionDurationSec;
  return {
    sessionId: session.id,
    sessionName: session.name || null,
    userId: session.userId,
    userName: session.userName,
    deviceId: session.deviceId,
    startTime: session.startTime,
    endTime: session.endTime,

    reportStatus: 'too_short',
    reportGeneratedAt: null,
    reportError: null,

    available: false,
    status: 'too_short',
    unavailableReason: 'session_too_short',
    recordingDurationSec: sec,
    minimumDurationSec: minimum,
    message:
      `No reports were generated for this recording. It lasted ${formatDurationShort(sec)}, ` +
      `and reports require at least ${formatDurationShort(minimum)} of recording.`,
    unavailableMessage:
      `No reports were generated for this recording. It lasted ${formatDurationShort(sec)}, ` +
      `and reports require at least ${formatDurationShort(minimum)} of recording.`,
  };
}

async function generateSessionReports(sessionId, sessionDoc = null) {
  const marked = await Session.findOneAndUpdate(
    { id: sessionId },
    {
      $set: { reportStatus: 'generating', reportError: null },
      $inc: { reportAttempts: 1 },
    },
    { new: true }
  );
  if (!marked) return { status: 'missing_session', analysis: null };

  // Below the minimum length, generate nothing. This lives here rather than in
  // the stop handler so EVERY trigger honours it - otherwise simply opening the
  // report page would lazily generate the reports the rule just refused.
  if (isSessionTooShort(sessionDoc || marked)) {
    // Discard anything previously stored for this session, so a short recording
    // cannot keep showing reports it is no longer entitled to.
    await deleteStoredReports(sessionId);
    await Session.updateOne(
      { id: sessionId },
      {
        $set: {
          reportStatus: 'too_short',
          reportGeneratedAt: null,
          reportError: null,
        },
      }
    );
    return { status: 'too_short', analysis: null };
  }

  try {
    const analysis = await recalculateSessionAnalysis(sessionId, sessionDoc);
    await Session.updateOne(
      { id: sessionId },
      { $set: { reportStatus: 'ready', reportGeneratedAt: new Date(), reportError: null } }
    );
    return { status: 'ready', analysis };
  } catch (error) {
    console.error(`Report generation failed for session ${sessionId}:`, error);
    await Session.updateOne(
      { id: sessionId },
      {
        $set: {
          reportStatus: 'failed',
          // Keep it short: this is surfaced in an API response.
          reportError: String(error && error.message ? error.message : error).slice(0, 500),
        },
      }
    ).catch(() => {});
    return { status: 'failed', analysis: null, error };
  }
}

/**
 * Queue report generation to run after the current response has been sent.
 *
 * Analysing a long recording is not something a device should wait on: the
 * session is already saved by this point, and a client timeout on the stop
 * request would make the app believe the recording failed when it did not.
 * The session is marked `pending` first, so a caller polling immediately sees
 * "queued" rather than an absence.
 */
function queueSessionReports(sessionId) {
  setImmediate(() => {
    generateSessionReports(sessionId).catch((error) => {
      console.error(`Queued report generation crashed for ${sessionId}:`, error);
    });
  });
}

/**
 * Shape a stored analysis (plus its events) into the report API response.
 */
function toReportResponse(session, analysis, events) {
  const base = {
    sessionId: session.id,
    sessionName: session.name || null,
    userId: session.userId,
    userName: session.userName,
    deviceId: session.deviceId,
    startTime: session.startTime,
    endTime: session.endTime,
    // Generation state of the session as a whole, so a client can tell
    // "not generated yet" from "generated, and this report has no data".
    reportStatus: session.reportStatus || 'not_started',
    reportGeneratedAt: session.reportGeneratedAt || null,
    reportError: session.reportError || null,
    recordingDurationSec: analysis.recordingDurationSec ?? null,
    analysedAt: analysis.analysedAt || null,

    available: analysis.available === true,
    unavailableReason: analysis.unavailableReason || null,
    unavailableMessage: analysis.unavailableMessage || null,

    // Beat accounting and signal quality are meaningful even when the report
    // itself is unavailable - they are what explains *why*.
    signalQuality: {
      status: analysis.signalQuality,
      usablePercentage: analysis.usableBeatPercentage ?? null,
      beatsDetected: analysis.beatsDetected ?? 0,
      validBeats: analysis.validBeats ?? 0,
      invalidBeats: analysis.invalidBeats ?? 0,
    },

    events: events.map((event) => ({
      timestamp: event.timestamp,
      rPeakTimestamp: event.rPeakTimestamp,
      eventType: event.eventType,
      durationMs: event.durationMs,
      rrValue: event.rrValue,
      quality: event.quality,
      description: event.description,
    })),
  };

  if (!base.available) {
    // Statistical blocks are omitted rather than zero-filled, so the UI cannot
    // accidentally render a report full of zeros (PART 27, PART 31).
    return { ...base, summary: null, rhythm: null, series: [], patientSummary: null, technicalSummary: null };
  }

  return {
    ...base,
    summary: {
      meanHR: analysis.meanHR,
      minHR: analysis.minHR,
      maxHR: analysis.maxHR,
      meanRR: analysis.meanRR,
      minRR: analysis.minRR,
      maxRR: analysis.maxRR,
      rrSD: analysis.rrStandardDeviation,
      rrCVPercent: analysis.rrCoefficientVariation,
      beatsDetected: analysis.beatsDetected,
      validBeats: analysis.validBeats,
      invalidBeats: analysis.invalidBeats,
      usablePercentage: analysis.usableBeatPercentage,
    },
    rhythm: {
      regularity: analysis.rhythmRegularity,
      beatToBeatVariation: analysis.beatToBeatVariation,
      meanAbsRrDifferenceMs: analysis.meanAbsRrDifference,
      maxAbsRrDifferenceMs: analysis.maxAbsRrDifference,
      longRREvents: analysis.longRREventCount ?? 0,
    },
    series: (analysis.series || []).map((point) => ({
      offsetSec: point.offsetSec,
      timestamp: point.timestamp || null,
      rr: point.rr,
      hr: point.hr,
    })),
    patientSummary: analysis.patientSummary,
    technicalSummary: analysis.technicalSummary,
  };
}

/**
 * Shape a stored HRV analysis into the report API response.
 *
 * Mirrors toReportResponse: on any non-success status the metric block is null
 * rather than zero-filled, while the interval accounting and duration survive
 * because they are what explain the outcome.
 */
function toHrvReportResponse(session, hrv) {
  const base = {
    sessionId: session.id,
    sessionName: session.name || null,
    userId: session.userId,
    // Generation state of the session as a whole, so a client can tell
    // "not generated yet" from "generated, and this report has no data".
    reportStatus: session.reportStatus || 'not_started',
    reportGeneratedAt: session.reportGeneratedAt || null,
    reportError: session.reportError || null,
    userName: session.userName,
    deviceId: session.deviceId,
    startTime: session.startTime,
    endTime: session.endTime,
    analysedAt: hrv.analysedAt || null,

    status: hrv.status,
    message: hrv.message || null,

    recording: {
      durationSec: hrv.recordingDurationSec ?? null,
      analysisDurationSec: hrv.analysisDurationSec ?? null,
      shortRecording: hrv.shortRecording === true,
      ultraShortRecording: hrv.ultraShortRecording === true,
    },

    quality: {
      status: hrv.quality,
      ecgSignalQuality: hrv.ecgSignalQuality ?? null,
      totalIntervals: hrv.totalRRIntervals ?? 0,
      validNNIntervals: hrv.validNNIntervals ?? 0,
      excludedIntervals: hrv.excludedIntervals ?? 0,
      usablePercentage: hrv.usablePercentage ?? null,
      artifactPercentage: hrv.artifactPercentage ?? null,
      successivePairs: hrv.successivePairs ?? 0,
      successivePairsSkipped: hrv.successivePairsSkipped ?? 0,
    },
  };

  if (hrv.status !== 'success') {
    return {
      ...base,
      metrics: null,
      baseline: { available: false },
      timeSeries: [],
      patientSummary: null,
      technicalSummary: null,
    };
  }

  return {
    ...base,
    metrics: {
      meanNNMs: hrv.meanNNMs,
      minNNMs: hrv.minNNMs,
      maxNNMs: hrv.maxNNMs,
      sdnnMs: hrv.sdnnMs,
      rmssdMs: hrv.rmssdMs,
      pnn50Percent: hrv.pnn50Percent,
    },
    baseline: {
      available: hrv.personalBaselineAvailable === true,
      sessionsUsed: hrv.baselineSessionsUsed ?? 0,
      baselineRmssdMs: hrv.baselineRmssdMs ?? null,
      baselineSdnnMs: hrv.baselineSdnnMs ?? null,
      rmssdChangePercent: hrv.rmssdChangePercent ?? null,
      comparison: hrv.baselineComparison ?? null,
    },
    timeSeries: (hrv.series || []).map((point) => ({
      offsetSec: point.offsetSec,
      timestamp: point.timestamp || null,
      rPeakTimestamp: point.rPeakTimestamp ?? null,
      nnMs: point.nnMs,
    })),
    patientSummary: hrv.patientSummary,
    technicalSummary: hrv.technicalSummary,
  };
}

/**
 * Shape a stored rhythm screening result into the report API response.
 * On any non-success status the summary blocks are null rather than zero-filled.
 */
function toRhythmReportResponse(session, rhythm, events) {
  const base = {
    sessionId: session.id,
    sessionName: session.name || null,
    userId: session.userId,
    // Generation state of the session as a whole, so a client can tell
    // "not generated yet" from "generated, and this report has no data".
    reportStatus: session.reportStatus || 'not_started',
    reportGeneratedAt: session.reportGeneratedAt || null,
    reportError: session.reportError || null,
    userName: session.userName,
    deviceId: session.deviceId,
    startTime: session.startTime,
    endTime: session.endTime,
    analysedAt: rhythm.analysedAt || null,

    status: rhythm.status,
    message: rhythm.message || null,

    signalQuality: {
      status: rhythm.signalQuality,
      usablePercentage: rhythm.usablePercentage ?? null,
      beatsDetected: rhythm.beatsDetected ?? 0,
      validBeats: rhythm.validBeats ?? 0,
      invalidBeats: rhythm.invalidBeats ?? 0,
    },

    events: events.map((event) => ({
      eventType: event.eventType,
      startSec: event.startSec ?? null,
      endSec: event.endSec ?? null,
      durationSec: event.durationSec ?? null,
      timestamp: event.timestamp ?? null,
      heartRateBpm: event.heartRateBpm ?? null,
      meanHeartRateBpm: event.meanHeartRateBpm ?? null,
      cvPercent: event.cvPercent ?? null,
      rrValue: event.rrValue ?? null,
      beats: event.beats ?? null,
      requiresContext: event.requiresContext === true,
      requiresQualityReview: event.requiresQualityReview === true,
      description: event.description ?? null,
    })),
  };

  if (rhythm.status !== 'success') {
    return { ...base, summary: null, screening: null, patientSummary: null, technicalSummary: null };
  }

  return {
    ...base,
    summary: {
      rhythmPattern: rhythm.rhythmPattern,
      classificationConfidence: rhythm.classificationConfidence,
      averageHR: rhythm.averageHR,
      minimumHR: rhythm.minimumHR,
      maximumHR: rhythm.maximumHR,
      rrCvPercent: rhythm.rrCvPercent,
      analysedBeats: rhythm.analysedBeats,
      recordingDurationSec: rhythm.recordingDurationSec,
    },
    screening: {
      elevatedHRPeriods: rhythm.elevatedHRPeriods ?? 0,
      lowHRPeriods: rhythm.lowHRPeriods ?? 0,
      irregularRRPeriods: rhythm.irregularRRPeriods ?? 0,
      possibleLongRREvents: rhythm.possibleLongRREvents ?? 0,
      possibleMissedBeats: rhythm.possibleMissedBeats ?? 0,
      possibleDoubleDetections: rhythm.possibleDoubleDetections ?? 0,
    },
    patientSummary: rhythm.patientSummary,
    technicalSummary: rhythm.technicalSummary,
  };
}

/**
 * Shape a stored respiration result into the report API response.
 *
 * The per-estimate blocks are always present, carrying either a rate or the
 * reason it is missing, so the UI can explain a gap rather than show a blank.
 */
function toRespirationReportResponse(session, resp) {
  return {
    sessionId: session.id,
    sessionName: session.name || null,
    userId: session.userId,
    // Generation state of the session as a whole, so a client can tell
    // "not generated yet" from "generated, and this report has no data".
    reportStatus: session.reportStatus || 'not_started',
    reportGeneratedAt: session.reportGeneratedAt || null,
    reportError: session.reportError || null,
    userName: session.userName,
    deviceId: session.deviceId,
    startTime: session.startTime,
    endTime: session.endTime,
    analysedAt: resp.analysedAt || null,

    status: resp.status,
    message: resp.message || null,

    summary: {
      respirationRate: resp.finalRespirationRate ?? null,
      unit: resp.unit || 'breaths/min',
      confidence: resp.confidence,
      basis: resp.basis ?? null,
      withinPlausibleRange: resp.withinPlausibleRange ?? null,
    },

    ecgEstimate: {
      available: resp.ecgRespirationRate !== null && resp.ecgRespirationRate !== undefined,
      rate: resp.ecgRespirationRate ?? null,
      freqHz: resp.ecgFreqHz ?? null,
      prominence: resp.ecgProminence ?? null,
      quality: resp.ecgQuality || 'Unavailable',
      intervalsUsed: resp.ecgIntervalsUsed ?? null,
      reason: resp.ecgUnavailableReason ?? null,
      detail: resp.ecgUnavailableDetail ?? null,
    },

    ppgEstimate: {
      available: resp.ppgRespirationRate !== null && resp.ppgRespirationRate !== undefined,
      rate: resp.ppgRespirationRate ?? null,
      freqHz: resp.ppgFreqHz ?? null,
      prominence: resp.ppgProminence ?? null,
      quality: resp.ppgQuality || 'Unavailable',
      samplesUsed: resp.ppgSamplesUsed ?? null,
      reason: resp.ppgUnavailableReason ?? null,
      detail: resp.ppgUnavailableDetail ?? null,
    },

    crossCheck: {
      status: resp.agreementStatus ?? null,
      difference: resp.differenceBpm ?? null,
    },

    recording: {
      durationSec: resp.recordingDurationSec ?? null,
      analysedDurationSec: resp.analysedDurationSec ?? null,
      artifactPercentage: resp.artifactPercentage ?? null,
      spectralResolutionBpm: resp.spectralResolutionBpm ?? null,
    },

    trend: (resp.trend || []).map((p) => ({
      offsetSec: p.offsetSec,
      midpointSec: p.midpointSec,
      rateBpm: p.rateBpm ?? null,
      usable: p.usable === true,
      reason: p.reason ?? null,
    })),

    patientSummary: resp.patientSummary ?? null,
    technicalSummary: resp.technicalSummary ?? null,
  };
}

/** Identity block every report response carries. */
function sessionMeta(session, doc) {
  return {
    sessionId: session.id,
    sessionName: session.name || null,
    userId: session.userId,
    // Generation state of the session as a whole, so a client can tell
    // "not generated yet" from "generated, and this report has no data".
    reportStatus: session.reportStatus || 'not_started',
    reportGeneratedAt: session.reportGeneratedAt || null,
    reportError: session.reportError || null,
    userName: session.userName,
    deviceId: session.deviceId,
    startTime: session.startTime,
    endTime: session.endTime,
    analysedAt: doc.analysedAt || null,
    status: doc.status,
    message: doc.message || null,
  };
}

/** Shape a stored SpO2 analysis into the report API response. */
function toSpo2ReportResponse(session, doc, events) {
  const base = {
    ...sessionMeta(session, doc),
    coverage: {
      totalSamples: doc.totalSamples ?? 0,
      usableSamples: doc.usableSamples ?? 0,
      excludedSamples: doc.excludedSamples ?? 0,
      coveragePct: doc.coveragePct ?? null,
      analysedDurationSec: doc.analysedDurationSec ?? null,
      recordingDurationSec: doc.recordingDurationSec ?? null,
    },
    events: events.map((e) => ({
      eventType: e.eventType,
      startSec: e.startSec ?? null,
      endSec: e.endSec ?? null,
      durationSec: e.durationSec ?? null,
      timestamp: e.timestamp ?? null,
      baselinePct: e.baselinePct ?? null,
      nadirPct: e.nadirPct ?? null,
      dropPct: e.dropPct ?? null,
      meanPct: e.meanPct ?? null,
      thresholdPct: e.thresholdPct ?? null,
      recovered: e.recovered ?? null,
      recoverySec: e.recoverySec ?? null,
      description: e.description ?? null,
    })),
  };

  if (doc.status !== 'success') {
    return { ...base, summary: null, stability: doc.stability, series: [], patientSummary: null, technicalSummary: null };
  }

  return {
    ...base,
    summary: {
      meanPct: doc.meanPct,
      medianPct: doc.medianPct,
      minPct: doc.minPct,
      maxPct: doc.maxPct,
      sdPct: doc.sdPct,
      desaturationEvents: doc.desaturationEvents ?? 0,
      strictDesaturationEvents: doc.strictDesaturationEvents ?? 0,
      recoveredDesaturations: doc.recoveredDesaturations ?? 0,
      lowSaturationPeriods: doc.lowSaturationPeriods ?? 0,
      timeBelow90Sec: doc.timeBelow90Sec,
      timeBelow90Percent: doc.timeBelow90Percent,
      timeBelow88Sec: doc.timeBelow88Sec,
      timeBelow88Percent: doc.timeBelow88Percent,
    },
    stability: doc.stability,
    series: (doc.series || []).map((p) => ({
      offsetSec: p.offsetSec,
      timestamp: p.timestamp || null,
      spo2: p.spo2,
      baseline: p.baseline ?? null,
    })),
    patientSummary: doc.patientSummary,
    technicalSummary: doc.technicalSummary,
  };
}

/** Shape a stored temperature analysis into the report API response. */
function toTemperatureReportResponse(session, doc, events) {
  const base = {
    ...sessionMeta(session, doc),
    regime: doc.regime,
    trend: doc.trend,
    stability: doc.stability,
    coverage: {
      totalSamples: doc.totalSamples ?? 0,
      usableSamples: doc.usableSamples ?? 0,
      excludedSamples: doc.excludedSamples ?? 0,
      coveragePct: doc.coveragePct ?? null,
      analysedDurationSec: doc.analysedDurationSec ?? null,
      recordingDurationSec: doc.recordingDurationSec ?? null,
    },
    events: events.map((e) => ({
      eventType: e.eventType,
      startSec: e.startSec ?? null,
      endSec: e.endSec ?? null,
      durationSec: e.durationSec ?? null,
      timestamp: e.timestamp ?? null,
      baselineC: e.baselineC ?? null,
      peakC: e.peakC ?? null,
      changeC: e.changeC ?? null,
      description: e.description ?? null,
    })),
  };

  if (doc.status !== 'success') {
    return { ...base, summary: null, series: [], patientSummary: null, technicalSummary: null };
  }

  return {
    ...base,
    summary: {
      meanC: doc.meanC,
      medianC: doc.medianC,
      minC: doc.minC,
      maxC: doc.maxC,
      sdC: doc.sdC,
      startC: doc.startC,
      endC: doc.endC,
      totalChangeC: doc.totalChangeC,
      driftCPerMin: doc.driftCPerMin,
      elevationEvents: doc.elevationEvents ?? 0,
      depressionEvents: doc.depressionEvents ?? 0,
    },
    series: (doc.series || []).map((p) => ({
      offsetSec: p.offsetSec,
      timestamp: p.timestamp || null,
      tempC: p.tempC,
      baseline: p.baseline ?? null,
    })),
    patientSummary: doc.patientSummary,
    technicalSummary: doc.technicalSummary,
  };
}

/** Shape a stored combined analysis into the report API response. */
function toCombinedReportResponse(session, doc) {
  const base = {
    ...sessionMeta(session, doc),
    coverage: {
      rows: doc.rows ?? 0,
      hrPresent: doc.hrPresent ?? 0,
      spo2Present: doc.spo2Present ?? 0,
      tempPresent: doc.tempPresent ?? 0,
      analysedDurationSec: doc.analysedDurationSec ?? null,
      recordingDurationSec: doc.recordingDurationSec ?? null,
    },
    // Relationships are returned even on a non-success status: an unavailable
    // relationship carries the reason it could not be described.
    relationships: (doc.relationships || []).map((r) => ({
      label: r.label,
      available: r.available === true,
      pairs: r.pairs ?? 0,
      minPairs: r.minPairs ?? null,
      spanSec: r.spanSec ?? null,
      r: r.r ?? null,
      rSquared: r.rSquared ?? null,
      association: r.association,
      direction: r.direction,
      reason: r.reason ?? null,
      detail: r.detail ?? null,
    })),
  };

  if (doc.status !== 'success') {
    return { ...base, concurrentEvents: [], series: [], patientSummary: null, technicalSummary: null };
  }

  return {
    ...base,
    concurrentEvents: (doc.concurrentEvents || []).map((e) => ({
      startSec: e.startSec,
      signals: e.signals || [],
      spo2EventType: e.spo2EventType ?? null,
      otherEventType: e.otherEventType ?? null,
      description: e.description ?? null,
    })),
    series: (doc.series || []).map((p) => ({
      offsetSec: p.offsetSec,
      timestamp: p.timestamp || null,
      hr: p.hr ?? null,
      spo2: p.spo2 ?? null,
      tempC: p.tempC ?? null,
    })),
    patientSummary: doc.patientSummary,
    technicalSummary: doc.technicalSummary,
  };
}

module.exports = {
  generateSessionReports,
  tooShortReportPayload,
  formatDurationShort,
  sessionDurationSec,
  isSessionTooShort,
  MIN_SESSION_DURATION_SEC: config.reports.minSessionDurationSec,
  queueSessionReports,
  loadRPeaks,
  loadPpgSamples,
  loadVitalsRows,
  toSpo2ReportResponse,
  toTemperatureReportResponse,
  toCombinedReportResponse,
  toRhythmReportResponse,
  toRespirationReportResponse,
  recalculateSessionAnalysis,
  recalculateSessionAnalysisSafe,
  invalidateSessionAnalysis,
  toReportResponse,
  toHrvReportResponse,
  loadHrvBaselineSessions,
};
