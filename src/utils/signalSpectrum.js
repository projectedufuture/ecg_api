/**
 * Minimal DSP helpers shared by the respiration estimators.
 *
 * Pure functions, no dependencies. Deliberately small: only what is needed to
 * pull a dominant frequency out of a slow, unevenly sampled physiological
 * signal, with the limitations made explicit rather than hidden.
 */

/** Arithmetic mean, or null for an empty list. */
function mean(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Resample an unevenly sampled series onto a uniform grid by linear
 * interpolation.
 *
 * RR intervals arrive one per heartbeat, so the tachogram is inherently uneven;
 * spectral analysis needs an even grid. Linear interpolation is the standard
 * choice for RR tachograms at these frequencies.
 *
 * @param {number[]} t Sample times in seconds, strictly increasing.
 * @param {number[]} v Sample values.
 * @param {number} rateHz Output sampling rate.
 * @returns {{values:number[], rateHz:number, durationSec:number}|null}
 */
function resampleUniform(t, v, rateHz) {
  if (t.length < 2 || t.length !== v.length || rateHz <= 0) return null;

  const start = t[0];
  const end = t[t.length - 1];
  const durationSec = end - start;
  if (durationSec <= 0) return null;

  const n = Math.floor(durationSec * rateHz) + 1;
  if (n < 2) return null;

  const values = new Array(n);
  let j = 0;
  for (let i = 0; i < n; i += 1) {
    const target = start + i / rateHz;
    // Advance to the bracketing pair for this target time.
    while (j < t.length - 2 && t[j + 1] < target) j += 1;
    const t0 = t[j];
    const t1 = t[j + 1];
    const span = t1 - t0;
    const w = span > 0 ? (target - t0) / span : 0;
    values[i] = v[j] + (v[j + 1] - v[j]) * Math.max(0, Math.min(1, w));
  }

  return { values, rateHz, durationSec };
}

/**
 * Remove the mean and any linear trend.
 *
 * A slow drift (posture change, baseline wander) otherwise leaks broadband
 * power into the low-frequency end and can masquerade as a respiratory peak.
 */
function detrend(values) {
  const n = values.length;
  if (n < 2) return values.slice();

  // Least-squares fit of value = a + b * index.
  const meanIndex = (n - 1) / 2;
  const meanValue = mean(values);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (i - meanIndex) * (values[i] - meanValue);
    den += (i - meanIndex) ** 2;
  }
  const slope = den > 0 ? num / den : 0;

  return values.map((value, i) => value - (meanValue + slope * (i - meanIndex)));
}

/**
 * Hann window — tapers the ends so the record's abrupt start and stop do not
 * smear energy across the spectrum.
 */
function hannWindow(values) {
  const n = values.length;
  if (n < 2) return values.slice();
  return values.map((value, i) => value * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1))));
}

/**
 * Power spectrum evaluated only at the frequencies of interest.
 *
 * A direct DFT restricted to a narrow band is far simpler than a full FFT and
 * costs less here: the respiratory band is ~80 bins wide, while an FFT would
 * compute thousands that are then discarded.
 *
 * Frequency *resolution* is still governed by the record length (~1/T); a finer
 * step only interpolates between genuinely independent bins, so callers are
 * given `resolutionHz` to report alongside the result.
 *
 * @param {number[]} values Uniformly sampled, detrended, windowed signal.
 * @param {number} rateHz Sampling rate of `values`.
 * @param {number} fromHz Low edge of the band.
 * @param {number} toHz High edge of the band.
 * @param {number} stepHz Evaluation step.
 * @returns {{freqs:number[], power:number[], resolutionHz:number}|null}
 */
function bandPowerSpectrum(values, rateHz, fromHz, toHz, stepHz) {
  const n = values.length;
  if (n < 4 || rateHz <= 0 || toHz <= fromHz) return null;

  // Nothing above Nyquist can be resolved.
  const nyquist = rateHz / 2;
  const hi = Math.min(toHz, nyquist);
  if (hi <= fromHz) return null;

  const durationSec = n / rateHz;
  const resolutionHz = 1 / durationSec;

  const freqs = [];
  const power = [];

  for (let f = fromHz; f <= hi + 1e-12; f += stepHz) {
    let re = 0;
    let im = 0;
    const w = (2 * Math.PI * f) / rateHz;
    for (let i = 0; i < n; i += 1) {
      re += values[i] * Math.cos(w * i);
      im -= values[i] * Math.sin(w * i);
    }
    freqs.push(f);
    power.push((re * re + im * im) / (n * n));
  }

  return { freqs, power, resolutionHz };
}

/**
 * Locate the dominant spectral peak and score how much it stands out.
 *
 * `prominence` is peak power divided by the mean power across the band. A broad,
 * flat spectrum (noise) gives a value near 1; a clear periodic component gives
 * a much larger one. This is what separates "there is a breathing rhythm here"
 * from "this is a number produced by noise".
 *
 * @returns {{freqHz:number, power:number, prominence:number}|null}
 */
function dominantPeak(spectrum) {
  if (!spectrum || !spectrum.power.length) return null;

  let bestIndex = 0;
  for (let i = 1; i < spectrum.power.length; i += 1) {
    if (spectrum.power[i] > spectrum.power[bestIndex]) bestIndex = i;
  }

  const peakPower = spectrum.power[bestIndex];
  const averagePower = mean(spectrum.power);
  if (!averagePower || peakPower <= 0) return null;

  return {
    freqHz: spectrum.freqs[bestIndex],
    power: peakPower,
    prominence: peakPower / averagePower,
  };
}

module.exports = {
  mean,
  resampleUniform,
  detrend,
  hannWindow,
  bandPowerSpectrum,
  dominantPeak,
};
