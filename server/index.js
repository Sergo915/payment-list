require('dotenv').config();
const { loadConfig } = require('./config');
const { BankClient } = require('./bank-client');
const { createApp } = require('./app');
const path = require('node:path');
const { AuthService } = require('./auth-service');

try {
  const config = loadConfig();
  const authService = new AuthService({
    dataDir: path.join(__dirname, '..', 'data'),
    encryptionSecret: config.auth.encryptionSecret,
    googleClientId: config.auth.googleClientId,
    allowedEmails: config.auth.allowedEmails,
    secureCookies: config.secureCookies,
  });
  const bankClient = new BankClient(config.bank);
  const app = createApp({ config, bankClient, authService });
  const server = app.listen(config.port, config.host, () => {
    console.log(`Payment list is running on ${config.host}:${config.port}`);
  });
  const shutdown = (signal) => {
    console.log(`[server] ${signal} received; shutting down`);
    server.close((error) => {
      if (error) { console.error(`[server] shutdown failed: ${error.message}`); process.exitCode = 1; }
    });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
} catch (error) {
  console.error(`Configuration error: ${error.message}`);
  process.exitCode = 1;
}
