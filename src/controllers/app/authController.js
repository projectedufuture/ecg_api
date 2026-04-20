const crypto = require('crypto');
const { validationResult } = require('express-validator');
const User = require('../../models/User');
const {
  generateAppAccessToken,
  generateAppRefreshToken,
  verifyAppRefreshToken,
} = require('../../utils/appTokenUtils');
const { sendAppPasswordResetEmail } = require('../../utils/emailService');
const config = require('../../config/env');

function makeUserId() {
  return `USR-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

async function register(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, data: null, error: errors.array()[0].msg });
  }

  const { name, email, password } = req.body;

  try {
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res
        .status(409)
        .json({ success: false, data: null, error: 'Email already registered.' });
    }

    const nowIso = new Date().toISOString();
    const user = new User({
      id: makeUserId(),
      name,
      email: email.toLowerCase(),
      password,
      registeredDate: nowIso,
      lastActive: nowIso,
      status: 'active',
    });

    const accessToken = generateAppAccessToken(user);
    const refreshToken = generateAppRefreshToken(user);
    user.refreshToken = refreshToken;
    await user.save();

    return res.status(201).json({
      success: true,
      data: {
        user: user.toAppJSON(),
        accessToken,
        refreshToken,
      },
      error: null,
    });
  } catch (error) {
    console.error('App register error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

async function login(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, data: null, error: errors.array()[0].msg });
  }

  const { email, password } = req.body;

  try {
    const user = await User.findOne({ email: email.toLowerCase() }).select('+password +refreshToken');
    if (!user || !user.password) {
      return res
        .status(401)
        .json({ success: false, data: null, error: 'Invalid email or password.' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res
        .status(401)
        .json({ success: false, data: null, error: 'Invalid email or password.' });
    }

    const accessToken = generateAppAccessToken(user);
    const refreshToken = generateAppRefreshToken(user);

    user.refreshToken = refreshToken;
    user.lastActive = new Date().toISOString();
    await user.save();

    return res.json({
      success: true,
      data: {
        user: user.toAppJSON(),
        accessToken,
        refreshToken,
      },
      error: null,
    });
  } catch (error) {
    console.error('App login error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

async function refresh(req, res) {
  const token = req.body?.refreshToken || req.cookies?.refreshToken;

  if (!token) {
    return res
      .status(401)
      .json({ success: false, data: null, error: 'Refresh token is required.' });
  }

  try {
    const decoded = verifyAppRefreshToken(token);
    if (decoded.type !== 'app') {
      return res.status(401).json({ success: false, data: null, error: 'Invalid refresh token.' });
    }

    const user = await User.findOne({ id: decoded.userId }).select('+refreshToken');
    if (!user || user.refreshToken !== token) {
      return res.status(401).json({ success: false, data: null, error: 'Invalid refresh token.' });
    }

    const newAccessToken = generateAppAccessToken(user);
    const newRefreshToken = generateAppRefreshToken(user);

    user.refreshToken = newRefreshToken;
    await user.save();

    return res.json({
      success: true,
      data: {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
      },
      error: null,
    });
  } catch (error) {
    return res
      .status(401)
      .json({ success: false, data: null, error: 'Invalid or expired refresh token.' });
  }
}

async function logout(req, res) {
  try {
    await User.findOneAndUpdate({ id: req.user.userId }, { refreshToken: null });
    return res.json({ success: true, data: null, error: null });
  } catch (error) {
    console.error('App logout error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

async function changePassword(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, data: null, error: errors.array()[0].msg });
  }

  const { currentPassword, newPassword } = req.body;

  try {
    const user = await User.findOne({ id: req.user.userId }).select('+password');
    if (!user || !user.password) {
      return res.status(404).json({ success: false, data: null, error: 'User not found.' });
    }

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res
        .status(400)
        .json({ success: false, data: null, error: 'Current password is incorrect.' });
    }

    user.password = newPassword;
    user.refreshToken = null;
    await user.save();

    return res.json({ success: true, data: null, error: null });
  } catch (error) {
    console.error('App change password error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

async function forgotPassword(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, data: null, error: errors.array()[0].msg });
  }

  const { email } = req.body;

  try {
    const user = await User.findOne({ email: email.toLowerCase() });

    // Always respond identically to prevent email enumeration
    if (!user) {
      return res.json({ success: true, data: null, error: null });
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

    user.resetPasswordToken = hashedToken;
    user.resetPasswordExpiry = new Date(Date.now() + 15 * 60 * 1000);
    await user.save();

    const resetUrl = `${config.email.frontendUrl}/app/reset-password?token=${rawToken}`;

    try {
      await sendAppPasswordResetEmail({
        toEmail: user.email,
        toName: user.name,
        resetUrl,
      });
    } catch (mailErr) {
      console.error('Brevo send error:', mailErr);
    }

    return res.json({ success: true, data: null, error: null });
  } catch (error) {
    console.error('App forgot password error:', error);
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

    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpiry: { $gt: new Date() },
    }).select('+password +resetPasswordToken +resetPasswordExpiry +refreshToken');

    if (!user) {
      return res
        .status(400)
        .json({ success: false, data: null, error: 'Invalid or expired reset token.' });
    }

    user.password = newPassword;
    user.resetPasswordToken = null;
    user.resetPasswordExpiry = null;
    user.refreshToken = null;
    await user.save();

    return res.json({ success: true, data: null, error: null });
  } catch (error) {
    console.error('App reset password error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

module.exports = { register, login, refresh, logout, changePassword, forgotPassword, resetPassword };
