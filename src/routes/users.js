const express = require('express');
const auth = require('../middleware/auth');
const { applyClientScope } = require('../middleware/rbac');
const { auditLogger } = require('../middleware/auditLogger');
const { listUsers, getUserById, deactivateUser, reactivateUser } = require('../controllers/usersController');

const router = express.Router();

router.use(auth);
router.use(applyClientScope);
router.use(auditLogger);

router.get('/', listUsers);
router.get('/:id', getUserById);
router.put('/:id/deactivate', deactivateUser);
router.put('/:id/reactivate', reactivateUser);

module.exports = router;
