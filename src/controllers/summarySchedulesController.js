const crypto = require('crypto');
const EmailSchedule = require('../models/EmailSchedule');
const { computeNextRun, runSchedule } = require('../services/summaryScheduler');

const genId = () => `sch_${crypto.randomBytes(8).toString('hex')}`;

// clientId a new/updated schedule should carry: a client_admin is locked to
// their own client; a super_admin's schedule is global (null = all clients).
function scopeFor(req) {
  return req.admin.role === 'super_admin' ? null : req.admin.clientId;
}

/**
 * GET /admin/summary-schedules
 * Lists the caller's in-scope schedules, newest first.
 */
async function listSchedules(req, res) {
  try {
    const filter = {};
    if (req.clientScope) filter.clientId = req.clientScope;

    const docs = await EmailSchedule.find(filter).sort({ createdAt: -1 });
    return res.json({
      success: true,
      data: docs.map((d) => d.toFrontend()),
      error: null,
    });
  } catch (error) {
    console.error('List summary schedules error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

/**
 * POST /admin/summary-schedules
 * Body: { name, recipientEmail, frequency, timeOfDay, weekday?, timezone?, enabled? }
 */
async function createSchedule(req, res) {
  try {
    const { name, recipientEmail, frequency, timeOfDay, weekday, timezone, enabled } = req.body;

    const doc = new EmailSchedule({
      id: genId(),
      name: name.trim(),
      recipientEmail: recipientEmail.trim().toLowerCase(),
      frequency,
      timeOfDay,
      weekday: frequency === 'weekly' ? Number(weekday) : 1,
      timezone: timezone || 'Asia/Kolkata',
      enabled: enabled !== false,
      clientId: scopeFor(req),
      createdBy: req.admin.id || null,
      createdByName: req.admin.name || null,
    });

    doc.nextRunAt = doc.enabled ? computeNextRun(doc, new Date()) : null;
    await doc.save();

    return res.status(201).json({ success: true, data: doc.toFrontend(), error: null });
  } catch (error) {
    console.error('Create summary schedule error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

/**
 * PUT /admin/summary-schedules/:id
 * Updates fields and recomputes the next run.
 */
async function updateSchedule(req, res) {
  try {
    const filter = { id: req.params.id };
    if (req.clientScope) filter.clientId = req.clientScope;

    const doc = await EmailSchedule.findOne(filter);
    if (!doc) {
      return res.status(404).json({ success: false, data: null, error: 'Schedule not found.' });
    }

    const { name, recipientEmail, frequency, timeOfDay, weekday, timezone, enabled } = req.body;
    if (name !== undefined) doc.name = name.trim();
    if (recipientEmail !== undefined) doc.recipientEmail = recipientEmail.trim().toLowerCase();
    if (frequency !== undefined) doc.frequency = frequency;
    if (timeOfDay !== undefined) doc.timeOfDay = timeOfDay;
    if (weekday !== undefined) doc.weekday = Number(weekday);
    if (timezone !== undefined) doc.timezone = timezone;
    if (enabled !== undefined) doc.enabled = enabled;

    doc.nextRunAt = doc.enabled ? computeNextRun(doc, new Date()) : null;
    await doc.save();

    return res.json({ success: true, data: doc.toFrontend(), error: null });
  } catch (error) {
    console.error('Update summary schedule error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

/**
 * DELETE /admin/summary-schedules/:id
 */
async function deleteSchedule(req, res) {
  try {
    const filter = { id: req.params.id };
    if (req.clientScope) filter.clientId = req.clientScope;

    const doc = await EmailSchedule.findOneAndDelete(filter);
    if (!doc) {
      return res.status(404).json({ success: false, data: null, error: 'Schedule not found.' });
    }
    return res.json({ success: true, data: { id: req.params.id }, error: null });
  } catch (error) {
    console.error('Delete summary schedule error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

/**
 * POST /admin/summary-schedules/:id/send-now
 * Sends the digest immediately (a test/manual run). Does not change the cadence.
 */
async function sendNow(req, res) {
  try {
    const filter = { id: req.params.id };
    if (req.clientScope) filter.clientId = req.clientScope;

    const doc = await EmailSchedule.findOne(filter);
    if (!doc) {
      return res.status(404).json({ success: false, data: null, error: 'Schedule not found.' });
    }

    const now = new Date();
    const digest = await runSchedule(doc, now);
    doc.lastRunAt = now;
    doc.lastStatus = 'success';
    doc.lastError = null;
    doc.lastSessionCount = digest.sessionCount;
    await doc.save();

    return res.json({
      success: true,
      data: { sessionCount: digest.sessionCount, activeUserCount: digest.activeUserCount },
      error: null,
    });
  } catch (error) {
    console.error('Send-now summary schedule error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Failed to send summary email.' });
  }
}

module.exports = {
  listSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  sendNow,
};
