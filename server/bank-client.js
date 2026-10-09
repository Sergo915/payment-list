class BankApiError extends Error {
  constructor(message, { status = 502, bankStatus, code, details } = {}) {
    super(message);
    this.name = 'BankApiError';
    this.status = status;
    this.bankStatus = bankStatus;
    this.code = code;
    this.details = details;
  }
}

class BankClient {
  constructor(config, fetchImpl = globalThis.fetch) {
    if (typeof fetchImpl !== 'function') throw new Error('Node.js 18+ is required');
    this.config = config;
    this.fetch = fetchImpl;
    this.tokens = null;
    this.authenticationPromise = null;
  }

  async accounts() {
    return this.authorizedPost('/accounts/v1/get-list', {
      desiredAccess: 1,
      includeBalances: true,
      includeCardAccounts: true,
      onlyCardAccounts: false,
      onlyActive: true,
      currency: null,
      balanceDate: null,
    });
  }

  async transactions(params) {
    return this.authorizedPost('/accounts/v1/transactions', params);
  }

  async authorizedPost(path, body) {
    await this.ensureAuthenticated();
    const attemptedAccessToken = this.tokens.accessToken;
    let response = await this.post(path, body, attemptedAccessToken);
    if (response.status === 401) {
      await this.refreshOrAuthenticate(attemptedAccessToken);
      response = await this.post(path, body, this.tokens.accessToken);
    }
    return this.unwrap(response);
  }

  async ensureAuthenticated() {
    if (this.tokens?.accessToken) return;
    await this.singleFlight(() => this.authenticate());
  }

  async refreshOrAuthenticate(rejectedAccessToken) {
    await this.singleFlight(async () => {
      if (this.tokens?.accessToken && this.tokens.accessToken !== rejectedAccessToken) return;
      if (!this.tokens?.refreshToken) return this.authenticate();
      const response = await this.post('/authentication/v1/refresh', {
        refreshToken: this.tokens.refreshToken,
        loginMode: 0,
      });
      if (!response.ok) return this.authenticate();
      const payload = await this.readJson(response);
      const value = payload?.value;
      if (!value?.accessToken) return this.authenticate();
      this.tokens = {
        accessToken: value.accessToken,
        refreshToken: value.refreshToken || this.tokens.refreshToken,
      };
    });
  }

  async authenticate() {
    const response = await this.post('/authentication/v1/authenticate', {
      accessKey: this.config.accessKey,
      applicationName: this.config.applicationName,
    });
    const payload = await this.unwrap(response);
    if (!payload?.accessToken) {
      throw new BankApiError('Bank authentication response did not contain an access token', { code: 'invalid_bank_response' });
    }
    this.tokens = { accessToken: payload.accessToken, refreshToken: payload.refreshToken || null };
  }

  async singleFlight(action) {
    if (!this.authenticationPromise) {
      this.authenticationPromise = action().finally(() => { this.authenticationPromise = null; });
    }
    return this.authenticationPromise;
  }

  post(path, body, accessToken) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Language': this.config.language };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    const options = {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    };
    return this.fetch(`${this.config.baseUrl}${path}`, options).catch((error) => {
      if (error.name === 'TimeoutError') {
        throw new BankApiError('Bank request timed out', { status: 504, code: 'bank_timeout' });
      }
      throw new BankApiError('Could not connect to the bank API', { code: 'bank_unavailable' });
    });
  }

  async unwrap(response) {
    const payload = await this.readJson(response);
    if (!response.ok) {
      throw new BankApiError(payload?.message || `Bank API returned HTTP ${response.status}`, {
        bankStatus: response.status,
        code: 'bank_error',
        details: undefined,
      });
    }
    if (payload?.responseCode && payload.responseCode !== '0') {
      throw new BankApiError(payload.message || 'Bank API rejected the request', {
        code: 'bank_error',
        details: undefined,
      });
    }
    return payload?.value;
  }

  async readJson(response) {
    const maximum = this.config.maxResponseBytes || 20 * 1024 * 1024;
    const declaredLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maximum) {
      throw new BankApiError('Bank API response exceeded the configured size limit', { code: 'bank_response_too_large' });
    }
    let text;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0;
      let result = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maximum) {
          await reader.cancel();
          throw new BankApiError('Bank API response exceeded the configured size limit', { code: 'bank_response_too_large' });
        }
        result += decoder.decode(value, { stream: true });
      }
      text = result + decoder.decode();
    } else {
      text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > maximum) throw new BankApiError('Bank API response exceeded the configured size limit', { code: 'bank_response_too_large' });
    }
    if (!text) return null;
    try { return JSON.parse(text); } catch {
      throw new BankApiError('Bank API returned a non-JSON response', { bankStatus: response.status, code: 'invalid_bank_response' });
    }
  }
}

module.exports = { BankClient, BankApiError };
