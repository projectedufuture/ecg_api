const express = require('express');
const { param, body } = require('express-validator');
const auth = require('../middleware/auth');
const { applyClientScope } = require('../middleware/rbac');
const { auditLogger } = require('../middleware/auditLogger');
const validate = require('../middleware/validate');
const { listUsers, getUserById, deactivateUser, reactivateUser } = require('../controllers/usersController');

const router = express.Router();

router.use(auth);
router.use(applyClientScope);
router.use(auditLogger);

const idParam = [param('id').isString().trim().notEmpty().withMessage('User id is required.')];
const reasonBody = [body('reason').optional().isString().trim().isLength({ max: 500 })];

router.get('/', listUsers);
router.get('/:id', idParam, validate, getUserById);
router.put('/:id/deactivate', idParam, reasonBody, validate, deactivateUser);
router.put('/:id/reactivate', idParam, reasonBody, validate, reactivateUser);

module.exports = router;
