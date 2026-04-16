/**
 * Role-based access control middleware.
 * super_admin: full access to all data across all clients.
 * client_admin: access scoped to their own clientId.
 */

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.admin) {
      return res.status(401).json({
        success: false,
        data: null,
        error: 'Authentication required.',
      });
    }

    if (!roles.includes(req.admin.role)) {
      return res.status(403).json({
        success: false,
        data: null,
        error: 'Insufficient permissions.',
      });
    }

    next();
  };
}

/**
 * Applies client scoping for client_admin users.
 * Attaches req.clientScope which controllers use to filter queries.
 * super_admin gets null (no filter = see everything).
 * client_admin gets their clientId.
 */
function applyClientScope(req, res, next) {
  if (req.admin.role === 'super_admin') {
    req.clientScope = null; // no restriction
  } else {
    req.clientScope = req.admin.clientId;
  }
  next();
}

module.exports = { requireRole, applyClientScope };
