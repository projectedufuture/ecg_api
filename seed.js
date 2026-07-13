/**
 * Seed script for ECG Admin Backend
 * Generates the EXACT same data as the frontend mock-data.ts
 * using the same seeded PRNG (seed=42) and same logic.
 *
 * Usage: node seed.js
 * Requires MONGO_URI env var or defaults to mongodb://localhost:27017/ecg_admin
 */

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const config = require('./src/config/env');

// Models
const Admin = require('./src/models/Admin');
const User = require('./src/models/User');
const Device = require('./src/models/Device');
const Session = require('./src/models/Session');
const Reading = require('./src/models/Reading');
const License = require('./src/models/License');

// ─── Seeded PRNG (identical to frontend) ───────────────────────────────────────

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

const rand = seededRandom(42);

// ─── Names (identical to frontend) ─────────────────────────────────────────────

const NAMES = [
  'Arun Kumar', 'Priya Sharma', 'Kiran Rao', 'Neha Patel', 'Rahul Gupta',
  'Deepa Nair', 'Vijay Singh', 'Sunita Devi', 'Arjun Reddy', 'Meera Iyer',
  'Sanjay Verma', 'Anita Das', 'Ravi Chopra', 'Pooja Mehta', 'Amit Joshi',
  'Divya Pillai', 'Suresh Babu', 'Kavita Rani', 'Manoj Tiwari', 'Lakshmi Menon',
  'Rajesh Shah', 'Swati Agarwal', 'Nikhil Sinha', 'Geeta Bose', 'Ashok Mishra',
  'Rekha Saxena', 'Tarun Kapoor', 'Jaya Prasad', 'Prakash Yadav', 'Nandini Hegde',
  'Gaurav Pandey', 'Seema Kulkarni', 'Rohit Chauhan', 'Usha Rajan', 'Vinod Bhatt',
  'Mala Sundaram', 'Dinesh Patil', 'Shanti Murthy', 'Ajay Thakur', 'Padma Venkat',
  'Mohan Desai', 'Aarti Gaikwad', 'Siddharth Nath', 'Uma Krishnan', 'Krishna Moorthy',
  'Lata Chandra', 'Ganesh Pai',
];

// ─── Generate Users (identical logic to frontend) ──────────────────────────────

function generateUsers() {
  return NAMES.map((name, i) => {
    const regRand = rand();
    const activeRand = rand();
    const statusRand = rand();
    const deviceRand = rand();
    const sessionsRand = rand();
    return {
      id: `usr_${(1000 + i).toString(36)}`,
      name,
      email: `${name.split(' ')[0].toLowerCase()}@example.com`,
      registeredDate: new Date(2026, 0, 1 + Math.floor(regRand * 90)).toISOString().split('T')[0],
      lastActive: new Date(2026, 2, 20 + Math.floor(activeRand * 15)).toISOString().split('T')[0],
      status: statusRand > 0.12 ? 'active' : 'inactive',
      deviceId: deviceRand > 0.15 ? `ECG-${String(2000 + i).padStart(5, '0')}` : null,
      sessions: Math.floor(sessionsRand * 85) + 1,
      clientId: 'CLIENT-001',
    };
  });
}

// ─── Generate Devices (identical logic to frontend) ────────────────────────────

function generateDevices(users) {
  return Array.from({ length: 32 }, (_, i) => {
    const lastSeenRand = rand();
    const fwRand = rand();
    const licRand = rand();
    const battRand = rand();
    return {
      id: `ECG-${String(2000 + i).padStart(5, '0')}`,
      userId: users[i] ? users[i].id : null,
      userName: users[i] ? users[i].name : 'Unassigned',
      lastSeen: new Date(2026, 2, 28 + Math.floor(lastSeenRand * 10) - 5).toISOString(),
      firmware: ['1.0.0', '1.0.1', '1.1.0', '1.2.0'][Math.floor(fwRand * 4)],
      hardwareVersion: 'HW-2.0',
      licenseStatus: (['active', 'active', 'active', 'active', 'inactive', 'expired'])[Math.floor(licRand * 6)],
      batteryLevel: Math.floor(battRand * 100),
      status: 'active',
      clientId: 'CLIENT-001',
    };
  });
}

// ─── Generate Sessions (identical logic to frontend) ───────────────────────────

function generateSessions(users) {
  return Array.from({ length: 64 }, (_, i) => {
    const u = users[i % users.length];
    const durRand = rand();
    const dayRand = rand();
    const hourRand = rand();
    const minRand = rand();
    const srcRand = rand();
    const tempRand = rand();
    const avgHRRand = rand();
    const minHRRand = rand();
    const maxHRRand = rand();
    const avgSpo2Rand = rand();
    const minSpo2Rand = rand();

    const dur = Math.floor(durRand * 180) + 10;
    const start = new Date(2026, 2, 15 + Math.floor(dayRand * 20));
    start.setHours(Math.floor(hourRand * 14) + 6, Math.floor(minRand * 60));
    const end = new Date(start.getTime() + dur * 60000);

    return {
      id: `SES-${String(3000 + i).padStart(6, '0')}`,
      userId: u.id,
      userEmail: u.email,
      userName: u.name,
      deviceId: u.deviceId || `ECG-0${2000 + i}`,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      duration: dur,
      dataPoints: dur * 250 * 60,
      dataSource: (['live', 'stored', 'mixed'])[Math.floor(srcRand * 3)],
      avgTemp: (36.2 + tempRand * 1.2).toFixed(1),
      avgHR: Math.floor(60 + avgHRRand * 40),
      minHR: Math.floor(55 + minHRRand * 15),
      maxHR: Math.floor(100 + maxHRRand * 40),
      avgSpo2: Math.floor(96 + avgSpo2Rand * 3), // 96–99%
      minSpo2: Math.floor(92 + minSpo2Rand * 4), // 92–95%
      maxSpo2: 100,
      clientId: 'CLIENT-001',
    };
  });
}

// ─── Generate Licenses (identical logic to frontend) ───────────────────────────

function generateLicenses(devices) {
  return devices.map((d, i) => {
    const prefixRand = rand();
    const seg1Rand = rand();
    const seg2Rand = rand();
    const actRand = rand();
    const expRand = rand();
    return {
      id: `LIC-${String(4000 + i).padStart(6, '0')}`,
      licenseKey: `${['A', 'B', 'C', 'D'][Math.floor(prefixRand * 4)]}${seg1Rand.toString(36).slice(2, 6).toUpperCase()}-${seg2Rand.toString(36).slice(2, 6).toUpperCase()}`,
      deviceId: d.id,
      clientId: 'CLIENT-001',
      status: d.licenseStatus,
      activationDate: new Date(2026, 0, 1 + Math.floor(actRand * 60)).toISOString().split('T')[0],
      expiryDate: new Date(2027, 0, 1 + Math.floor(expRand * 60)).toISOString().split('T')[0],
    };
  });
}

// ─── Generate ECG readings for each session ────────────────────────────────────

function generateECG(count) {
  const d = [];
  for (let i = 0; i < count; i++) {
    const t = (i % 100) / 100;
    let v = 0;
    if (t > 0.05 && t < 0.10) v = Math.sin((t - 0.05) * Math.PI / 0.05) * 0.15;
    else if (t > 0.15 && t < 0.18) v = -0.08;
    else if (t > 0.18 && t < 0.22) v = Math.sin((t - 0.18) * Math.PI / 0.04) * 1.0;
    else if (t > 0.22 && t < 0.26) v = -0.2;
    else if (t > 0.30 && t < 0.42) v = Math.sin((t - 0.30) * Math.PI / 0.12) * 0.25;
    v += (Math.random() - 0.5) * 0.03;
    d.push(v);
  }
  return d;
}

function generateReadingsForSession(session) {
  // Generate a reasonable number of readings (600 per session for detail view)
  const count = 600;
  const ecgValues = generateECG(count);
  const readings = [];
  const startMs = new Date(session.startTime).getTime();
  const intervalMs = (session.duration * 60000) / count;

  for (let i = 0; i < count; i++) {
    const ts = new Date(startMs + i * intervalMs);
    readings.push({
      id: `RDG-${session.id}-${String(i).padStart(4, '0')}`,
      sessionId: session.id,
      userId: session.userId,
      timestamp: ts.toISOString(),
      ecgValue: parseFloat(ecgValues[i].toFixed(4)),
      temperatureCelsius: parseFloat((36.2 + Math.random() * 1.2).toFixed(2)),
      deviceId: session.deviceId,
      clientId: 'CLIENT-001',
    });
  }
  return readings;
}

// ─── Main seed function ────────────────────────────────────────────────────────

async function seed() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(config.mongo.uri);
    console.log('Connected.\n');

    // Clear existing data — drop the collections (not just deleteMany) so any
    // stale indexes from an older schema version are removed and Mongoose
    // recreates them fresh from the current schema on the next insert.
    console.log('Clearing existing data...');
    const collections = ['admins', 'users', 'devices', 'sessions', 'licenses', 'readings'];
    for (const name of collections) {
      try {
        await mongoose.connection.db.collection(name).drop();
      } catch (err) {
        if (err.codeName !== 'NamespaceNotFound') throw err;
      }
    }
    console.log('Cleared.\n');

    // 1. Create admin accounts
    console.log('Creating admin accounts...');
    await Admin.create({
      id: 'adm_001',
      name: 'Super Admin',
      email: 'admin@ecgplatform.com',
      password: 'Admin123!',
      role: 'super_admin',
      clientId: 'CLIENT-001',
    });
    await Admin.create({
      id: 'adm_002',
      name: 'Client Admin',
      email: 'client@ecgplatform.com',
      password: 'Client123!',
      role: 'client_admin',
      clientId: 'CLIENT-001',
    });
    console.log('  ✓ super_admin: admin@ecgplatform.com / Admin123!');
    console.log('  ✓ client_admin: client@ecgplatform.com / Client123!\n');

    // 2. Generate and insert users
    console.log('Generating users...');
    const users = generateUsers();
    await User.insertMany(users);
    console.log(`  ✓ ${users.length} users created.\n`);

    // 3. Generate and insert devices
    console.log('Generating devices...');
    const devices = generateDevices(users);
    await Device.insertMany(devices);
    console.log(`  ✓ ${devices.length} devices created.\n`);

    // 4. Generate and insert sessions
    console.log('Generating sessions...');
    const sessions = generateSessions(users);
    await Session.insertMany(sessions);
    console.log(`  ✓ ${sessions.length} sessions created.\n`);

    // 5. Generate and insert licenses
    console.log('Generating licenses...');
    const licenses = generateLicenses(devices);
    await License.insertMany(licenses);
    console.log(`  ✓ ${licenses.length} licenses created.\n`);

    // 6. Generate readings for each session (limited set for seed)
    console.log('Generating readings (600 per session, 64 sessions)...');
    let totalReadings = 0;
    for (const session of sessions) {
      const readings = generateReadingsForSession(session);
      await Reading.insertMany(readings);
      totalReadings += readings.length;
      process.stdout.write(`  Processing session ${session.id}... (${totalReadings} readings so far)\r`);
    }
    console.log(`\n  ✓ ${totalReadings} readings created.\n`);

    // Summary
    console.log('═══════════════════════════════════════');
    console.log('  SEED COMPLETE');
    console.log('═══════════════════════════════════════');
    console.log(`  Admins:    2`);
    console.log(`  Users:     ${users.length}`);
    console.log(`  Devices:   ${devices.length}`);
    console.log(`  Sessions:  ${sessions.length}`);
    console.log(`  Licenses:  ${licenses.length}`);
    console.log(`  Readings:  ${totalReadings}`);
    console.log('═══════════════════════════════════════\n');

    await mongoose.connection.close();
    console.log('MongoDB connection closed. Done.');
    process.exit(0);
  } catch (error) {
    console.error('Seed error:', error);
    process.exit(1);
  }
}

seed();
