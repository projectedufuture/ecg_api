const { validationResult } = require('express-validator');

/**
 * Express middleware that short-circuits with 400 if any express-validator
 * chain queued earlier in the stack produced errors. Place it after the
 * validator array on a route.
 */
function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      data: null,
      error: errors.array()[0].msg,
    });
  }
  return next();
}

module.exports = validate;
