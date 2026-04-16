const AuditLog = require('../models/AuditLog');

/**
 * Creates an audit log entry.
 * Can be called directly from controllers for mutation endpoints.
 */
async function createAuditLog({ adminId, action, resourceType, resourceId, details, ipAddress }) {
  try {
    await AuditLog.create({
      adminId,
      action,
      resourceType,
      resourceId,
      timestamp: new Date(),
      details: details || {},
      ipAddress: ipAddress || null,
    });
  } catch (error) {
    console.error('Audit log creation failed:', error.message);
  }
}

/**
 * Middleware that attaches the audit logger function to the request.
 */
function auditLogger(req, res, next) {
  req.audit = async (action, resourceType, resourceId, details) => {
    const ip = req.ip || req.connection.remoteAddress || null;
    await createAuditLog({
      adminId: req.admin ? req.admin.id : 'unknown',
      action,
      resourceType,
      resourceId,
      details,
      ipAddress: ip,
    });
  };
  next();
}

module.exports = { auditLogger, createAuditLog };
