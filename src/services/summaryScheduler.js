const EmailSchedule = require('../models/EmailSchedule');
const { buildSummaryDigest } = require('../utils/summaryDigest');
const { sendSummaryEmail } = require('../utils/emailService');

// How often the ticker wakes up to look for due schedules.
const TICK_MS = 60 * 1000;

// ── Timezone helpers ─────────────────────────────────────────────────────────
// We store the send time as local "HH:MM" (+ weekday) in an IANA timezone, and
// must turn that into an absolute UTC instant — DST included. Intl gives us the
// zone's wall-clock for any instant, so we convert a wanted wall-clock to UTC by
// measuring the offset at a first guess and correcting once (enough except for
// the ~1h/year DST-transition ambiguity, which is harmless for a digest).
function zoneOffsetMs(utcMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const m = {};
  for (const p of parts) m[p.type] = p.value;
  let hour = parseInt(m.hour, 10);
  if (hour === 24) hour = 0; // some engines render midnight as "24"
  const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, hour, +m.minute, +m.second);
  return asUTC - utcMs;
}

// Wall-clock (y/mo/d/h/min) in `timeZone` → UTC Date.
function zonedWallClockToUtc(y, mo, d, h, min, timeZone) {
  const guess = Date.UTC(y, mo, d, h, min, 0);
  const offset = zoneOffsetMs(guess, timeZone);
  return new Date(guess - offset);
}

// The zone's current wall-clock parts for a given instant.
function wallClockParts(utcDate, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = dtf.formatToParts(utcDate);
  const m = {};
  for (const p of parts) m[p.type] = p.value;
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hour = parseInt(m.hour, 10);
  if (hour === 24) hour = 0;
  return {
    year: +m.year,
    month: +m.month - 1,
    day: +m.day,
    hour,
    minute: +m.minute,
    weekday: weekdayMap[m.weekday],
  };
}

/**
 * Next UTC instant at which this schedule should fire, strictly after `from`.
 * daily  → next day whose local time is timeOfDay.
 * weekly → next occurrence of (weekday, timeOfDay).
 */
function computeNextRun(schedule, from = new Date()) {
  const tz = schedule.timezone || 'UTC';
  const [hh, mm] = String(schedule.timeOfDay || '00:00').split(':').map((n) => parseInt(n, 10));
  const hour = Number.isFinite(hh) ? hh : 0;
  const minute = Number.isFinite(mm) ? mm : 0;

  // Walk forward day by day (local date) until we find one strictly after `from`
  // that also matches the weekday (for weekly). 8 days covers any weekly slot.
  const nowParts = wallClockParts(from, tz);
  for (let i = 0; i < 8; i += 1) {
    // Build the local date i days ahead by adding i*24h to a local-noon anchor,
    // then re-reading its local calendar date (robust across DST shifts).
    const anchor = zonedWallClockToUtc(nowParts.year, nowParts.month, nowParts.day + i, 12, 0, tz);
    const dayParts = wallClockParts(anchor, tz);
    if (schedule.frequency === 'weekly' && dayParts.weekday !== Number(schedule.weekday)) {
      continue;
    }
    const candidate = zonedWallClockToUtc(dayParts.year, dayParts.month, dayParts.day, hour, minute, tz);
    if (candidate.getTime() > from.getTime()) {
      return candidate;
    }
  }
  // Fallback: 24h out (should not be reached).
  return new Date(from.getTime() + 24 * 60 * 60 * 1000);
}

// Window of activity the digest covers: from the previous expected fire to now.
function digestWindow(schedule, now) {
  const periodMs = schedule.frequency === 'weekly'
    ? 7 * 24 * 60 * 60 * 1000
    : 24 * 60 * 60 * 1000;
  const from = schedule.lastRunAt
    ? new Date(schedule.lastRunAt)
    : new Date(now.getTime() - periodMs);
  return { from, to: now };
}

async function runSchedule(schedule, now) {
  const { from, to } = digestWindow(schedule, now);
  const digest = await buildSummaryDigest({ from, to, clientScope: schedule.clientId || null });

  const periodLabel = schedule.frequency === 'weekly' ? 'Weekly' : 'Daily';
  const tz = schedule.timezone || 'UTC';
  const fmt = (d) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(d);
  const rangeLabel = `${fmt(from)} → ${fmt(to)}`;
  const scopeLabel = schedule.clientId ? `Scope: ${schedule.clientId}` : 'Scope: All clients';

  await sendSummaryEmail({
    toEmail: schedule.recipientEmail,
    periodLabel,
    rangeLabel,
    timezone: tz,
    digest,
    scopeLabel,
  });

  return digest;
}

let timer = null;
let ticking = false;

async function tick() {
  if (ticking) return; // never overlap ticks
  ticking = true;
  const now = new Date();
  try {
    // Claim one due schedule at a time. The claim is a single atomic
    // findOneAndUpdate guarded on the current nextRunAt: whichever worker (or
    // overlapping tick) wins advances the slot and gets the doc; the loser's
    // update matches nothing and skips. This prevents double-sending the same
    // slot even if the API runs on more than one instance.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const due = await EmailSchedule.findOne({
        enabled: true,
        nextRunAt: { $ne: null, $lte: now },
      }).lean();
      if (!due) break;

      const doc = await EmailSchedule.findOneAndUpdate(
        { id: due.id, enabled: true, nextRunAt: due.nextRunAt },
        { $set: { nextRunAt: computeNextRun(due, now), lastStatus: 'pending' } },
        { new: true }
      );
      if (!doc) continue; // another worker claimed this slot first

      try {
        const digest = await runSchedule(doc, now);
        doc.lastRunAt = now;
        doc.lastStatus = 'success';
        doc.lastError = null;
        doc.lastSessionCount = digest.sessionCount;
        await doc.save();
        console.log(`[summaryScheduler] sent "${doc.name}" → ${doc.recipientEmail} (${digest.sessionCount} sessions)`);
      } catch (err) {
        doc.lastRunAt = now;
        doc.lastStatus = 'failed';
        doc.lastError = String(err.message || err).slice(0, 500);
        await doc.save();
        console.error(`[summaryScheduler] failed "${doc.name}":`, err.message);
      }
    }
  } catch (err) {
    console.error('[summaryScheduler] tick error:', err.message);
  } finally {
    ticking = false;
  }
}

function startScheduler() {
  if (timer) return;
  // First tick shortly after boot, then on the fixed interval.
  timer = setInterval(tick, TICK_MS);
  setTimeout(tick, 5000);
  console.log('[summaryScheduler] started');
}

module.exports = { startScheduler, computeNextRun, runSchedule, tick };
