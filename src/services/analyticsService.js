/**
 * Pure analytics maths for the training-load feature. Mirrors the Flutter
 * `FitnessFormulas` / `AnalyticsService` exactly so the server-side result and
 * the app's offline fallback agree. No Express/Mongoose here — unit-tested with
 * node:test like the rest of the suite.
 *
 * Every function returns null when inputs are insufficient (never NaN/Infinity).
 */

const ANALYTICS_PERIODS = ['day', 'week', 'month', 'year'];
const WINDOW_DAYS = 28;

/** Tanaka (2001) HRmax = 208 − 0.7·age. Mirrors the app's profile formula. */
function maxHrFromAge(age) {
  const a = Number(age);
  if (!Number.isFinite(a) || a <= 0 || a > 120) return null;
  return Math.round(208 - 0.7 * a);
}

/** Banister TRIMP for one bout; null when inputs are insufficient. */
function trimp({ minutes, hrAvg, hrRest, hrMax }) {
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  if (!Number.isFinite(hrAvg) || !Number.isFinite(hrRest) || !Number.isFinite(hrMax)) {
    return null;
  }
  if (hrMax <= hrRest) return null;
  const x = (hrAvg - hrRest) / (hrMax - hrRest);
  if (!Number.isFinite(x) || x <= 0) return null;
  const xc = x > 1 ? 1 : x;
  const value = minutes * xc * 0.64 * Math.exp(1.92 * xc);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function acwr(acute, chronic) {
  if (!(chronic > 1e-9)) return null;
  const r = acute / chronic;
  return Number.isFinite(r) ? r : null;
}

function acwrLabel(ratio) {
  if (ratio == null) return 'insufficient';
  if (ratio > 1.5) return 'spike';
  if (ratio >= 0.8 && ratio <= 1.3) return 'steady';
  if (ratio < 0.8) return 'low';
  return 'elevated';
}

function monotony(dailyLoads) {
  if (!Array.isArray(dailyLoads) || dailyLoads.length < 2) return null;
  const mean = dailyLoads.reduce((a, b) => a + b, 0) / dailyLoads.length;
  if (mean <= 1e-9) return null;
  let sumSq = 0;
  for (const v of dailyLoads) sumSq += (v - mean) * (v - mean);
  const sd = Math.sqrt(sumSq / dailyLoads.length);
  if (sd <= 1e-9) return null;
  const m = mean / sd;
  return Number.isFinite(m) ? m : null;
}

function mean(xs) {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Local calendar day string YYYY-MM-DD for a Date. */
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Compute the full analytics payload from activity records + profile.
 *
 * @param {Array} activities  each: { activityType, startedAt(ISO), activeDurationSeconds,
 *                                    distanceMeters, calories, averageHeartRate }
 * @param {Object} opts { age, restingHeartRate, period, now? }
 */
function computeAnalytics(activities, { age, restingHeartRate, period = 'week', now } = {}) {
  const ref = now ? new Date(now) : new Date();
  const today = startOfDay(ref);
  const hrMax = maxHrFromAge(age);
  const hrRest = Number.isFinite(Number(restingHeartRate)) && Number(restingHeartRate) > 0
    ? Number(restingHeartRate)
    : null;
  const hasRestingHr = hrRest != null;

  const acts = (activities || []).map((a) => ({
    ...a,
    _date: startOfDay(new Date(a.startedAt)),
  }));

  // Per-activity TRIMP → daily map.
  const daily = new Map();
  for (const a of acts) {
    const t = trimp({
      minutes: (Number(a.activeDurationSeconds) || 0) / 60,
      hrAvg: Number(a.averageHeartRate),
      hrRest,
      hrMax,
    });
    if (t == null) continue;
    const key = ymd(a._date);
    daily.set(key, (daily.get(key) || 0) + t);
  }

  // 28-day series + rolling 7.
  const days = [];
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const day = new Date(today.getTime() - i * 86400000);
    const key = ymd(day);
    const t = daily.get(key) || 0;
    let sum7 = 0;
    for (let k = 0; k < 7; k++) {
      const d = new Date(day.getTime() - k * 86400000);
      sum7 += daily.get(ymd(d)) || 0;
    }
    days.push({
      date: key,
      trimp: round2(t),
      rolling7: round2(sum7 / 7),
    });
  }

  const last7 = days.slice(-7).map((d) => d.trimp);
  const all28 = days.map((d) => d.trimp);
  const acute7 = mean(last7) || 0;
  const chronic28 = mean(all28) || 0;

  // ACWR needs ≥14 days of history and non-zero chronic.
  let earliest = null;
  for (const a of acts) {
    if (!earliest || a._date < earliest) earliest = a._date;
  }
  const daysOfHistory = earliest ? Math.floor((today - earliest) / 86400000) + 1 : 0;
  const enoughHistory = daysOfHistory >= 14;

  let ratio = null;
  let label = 'insufficient';
  if (hasRestingHr && enoughHistory) {
    ratio = acwr(acute7, chronic28);
    label = acwrLabel(ratio);
  }

  const load7Sum = hasRestingHr ? last7.reduce((a, b) => a + b, 0) : null;
  const avgWeek28 = hasRestingHr ? all28.reduce((a, b) => a + b, 0) / 4 : null;
  const mono = hasRestingHr ? monotony(last7) : null;
  const trimpToday = hasRestingHr ? (daily.get(ymd(today)) || 0) : null;

  // Monthly series (last 12 months).
  const months = monthlySeries(acts, ref, hrRest, hrMax);

  // Period stats.
  const stats = statsForPeriod(acts, period, ref);

  return {
    period,
    hasRestingHr,
    load7Sum: nOrNull(load7Sum),
    avgWeek28: nOrNull(avgWeek28),
    acwr: nOrNull(ratio),
    acwrLabel: label,
    monotony: nOrNull(mono),
    trimpToday: nOrNull(trimpToday),
    days,
    months,
    stats,
  };
}

function monthlySeries(acts, ref, hrRest, hrMax) {
  const buckets = new Map();
  const order = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(ref.getFullYear(), ref.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${d.getMonth() + 1}`;
    buckets.set(key, { year: d.getFullYear(), month: d.getMonth() + 1, trimp: 0, activityCount: 0 });
    order.push(key);
  }
  for (const a of acts) {
    const d = new Date(a.startedAt);
    const key = `${d.getFullYear()}-${d.getMonth() + 1}`;
    const b = buckets.get(key);
    if (!b) continue;
    const t = trimp({
      minutes: (Number(a.activeDurationSeconds) || 0) / 60,
      hrAvg: Number(a.averageHeartRate),
      hrRest,
      hrMax,
    }) || 0;
    b.trimp += t;
    b.activityCount += 1;
  }
  return order.map((k) => {
    const b = buckets.get(k);
    return { year: b.year, month: b.month, trimp: round2(b.trimp), activityCount: b.activityCount };
  });
}

function statsForPeriod(acts, period, ref) {
  const today = startOfDay(ref);
  const inPeriod = (a) => {
    const d = new Date(a.startedAt);
    const day = startOfDay(d);
    switch (period) {
      case 'day':
        return day.getTime() === today.getTime();
      case 'week':
        return day.getTime() >= today.getTime() - 6 * 86400000;
      case 'month':
        return d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth();
      case 'year':
        return d.getFullYear() === ref.getFullYear();
      default:
        return false;
    }
  };
  const inRange = acts.filter(inPeriod);
  let distance = 0;
  let calories = 0;
  let activeSec = 0;
  let hrSum = 0;
  let hrCount = 0;
  for (const a of inRange) {
    distance += Number(a.distanceMeters) || 0;
    calories += Number(a.calories) || 0;
    activeSec += Number(a.activeDurationSeconds) || 0;
    if (Number(a.averageHeartRate) > 0) {
      hrSum += Number(a.averageHeartRate);
      hrCount += 1;
    }
  }
  return {
    activityCount: inRange.length,
    totalDistanceMeters: round2(distance),
    totalCalories: Math.round(calories),
    totalActiveSeconds: Math.round(activeSec),
    avgHeartRate: hrCount > 0 ? Math.round(hrSum / hrCount) : null,
  };
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
function nOrNull(n) {
  return n == null || !Number.isFinite(Number(n)) ? null : round2(n);
}

module.exports = {
  ANALYTICS_PERIODS,
  maxHrFromAge,
  trimp,
  acwr,
  acwrLabel,
  monotony,
  mean,
  computeAnalytics,
};
