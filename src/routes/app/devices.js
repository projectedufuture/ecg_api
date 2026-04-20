const express = require('express');
const { body } = require('express-validator');
const appAuth = require('../../middleware/appAuth');
const {
  pairDevice,
  getMyDevice,
  unpairDevice,
} = require('../../controllers/app/devicesController');

const router = express.Router();

router.post(
  '/pair',
  appAuth,
  [body('deviceId').isString().trim().notEmpty().withMessage('deviceId is required.')],
  pairDevice
);

router.get('/mine', appAuth, getMyDevice);

router.delete('/mine', appAuth, unpairDevice);

module.exports = router;
