const { verifyAccessToken } = require('../utils/tokenUtils');

function auth(req, res, next) {
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
    const decoded = verifyAccessToken(token);
    // Mobile-app tokens are signed with the SAME secret, so the signature
    // alone does not prove this is an admin. An app token has no admin role;
    // without this check it reached applyClientScope with clientScope
    // `undefined`, which every controller treats as "unscoped super admin".
    if (decoded.type === 'app' || !['super_admin', 'client_admin'].includes(decoded.role) || !decoded.id) {
      return res.status(401).json({
        success: false,
        data: null,
        error: 'Invalid token.',
      });
    }
    req.admin = decoded;
    next();
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

module.exports = auth;
