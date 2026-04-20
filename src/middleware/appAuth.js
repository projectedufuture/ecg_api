const { verifyAppAccessToken } = require('../utils/appTokenUtils');

function appAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      data: null,
      error: 'Access denied. No token provided.',
    });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = verifyAppAccessToken(token);
    if (decoded.type !== 'app' || !decoded.userId) {
      return res.status(401).json({
        success: false,
        data: null,
        error: 'Invalid token.',
      });
    }
    req.user = { userId: decoded.userId, email: decoded.email };
    return next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        data: null,
        error: 'Token expired.',
      });
    }
    return res.status(401).json({
      success: false,
      data: null,
      error: 'Invalid token.',
    });
  }
}

module.exports = appAuth;
