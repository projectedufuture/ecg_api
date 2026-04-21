const crypto = require('crypto');
const { validationResult } = require('express-validator');
const User = require('../models/User');
const Device = require('../models/Device');
const Session = require('../models/Session');
const License = require('../models/License');
const { sendUserOnboardingEmail, sendDeviceAssignmentEmail } = require('../utils/emailService');

function makeUserId() {
  return `USR-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

// Generate a temporary password that passes app's complexity requirements:
// 8+ chars, upper, lower, digit, special.
function generateTempPassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digit = '23456789';
  const special = '!@#$%^&*';
  const all = upper + lower + digit + special;
  const pick = (s) => s[crypto.randomInt(0, s.length)];
  const base = [pick(upper), pick(lower), pick(digit), pick(special)];
  for (let i = 0; i < 8; i += 1) base.push(pick(all));
  // Fisher-Yates shuffle
  for (let i = base.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [base[i], base[j]] = [base[j], base[i]];
  }
  return base.join('');
}

async function listUsers(req, res) {
  try {
    const {
      page = 1,
      limit = 25,
      sort = 'registeredDate',
      order = 'desc',
      search,
      status,
      dateFrom,
      dateTo,
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const sortOrder = order === 'asc' ? 1 : -1;

    // Build filter
    const filter = {};

    // RBAC: client_admin sees only their client
    if (req.clientScope) {
      filter.clientId = req.clientScope;
    }

    if (search) {
      const searchRegex = new RegExp(search, 'i');
      filter.$or = [{ email: searchRegex }, { name: searchRegex }];
    }

    if (status && ['active', 'inactive'].includes(status)) {
      filter.status = status;
    }

    if (dateFrom || dateTo) {
      filter.registeredDate = {};
      if (dateFrom) filter.registeredDate.$gte = dateFrom;
      if (dateTo) filter.registeredDate.$lte = dateTo;
    }

    const total = await User.countDocuments(filter);
    const totalPages = Math.ceil(total / limitNum);

    const users = await User.find(filter)
      .sort({ [sort]: sortOrder })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean();

    return res.json({
      success: true,
      data: users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        registeredDate: u.registeredDate,
        lastActive: u.lastActive,
        status: u.status,
        deviceId: u.deviceId,
        sessions: u.sessions,
      })),
      error: null,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages,
      },
    });
  } catch (error) {
    console.error('List users error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

async function getUserById(req, res) {
  try {
    const { id } = req.params;

    const filter = { id };
    if (req.clientScope) {
      filter.clientId = req.clientScope;
    }

    const user = await User.findOne(filter).lean();
    if (!user) {
      return res.status(404).json({ success: false, data: null, error: 'User not found.' });
    }

    // Get linked devices
    const devices = await Device.find({ userId: user.id }).lean();
    const linkedDevices = devices.map((d) => ({
      id: d.id,
      userId: d.userId,
      userName: d.userName,
      lastSeen: d.lastSeen,
      firmware: d.firmware,
      hardwareVersion: d.hardwareVersion,
      licenseStatus: d.licenseStatus,
      batteryLevel: d.batteryLevel,
    }));

    // Get session history
    const sessions = await Session.find({ userId: user.id })
      .sort({ startTime: -1 })
      .lean();
    const sessionHistory = sessions.map((s) => ({
      id: s.id,
      userId: s.userId,
      userEmail: s.userEmail,
      userName: s.userName,
      deviceId: s.deviceId,
      startTime: s.startTime,
      endTime: s.endTime,
      duration: s.duration,
      dataPoints: s.dataPoints,
      dataSource: s.dataSource,
      avgTemp: s.avgTemp,
      avgHR: s.avgHR,
      minHR: s.minHR,
      maxHR: s.maxHR,
    }));

    return res.json({
      success: true,
      data: {
        id: user.id,
        name: user.name,
        email: user.email,
        registeredDate: user.registeredDate,
        lastActive: user.lastActive,
        status: user.status,
        deviceId: user.deviceId,
        sessions: user.sessions,
        linkedDevices,
        sessionHistory,
      },
      error: null,
    });
  } catch (error) {
    console.error('Get user error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

async function deactivateUser(req, res) {
  try {
    const { id } = req.params;

    const filter = { id };
    if (req.clientScope) {
      filter.clientId = req.clientScope;
    }

    const user = await User.findOne(filter);
    if (!user) {
      return res.status(404).json({ success: false, data: null, error: 'User not found.' });
    }

    if (user.status === 'inactive') {
      return res.status(400).json({ success: false, data: null, error: 'User is already inactive.' });
    }

    user.status = 'inactive';
    await user.save();

    await req.audit('deactivate', 'user', id, { reason: req.body.reason || 'No reason provided' });

    return res.json({
      success: true,
      data: {
        id: user.id,
        name: user.name,
        email: user.email,
        registeredDate: user.registeredDate,
        lastActive: user.lastActive,
        status: user.status,
        deviceId: user.deviceId,
        sessions: user.sessions,
      },
      error: null,
    });
  } catch (error) {
    console.error('Deactivate user error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

async function reactivateUser(req, res) {
  try {
    const { id } = req.params;

    const filter = { id };
    if (req.clientScope) {
      filter.clientId = req.clientScope;
    }

    const user = await User.findOne(filter);
    if (!user) {
      return res.status(404).json({ success: false, data: null, error: 'User not found.' });
    }

    if (user.status === 'active') {
      return res.status(400).json({ success: false, data: null, error: 'User is already active.' });
    }

    user.status = 'active';
    await user.save();

    await req.audit('reactivate', 'user', id, {});

    return res.json({
      success: true,
      data: {
        id: user.id,
        name: user.name,
        email: user.email,
        registeredDate: user.registeredDate,
        lastActive: user.lastActive,
        status: user.status,
        deviceId: user.deviceId,
        sessions: user.sessions,
      },
      error: null,
    });
  } catch (error) {
    console.error('Reactivate user error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

async function createUser(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, data: null, error: errors.array()[0].msg });
  }

  const { name, email, deviceId } = req.body;

  try {
    const emailLc = email.toLowerCase();
    const existing = await User.findOne({ email: emailLc });
    if (existing) {
      return res
        .status(409)
        .json({ success: false, data: null, error: 'A user with this email already exists.' });
    }

    let device = null;
    let license = null;
    if (deviceId) {
      device = await Device.findOne({ id: deviceId });
      if (!device) {
        return res
          .status(404)
          .json({ success: false, data: null, error: `Device ${deviceId} not found.` });
      }
      if (device.userId) {
        return res.status(409).json({
          success: false,
          data: null,
          error: `Device ${deviceId} is already assigned to another user.`,
        });
      }
      license = await License.findOne({ deviceId }).lean();
    }

    const tempPassword = generateTempPassword();
    const nowIso = new Date().toISOString();

    const user = new User({
      id: makeUserId(),
      name,
      email: emailLc,
      password: tempPassword,
      registeredDate: nowIso,
      lastActive: nowIso,
      status: 'active',
      deviceId: device ? device.id : null,
      clientId: req.admin.clientId || 'CLIENT-001',
      mustChangePassword: true,
    });
    await user.save();

    if (device) {
      device.userId = user.id;
      device.userName = user.name;
      await device.save();
    }

    // Email credentials — don't fail the request if the mail provider errors.
    let emailSent = false;
    let emailError = null;
    try {
      await sendUserOnboardingEmail({
        toEmail: user.email,
        toName: user.name,
        password: tempPassword,
        deviceId: device ? device.id : null,
        licenseKey: license ? license.licenseKey : null,
      });
      emailSent = true;
    } catch (mailErr) {
      emailError = mailErr.message;
      console.error('Onboarding email error:', mailErr);
    }

    await req.audit('create', 'user', user.id, { email: user.email, deviceId: device?.id });

    const body = {
      success: true,
      data: {
        id: user.id,
        name: user.name,
        email: user.email,
        deviceId: user.deviceId,
        status: user.status,
        mustChangePassword: user.mustChangePassword,
        assignedDevice: device
          ? { id: device.id, firmware: device.firmware, licenseKey: license?.licenseKey || null }
          : null,
        emailSent,
      },
      error: null,
    };

    const isDev = (process.env.NODE_ENV || 'development') !== 'production';
    if (isDev) {
      body.debug = { tempPassword, emailError };
    }

    return res.status(201).json(body);
  } catch (error) {
    console.error('Create user error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

async function assignDevice(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, data: null, error: errors.array()[0].msg });
  }

  const { id: userId } = req.params;
  const { deviceId } = req.body;

  try {
    const userFilter = { id: userId };
    if (req.clientScope) userFilter.clientId = req.clientScope;

    const user = await User.findOne(userFilter);
    if (!user) {
      return res.status(404).json({ success: false, data: null, error: 'User not found.' });
    }

    if (user.deviceId) {
      return res.status(409).json({
        success: false,
        data: null,
        error: `User already has device ${user.deviceId} assigned. Unassign it first.`,
      });
    }

    const device = await Device.findOne({ id: deviceId });
    if (!device) {
      return res
        .status(404)
        .json({ success: false, data: null, error: `Device ${deviceId} not found.` });
    }
    if (device.userId && device.userId !== user.id) {
      return res.status(409).json({
        success: false,
        data: null,
        error: `Device ${deviceId} is already assigned to another user.`,
      });
    }
    if (device.status === 'inactive') {
      return res
        .status(403)
        .json({ success: false, data: null, error: 'Device is inactive.' });
    }

    const license = await License.findOne({ deviceId }).lean();

    device.userId = user.id;
    device.userName = user.name;
    await device.save();

    user.deviceId = device.id;
    user.lastActive = new Date().toISOString();
    await user.save();

    let emailSent = false;
    let emailError = null;
    try {
      await sendDeviceAssignmentEmail({
        toEmail: user.email,
        toName: user.name,
        deviceId: device.id,
        licenseKey: license ? license.licenseKey : 'Contact support for your license key',
      });
      emailSent = true;
    } catch (mailErr) {
      emailError = mailErr.message;
      console.error('Device assignment email error:', mailErr);
    }

    await req.audit('assign_device', 'user', user.id, { deviceId: device.id });

    return res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          deviceId: user.deviceId,
        },
        device: {
          id: device.id,
          firmware: device.firmware,
          licenseKey: license ? license.licenseKey : null,
        },
        emailSent,
        emailError,
      },
      error: null,
    });
  } catch (error) {
    console.error('Assign device error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

async function unassignDevice(req, res) {
  const { id: userId } = req.params;

  try {
    const userFilter = { id: userId };
    if (req.clientScope) userFilter.clientId = req.clientScope;

    const user = await User.findOne(userFilter);
    if (!user) {
      return res.status(404).json({ success: false, data: null, error: 'User not found.' });
    }
    if (!user.deviceId) {
      return res
        .status(400)
        .json({ success: false, data: null, error: 'User has no device assigned.' });
    }

    const prevDeviceId = user.deviceId;
    await Device.findOneAndUpdate(
      { id: prevDeviceId, userId: user.id },
      { userId: null, userName: 'Unassigned' }
    );

    user.deviceId = null;
    await user.save();

    await req.audit('unassign_device', 'user', user.id, { deviceId: prevDeviceId });

    return res.json({
      success: true,
      data: { userId: user.id, unassignedDeviceId: prevDeviceId },
      error: null,
    });
  } catch (error) {
    console.error('Unassign device error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

module.exports = {
  listUsers,
  getUserById,
  deactivateUser,
  reactivateUser,
  createUser,
  assignDevice,
  unassignDevice,
};
