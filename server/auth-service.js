const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const { OAuth2Client } = require('google-auth-library');

const COOKIE_NAME = 'bank_session';
const GOOGLE_COOKIE_NAME = 'bank_google_challenge';
const ENROLLMENT_COOKIE_NAME = 'bank_totp_enrollment';
authenticator.options = { ...authenticator.options, window: 1 };

function parseCookies(header = '') {
  const result = {};
  for (const part of String(header).split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    try {
      const name = decodeURIComponent(part.slice(0, separator).trim());
      const value = decodeURIComponent(part.slice(separator + 1).trim());
      result[name] = value;
    } catch {
      // A malformed cookie must not fail the entire request.
    }
  }
  return result;
}

class AuthService {
  constructor({ dataDir, encryptionSecret, googleClientId, allowedEmails = new Set(), issuer = 'Milon Bank Statements', secureCookies = false }) {
    this.filePath = path.join(dataDir, 'auth-users.enc');
    this.key = crypto.scryptSync(encryptionSecret, 'demo-payment-list-auth-v1', 32);
    this.issuer = issuer;
    this.googleClientId = googleClientId;
    this.googleClient = new OAuth2Client(googleClientId);
    this.allowedEmails = new Set([...allowedEmails].map((email) => String(email).trim().toLowerCase()));
    this.secureCookies = secureCookies;
    fs.mkdirSync(dataDir, { recursive: true });
  }

  listUsers() {
    if (!fs.existsSync(this.filePath)) return [];
    const packed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(packed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(packed.tag, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(packed.data, 'base64')), decipher.final()]);
    const users = JSON.parse(plaintext.toString('utf8'));
    return users.map((user) => ({ ...user, sessionVersion: Number(user.sessionVersion || 0) }));
  }

  saveUsers(users) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(users), 'utf8'), cipher.final()]);
    const packed = JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') });
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temporaryPath, packed, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      fs.renameSync(temporaryPath, this.filePath);
    } catch (error) {
      fs.rmSync(temporaryPath, { force: true });
      throw error;
    }
  }

  normalizeUsername(value) {
    const username = String(value || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username)) {
      throw Object.assign(new Error('Էլ․ փոստի հասցեն սխալ է'), { status: 400 });
    }
    if (!this.allowedEmails.has(username)) {
      throw Object.assign(new Error('Այս Google հաշիվը թույլատրված չէ'), { status: 403, code: 'google_account_not_allowed' });
    }
    return username;
  }

  findEnabledUser(emailValue) {
    const email = this.normalizeUsername(emailValue);
    return this.listUsers().find((user) => user.username === email && user.enabled) || null;
  }

  hasUser(emailValue) { return Boolean(this.findEnabledUser(emailValue)); }

  async verifyGoogleCredential(credential) {
    let ticket;
    try {
      ticket = await this.googleClient.verifyIdToken({ idToken: String(credential || ''), audience: this.googleClientId });
    } catch {
      throw Object.assign(new Error('Google authentication failed'), { status: 401, code: 'invalid_google_credential' });
    }
    const payload = ticket.getPayload();
    if (!payload?.email_verified) throw Object.assign(new Error('Google email is not verified'), { status: 401 });
    return this.normalizeUsername(payload.email);
  }

  async beginEnrollment(usernameValue) {
    const username = this.normalizeUsername(usernameValue);
    if (this.hasUser(username)) throw Object.assign(new Error('Authenticator-ն արդեն միացված է'), { status: 409 });
    const secret = authenticator.generateSecret();
    const token = this.createSignedToken({ username, secret, type: 'enrollment', exp: Date.now() + 10 * 60 * 1000 });
    const otpauth = authenticator.keyuri(username, this.issuer, secret);
    return { token, qrCode: await QRCode.toDataURL(otpauth, { width: 280, margin: 2 }), manualKey: secret };
  }

  verifyTotp(secret, codeValue) {
    const code = String(codeValue || '').replace(/\s/g, '');
    return /^\d{6}$/.test(code) && authenticator.check(code, secret);
  }

  verifyLogin(usernameValue, codeValue, enrollmentToken) {
    const username = this.normalizeUsername(usernameValue);
    const user = this.findEnabledUser(username);
    if (user) return this.verifyTotp(user.secret, codeValue) ? user : null;

    const enrollment = this.readSignedToken(enrollmentToken, 'enrollment');
    if (!enrollment || enrollment.username !== username || !this.verifyTotp(enrollment.secret, codeValue)) return null;
    const users = this.listUsers();
    if (users.some((item) => item.username === username)) return null;
    const created = { username, secret: enrollment.secret, enabled: true, sessionVersion: 0, createdAt: new Date().toISOString() };
    users.push(created);
    this.saveUsers(users);
    return created;
  }

  createSession(user) {
    return this.createSignedToken({ username: user.username, sessionVersion: Number(user.sessionVersion || 0), type: 'session', exp: Date.now() + 8 * 60 * 60 * 1000 });
  }

  createGoogleChallenge(username) {
    return this.createSignedToken({ username, type: 'google', exp: Date.now() + 5 * 60 * 1000 });
  }

  createSignedToken(value) {
    const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
    const signature = crypto.createHmac('sha256', this.key).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  readSignedToken(token, type) {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payload, suppliedSignature] = parts;
    const expected = crypto.createHmac('sha256', this.key).update(payload).digest();
    let supplied;
    try { supplied = Buffer.from(suppliedSignature, 'base64url'); } catch { return null; }
    if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return null;
    try {
      const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return value.exp > Date.now() && value.type === type ? value : null;
    } catch { return null; }
  }

  readSession(req) {
    const token = this.readSignedToken(parseCookies(req.headers.cookie)[COOKIE_NAME], 'session');
    if (!token) return null;
    let user;
    try { user = this.findEnabledUser(token.username); } catch { return null; }
    return user && Number(user.sessionVersion || 0) === Number(token.sessionVersion || 0) ? token : null;
  }

  readGoogleChallenge(req) { return this.readSignedToken(parseCookies(req.headers.cookie)[GOOGLE_COOKIE_NAME], 'google'); }
  readEnrollment(req) { return parseCookies(req.headers.cookie)[ENROLLMENT_COOKIE_NAME] || null; }

  revokeSessions(usernameValue) {
    const username = this.normalizeUsername(usernameValue);
    const users = this.listUsers();
    const user = users.find((item) => item.username === username);
    if (!user) return;
    user.sessionVersion = Number(user.sessionVersion || 0) + 1;
    this.saveUsers(users);
  }

  cookieHeader(name, token, maxAge) {
    return `${name}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${this.secureCookies ? '; Secure' : ''}`;
  }

  cookie(token) { return this.cookieHeader(COOKIE_NAME, token, 28800); }
  clearCookie() { return this.cookieHeader(COOKIE_NAME, '', 0); }
  googleCookie(token) { return this.cookieHeader(GOOGLE_COOKIE_NAME, token, 300); }
  clearGoogleCookie() { return this.cookieHeader(GOOGLE_COOKIE_NAME, '', 0); }
  enrollmentCookie(token) { return this.cookieHeader(ENROLLMENT_COOKIE_NAME, token, 600); }
  clearEnrollmentCookie() { return this.cookieHeader(ENROLLMENT_COOKIE_NAME, '', 0); }
}

module.exports = { AuthService, parseCookies };
