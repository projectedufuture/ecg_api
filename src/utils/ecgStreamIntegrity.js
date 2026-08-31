/**
 * ECG transmission integrity from the device SEQ counter.
 *
 * The device stamps each ECG frame with SEQ_START and a sample count N, so
 * every individual sample has an implied sequence number. The radio link
 * guarantees neither delivery nor order, so that sequence is the only evidence
 * of what actually arrived:
 *
 *   currentSEQ == previousSEQ + 1   -> continuous stream
 *   currentSEQ >  previousSEQ + 1   -> samples were lost in transmission
 *   currentSEQ <= previousSEQ       -> duplicate, or a late (out-of-order) packet
 *
 * NOTHING is fabricated. A missing SEQ leaves a hole, and that hole is carried
 * forward into every downstream calculation and into the chart. Interpolating
 * across a gap would invent samples the sensor never produced and yield RR
 * intervals with no physiological basis.
 *
 * Frames are expanded into one row per sample at ingest (see
 * rPeakIngest.expandDeviceFrame), so this module works on per-sample SEQ and
 * never has to know about batching.
 */

// ---------------------------------------------------------------------------
// SEQ wrap-around
// ---------------------------------------------------------------------------

/**
 * A packet counter is a fixed-width integer, so it eventually wraps to zero.
 * A wrap looks exactly like a huge backwards jump, and misreading one would
 * either invent a gap of billions of samples or discard a legitimate packet.
 *
 * The width is a FIRMWARE DETAIL that has not been confirmed, so it is not
 * assumed. A backwards step is treated as a wrap only when it looks like one:
 * the previous value sat within a small margin of a plausible boundary, and
 * the new value is near zero. Anything else is reported as out-of-order, which
 * is the conservative reading - it flags data rather than silently accepting it.
 *
 * Set ECG_SEQ_MODULUS to the real width to remove the guesswork entirely.
 */
const CANDIDATE_MODULI = [256, 4096, 65536, 16777216, 4294967296];

// How close to the boundary the previous value must sit, and how close to zero
// the new value must be, for a wrap to be credible.
const WRAP_MARGIN = 64;

function detectWrapModulus(previousSeq, currentSeq, configuredModulus) {
  if (configuredModulus && configuredModulus > 0) {
    // An explicit width was configured: trust it, and only call it a wrap when
    // the numbers are actually consistent with one.
    const wrapped = previousSeq > configuredModulus - WRAP_MARGIN && currentSeq < WRAP_MARGIN;
    return wrapped ? configuredModulus : null;
  }
  for (const modulus of CANDIDATE_MODULI) {
    if (
      previousSeq <= modulus - 1 &&
      previousSeq > modulus - WRAP_MARGIN &&
      currentSeq < WRAP_MARGIN
    ) {
      return modulus;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Gap bookkeeping
// ---------------------------------------------------------------------------

/**
 * A gap is the SEQ range that never arrived, together with the wall-clock
 * window it covers.
 *
 * Gaps are mutable because the radio can deliver late. A packet whose SEQ lands
 * inside a recorded gap is a REAL sample that simply arrived out of order, so it
 * shrinks or splits that gap rather than being written off. Counting it as a
 * permanent loss would overstate the damage.
 */
function newGap(previousSeq, currentSeq, previousTimestamp, currentTimestamp) {
  return {
    // The last SEQ that DID arrive before the hole, and the first that arrived
    // after it. The missing values are strictly between them.
    previousSeq,
    currentSeq,
    gapStartSeq: previousSeq + 1,
    gapEndSeq: currentSeq - 1,
    missingSampleCount: currentSeq - previousSeq - 1,
    // Wall-clock bounds, taken from the packets either side. Everything between
    // these two instants is unrecorded.
    gapStart: previousTimestamp,
    gapEnd: currentTimestamp,
  };
}

function gapDurationMs(gap) {
  const a = Date.parse(gap.gapStart);
  const b = Date.parse(gap.gapEnd);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, b - a);
}

/**
 * Absorb a late packet into the gap list.
 *
 * Returns true when the SEQ belonged to a known gap (so it is a genuine, late
 * sample) and false when it does not (a packet from outside the tracked window).
 */
function fillGap(gaps, seq, timestamp) {
  for (let i = 0; i < gaps.length; i += 1) {
    const gap = gaps[i];
    if (seq < gap.gapStartSeq || seq > gap.gapEndSeq) continue;

    const before =
      seq > gap.gapStartSeq
        ? {
            ...gap,
            currentSeq: seq,
            gapEndSeq: seq - 1,
            missingSampleCount: seq - gap.gapStartSeq,
            gapEnd: timestamp || gap.gapEnd,
          }
        : null;
    const after =
      seq < gap.gapEndSeq
        ? {
            ...gap,
            previousSeq: seq,
            gapStartSeq: seq + 1,
            missingSampleCount: gap.gapEndSeq - seq,
            gapStart: timestamp || gap.gapStart,
          }
        : null;

    gaps.splice(i, 1, ...[before, after].filter(Boolean));
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The analysis
// ---------------------------------------------------------------------------

const REJECT_REASON = {
  DUPLICATE: 'duplicate_seq',
  OUT_OF_ORDER: 'out_of_order_seq',
  NO_SEQ: 'no_seq',
};

/**
 * Analyse the SEQ continuity of one session's ECG samples.
 *
 * @param {Array} samples Rows in ARRIVAL order - the order matters, since that
 *   is what makes an out-of-order packet detectable at all. Each needs `seq`
 *   (number|null) and `timestamp` (ISO string).
 * @param {object} options
 * @param {number} [options.seqModulus] Known SEQ width, if the firmware's is known.
 * @param {number} [options.maxGaps] Cap on the gap list kept for reporting.
 * @param {number} [options.significantGapMs] A gap at least this long is
 *   "significant": long enough to invalidate measurements that span it.
 */
function analyseEcgStream(samples, options = {}) {
  const rows = samples || [];
  const seqModulus = options.seqModulus || 0;
  const maxGaps = options.maxGaps || 500;
  const significantGapMs = options.significantGapMs ?? 40;

  let totalSamples = 0;
  let sequencedSamples = 0;
  let unsequencedSamples = 0;
  let validSamples = 0;
  let duplicateSamples = 0;
  let outOfOrderSamples = 0;
  let lateFilledSamples = 0;
  let wrapCount = 0;

  const gaps = [];
  let droppedGapRecords = 0;

  // The highest in-order SEQ seen so far. A late packet must NOT move this
  // backwards: doing so would make the next in-order packet look like a huge
  // gap, turning one reordering into two phantom faults.
  let highWaterSeq = null;
  let highWaterTimestamp = null;
  let firstSeq = null;

  // Every SEQ accepted so far, so a repeat is recognised as a duplicate rather
  // than mistaken for a late arrival.
  const seen = new Set();

  for (const row of rows) {
    totalSamples += 1;
    const seq = row && typeof row.seq === 'number' && Number.isFinite(row.seq) ? row.seq : null;
    const timestamp = (row && row.timestamp) || null;

    if (seq === null || seq < 0) {
      // A sample with no SEQ cannot be placed in the sequence. It is counted
      // and kept, but it can neither prove continuity nor prove a gap.
      unsequencedSamples += 1;
      continue;
    }

    sequencedSamples += 1;

    if (highWaterSeq === null) {
      firstSeq = seq;
      highWaterSeq = seq;
      highWaterTimestamp = timestamp;
      seen.add(seq);
      validSamples += 1;
      continue;
    }

    if (seq === highWaterSeq + 1) {
      // Continuous.
      highWaterSeq = seq;
      highWaterTimestamp = timestamp;
      seen.add(seq);
      validSamples += 1;
      continue;
    }

    if (seq > highWaterSeq + 1) {
      // Samples were lost between the previous sample and this one.
      if (gaps.length < maxGaps) {
        gaps.push(newGap(highWaterSeq, seq, highWaterTimestamp, timestamp));
      } else {
        droppedGapRecords += 1;
      }
      highWaterSeq = seq;
      highWaterTimestamp = timestamp;
      seen.add(seq);
      validSamples += 1;
      continue;
    }

    // seq <= highWaterSeq: a wrap, a duplicate, or a late packet.
    const modulus = detectWrapModulus(highWaterSeq, seq, seqModulus);
    if (modulus) {
      wrapCount += 1;
      const missing = modulus - 1 - highWaterSeq + seq;
      if (missing > 0) {
        if (gaps.length < maxGaps) {
          const gap = newGap(highWaterSeq, highWaterSeq + missing + 1, highWaterTimestamp, timestamp);
          gap.acrossWrap = true;
          gaps.push(gap);
        } else {
          droppedGapRecords += 1;
        }
      }
      highWaterSeq = seq;
      highWaterTimestamp = timestamp;
      seen.clear();
      seen.add(seq);
      validSamples += 1;
      continue;
    }

    if (seen.has(seq)) {
      // The same sample twice. NOT accepted as a new ECG sample: doing so would
      // duplicate a point in the waveform and bias every derived statistic.
      duplicateSamples += 1;
      continue;
    }

    // A SEQ below the high-water mark that has not been seen: it arrived late.
    // If it belongs to a recorded gap it is a real sample and closes part of
    // that hole. Otherwise it is out of order with no gap to explain it.
    outOfOrderSamples += 1;
    seen.add(seq);
    if (fillGap(gaps, seq, timestamp)) {
      lateFilledSamples += 1;
      validSamples += 1;
    }
  }

  const liveGaps = gaps.filter((g) => g.missingSampleCount > 0);
  const missingSamples = liveGaps.reduce((sum, g) => sum + g.missingSampleCount, 0);

  // What the device intended to send across the span observed. Wraps are folded
  // in through the gap accounting above.
  const expectedSamples = sequencedSamples > 0 ? validSamples + missingSamples : 0;

  const signalQualityPercentage =
    expectedSamples > 0 ? round((validSamples / expectedSamples) * 100, 2) : null;

  const significantGaps = liveGaps.filter((g) => {
    const ms = gapDurationMs(g);
    return ms === null ? false : ms >= significantGapMs;
  });

  return {
    // The six figures the ECG report must show.
    totalSamples,
    validSamples,
    duplicateSamples,
    outOfOrderSamples,
    missingSamples,
    signalQualityPercentage,

    expectedSamples,
    sequencedSamples,
    unsequencedSamples,
    lateFilledSamples,

    gapCount: liveGaps.length,
    significantGapCount: significantGaps.length,
    largestGapSamples: liveGaps.reduce((m, g) => Math.max(m, g.missingSampleCount), 0),
    gaps: liveGaps.map((g) => ({
      previousSeq: g.previousSeq,
      currentSeq: g.currentSeq,
      gapStartSeq: g.gapStartSeq,
      gapEndSeq: g.gapEndSeq,
      missingSampleCount: g.missingSampleCount,
      gapStart: g.gapStart,
      gapEnd: g.gapEnd,
      durationMs: gapDurationMs(g),
      acrossWrap: g.acrossWrap === true,
    })),
    droppedGapRecords,

    seqFirst: firstSeq,
    seqLast: highWaterSeq,
    wrapCount,
  };
}

/**
 * Wall-clock windows in which no ECG was recorded.
 *
 * This is the form the beat validation needs: a list of [from, to] epoch-ms
 * intervals it can test a heartbeat's waveform region against.
 */
function gapWindows(streamResult, { significantOnly = true, significantGapMs = 40 } = {}) {
  const gaps = (streamResult && streamResult.gaps) || [];
  const windows = [];
  for (const gap of gaps) {
    const from = Date.parse(gap.gapStart);
    const to = Date.parse(gap.gapEnd);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue;
    if (significantOnly && to - from < significantGapMs) continue;
    windows.push({ from, to, missingSampleCount: gap.missingSampleCount });
  }
  return windows.sort((a, b) => a.from - b.from);
}

/** Does [from, to] touch any recorded gap? */
function overlapsGap(windows, from, to) {
  for (const w of windows || []) {
    if (w.from < to && from < w.to) return true;
  }
  return false;
}

function round(value, dp) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}

module.exports = {
  analyseEcgStream,
  gapWindows,
  overlapsGap,
  detectWrapModulus,
  fillGap,
  newGap,
  REJECT_REASON,
  CANDIDATE_MODULI,
  WRAP_MARGIN,
};
