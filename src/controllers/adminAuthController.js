
const crypto = require('crypto');
const { validationResult } = require('express-validator');
const Admin = require('../models/Admin');
const {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
} = require('../utils/tokenUtils');
const { sendPasswordResetEmail } = require('../utils/emailService');
const config = require('../config/env');

async function login(req, res) {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      data: null,
      error: errors.array()[0].msg,
    });
  }

  const { email, password } = req.body;
  console.log("RAW EMAIL:", JSON.stringify(email));
  console.log("EMAIL LENGTH:", email?.length);

  try {
    const normalizedEmail = String(email || '').trim().toLowerCase();

    console.log('[admin login] database:', Admin.db.name);
    console.log('[admin login] collection:', Admin.collection.name);
    console.log('[admin login] email:', normalizedEmail);

    const admin = await Admin.findOne({ email: normalizedEmail });

    console.log('[admin login] admin found:', !!admin);

    if (!admin) {
      return res.status(401).json({
        success: false,
        data: null,
        error: 'Invalid email or password.',
      });
    }

    const isMatch = await admin.comparePassword(password);

    console.log('[admin login] password matches:', isMatch);

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        data: null,
        error: 'Invalid email or password.',
      });
    }

    const accessToken = generateAccessToken(admin);
    const refreshToken = generateRefreshToken(admin);

    admin.refreshToken = refreshToken;
    await admin.save();

    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: config.server.nodeEnv === 'production',
      sameSite:
        config.server.nodeEnv === 'production' ? 'none' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
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
    console.error('[admin login] error:', error.message);

    return res.status(500).json({
      success: false,
      data: null,
      error: 'Internal server error.',
    });
  }
}

async function refreshToken(req, res) {
  const token = req.cookies?.refreshToken;

  if (!token) {
    return res.status(401).json({
      success: false,
      data: null,
      error: 'No refresh token provided.',
    });
  }

  try {
    const decoded = verifyRefreshToken(token);
    const admin = await Admin.findOne({
      id: decoded.id,
      refreshToken: token,
    });

    if (!admin) {
      return res.status(401).json({
        success: false,
        data: null,
        error: 'Invalid refresh token.',
      });
    }

    const newAccessToken = generateAccessToken(admin);
    const newRefreshToken = generateRefreshToken(admin);

    admin.refreshToken = newRefreshToken;
    await admin.save();

    res.cookie('refreshToken', newRefreshToken, {
      httpOnly: true,
      secure: config.server.nodeEnv === 'production',
      sameSite:
        config.server.nodeEnv === 'production' ? 'none' : 'lax',
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
    console.error('[admin refresh] error:', error.message);

    return res.status(401).json({
      success: false,
      data: null,
      error: 'Invalid or expired refresh token.',
    });
  }
}

async function logout(req, res) {
  const token = req.cookies?.refreshToken;

  if (token) {
    try {
      const decoded = verifyRefreshToken(token);
      await Admin.findOneAndUpdate(
        { id: decoded.id },
        { refreshToken: null }
      );
    } catch (_) {
      // An invalid token does not prevent logout.
    }
  }

  res.clearCookie('refreshToken', { path: '/' });

  return res.json({
    success: true,
    data: null,
    error: null,
  });
}

async function forgotPassword(req, res) {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      data: null,
      error: errors.array()[0].msg,
    });
  }

  const { email } = req.body;

  try {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const admin = await Admin.findOne({ email: normalizedEmail });

    // Keep the response consistent to prevent email enumeration.
    if (!admin) {
      return res.json({
        success: true,
        data: null,
        error: null,
      });
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto
      .createHash('sha256')
      .update(rawToken)
      .digest('hex');

    admin.resetPasswordToken = hashedToken;
    admin.resetPasswordExpiry = new Date(Date.now() + 15 * 60 * 1000);

    await admin.save();

    const resetUrl =
      `${config.email.frontendUrl}/reset-password?token=${rawToken}`;

    await sendPasswordResetEmail({
      toEmail: admin.email,
      toName: admin.name,
      resetUrl,
    });

    return res.json({
      success: true,
      data: null,
      error: null,
    });
  } catch (error) {
    console.error('[admin forgot password] error:', error.message);

    return res.status(500).json({
      success: false,
      data: null,
      error: 'Internal server error.',
    });
  }
}

async function resetPassword(req, res) {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      data: null,
      error: errors.array()[0].msg,
    });
  }

  const { token, newPassword } = req.body;

  try {
    const hashedToken = crypto
      .createHash('sha256')
      .update(token)
      .digest('hex');

    const admin = await Admin.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpiry: { $gt: new Date() },
    });

    if (!admin) {
      return res.status(400).json({
        success: false,
        data: null,
        error: 'Invalid or expired reset token.',
      });
    }

    // The Admin model hashes the password before saving.
    admin.password = newPassword;
    admin.resetPasswordToken = null;
    admin.resetPasswordExpiry = null;
    admin.refreshToken = null;

    await admin.save();

    return res.json({
      success: true,
      data: null,
      error: null,
    });
  } catch (error) {
    console.error('[admin reset password] error:', error.message);

    return res.status(500).json({
      success: false,
      data: null,
      error: 'Internal server error.',
    });
  }
}

async function changePassword(req, res) {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      data: null,
      error: errors.array()[0].msg,
    });
  }

  const { current_password, new_password } = req.body;

  try {
    const admin = await Admin.findOne({ id: req.admin.id });

    if (!admin) {
      return res.status(404).json({
        success: false,
        data: null,
        error: 'Admin not found.',
      });
    }

    const isMatch = await admin.comparePassword(current_password);

    if (!isMatch) {
      return res.status(400).json({
        success: false,
        data: null,
        error: 'Current password is incorrect.',
      });
    }

    admin.password = new_password;
    await admin.save();

    return res.json({
      success: true,
      data: null,
      error: null,
    });
  } catch (error) {
    console.error('[admin change password] error:', error.message);

    return res.status(500).json({
      success: false,
      data: null,
      error: 'Internal server error.',
    });
  }
}

async function updateProfile(req, res) {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      data: null,
      error: errors.array()[0].msg,
    });
  }

  const { name, email } = req.body;

  try {
    const admin = await Admin.findOne({ id: req.admin.id });

    if (!admin) {
      return res.status(404).json({
        success: false,
        data: null,
        error: 'Admin not found.',
      });
    }

    if (email && email.trim().toLowerCase() !== admin.email) {
      const normalizedEmail = email.trim().toLowerCase();

      const existing = await Admin.findOne({
        email: normalizedEmail,
      });

      if (existing) {
        return res.status(409).json({
          success: false,
          data: null,
          error: 'Email is already in use by another admin.',
        });
      }

      admin.email = normalizedEmail;
    }

    if (name) {
      admin.name = name;
    }

    await admin.save();

    return res.json({
      success: true,
      data: admin.toPublicJSON(),
      error: null,
    });
  } catch (error) {
    console.error('[admin update profile] error:', error.message);

    return res.status(500).json({
      success: false,
      data: null,
      error: 'Internal server error.',
    });
  }
}

module.exports = {
  login,
  refreshToken,
  logout,
  forgotPassword,
  resetPassword,
  changePassword,
  updateProfile,
};