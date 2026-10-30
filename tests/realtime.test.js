/**
 * End-to-end tests for real-time support chat + notifications.
 *
 * Runs the REAL routers/controllers and the REAL Socket.IO server against a
 * throwaway in-memory MongoDB. It deliberately does NOT load src/server.js
 * (which connects to the configured MONGO_URI on require) — nothing here can
 * touch a real database.
 */
process.env.JWT_ACCESS_SECRET = 'test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
process.env.MONGO_URI = 'mongodb://unused-in-tests';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { io: ioClient } = require('socket.io-client');

const { initRealtime } = require('../src/realtime/socket');
const User = require('../src/models/User');
const TicketMessage = require('../src/models/TicketMessage');

const SECRET = process.env.JWT_ACCESS_SECRET;
let mongod;
let server;
let base;
const open = [];

const appToken = (userId, opts = {}) =>
  jwt.sign({ userId, email: `${userId}@t.io`, type: 'app' }, SECRET, { expiresIn: '30m', ...opts });
const adminToken = (id, role, clientId = null) =>
  jwt.sign({ id, email: `${id}@t.io`, role, clientId }, SECRET, { expiresIn: '30m' });

function connect(token) {
  return new Promise((resolve, reject) => {
    const s = ioClient(base, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
    open.push(s);
    s.once('ready', () => resolve(s));
    s.once('connect_error', (e) => reject(e));
  });
}

function waitFor(socket, event, ms = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
    socket.once(event, (p) => {
      clearTimeout(t);
      resolve(p);
    });
  });
}

/** Resolves with every payload of `event` received within `ms`. */
function collect(socket, event, ms = 500) {
  const got = [];
  const h = (p) => got.push(p);
  socket.on(event, h);
  return new Promise((r) => setTimeout(() => { socket.off(event, h); r(got); }, ms));
}

async function call(method, path, token, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await TicketMessage.syncIndexes();

  const app = express();
  app.use(express.json());
  app.use('/api/admin/tickets', require('../src/routes/tickets'));
  app.use('/api/admin/notifications', require('../src/routes/notifications'));
  app.use('/api/app/tickets', require('../src/routes/app/tickets'));
  app.use('/api/app/notifications', require('../src/routes/app/notifications'));

  server = http.createServer(app);
  initRealtime(server);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;

  const day = '2026-10-29';
  await User.create([
    { id: 'usr_a', name: 'Alice', email: 'a@t.io', registeredDate: day, lastActive: day, clientId: 'CLIENT-001' },
    { id: 'usr_b', name: 'Bob', email: 'b@t.io', registeredDate: day, lastActive: day, clientId: 'CLIENT-001' },
  ]);
});

after(async () => {
  open.forEach((s) => s.close());
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mongod.stop();
});

test('socket rejects missing, forged and expired tokens', async () => {
  await assert.rejects(connect(undefined), /unauthorized/);
  await assert.rejects(connect(jwt.sign({ userId: 'usr_a', type: 'app' }, 'wrong-secret')), /unauthorized/);
  await assert.rejects(connect(jwt.sign({ foo: 1 }, SECRET)), /unauthorized/);
  const expired = jwt.sign({ userId: 'usr_a', type: 'app', exp: Math.floor(Date.now() / 1000) - 5 }, SECRET);
  await assert.rejects(connect(expired), /token_expired/);
});

test('admin REST rejects a mobile-app token (shared-secret fix)', async () => {
  const r = await call('GET', '/api/admin/tickets', appToken('usr_a'));
  assert.equal(r.status, 401);
  const ok = await call('GET', '/api/admin/tickets', adminToken('adm_1', 'super_admin'));
  assert.equal(ok.status, 200);
});

test('user message reaches in-scope admins immediately, and nobody else', async () => {
  const superAdmin = await connect(adminToken('adm_1', 'super_admin'));
  const sameClient = await connect(adminToken('adm_2', 'client_admin', 'CLIENT-001'));
  const otherClient = await connect(adminToken('adm_3', 'client_admin', 'CLIENT-002'));
  const bob = await connect(appToken('usr_b'));

  const gotSuper = waitFor(superAdmin, 'ticket:created');
  const gotSame = waitFor(sameClient, 'ticket:created');
  const notOther = collect(otherClient, 'ticket:created');
  const notBob = collect(bob, 'ticket:created');

  const created = await call('POST', '/api/app/tickets', appToken('usr_a'), {
    subject: 'Jacket will not pair', message: 'It blinks red', category: 'device',
  });
  assert.equal(created.status, 201);

  const p = await gotSuper;
  assert.equal(p.ticket.id, created.json.data.id);
  assert.equal(p.message.body, 'It blinks red');
  assert.equal((await gotSame).ticket.id, created.json.data.id);
  assert.equal((await notOther).length, 0, 'other client admin must not see it');
  assert.equal((await notBob).length, 0, 'other user must not see it');

  const reply = waitFor(superAdmin, 'ticket:message');
  const r = await call('POST', `/api/app/tickets/${created.json.data.id}/reply`, appToken('usr_a'), { body: 'Still blinking' });
  assert.equal(r.status, 201);
  const m = await reply;
  assert.equal(m.message.id, r.json.data.message.id, 'event carries the saved message id');
  assert.equal(m.message.sender, 'user');
});

test('admin reply reaches only the ticket owner, with badge count', async () => {
  const alice = await connect(appToken('usr_a'));
  const bob = await connect(appToken('usr_b'));
  const t = (await call('POST', '/api/app/tickets', appToken('usr_a'), { subject: 'Q', message: 'Hello' })).json.data;

  const gotMsg = waitFor(alice, 'ticket:message');
  const gotCounts = waitFor(alice, 'unread:counts');
  const notBob = collect(bob, 'ticket:message');

  const r = await call('POST', `/api/admin/tickets/${t.id}/reply`, adminToken('adm_1', 'super_admin'), { body: 'We are on it' });
  assert.equal(r.status, 201);

  const p = await gotMsg;
  assert.equal(p.ticketId, t.id);
  assert.equal(p.message.sender, 'admin');
  assert.equal(p.message.body, 'We are on it');
  assert.equal(p.ticket.status, 'pending');
  assert.equal(p.ticket.userEmail, undefined, 'app payload omits admin-only user fields');
  assert.ok((await gotCounts).support >= 1);
  assert.equal((await notBob).length, 0);
});

test('a client cannot subscribe to another user\'s room', async () => {
  const bob = await connect(appToken('usr_b'));
  bob.emit('join', 'user:usr_a');
  bob.emit('subscribe', { room: 'admins:all' });
  const t = (await call('POST', '/api/app/tickets', appToken('usr_a'), { subject: 'Private', message: 'secret' })).json.data;
  const leak = collect(bob, 'ticket:message', 600);
  await call('POST', `/api/admin/tickets/${t.id}/reply`, adminToken('adm_1', 'super_admin'), { body: 'for Alice only' });
  assert.equal((await leak).length, 0);
});

test('retrying a send with the same clientMsgId does not duplicate it', async () => {
  const admin = await connect(adminToken('adm_1', 'super_admin'));
  const t = (await call('POST', '/api/app/tickets', appToken('usr_a'), { subject: 'Dup', message: 'first' })).json.data;
  const events = collect(admin, 'ticket:message', 800);

  const body = { body: 'only once', clientMsgId: 'retry-key-0001' };
  const r1 = await call('POST', `/api/app/tickets/${t.id}/reply`, appToken('usr_a'), body);
  const r2 = await call('POST', `/api/app/tickets/${t.id}/reply`, appToken('usr_a'), body);
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 200);
  assert.equal(r1.json.data.message.id, r2.json.data.message.id);
  assert.equal(await TicketMessage.countDocuments({ ticketId: t.id, body: 'only once' }), 1);
  assert.equal((await events).length, 1, 'announced exactly once');

  // Idempotent ticket creation too.
  const c = { subject: 'Once', message: 'create once', clientMsgId: 'create-key-0001' };
  const c1 = await call('POST', '/api/app/tickets', appToken('usr_a'), c);
  const c2 = await call('POST', '/api/app/tickets', appToken('usr_a'), c);
  assert.equal(c1.json.data.id, c2.json.data.id);
});

test('offline user gets saved replies and notifications after reconnecting', async () => {
  const t = (await call('POST', '/api/app/tickets', appToken('usr_b'), { subject: 'Offline', message: 'hi' })).json.data;
  // usr_b has NO socket connected now.
  await call('POST', `/api/admin/tickets/${t.id}/reply`, adminToken('adm_1', 'super_admin'), { body: 'reply while offline' });
  await call('POST', '/api/admin/notifications', adminToken('adm_1', 'super_admin'), {
    title: 'Hello Bob', body: 'sent while offline', userIds: ['usr_b'],
  });

  // Reconnect → the app re-syncs over REST (socket events are not replayed).
  const bob = await connect(appToken('usr_b'));
  assert.ok(bob.connected);
  const unread = await call('GET', '/api/app/tickets/unread-count', appToken('usr_b'));
  assert.ok(unread.json.data.unreadCount >= 1);
  const thread = await call('GET', `/api/app/tickets/${t.id}`, appToken('usr_b'));
  assert.ok(thread.json.data.messages.some((m) => m.body === 'reply while offline'));
  const notes = await call('GET', '/api/app/notifications', appToken('usr_b'));
  assert.equal(notes.json.data.items[0].title, 'Hello Bob', 'newest first');
});

test('notifications go only to the intended user; read state syncs across devices', async () => {
  const aliceA = await connect(appToken('usr_a'));
  const aliceB = await connect(appToken('usr_a')); // second device
  const bob = await connect(appToken('usr_b'));

  const gotA = waitFor(aliceA, 'notification:new');
  const gotB = waitFor(aliceB, 'notification:new');
  const notBob = collect(bob, 'notification:new');
  const sent = await call('POST', '/api/admin/notifications', adminToken('adm_1', 'super_admin'), {
    title: 'Firmware update', body: 'v2.1 is available', type: 'info', userIds: ['usr_a'],
  });
  assert.equal(sent.status, 201);
  const n = (await gotA).notification;
  assert.equal(n.title, 'Firmware update');
  assert.equal(n.read, false);
  assert.equal((await gotB).notification.id, n.id);
  assert.equal((await notBob).length, 0);

  const counts = waitFor(aliceB, 'unread:counts');
  await call('PUT', '/api/app/notifications/read-all', appToken('usr_a'));
  assert.equal((await counts).notifications, 0);
});

test('admin bell count endpoint is scoped', async () => {
  const r = await call('GET', '/api/admin/tickets/unread-count', adminToken('adm_1', 'super_admin'));
  assert.equal(r.status, 200);
  assert.equal(typeof r.json.data.unreadCount, 'number');
  const other = await call('GET', '/api/admin/tickets/unread-count', adminToken('adm_3', 'client_admin', 'CLIENT-002'));
  assert.equal(other.json.data.unreadCount, 0);
});

test('account switch: a new socket only receives the new user\'s events', async () => {
  const alice = await connect(appToken('usr_a'));
  alice.close(); // sign out
  const bob = await connect(appToken('usr_b')); // sign in as someone else
  const t = (await call('POST', '/api/app/tickets', appToken('usr_a'), { subject: 'A', message: 'a' })).json.data;
  const leak = collect(bob, 'ticket:message', 600);
  await call('POST', `/api/admin/tickets/${t.id}/reply`, adminToken('adm_1', 'super_admin'), { body: 'for A' });
  assert.equal((await leak).length, 0);
});

test('socket is dropped when its token expires; flooding clients are dropped', async () => {
  const short = await connect(appToken('usr_a', { expiresIn: 2 }));
  await waitFor(short, 'auth:expired', 4000);

  const flood = await connect(appToken('usr_b'));
  const dropped = waitFor(flood, 'disconnect', 3000);
  for (let i = 0; i < 40; i++) flood.emit('spam', i);
  await dropped;
});

test('rapid sending is rate-limited per user', async () => {
  const t = (await call('POST', '/api/app/tickets', appToken('usr_b'), { subject: 'RL', message: 'x' })).json.data;
  let limited = false;
  for (let i = 0; i < 25 && !limited; i++) {
    const r = await call('POST', `/api/app/tickets/${t.id}/reply`, appToken('usr_b'), { body: `m${i}` });
    if (r.status === 429) limited = true;
  }
  assert.ok(limited, 'expected a 429 before 25 messages/minute');
});
