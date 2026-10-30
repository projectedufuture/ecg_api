const { Server } = require('socket.io');
const { verifyAccessToken } = require('../utils/tokenUtils');

/**
 * Real-time channel (Socket.IO) shared by the mobile app and the admin panel.
 *
 * ── DESIGN ──────────────────────────────────────────────────────────────────
 * • SERVER → CLIENT ONLY. Clients never write through the socket: sending a
 *   support message, creating a ticket, marking read etc. all stay on the
 *   existing REST endpoints, which already validate, authorize, persist and
 *   rate-limit. The socket only announces "this was saved" — emitted AFTER the
 *   database write succeeded. Any event a client emits is ignored, and a client
 *   that floods events is disconnected.
 * • ROOMS ARE ASSIGNED BY THE SERVER from the verified token. There is no
 *   "join" event, so a client cannot subscribe to another user's room:
 *     app user          → `user:<userId>`
 *     super_admin       → `admins:all`
 *     client_admin      → `admins:client:<clientId>` (same scope as REST)
 * • Same JWTs as REST. App and admin access tokens share one signing secret,
 *   so the principal is decided by payload SHAPE (`type:'app'` vs an admin
 *   `role`), never by the signature alone.
 * • A socket is disconnected when its access token expires (`auth:expired`),
 *   so a revoked/expired session can't keep receiving events; the client
 *   refreshes its token over REST and reconnects.
 * • Offline users simply miss socket events — everything is persisted, and
 *   clients re-sync over REST on every (re)connect.
 *
 * Single-instance note: rooms live in this process. Running more than one API
 * instance requires a shared adapter (e.g. @socket.io/redis-adapter).
 */

let io = null;

const ADMIN_ROLES = ['super_admin', 'client_admin'];
const MAX_SOCKETS_PER_PRINCIPAL = 10;
const MAX_CLIENT_EVENTS_PER_10S = 20;
const MAX_TIMEOUT_MS = 2 ** 31 - 1; // setTimeout overflow guard

const liveCounts = new Map(); // principalKey → open socket count

function authError(code) {
  const err = new Error(code);
  err.data = { code };
  return err;
}

/** Decide who a verified token belongs to. Returns null if it is neither. */
function principalFrom(decoded) {
  if (!decoded || typeof decoded !== 'object') return null;
  if (decoded.type === 'app') {
    if (typeof decoded.userId !== 'string' || !decoded.userId) return null;
    return { kind: 'user', userId: decoded.userId, key: `u:${decoded.userId}` };
  }
  if (typeof decoded.id === 'string' && decoded.id && ADMIN_ROLES.includes(decoded.role)) {
    return {
      kind: 'admin',
      adminId: decoded.id,
      role: decoded.role,
      // Mirrors applyClientScope: super_admin (or an admin with no clientId)
      // is unscoped; a client_admin sees only their own client.
      clientScope: decoded.role === 'super_admin' ? null : decoded.clientId || null,
      key: `a:${decoded.id}`,
    };
  }
  return null;
}

function tokenFromHandshake(handshake) {
  const fromAuth = handshake.auth && handshake.auth.token;
  if (typeof fromAuth === 'string') return fromAuth.replace(/^Bearer\s+/i, '');
  const header = handshake.headers && handshake.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7);
  return null;
}

function roomsFor(p) {
  if (p.kind === 'user') return [`user:${p.userId}`];
  return [p.clientScope ? `admins:client:${p.clientScope}` : 'admins:all'];
}

function initRealtime(httpServer) {
  io = new Server(httpServer, {
    path: '/socket.io',
    serveClient: false,
    // Same policy as the REST CORS config (reflect the caller's origin).
    cors: { origin: true, credentials: true, methods: ['GET', 'POST'] },
    // Clients never send payloads, so keep the inbound limit tiny.
    maxHttpBufferSize: 10 * 1024,
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  io.use((socket, next) => {
    const token = tokenFromHandshake(socket.handshake);
    if (!token || token.length > 4096) return next(authError('unauthorized'));
    let decoded;
    try {
      decoded = verifyAccessToken(token);
    } catch (e) {
      return next(authError(e && e.name === 'TokenExpiredError' ? 'token_expired' : 'unauthorized'));
    }
    const principal = principalFrom(decoded);
    if (!principal) return next(authError('unauthorized'));
    if ((liveCounts.get(principal.key) || 0) >= MAX_SOCKETS_PER_PRINCIPAL) {
      return next(authError('too_many_connections'));
    }
    socket.data.principal = principal;
    socket.data.exp = typeof decoded.exp === 'number' ? decoded.exp : null;
    return next();
  });

  io.on('connection', (socket) => {
    const p = socket.data.principal;
    liveCounts.set(p.key, (liveCounts.get(p.key) || 0) + 1);
    roomsFor(p).forEach((r) => socket.join(r));

    // Drop the connection the moment the access token expires.
    let expiryTimer = null;
    if (socket.data.exp) {
      const ms = socket.data.exp * 1000 - Date.now();
      if (ms <= 0) {
        socket.emit('auth:expired');
        socket.disconnect(true);
        return;
      }
      if (ms < MAX_TIMEOUT_MS) {
        expiryTimer = setTimeout(() => {
          socket.emit('auth:expired');
          socket.disconnect(true);
        }, ms);
      }
    }

    // Server→client only: ignore client events, disconnect a flooding client.
    let windowStart = Date.now();
    let windowCount = 0;
    socket.onAny(() => {
      const now = Date.now();
      if (now - windowStart > 10000) {
        windowStart = now;
        windowCount = 0;
      }
      windowCount += 1;
      if (windowCount > MAX_CLIENT_EVENTS_PER_10S) socket.disconnect(true);
    });

    socket.on('disconnect', () => {
      if (expiryTimer) clearTimeout(expiryTimer);
      const n = (liveCounts.get(p.key) || 1) - 1;
      if (n <= 0) liveCounts.delete(p.key);
      else liveCounts.set(p.key, n);
    });

    socket.emit('ready', { kind: p.kind, serverTime: new Date().toISOString() });
  });

  return io;
}

/** Emit to one app user (all their devices). Never throws. */
function emitToUser(userId, event, payload) {
  if (!io || !userId) return;
  try {
    io.to(`user:${userId}`).emit(event, payload);
  } catch (e) {
    console.error(`[realtime] emitToUser ${event} failed:`, e.message);
  }
}

/**
 * Emit to every admin allowed to see data of `clientId`: all super admins plus
 * that client's admins. Socket.IO de-duplicates sockets across the two rooms.
 * Never throws.
 */
function emitToAdmins(clientId, event, payload) {
  if (!io) return;
  try {
    let target = io.to('admins:all');
    if (clientId) target = target.to(`admins:client:${clientId}`);
    target.emit(event, payload);
  } catch (e) {
    console.error(`[realtime] emitToAdmins ${event} failed:`, e.message);
  }
}

module.exports = { initRealtime, emitToUser, emitToAdmins, principalFrom, _getIo: () => io };
