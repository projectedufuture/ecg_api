const express = require('express');
const { query } = require('express-validator');
const appAuth = require('../../middleware/appAuth');
const { getAnalytics } = require('../../controllers/app/analyticsController');

const router = express.Router();

router.get(
  '/',
  appAuth,
  [query('period').optional().isIn(['day', 'week', 'month', 'year'])],
  getAnalytics
);

module.exports = router;
