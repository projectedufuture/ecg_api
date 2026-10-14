/**
 * Evenly downsample an array to at most `points` elements, for VISUALIZATION
 * ONLY (never clinical/PQRST analysis).
 *
 * - Preserves order.
 * - Always keeps the FIRST and the true LAST element, so a waveform preview
 *   starts and ends on real samples and the time axis stays aligned.
 * - Never returns more than `points` elements (+1 only when the forced last
 *   sample is not already the final picked one).
 * - Returns the input array unchanged when it already fits within `points`.
 * - Does NOT mutate the input.
 *
 * @param {Array} arr   Source samples, already in chronological order.
 * @param {number} points Max points to keep (clamped to >= 1).
 * @returns {Array} The decimated array (or the original if it already fits).
 */
function decimateEvenly(arr, points) {
  if (!Array.isArray(arr)) return [];
  const n = arr.length;
  const cap = Math.max(1, Math.floor(points) || 0);
  if (n <= cap) return arr;

  const stride = n / cap;
  const out = [];
  for (let i = 0; i < cap; i += 1) {
    out.push(arr[Math.floor(i * stride)]);
  }
  // Guarantee the trace terminates on the real last sample.
  if (out[out.length - 1] !== arr[n - 1]) out.push(arr[n - 1]);
  return out;
}

/**
 * The stride used to pick ~`points` evenly-spaced samples out of `total` by
 * `seq % stride === 0`. At least 2 (so a session larger than `points` is always
 * thinned), and ceil(total/points) so the result stays within the budget.
 *
 * @param {number} total  Total samples in the session.
 * @param {number} points Target preview size.
 * @returns {number} The modulo stride (>= 2).
 */
function previewStride(total, points) {
  const p = Math.max(1, Math.floor(points) || 0);
  return Math.max(2, Math.ceil(total / p));
}

module.exports = { decimateEvenly, previewStride };
