const { validationResult } = require('express-validator');
const Session = require('../../models/Session');
const EcgRrAnalysis = require('../../models/EcgRrAnalysis');
const EcgRrEvent = require('../../models/EcgRrEvent');
const HrvAnalysis = require('../../models/HrvAnalysis');
const RhythmAnalysis = require('../../models/RhythmAnalysis');
const RhythmEvent = require('../../models/RhythmEvent');
const RespirationAnalysis = require('../../models/RespirationAnalysis');
const Spo2Analysis = require('../../models/Spo2Analysis');
const Spo2Event = require('../../models/Spo2Event');
const TemperatureAnalysis = require('../../models/TemperatureAnalysis');
const TemperatureEvent = require('../../models/TemperatureEvent');
const CombinedAnalysis = require('../../models/CombinedAnalysis');
const {
  generateSessionReports,
  isSessionTooShort,
  tooShortReportPayload,
  sessionDurationSec,
  MIN_SESSION_DURATION_SEC,
  toReportResponse,
  toHrvReportResponse,
  toRhythmReportResponse,
  toRespirationReportResponse,
  toSpo2ReportResponse,
  toTemperatureReportResponse,
  toCombinedReportResponse,
} = require('../../services/ecgRrService');

/**
 * App-facing report endpoints.
 *
 * These mirror the admin report API for the phone, with two differences that
 * matter:
 *
 * 1. AUTHORIZATION. Every lookup is scoped to `req.user.userId`, so a user can
 *    only ever read reports for their OWN sessions. The analysis collections
 *    are never queried by sessionId alone - substituting someone else's id
 *    returns the same 404 as an id that does not exist, which is also what
 *    stops the endpoint from confirming that another user's session exists.
 *
 * 2. PAYLOAD SIZE. The overview endpoint deliberately omits the per-sample
 *    series and event arrays. A full seven-module report runs to hundreds of
 *    kilobytes, which is the wrong thing to push down a mobile connection when
 *    the app only needs headline numbers for a list. The app fetches one module
 *    at a time, with its charts, when the user opens it.
 *
 * Everything is rendered through the SAME mappers the admin API uses, so the
 * phone and the dashboard can never disagree about a number.
 */

// ── module registry ────────────────────────────────────────────────

/**
 * One entry per report module. `pick` extracts the headline fields for the
 * overview from the module's own mapped response, so the overview can never
 * drift from the detail view - it is a projection of the same object.
 */
const MODULES = {
  'ecg-rr': {
    label: 'ECG / RR analysis',
    Model: EcgRrAnalysis,
    EventModel: EcgRrEvent,
    sortEvents: { rPeakTimestamp: 1 },
    map: toReportResponse,
    pick: (r) => ({
      available: r.available === true,
      meanHR: r.summary ? r.summary.meanHR : null,
      minHR: r.summary ? r.summary.minHR : null,
      maxHR: r.summary ? r.summary.maxHR : null,
      meanRR: r.summary ? r.summary.meanRR : null,
      rhythmPattern: r.rhythm ? r.rhythm.regularity : null,
      signalQuality: r.signalQuality ? r.signalQuality.status : null,
      usablePercentage: r.summary ? r.summary.usablePercentage : null,
      eventCount: (r.events || []).length,
    }),
  },
  hrv: {
    label: 'HRV analysis',
    Model: HrvAnalysis,
    map: toHrvReportResponse,
    pick: (r) => ({
      available: r.status === 'success',
      sdnnMs: r.metrics ? r.metrics.sdnnMs : null,
      rmssdMs: r.metrics ? r.metrics.rmssdMs : null,
      pnn50Percent: r.metrics ? r.metrics.pnn50Percent : null,
      meanNNMs: r.metrics ? r.metrics.meanNNMs : null,
      confidence: r.quality ? r.quality.confidence : null,
    }),
  },
  rhythm: {
    label: 'rhythm screening',
    Model: RhythmAnalysis,
    EventModel: RhythmEvent,
    sortEvents: { startSec: 1 },
    map: toRhythmReportResponse,
    pick: (r) => ({
      available: r.status === 'success',
      rhythmPattern: r.summary ? r.summary.rhythmPattern : null,
      averageHR: r.summary ? r.summary.averageHR : null,
      rrCvPercent: r.summary ? r.summary.rrCvPercent : null,
      eventCount: (r.events || []).length,
    }),
  },
  respiration: {
    label: 'respiration rate',
    Model: RespirationAnalysis,
    map: toRespirationReportResponse,
    pick: (r) => ({
      available: r.status === 'success',
      respirationRate: r.summary ? r.summary.respirationRate : null,
      unit: r.summary ? r.summary.unit : 'breaths/min',
      confidence: r.summary ? r.summary.confidence : null,
      basis: r.summary ? r.summary.basis : null,
    }),
  },
  spo2: {
    label: 'SpO2 analysis',
    Model: Spo2Analysis,
    EventModel: Spo2Event,
    sortEvents: { startSec: 1 },
    map: toSpo2ReportResponse,
    pick: (r) => ({
      available: r.status === 'success',
      meanPct: r.summary ? r.summary.meanPct : null,
      minPct: r.summary ? r.summary.minPct : null,
      desaturationEvents: r.summary ? r.summary.desaturationEvents : null,
      timeBelow90Percent: r.summary ? r.summary.timeBelow90Percent : null,
      eventCount: (r.events || []).length,
    }),
  },
  temperature: {
    label: 'temperature analysis',
    Model: TemperatureAnalysis,
    EventModel: TemperatureEvent,
    sortEvents: { startSec: 1 },
    map: toTemperatureReportResponse,
    pick: (r) => ({
      available: r.status === 'success',
      meanC: r.summary ? r.summary.meanC : null,
      minC: r.summary ? r.summary.minC : null,
      maxC: r.summary ? r.summary.maxC : null,
      // The regime matters more than the number: this is a skin sensor, and
      // the app must not present it as a body temperature.
      regime: r.regime ?? null,
      trend: r.trend ?? null,
      eventCount: (r.events || []).length,
    }),
  },
  combined: {
    label: 'combined physiological analysis',
    Model: CombinedAnalysis,
    map: toCombinedReportResponse,
    pick: (r) => ({
      available: r.status === 'success',
      relationships: (r.relationships || []).map((rel) => ({
        pair: rel.pair ?? null,
        available: rel.available === true,
        r: rel.r ?? null,
        strength: rel.strength ?? null,
        pairs: rel.pairs ?? null,
      })),
      concurrentEventCount: (r.concurrentEvents || []).length,
    }),
  },
};

const MODULE_NAMES = Object.keys(MODULES);

// ── shared helpers ─────────────────────────────────────────────────

/**
 * Find a session that belongs to the calling user.
 *
 * The userId filter is the entire authorization model here: without it, any
 * authenticated user could read any other user's reports by guessing an id.
 */
async function findOwnSession(sessionId, userId) {
  return Session.findOne({ id: sessionId, userId }).lean();
}

/**
 * The state of report generation, as the app needs to act on it.
 *
 * Returns null when the reports are ready to be read; otherwise a body
 * explaining why they are not, so the app can show the right thing instead of
 * an empty screen.
 */
function generationStateResponse(session) {
  if (isSessionTooShort(session)) {
    return { httpStatus: 200, body: tooShortReportPayload(session) };
  }

  const status = session.reportStatus || 'not_started';

  if (status === 'not_started') {
    return {
      httpStatus: 200,
      body: {
        ...sessionIdentity(session),
        reportStatus: 'not_started',
        available: false,
        unavailableReason: 'recording_not_finished',
        message: 'This recording has not finished yet, so no reports exist for it.',
      },
    };
  }

  if (status === 'pending' || status === 'generating') {
    return {
      httpStatus: 200,
      body: {
        ...sessionIdentity(session),
        reportStatus: status,
        available: false,
        unavailableReason: 'generation_in_progress',
        // A hint, not a contract: the app should poll rather than assume.
        retryAfterSec: 3,
        message: 'The reports for this recording are still being prepared.',
      },
    };
  }

  if (status === 'failed') {
    return {
      httpStatus: 200,
      body: {
        ...sessionIdentity(session),
        reportStatus: 'failed',
        available: false,
        unavailableReason: 'generation_failed',
        // The underlying error is deliberately NOT forwarded to the phone: it
        // can name internal collections and is of no use to a patient.
        message: 'The reports for this recording could not be prepared.',
      },
    };
  }

  return null;
}

function sessionIdentity(session) {
  return {
    sessionId: session.id,
    sessionName: session.name || null,
    startTime: session.startTime,
    endTime: session.endTime,
    deviceId: session.deviceId,
    recordingDurationSec: sessionDurationSec(session),
  };
}

// ── GET /api/app/reports/sessions ──────────────────────────────────

/**
 * The user's recordings, newest first, with the state of their reports.
 *
 * This is what the app's report list is built from: it needs to know which
 * recordings have reports worth opening, and why the others do not.
 */
async function listReportSessions(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, data: null, error: errors.array()[0].msg });
  }

  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const sessions = await Session.find({ userId: req.user.userId })
      .select('id name startTime endTime deviceId duration reportStatus reportGeneratedAt')
      .sort({ startTime: -1 })
      .limit(limit)
      .lean();

    return res.json({
      success: true,
      data: {
        minimumDurationSec: MIN_SESSION_DURATION_SEC,
        sessions: sessions.map((s) => {
          const durationSec = sessionDurationSec(s);
          const tooShort = isSessionTooShort(s);
          return {
            ...sessionIdentity(s),
            // A short recording is reported as too_short even before the
            // generator has run, so the list never briefly promises reports it
            // is not going to produce.
            reportStatus: tooShort ? 'too_short' : s.reportStatus || 'not_started',
            reportGeneratedAt: s.reportGeneratedAt || null,
            reportsAvailable: !tooShort && s.reportStatus === 'ready',
            durationSec,
          };
        }),
      },
      error: null,
    });
  } catch (error) {
    console.error('App list report sessions error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

// ── GET /api/app/reports/:sessionId ────────────────────────────────

/**
 * Headline numbers for all seven modules in ONE request.
 *
 * Deliberately excludes the per-sample series and the event lists: those are
 * what make a full report large, and the app does not need them to render an
 * overview. Each module is fetched in full, individually, when opened.
 */
async function getReportOverview(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, data: null, error: errors.array()[0].msg });
  }

  try {
    const session = await findOwnSession(req.params.sessionId, req.user.userId);
    if (!session) {
      return res.status(404).json({ success: false, data: null, error: 'Session not found.' });
    }

    const state = generationStateResponse(session);
    if (state) return res.status(state.httpStatus).json({ success: true, data: state.body, error: null });

    // Every module is read from storage. Generation already happened when the
    // recording finished, so nothing is computed on this request.
    const modules = {};
    for (const [name, spec] of Object.entries(MODULES)) {
      const doc = await spec.Model.findOne({ sessionId: session.id }).lean();
      if (!doc) {
        modules[name] = { available: false, unavailableReason: 'not_generated' };
        continue;
      }
      // Mapped through the real mapper, then projected - so the overview is
      // always a subset of what the detail endpoint returns.
      const events = spec.EventModel
        ? await spec.EventModel.find({ sessionId: session.id }).sort(spec.sortEvents).lean()
        : [];
      const full = spec.map(session, doc, events);
      modules[name] = {
        ...spec.pick(full),
        unavailableReason: full.unavailableReason ?? null,
        message: full.unavailableMessage ?? full.message ?? null,
      };
    }

    return res.json({
      success: true,
      data: {
        ...sessionIdentity(session),
        reportStatus: session.reportStatus,
        reportGeneratedAt: session.reportGeneratedAt || null,
        available: true,
        modules,
      },
      error: null,
    });
  } catch (error) {
    console.error('App report overview error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

// ── GET /api/app/reports/:sessionId/:module ────────────────────────

/**
 * One module in full, charts and events included.
 *
 * The body is byte-for-byte what the admin endpoint returns for the same
 * module, because it goes through the same mapper.
 */
async function getReportModule(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, data: null, error: errors.array()[0].msg });
  }

  const { sessionId, module } = req.params;
  const spec = MODULES[module];
  if (!spec) {
    return res.status(404).json({
      success: false,
      data: null,
      error: `Unknown report module. Expected one of: ${MODULE_NAMES.join(', ')}.`,
    });
  }

  try {
    const session = await findOwnSession(sessionId, req.user.userId);
    if (!session) {
      return res.status(404).json({ success: false, data: null, error: 'Session not found.' });
    }

    const state = generationStateResponse(session);
    if (state) return res.status(state.httpStatus).json({ success: true, data: state.body, error: null });

    let doc = await spec.Model.findOne({ sessionId: session.id }).lean();
    if (!doc) {
      // Safety net for a session whose reports were invalidated by a late
      // upload: generate on demand, honouring the same rules as every other
      // trigger (the length gate lives inside generateSessionReports).
      await generateSessionReports(session.id, session);
      doc = await spec.Model.findOne({ sessionId: session.id }).lean();
    }
    if (!doc) {
      return res.status(200).json({
        success: true,
        data: {
          ...sessionIdentity(session),
          available: false,
          unavailableReason: 'not_generated',
          message: `No ${spec.label} could be prepared for this recording.`,
        },
        error: null,
      });
    }

    const events = spec.EventModel
      ? await spec.EventModel.find({ sessionId: session.id }).sort(spec.sortEvents).lean()
      : [];

    return res.json({
      success: true,
      data: spec.map(session, doc, events),
      error: null,
    });
  } catch (error) {
    console.error(`App ${module} report error:`, error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

module.exports = {
  listReportSessions,
  getReportOverview,
  getReportModule,
  MODULE_NAMES,
};
