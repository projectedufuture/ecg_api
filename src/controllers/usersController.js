const { validationResult } = require('express-validator');
const User = require('../models/User');
const Device = require('../models/Device');
const Session = require('../models/Session');

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

module.exports = { listUsers, getUserById, deactivateUser, reactivateUser };
