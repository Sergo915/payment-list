const express = require('express');
const helmet = require('helmet');
const { BankApiError } = require('./bank-client');
const { createStatementWorkbook } = require('./statement-workbook');

const ACCOUNT_RE = /^[A-Za-z0-9.-]{5,34}$/;
const MAX_RANGE_DAYS = 366;
const MAX_EXPORT_ROWS = 20000;

function requestError(message, status = 400, code = 'invalid_request') {
  return Object.assign(new Error(message), { status, code });
}

function parseDay(value, field, endOfDay = false) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw requestError(`${field} must use YYYY-MM-DD`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const instant = new Date(Date.UTC(year, month - 1, day, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0));
  if (instant.getUTCFullYear() !== year || instant.getUTCMonth() !== month - 1 || instant.getUTCDate() !== day) {
    throw requestError(`${field} is not a valid calendar date`);
  }
  return instant;
}

function parseDateRange(query) {
  const from = parseDay(query.dateFrom, 'dateFrom');
  const to = parseDay(query.dateTo, 'dateTo', true);
  if (from > to) throw requestError('dateFrom must not be after dateTo');
  if ((to - from) / 86400000 > MAX_RANGE_DAYS) throw requestError(`Date range must not exceed ${MAX_RANGE_DAYS} days`);
  return { dateFrom: from.toISOString(), dateTo: to.toISOString() };
}

function createRateLimiter({ limit, windowMs, key = (req) => req.ip }) {
  const attempts = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const id = key(req);
    const entry = attempts.get(id);
    if (!entry || entry.resetAt <= now) {
      if (attempts.size >= 10000) {
        for (const [entryKey, value] of attempts) if (value.resetAt <= now) attempts.delete(entryKey);
        if (attempts.size >= 10000) return res.status(429).json({ error: { code: 'too_many_requests', message: 'Չափազանց շատ հարցումներ։ Փորձեք ավելի ուշ։' } });
      }
      attempts.set(id, { count: 1, resetAt: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count <= limit) return next();
    res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
    return res.status(429).json({ error: { code: 'too_many_requests', message: 'Չափազանց շատ հարցումներ։ Փորձեք ավելի ուշ։' } });
  };
}

function audit(event, fields = {}) {
  console.log(JSON.stringify({ type: 'audit', event, at: new Date().toISOString(), ...fields }));
}

function createApp({ config, bankClient, authService }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://accounts.google.com'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://accounts.google.com'],
        imgSrc: ["'self'", 'data:', 'https://*.googleusercontent.com'],
        frameSrc: ['https://accounts.google.com'],
        connectSrc: ["'self'", 'https://accounts.google.com'],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    referrerPolicy: { policy: 'no-referrer' },
  }));
  app.use(express.json({ limit: '32kb' }));

  app.use((req, res, next) => {
    const origin = req.get('Origin');
    if (!origin || origin === config.publicOrigin) return next();
    return res.status(403).json({ error: { code: 'origin_not_allowed', message: 'Origin is not allowed' } });
  });

  const authRateLimit = createRateLimiter({ limit: 20, windowMs: 5 * 60 * 1000 });
  const dataRateLimit = createRateLimiter({ limit: 60, windowMs: 60 * 1000, key: (req) => req.user?.username || req.ip });
  const loginFailures = new Map();

  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/auth/config', (_req, res) => res.json({ googleClientId: authService.googleClientId }));

  app.post('/api/auth/google', authRateLimit, async (req, res, next) => {
    try {
      const email = await authService.verifyGoogleCredential(req.body?.credential);
      res.setHeader('Set-Cookie', authService.googleCookie(authService.createGoogleChallenge(email)));
      audit('google_auth_success', { username: email, ip: req.ip });
      res.json({ email, requiresEnrollment: !authService.hasUser(email) });
    } catch (error) { audit('google_auth_failure', { ip: req.ip }); next(error); }
  });

  app.get('/api/auth/me', (req, res) => {
    const session = authService.readSession(req);
    if (!session) return res.status(401).json({ error: { code: 'authentication_required', message: 'Մուտք գործեք համակարգ' } });
    return res.json({ username: session.username });
  });

  app.post('/api/auth/enroll', authRateLimit, async (req, res, next) => {
    try {
      const challenge = authService.readGoogleChallenge(req);
      if (!challenge) throw requestError('Նախ մուտք գործեք Google հաշվով', 401, 'google_authentication_required');
      const enrollment = await authService.beginEnrollment(challenge.username);
      res.setHeader('Set-Cookie', authService.enrollmentCookie(enrollment.token));
      res.set('Cache-Control', 'no-store');
      audit('totp_enrollment_started', { username: challenge.username, ip: req.ip });
      res.json({ qrCode: enrollment.qrCode, manualKey: enrollment.manualKey });
    } catch (error) { next(error); }
  });

  app.post('/api/auth/login', authRateLimit, (req, res, next) => {
    try {
      const challenge = authService.readGoogleChallenge(req);
      if (!challenge) throw requestError('Նախ մուտք գործեք Google հաշվով', 401, 'google_authentication_required');
      const key = `${req.ip}:${challenge.username}`;
      const attempt = loginFailures.get(key) || { count: 0, blockedUntil: 0 };
      if (attempt.blockedUntil > Date.now()) throw requestError('Չափազանց շատ սխալ փորձեր։ Փորձեք 5 րոպե անց։', 429, 'too_many_attempts');
      const user = authService.verifyLogin(challenge.username, req.body?.code, authService.readEnrollment(req));
      if (!user) {
        attempt.count += 1;
        if (attempt.count >= 5) { attempt.count = 0; attempt.blockedUntil = Date.now() + 5 * 60 * 1000; }
        loginFailures.set(key, attempt);
        audit('totp_login_failure', { username: challenge.username, ip: req.ip });
        throw requestError('Authenticator կոդը սխալ է կամ արդեն ժամկետանց է', 401, 'invalid_code');
      }
      loginFailures.delete(key);
      res.setHeader('Set-Cookie', [authService.cookie(authService.createSession(user)), authService.clearGoogleCookie(), authService.clearEnrollmentCookie()]);
      audit('login_success', { username: user.username, ip: req.ip });
      res.json({ username: user.username });
    } catch (error) { next(error); }
  });

  app.post('/api/auth/logout', (req, res) => {
    const session = authService.readSession(req);
    if (session) {
      authService.revokeSessions(session.username);
      audit('logout', { username: session.username, ip: req.ip });
    }
    res.setHeader('Set-Cookie', [authService.clearCookie(), authService.clearGoogleCookie(), authService.clearEnrollmentCookie()]);
    res.json({ ok: true });
  });

  app.use('/api/accounts', (req, res, next) => {
    const session = authService.readSession(req);
    if (!session) return res.status(401).json({ error: { code: 'authentication_required', message: 'Մուտք գործեք համակարգ' } });
    req.user = session;
    return dataRateLimit(req, res, next);
  });

  let accountCache = { expiresAt: 0, accounts: [] };
  async function getAccounts() {
    if (accountCache.expiresAt > Date.now()) return accountCache.accounts;
    const accounts = (await bankClient.accounts()) || [];
    accountCache = { accounts, expiresAt: Date.now() + 30000 };
    return accounts;
  }

  async function validatedRequest(req) {
    const accountNumber = req.params.accountNumber.trim();
    if (!ACCOUNT_RE.test(accountNumber)) throw requestError('accountNumber has an invalid format');
    const accounts = await getAccounts();
    if (!accounts.some((account) => String(account.number) === accountNumber)) throw requestError('Հաշիվը հասանելի չէ', 403, 'account_not_allowed');
    return { accountNumber, ...parseDateRange(req.query) };
  }

  app.get('/api/accounts', async (req, res, next) => {
    try {
      const accounts = await getAccounts();
      audit('accounts_viewed', { username: req.user.username, ip: req.ip });
      res.set('Cache-Control', 'no-store').json({ accounts });
    } catch (error) { next(error); }
  });

  app.get('/api/accounts/:accountNumber/transactions', async (req, res, next) => {
    try {
      const { accountNumber, dateFrom, dateTo } = await validatedRequest(req);
      const transactions = (await bankClient.transactions({ accountNumber, dateFrom, dateTo, showAmdEquivalents: req.query.showAmdEquivalents !== 'false', includeTransferIds: req.query.includeTransferIds === 'true' })) || [];
      audit('transactions_viewed', { username: req.user.username, accountNumber, dateFrom, dateTo, count: transactions.length, ip: req.ip });
      res.set('Cache-Control', 'no-store').json({ accountNumber, dateFrom, dateTo, transactions });
    } catch (error) { next(error); }
  });

  app.get('/api/accounts/:accountNumber/transactions.xlsx', async (req, res, next) => {
    try {
      const { accountNumber, dateFrom, dateTo } = await validatedRequest(req);
      const transactions = (await bankClient.transactions({ accountNumber, dateFrom, dateTo, showAmdEquivalents: true, includeTransferIds: true })) || [];
      if (transactions.length > MAX_EXPORT_ROWS) throw requestError(`Excel export is limited to ${MAX_EXPORT_ROWS} rows`, 413, 'export_too_large');
      const buffer = await createStatementWorkbook({ transactions, accountNumber, dateFrom, dateTo });
      const filename = `statement_${accountNumber}_${dateFrom.slice(0, 10)}_${dateTo.slice(0, 10)}.xlsx`;
      audit('statement_downloaded', { username: req.user.username, accountNumber, dateFrom, dateTo, count: transactions.length, ip: req.ip });
      res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${filename}"`, 'Content-Length': buffer.length, 'Cache-Control': 'no-store' });
      res.send(Buffer.from(buffer));
    } catch (error) { next(error); }
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'not_found', message: 'API route not found' } }));
  app.get(['/setup.html', '*.map', '/static/js/main.*', '/static/js/453.*'], (_req, res) => res.sendStatus(404));
  app.use(express.static(config.staticDir, { index: 'index.html', maxAge: '1h', setHeaders: (res, filePath) => { if (filePath.endsWith('index.html') || filePath.endsWith('bank-download.js')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); } }));
  app.get('*', (_req, res) => res.sendFile('index.html', { root: config.staticDir }));

  app.use((error, _req, res, _next) => {
    const status = Number.isInteger(error.status) ? error.status : 500;
    const isBankError = error instanceof BankApiError;
    if (status >= 500) console.error(`[server] ${error.name}: ${error.message}`);
    res.status(status).json({ error: { code: error.code || (isBankError ? 'bank_error' : 'request_error'), message: isBankError ? 'Բանկի ծառայությունը ժամանակավորապես անհասանելի է' : status >= 500 ? 'Internal server error' : error.message, ...(isBankError && error.bankStatus ? { bankStatus: error.bankStatus } : {}) } });
  });
  return app;
}

module.exports = { createApp, parseDateRange, parseDay, createRateLimiter };
