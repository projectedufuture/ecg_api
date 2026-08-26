const { validationResult } = require('express-validator');
const User = require('../../models/User');
const { attachCachedAddress, queueResolve } = require('../../services/locationService');

async function getMe(req, res) {
  try {
    const user = await User.findOne({ id: req.user.userId });
    if (!user) {
      return res.status(404).json({ success: false, data: null, error: 'User not found.' });
    }
    return res.json({ success: true, data: user.toAppJSON(), error: null });
  } catch (error) {
    console.error('App getMe error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

async function updateMe(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, data: null, error: errors.array()[0].msg });
  }

  const { name, email } = req.body;

  try {
    const user = await User.findOne({ id: req.user.userId });
    if (!user) {
      return res.status(404).json({ success: false, data: null, error: 'User not found.' });
    }

    if (email && email.toLowerCase() !== user.email) {
      const taken = await User.findOne({ email: email.toLowerCase() });
      if (taken) {
        return res
          .status(409)
          .json({ success: false, data: null, error: 'Email is already in use.' });
      }
      user.email = email.toLowerCase();
    }

    if (name) user.name = name;
    user.lastActive = new Date().toISOString();
    await user.save();

    return res.json({ success: true, data: user.toAppJSON(), error: null });
  } catch (error) {
    console.error('App updateMe error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

async function updateLocation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, data: null, error: errors.array()[0].msg });
  }

  const { lat, lng, accuracy, address } = req.body;

  try {
    const user = await User.findOne({ id: req.user.userId });
    if (!user) {
      return res.status(404).json({ success: false, data: null, error: 'User not found.' });
    }

    // Attach a place name so admins see somewhere recognisable rather than raw
    // coordinates. Only the cache is consulted here - a miss is resolved in the
    // background below, so this request never waits on a third-party service.
    user.lastLocation = await attachCachedAddress({
      lat: Number(lat),
      lng: Number(lng),
      accuracy: accuracy != null ? Number(accuracy) : null,
      address: address || null,
      capturedAt: new Date(),
    });
    user.lastActive = new Date().toISOString();
    await user.save();

    if (!user.lastLocation.address) {
      queueResolve({ userId: user.id, lat: Number(lat), lng: Number(lng) });
    }

    return res.json({
      success: true,
      data: { lastLocation: user.lastLocation },
      error: null,
    });
  } catch (error) {
    console.error('App update location error:', error);
    return res.status(500).json({ success: false, data: null, error: 'Internal server error.' });
  }
}

module.exports = { getMe, updateMe, updateLocation };
