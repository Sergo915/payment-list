const path = require('node:path');

function required(name, env) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function loadConfig(env = process.env) {
  const baseUrl = required('BANK_API_BASE_URL', env).replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('BANK_API_BASE_URL must be a valid absolute URL');
  }
  if (parsed.protocol !== 'https:' && env.NODE_ENV === 'production') {
    throw new Error('BANK_API_BASE_URL must use HTTPS in production');
  }

  const timeoutMs = Number(env.BANK_REQUEST_TIMEOUT_MS || 30000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    throw new Error('BANK_REQUEST_TIMEOUT_MS must be between 1000 and 120000');
  }
  const maxResponseBytes = Number(env.BANK_MAX_RESPONSE_BYTES || 20 * 1024 * 1024);
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 100 * 1024 * 1024) {
    throw new Error('BANK_MAX_RESPONSE_BYTES must be between 1024 and 104857600');
  }

  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be a valid TCP port');
  }

  const encryptionSecret = required('AUTH_ENCRYPTION_SECRET', env);
  if (encryptionSecret.length < 32) {
    throw new Error('AUTH_ENCRYPTION_SECRET must contain at least 32 characters');
  }

  const publicOrigin = required('PUBLIC_ORIGIN', env).replace(/\/+$/, '');
  let parsedOrigin;
  try {
    parsedOrigin = new URL(publicOrigin);
  } catch {
    throw new Error('PUBLIC_ORIGIN must be a valid absolute URL');
  }
  if (parsedOrigin.origin !== publicOrigin || !['http:', 'https:'].includes(parsedOrigin.protocol)) {
    throw new Error('PUBLIC_ORIGIN must contain only an HTTP(S) origin');
  }
  const production = env.NODE_ENV === 'production';
  if (production && parsedOrigin.protocol !== 'https:') {
    throw new Error('PUBLIC_ORIGIN must use HTTPS in production');
  }

  return {
    auth: {
      googleClientId: required('GOOGLE_CLIENT_ID', env),
      encryptionSecret,
      allowedEmails: new Set(required('GOOGLE_ALLOWED_EMAILS', env)
        .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean)),
    },
    bank: {
      baseUrl,
      accessKey: required('BANK_ACCESS_KEY', env),
      applicationName: required('BANK_APPLICATION_NAME', env),
      language: env.BANK_LANGUAGE?.trim() || 'en-US',
      timeoutMs,
      maxResponseBytes,
    },
    host: env.HOST?.trim() || '127.0.0.1',
    port,
    publicOrigin,
    secureCookies: production || parsedOrigin.protocol === 'https:',
    staticDir: path.resolve(__dirname, '..'),
  };
}

module.exports = { loadConfig };
