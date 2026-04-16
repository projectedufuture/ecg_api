const { validationResult } = require('express-validator');
const Admin = require('../models/Admin');
const { generateAccessToken, generateRefreshToken, verifyRefreshToken } = require('../utils/tokenUtils');
const config = require('../config/env');

async function login(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, data: null, error: errors.array()[0].msg });
  }

  const { email, password } = req.body;

  try {
    const admin = await Admin.findOne({ email: email.toLowerCase() });
    if (!admin) {
      return res.status(401).json({ success: false, data: null, error: 'Invalid email or password.' });
    }

    const isMatch = await admin.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ success: false, data: null, error: 'Invalid email or password.' });
    }

    const accessToken = generateAccessToken(admin);
    const refreshToken = generateRefreshToken(admin);

    // Store refresh token in DB
    admin.refreshToken = refreshToken;
    await admin.save();

    // Set refresh token as httpOnly cookie
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: config.server.nodeEnv === 'production',
      sameSite: config.server.nodeEnv === 'production' ? 'strict' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: '/',
    });

    return res.json({
      success: true,
      data: null,
      error: null,
      accessToken,
      admin: admin.toPublicJSON(),
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

async function refreshToken(req, res) {
  const token = req.cookies?.refreshToken;

  if (!token) {
    return res.status(401).json({ success: false, data: null, error: 'No refresh token provided.' });
  }

  try {
    const decoded = verifyRefreshToken(token);
    const admin = await Admin.findOne({ id: decoded.id, refreshToken: token });

    if (!admin) {
      return res.status(401).json({ success: false, data: null, error: 'Invalid refresh token.' });
    }

    // Rotate tokens
    const newAccessToken = generateAccessToken(admin);
    const newRefreshToken = generateRefreshToken(admin);

    admin.refreshToken = newRefreshToken;
    await admin.save();

    res.cookie('refreshToken', newRefreshToken, {
      httpOnly: true,
      secure: config.server.nodeEnv === 'production',
      sameSite: config.server.nodeEnv === 'production' ? 'strict' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/',
    });

    return res.json({
      success: true,
      data: null,
      error: null,
      accessToken: newAccessToken,
    });
  } catch (error) {
    return res.status(401).json({ success: false, data: null, error: 'Invalid or expired refresh token.' });
  }
}

async function logout(req, res) {
  const token = req.cookies?.refreshToken;

  if (token) {
    try {
      const decoded = verifyRefreshToken(token);
      await Admin.findOneAndUpdate({ id: decoded.id }, { refreshToken: null });
    } catch (_) {
      // Token invalid, that's fine for logout
    }
  }

  res.clearCookie('refreshToken', { path: '/' });
  return res.json({ success: true, data: null, error: null });
}

module.exports = { login, refreshToken, logout };
