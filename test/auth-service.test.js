const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { authenticator } = require('otplib');
const { AuthService, parseCookies } = require('../server/auth-service');

function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-auth-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return new AuthService({ dataDir, encryptionSecret: 'a'.repeat(64), googleClientId: 'client', allowedEmails: new Set(['armen@example.com']), ...options });
}

test('keeps enrollment pending until the first valid TOTP code', async (t) => {
  const service = fixture(t);
  const enrollment = await service.beginEnrollment('armen@example.com');
  assert.equal(service.hasUser('armen@example.com'), false);
  assert.equal(service.verifyLogin('armen@example.com', '000000', enrollment.token), null);
  assert.equal(service.hasUser('armen@example.com'), false);
  const user = service.verifyLogin('armen@example.com', authenticator.generate(enrollment.manualKey), enrollment.token);
  assert.equal(user.username, 'armen@example.com');
  assert.equal(service.hasUser('armen@example.com'), true);
  assert.equal(fs.readFileSync(service.filePath, 'utf8').includes(enrollment.manualKey), false);
});

test('revokes copied sessions and rechecks current user state', async (t) => {
  const service = fixture(t);
  const enrollment = await service.beginEnrollment('armen@example.com');
  const user = service.verifyLogin('armen@example.com', authenticator.generate(enrollment.manualKey), enrollment.token);
  const request = { headers: { cookie: service.cookie(service.createSession(user)) } };
  assert.equal(service.readSession(request).username, 'armen@example.com');
  service.revokeSessions('armen@example.com');
  assert.equal(service.readSession(request), null);
});

test('ignores malformed cookie fragments and emits Secure cookies when configured', (t) => {
  const service = fixture(t, { secureCookies: true });
  assert.deepEqual(parseCookies('broken=%E0%A4%A; good=value'), { good: 'value' });
  assert.match(service.cookie('token'), /; Secure$/);
  assert.equal(service.readSession({ headers: { cookie: 'bank_session=%E0%A4%A' } }), null);
});

test('enforces the Google email allowlist', (t) => {
  const service = fixture(t);
  assert.equal(service.normalizeUsername(' Armen@Example.com '), 'armen@example.com');
  assert.throws(() => service.normalizeUsername('blocked@example.com'), { status: 403 });
});
