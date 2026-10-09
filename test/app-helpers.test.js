const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDateRange } = require('../server/app');

test('date range is strict, UTC based, and includes the full final day', () => {
  assert.deepEqual(parseDateRange({ dateFrom: '2026-10-01', dateTo: '2026-10-08' }), { dateFrom: '2026-10-01T00:00:00.000Z', dateTo: '2026-10-08T23:59:59.999Z' });
  assert.throws(() => parseDateRange({ dateFrom: '2026-02-30', dateTo: '2026-03-01' }), /valid calendar/);
  assert.throws(() => parseDateRange({ dateFrom: '2026-01-01T00:00:00Z', dateTo: '2026-01-02' }), /YYYY-MM-DD/);
  assert.throws(() => parseDateRange({ dateFrom: '2025-01-01', dateTo: '2026-02-01' }), /366 days/);
});
