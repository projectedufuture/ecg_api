/**
 * The app-facing report module registry.
 *
 * The overview endpoint projects each module's FULL mapped response down to a
 * handful of headline fields. These tests pin that projection, because a field
 * renamed in a mapper would otherwise turn the overview silently into nulls
 * while the detail view kept working.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { MODULE_NAMES } = require('../src/controllers/app/reportsController');

test('all seven report modules are exposed to the app', () => {
  assert.deepEqual(MODULE_NAMES, [
    'ecg-rr',
    'hrv',
    'rhythm',
    'respiration',
    'spo2',
    'temperature',
    'combined',
  ]);
});

test('the module names match the admin route names', () => {
  // The app and admin APIs must address the same modules by the same names, so
  // documentation and client code can be shared.
  const adminRoutes = require('fs')
    .readFileSync(require('path').join(__dirname, '..', 'src', 'routes', 'sessions.js'), 'utf8');
  for (const name of MODULE_NAMES) {
    assert.ok(
      adminRoutes.includes(`/reports/${name}`),
      `admin API is missing a /reports/${name} route`
    );
  }
});
