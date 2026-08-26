const Session = require('../models/Session');
const EcgRrAnalysis = require('../models/EcgRrAnalysis');
const EcgRrEvent = require('../models/EcgRrEvent');
const HrvAnalysis = require('../models/HrvAnalysis');
const RhythmAnalysis = require('../models/RhythmAnalysis');
const RhythmEvent = require('../models/RhythmEvent');
const RespirationAnalysis = require('../models/RespirationAnalysis');
const Spo2Analysis = require('../models/Spo2Analysis');
const Spo2Event = require('../models/Spo2Event');
const TemperatureAnalysis = require('../models/TemperatureAnalysis');
const TemperatureEvent = require('../models/TemperatureEvent');
const CombinedAnalysis = require('../models/CombinedAnalysis');
const {
  recalculateSessionAnalysis,
  toReportResponse,
  toHrvReportResponse,
  toRhythmReportResponse,
  toRespirationReportResponse,
  toSpo2ReportResponse,
  toTemperatureReportResponse,
  toCombinedReportResponse,
} = require('../services/ecgRrService');

/**
 * Admin ECG/RR report endpoints.
 *
 * Authorization (PART 29): every lookup goes through the session, filtered by
 * `req.clientScope` exactly like the rest of the admin API. A client_admin who
 * substitutes another tenant's sessionId gets the same 404 as a nonexistent id -
 * the analysis and event collections are never queried by sessionId alone.
 */

/** Resolve a session within the caller's client scope, or null. */
async function findScopedSession(sessionId, clientScope) {
  const filter = { id: sessionId };
  if (clientScope) filter.clientId = clientScope;
  return Session.findOne(filter).lean();
}

/**
 * GET /api/admin/readings/:sessionId/reports/ecg-rr
 *
 * Serves the stored analysis. When none exists yet (recording predates the
 * feature, or ingestion happened before analysis was wired in) it is computed
 * once and persisted, so subsequent requests are a plain read (PART 30).
 */
async function getEcgRrReport(req, res) {
  try {
    const { sessionId } = req.params;

    const session = await findScopedSession(sessionId, req.clientScope);
    if (!session) {
      return res.status(404).json({ success: false, data: null, error: 'Session not found.' });
    }

    let analysis = await EcgRrAnalysis.findOne({ sessionId: session.id }).lean();

    if (!analysis) {
      analysis = await recalculateSessionAnalysis(session.id, session);
    }

    if (!analysis) {
      return res
        .status(500)
        .json({ success: false, data: null, error: 'Unable to generate ECG/RR analysis.' });
    }

    const events = await EcgRrEvent.find({ sessionId: session.id })
      .sort({ rPeakTimestamp: 1 })
      .lean();

    return res.json({
      success: true,
      data: toReportResponse(session, analysis, events),
      error: null,
    });
  } catch (error) {
    console.error('Get ECG/RR report error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

/**
 * POST /api/admin/readings/:sessionId/reports/ecg-rr/recalculate
 *
 * Explicit, idempotent recalculation for when readings were backfilled or the
 * thresholds changed. Kept as a separate verb so a GET never carries the cost
 * of a full re-analysis.
 */
async function recalculateEcgRrReport(req, res) {
  try {
    const { sessionId } = req.params;

    const session = await findScopedSession(sessionId, req.clientScope);
    if (!session) {
      return res.status(404).json({ success: false, data: null, error: 'Session not found.' });
    }

    const analysis = await recalculateSessionAnalysis(session.id, session);
    if (!analysis) {
      return res
        .status(500)
        .json({ success: false, data: null, error: 'Unable to generate ECG/RR analysis.' });
    }

    const events = await EcgRrEvent.find({ sessionId: session.id })
      .sort({ rPeakTimestamp: 1 })
      .lean();

    return res.json({
      success: true,
      data: toReportResponse(session, analysis, events),
      error: null,
    });
  } catch (error) {
    console.error('Recalculate ECG/RR report error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

/**
 * GET /api/admin/readings/:sessionId/reports/hrv
 *
 * Serves the stored HRV analysis. HRV is computed in the same pass as the ECG/RR
 * analysis (both consume one validated NN sequence), so a missing HRV document
 * means the session has not been analysed yet — recalculating produces both.
 */
async function getHrvReport(req, res) {
  try {
    const { sessionId } = req.params;

    const session = await findScopedSession(sessionId, req.clientScope);
    if (!session) {
      return res.status(404).json({ success: false, data: null, error: 'Session not found.' });
    }

    let hrv = await HrvAnalysis.findOne({ sessionId: session.id }).lean();

    if (!hrv) {
      await recalculateSessionAnalysis(session.id, session);
      hrv = await HrvAnalysis.findOne({ sessionId: session.id }).lean();
    }

    if (!hrv) {
      return res
        .status(500)
        .json({ success: false, data: null, error: 'Unable to generate HRV analysis.' });
    }

    return res.json({
      success: true,
      data: toHrvReportResponse(session, hrv),
      error: null,
    });
  } catch (error) {
    console.error('Get HRV report error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

/**
 * GET /api/admin/readings/:sessionId/reports/hrv/trend
 *
 * The user's HRV across their sessions, oldest first, for the trend chart.
 * Only successful analyses are returned — a rejected session contributes no
 * point rather than a zero.
 */
async function getHrvTrend(req, res) {
  try {
    const { sessionId } = req.params;

    const session = await findScopedSession(sessionId, req.clientScope);
    if (!session) {
      return res.status(404).json({ success: false, data: null, error: 'Session not found.' });
    }

    // Scope the trend to sessions the caller may see, then join their HRV results.
    const sessionFilter = { userId: session.userId };
    if (req.clientScope) sessionFilter.clientId = req.clientScope;

    const sessions = await Session.find(sessionFilter)
      .select('id name startTime')
      .sort({ startTime: 1 })
      .limit(200)
      .lean();

    if (!sessions.length) {
      return res.json({ success: true, data: { points: [] }, error: null });
    }

    const rows = await HrvAnalysis.find({
      sessionId: { $in: sessions.map((s) => s.id) },
      status: 'success',
    })
      .select('sessionId rmssdMs sdnnMs pnn50Percent quality validNNIntervals')
      .lean();

    const bySession = new Map(rows.map((r) => [r.sessionId, r]));

    const points = sessions
      .map((s) => {
        const hrv = bySession.get(s.id);
        if (!hrv) return null;
        return {
          sessionId: s.id,
          sessionName: s.name || null,
          startTime: s.startTime,
          rmssdMs: hrv.rmssdMs,
          sdnnMs: hrv.sdnnMs,
          pnn50Percent: hrv.pnn50Percent,
          quality: hrv.quality,
          validNNIntervals: hrv.validNNIntervals,
        };
      })
      .filter(Boolean);

    return res.json({
      success: true,
      data: { points, currentSessionId: session.id },
      error: null,
    });
  } catch (error) {
    console.error('Get HRV trend error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

/**
 * GET /api/admin/readings/:sessionId/reports/rhythm
 *
 * Rhythm screening. Computed in the same pass as the ECG/RR analysis, so a
 * missing document means the session has not been analysed yet.
 */
async function getRhythmReport(req, res) {
  try {
    const { sessionId } = req.params;

    const session = await findScopedSession(sessionId, req.clientScope);
    if (!session) {
      return res.status(404).json({ success: false, data: null, error: 'Session not found.' });
    }

    let rhythm = await RhythmAnalysis.findOne({ sessionId: session.id }).lean();
    if (!rhythm) {
      await recalculateSessionAnalysis(session.id, session);
      rhythm = await RhythmAnalysis.findOne({ sessionId: session.id }).lean();
    }
    if (!rhythm) {
      return res
        .status(500)
        .json({ success: false, data: null, error: 'Unable to generate rhythm screening.' });
    }

    const events = await RhythmEvent.find({ sessionId: session.id })
      .sort({ rPeakTimestamp: 1, startSec: 1 })
      .lean();

    return res.json({
      success: true,
      data: toRhythmReportResponse(session, rhythm, events),
      error: null,
    });
  } catch (error) {
    console.error('Get rhythm report error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

/**
 * GET /api/admin/readings/:sessionId/reports/respiration
 */
async function getRespirationReport(req, res) {
  try {
    const { sessionId } = req.params;

    const session = await findScopedSession(sessionId, req.clientScope);
    if (!session) {
      return res.status(404).json({ success: false, data: null, error: 'Session not found.' });
    }

    let resp = await RespirationAnalysis.findOne({ sessionId: session.id }).lean();
    if (!resp) {
      await recalculateSessionAnalysis(session.id, session);
      resp = await RespirationAnalysis.findOne({ sessionId: session.id }).lean();
    }
    if (!resp) {
      return res
        .status(500)
        .json({ success: false, data: null, error: 'Unable to generate respiration analysis.' });
    }

    return res.json({
      success: true,
      data: toRespirationReportResponse(session, resp),
      error: null,
    });
  } catch (error) {
    console.error('Get respiration report error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

/**
 * Shared handler for the three signal reports.
 *
 * All follow the same contract: scope the session, read the stored document,
 * compute once if absent, then map. Factored out so the three endpoints cannot
 * drift apart in their scoping or lazy-generation behaviour.
 */
function makeReportHandler({ label, Model, EventModel, sortEvents, mapper }) {
  return async function handler(req, res) {
    try {
      const { sessionId } = req.params;

      const session = await findScopedSession(sessionId, req.clientScope);
      if (!session) {
        return res.status(404).json({ success: false, data: null, error: 'Session not found.' });
      }

      let doc = await Model.findOne({ sessionId: session.id }).lean();
      if (!doc) {
        await recalculateSessionAnalysis(session.id, session);
        doc = await Model.findOne({ sessionId: session.id }).lean();
      }
      if (!doc) {
        return res
          .status(500)
          .json({ success: false, data: null, error: `Unable to generate ${label}.` });
      }

      const events = EventModel
        ? await EventModel.find({ sessionId: session.id }).sort(sortEvents).lean()
        : [];

      return res.json({
        success: true,
        data: EventModel ? mapper(session, doc, events) : mapper(session, doc),
        error: null,
      });
    } catch (error) {
      console.error(`Get ${label} error:`, error);
      return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
    }
  };
}

/** GET /api/admin/readings/:sessionId/reports/spo2 */
const getSpo2Report = makeReportHandler({
  label: 'SpO2 analysis',
  Model: Spo2Analysis,
  EventModel: Spo2Event,
  sortEvents: { startSec: 1 },
  mapper: toSpo2ReportResponse,
});

/** GET /api/admin/readings/:sessionId/reports/temperature */
const getTemperatureReport = makeReportHandler({
  label: 'temperature analysis',
  Model: TemperatureAnalysis,
  EventModel: TemperatureEvent,
  sortEvents: { startSec: 1 },
  mapper: toTemperatureReportResponse,
});

/** GET /api/admin/readings/:sessionId/reports/combined */
const getCombinedReport = makeReportHandler({
  label: 'combined analysis',
  Model: CombinedAnalysis,
  EventModel: null,
  sortEvents: null,
  mapper: toCombinedReportResponse,
});

module.exports = {
  getSpo2Report,
  getTemperatureReport,
  getCombinedReport,
  getEcgRrReport,
  recalculateEcgRrReport,
  getHrvReport,
  getHrvTrend,
  getRhythmReport,
  getRespirationReport,
};
