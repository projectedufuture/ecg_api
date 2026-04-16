const express = require('express');
const auth = require('../middleware/auth');
const { applyClientScope } = require('../middleware/rbac');
const { getDashboard } = require('../controllers/dashboardController');

const router = express.Router();

router.use(auth);
router.use(applyClientScope);

router.get('/', getDashboard);

module.exports = router;
