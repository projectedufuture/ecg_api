/**
 * Options passed to express-validator's .normalizeEmail().
 *
 * validator.js defaults strip dots from the local part of @gmail.com addresses
 * (gmail_remove_dots) and drop "+tag" subaddresses. That turns a real, stored
 * address such as `project.edufuture@gmail.com` into `projectedufuture@gmail.com`
 * before it reaches any controller, so the Admin/User lookup misses and login
 * fails. We disable those destructive rules and keep only safe canonicalization:
 * lowercasing. Dots and plus signs are preserved for every provider.
 */
const EMAIL_NORMALIZE_OPTS = {
  all_lowercase: true,
  gmail_remove_dots: false,
  gmail_remove_subaddress: false,
  outlookdotcom_remove_subaddress: false,
  icloud_remove_subaddress: false,
  yahoo_remove_subaddress: false,
};

module.exports = { EMAIL_NORMALIZE_OPTS };
