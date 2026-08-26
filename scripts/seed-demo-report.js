/**
 * Insert ONE clearly-labelled demo user + device + session with realistic
 * R-peak and PPG data, so all four report modules render with real analysis.
 *
 *   node scripts/seed-demo-report.js          # insert (and analyse)
 *   node scripts/seed-demo-report.js --remove # delete everything it created
 *
 * Everything it writes carries a DEMO id, so removal is exact. It touches no
 * pre-existing document.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const User = require('../src/models/User');
const Device = require('../src/models/Device');
const Session = require('../src/models/Session');
const Reading = require('../src/models/Reading');
const EcgRrAnalysis = require('../src/models/EcgRrAnalysis');
const EcgRrEvent = require('../src/models/EcgRrEvent');
const HrvAnalysis = require('../src/models/HrvAnalysis');
const RhythmAnalysis = require('../src/models/RhythmAnalysis');
const RhythmEvent = require('../src/models/RhythmEvent');
const RespirationAnalysis = require('../src/models/RespirationAnalysis');
const { recalculateSessionAnalysis } = require('../src/services/ecgRrService');

// Everything this script owns. Nothing else is ever touched.
const DEMO = {
  userId: 'USR-DEMO000001',
  deviceId: 'ECG-DEMO1',
  sessionId: 'sess_demo_report_sample',
  clientId: 'CLIENT-001',
};

/** Respiratory sinus arrhythmia: NN modulated at `respHz`, so EDR can find it. */
function rsaIntervals({ durationSec, baseRrMs = 820, modulationMs = 45, respHz = 0.25 }) {
  const out = [];
  let elapsed = 0;
  while (elapsed < durationSec) {
    const nn = Math.round(baseRrMs + modulationMs * Math.sin(2 * Math.PI * respHz * elapsed));
    out.push(nn);
    elapsed += nn / 1000;
  }
  return out;
}

const run = (count, ms, jitter) =>
  Array.from({ length: count }, (_, i) => ms + ((i % 5) - 2) * jitter);

/**
 * The recording. Shaped so every module has something real to report:
 * baseline RSA breathing, a sustained fast stretch, a sustained slow stretch,
 * and a few isolated artifacts.
 */
function buildRrList() {
  return [
    ...rsaIntervals({ durationSec: 150 }), // calm baseline
    ...run(110, 520, 6), // ~115 BPM sustained -> elevated-HR period
    ...rsaIntervals({ durationSec: 90 }),
    2300, // isolated long interval -> possible long RR
    ...rsaIntervals({ durationSec: 60 }),
    1640, // ~2x baseline -> possible missed beat
    ...rsaIntervals({ durationSec: 60 }),
    410,
    410, // pair summing to one beat -> possible double detection
    ...rsaIntervals({ durationSec: 60 }),
    ...run(110, 1150, 12), // ~52 BPM sustained -> low-HR period
    ...rsaIntervals({ durationSec: 120 }),
  ];
}

/**
 * Turn the interval list into stored readings.
 *
 * One reading per detected beat carries BEAT/R_TIME; two filler readings sit
 * between beats so the raw PPG waveform is sampled densely enough for the
 * PPG-derived respiration estimate.
 */
function buildReadings({ rrList, startEpoch, ppgRespHz = 0.26 }) {
  const readings = [];
  let deviceClock = 500000; // arbitrary monotonic device counter
  let elapsedMs = 0;

  const ppg = (ms) => ({
    ppgIr: Math.round(
      100000 +
        950 * Math.sin((2 * Math.PI * ppgRespHz * ms) / 1000) +
        320 * Math.sin((2 * Math.PI * 1.2 * ms) / 1000)
    ),
    ppgRed: Math.round(92000 + 820 * Math.sin((2 * Math.PI * ppgRespHz * ms) / 1000)),
  });

  const base = {
    temperatureCelsius: 36.7,
    deviceId: DEMO.deviceId,
    ecgQuality: 1,
    leadOff: false,
  };

  const pushBeat = (ms) => {
    readings.push({
      ...base,
      ...ppg(ms),
      timestamp: new Date(startEpoch + ms).toISOString(),
      ecgValue: 4671,
      // HR/SpO2 sentinels: this device reports 0 when unmeasured, and the
      // analysis derives heart rate from the RR timing instead.
      hr: 0,
      spo2: 98,
      beat: true,
      rPeakTimestamp: deviceClock + ms,
      beatConfidence: 0.96,
      rrIntervalMs: null,
    });
  };

  pushBeat(0);
  for (const rr of rrList) {
    // Two filler samples between beats (BEAT:0, still repeating the last RR).
    for (let k = 1; k <= 2; k += 1) {
      const ms = elapsedMs + (rr * k) / 3;
      readings.push({
        ...base,
        ...ppg(ms),
        timestamp: new Date(startEpoch + ms).toISOString(),
        ecgValue: 480 + k * 40,
        hr: 0,
        spo2: 98,
        beat: false,
        rPeakTimestamp: null,
        rrIntervalMs: rr, // repeated every packet, as the firmware does
      });
    }
    elapsedMs += rr;
    pushBeat(elapsedMs);
  }

  return { readings, totalMs: elapsedMs };
}

async function remove() {
  const r = await Promise.all([
    User.deleteOne({ id: DEMO.userId }),
    Device.deleteOne({ id: DEMO.deviceId }),
    Session.deleteOne({ id: DEMO.sessionId }),
    Reading.deleteMany({ sessionId: DEMO.sessionId }),
    EcgRrAnalysis.deleteOne({ sessionId: DEMO.sessionId }),
    EcgRrEvent.deleteMany({ sessionId: DEMO.sessionId }),
    HrvAnalysis.deleteOne({ sessionId: DEMO.sessionId }),
    RhythmAnalysis.deleteOne({ sessionId: DEMO.sessionId }),
    RhythmEvent.deleteMany({ sessionId: DEMO.sessionId }),
    RespirationAnalysis.deleteOne({ sessionId: DEMO.sessionId }),
  ]);
  const total = r.reduce((a, x) => a + (x.deletedCount || 0), 0);
  console.log(`Removed ${total} demo document(s).`);
}

async function insert() {
  await remove(); // idempotent: re-running replaces rather than duplicates

  const rrList = buildRrList();
  // Back-date the recording so it ends now, which needs the duration up front.
  const totalMs = rrList.reduce((a, b) => a + b, 0);
  const startEpoch = Date.now() - totalMs;
  const built = buildReadings({ rrList, startEpoch });

  await User.create({
    id: DEMO.userId,
    name: 'Demo Patient (sample data)',
    email: 'demo.patient@example.com',
    registeredDate: new Date(startEpoch).toISOString(),
    lastActive: new Date().toISOString(),
    status: 'active',
    deviceId: DEMO.deviceId,
    sessions: 1,
    clientId: DEMO.clientId,
  });

  await Device.create({
    id: DEMO.deviceId,
    userId: DEMO.userId,
    userName: 'Demo Patient (sample data)',
    lastSeen: new Date().toISOString(),
    firmware: 'FW-DEMO',
    hardwareVersion: 'HW-DEMO',
    licenseStatus: 'active',
    batteryLevel: 82,
    status: 'active',
    clientId: DEMO.clientId,
    pairedAt: new Date(startEpoch),
  });

  await Session.create({
    id: DEMO.sessionId,
    name: 'DEMO — sample recording for reports',
    userId: DEMO.userId,
    userEmail: 'demo.patient@example.com',
    userName: 'Demo Patient (sample data)',
    deviceId: DEMO.deviceId,
    startTime: new Date(startEpoch).toISOString(),
    endTime: new Date(startEpoch + totalMs).toISOString(),
    duration: Math.max(1, Math.round(totalMs / 60000)),
    dataPoints: built.readings.length,
    dataSource: 'stored',
    avgTemp: '36.7',
    // Session-level HR/SpO2 summaries, as stopSession would compute them.
    avgHR: 0,
    minHR: 0,
    maxHR: 0,
    avgSpo2: 98,
    minSpo2: 96,
    maxSpo2: 99,
    clientId: DEMO.clientId,
  });

  let n = 0;
  await Reading.insertMany(
    built.readings.map((r) => ({
      id: `rdg_demo_${String(n++).padStart(6, '0')}`,
      sessionId: DEMO.sessionId,
      userId: DEMO.userId,
      clientId: DEMO.clientId,
      ...r,
    })),
    { ordered: false }
  );

  await recalculateSessionAnalysis(DEMO.sessionId);

  return { readingCount: built.readings.length, beats: rrList.length + 1, totalMs };
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set');
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected to database: ${mongoose.connection.name}`);

  if (process.argv.includes('--remove')) {
    await remove();
    await mongoose.disconnect();
    return;
  }

  const { readingCount, beats, totalMs } = await insert();

  const [ecg, hrv, rhythm, resp] = await Promise.all([
    EcgRrAnalysis.findOne({ sessionId: DEMO.sessionId }).lean(),
    HrvAnalysis.findOne({ sessionId: DEMO.sessionId }).lean(),
    RhythmAnalysis.findOne({ sessionId: DEMO.sessionId }).lean(),
    RespirationAnalysis.findOne({ sessionId: DEMO.sessionId }).lean(),
  ]);

  console.log(`\nInserted demo recording: ${DEMO.sessionId}`);
  console.log(`  user     ${DEMO.userId}  "Demo Patient (sample data)"`);
  console.log(`  device   ${DEMO.deviceId}`);
  console.log(`  readings ${readingCount} (${beats} detected beats over ${Math.round(totalMs / 1000)} s)`);

  console.log('\nECG / RR Analysis');
  console.log(`  mean HR ${ecg.meanHR} BPM (${ecg.minHR}-${ecg.maxHR})   mean RR ${ecg.meanRR} ms`);
  console.log(`  rhythm ${ecg.rhythmRegularity}   quality ${ecg.signalQuality}   beats ${ecg.validBeats}/${ecg.beatsDetected}`);

  console.log('\nHRV Analysis');
  console.log(`  status ${hrv.status}   SDNN ${hrv.sdnnMs} ms   RMSSD ${hrv.rmssdMs} ms   pNN50 ${hrv.pnn50Percent}%`);
  console.log(`  quality ${hrv.quality}   valid NN ${hrv.validNNIntervals}/${hrv.totalRRIntervals}`);

  console.log('\nRhythm Screening');
  console.log(`  status ${rhythm.status}   pattern ${rhythm.rhythmPattern}   HR ${rhythm.averageHR} (${rhythm.minimumHR}-${rhythm.maximumHR})`);
  console.log(`  elevated ${rhythm.elevatedHRPeriods}  low ${rhythm.lowHRPeriods}  irregular ${rhythm.irregularRRPeriods}`);
  console.log(`  longRR ${rhythm.possibleLongRREvents}  missedBeat ${rhythm.possibleMissedBeats}  doubleDetect ${rhythm.possibleDoubleDetections}`);

  console.log('\nRespiration Rate');
  console.log(`  status ${resp.status}   rate ${resp.finalRespirationRate} breaths/min   confidence ${resp.confidence}`);
  console.log(`  ECG ${resp.ecgRespirationRate}   PPG ${resp.ppgRespirationRate}   cross-check ${resp.agreementStatus}`);

  console.log(`\nView it at: /reports/ecg-rr/${DEMO.userId}/${DEMO.sessionId}`);
  console.log('Remove it with: node scripts/seed-demo-report.js --remove');

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error('Failed:', e.message);
  process.exitCode = 1;
});
