const express = require('express');
const appAuth = require('../../middleware/appAuth');
const { syncData } = require('../../controllers/app/syncController');

const router = express.Router();

router.post('/', appAuth, syncData);

module.exports = router;
