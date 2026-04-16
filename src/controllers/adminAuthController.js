const crypto = require('crypto');
const { validationResult } = require('express-validator');
const Admin = require('../models/Admin');
const { generateAccessToken, generateRefreshToken, verifyRefreshToken } = require('../utils/tokenUtils');
const { sendPasswordResetEmail } = require('../utils/emailService');
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
      sameSite: config.server.nodeEnv === 'production' ? 'none' : 'lax',
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
      sameSite: config.server.nodeEnv === 'production' ? 'none' : 'lax',
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

async function forgotPassword(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, data: null, error: errors.array()[0].msg });
  }

  const { email } = req.body;

  try {
    const admin = await Admin.findOne({ email: email.toLowerCase() });

    // Always respond the same way to avoid email enumeration
    if (!admin) {
      return res.json({ success: true, data: null, error: null });
    }

    // Generate a raw token and hash it for storage
    const rawToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

    admin.resetPasswordToken = hashedToken;
    admin.resetPasswordExpiry = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
    await admin.save();

    const resetUrl = `${config.email.frontendUrl}/reset-password?token=${rawToken}`;

    await sendPasswordResetEmail({
      toEmail: admin.email,
      toName: admin.name,
      resetUrl,
    });

    return res.json({ success: true, data: null, error: null });
  } catch (error) {
    console.error('Forgot password error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

async function resetPassword(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, data: null, error: errors.array()[0].msg });
  }

  const { token, newPassword } = req.body;

  try {
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const admin = await Admin.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpiry: { $gt: new Date() },
    });

    if (!admin) {
      return res.status(400).json({ success: false, data: null, error: 'Invalid or expired reset token.' });
    }

    admin.password = newPassword; // pre-save hook handles bcrypt hashing
    admin.resetPasswordToken = null;
    admin.resetPasswordExpiry = null;
    admin.refreshToken = null; // invalidate any active sessions
    await admin.save();

    return res.json({ success: true, data: null, error: null });
  } catch (error) {
    console.error('Reset password error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

async function changePassword(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, data: null, error: errors.array()[0].msg });
  }

  const { current_password, new_password } = req.body;

  try {
    const admin = await Admin.findOne({ id: req.admin.id });
    if (!admin) {
      return res.status(404).json({ success: false, data: null, error: 'Admin not found.' });
    }

    const isMatch = await admin.comparePassword(current_password);
    if (!isMatch) {
      return res.status(400).json({ success: false, data: null, error: 'Current password is incorrect.' });
    }

    admin.password = new_password; // pre-save hook handles bcrypt hashing
    await admin.save();

    return res.json({ success: true, data: null, error: null });
  } catch (error) {
    console.error('Change password error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

async function updateProfile(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, data: null, error: errors.array()[0].msg });
  }

  const { name, email } = req.body;

  try {
    const admin = await Admin.findOne({ id: req.admin.id });
    if (!admin) {
      return res.status(404).json({ success: false, data: null, error: 'Admin not found.' });
    }

    // Check if new email is already taken by another admin
    if (email && email.toLowerCase() !== admin.email) {
      const existing = await Admin.findOne({ email: email.toLowerCase() });
      if (existing) {
        return res.status(409).json({ success: false, data: null, error: 'Email is already in use by another admin.' });
      }
      admin.email = email.toLowerCase();
    }

    if (name) admin.name = name;
    await admin.save();

    return res.json({ success: true, data: admin.toPublicJSON(), error: null });
  } catch (error) {
    console.error('Update profile error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

module.exports = { login, refreshToken, logout, forgotPassword, resetPassword, changePassword, updateProfile };
