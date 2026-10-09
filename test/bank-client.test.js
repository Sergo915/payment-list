const test = require('node:test');
const assert = require('node:assert/strict');
const { BankClient } = require('../server/bank-client');

const config = { baseUrl: 'https://bank.test/api', accessKey: 'secret', applicationName: 'test-app', language: 'en-US', timeoutMs: 5000 };
const jsonResponse = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

test('authenticates and requests transactions with a bearer token', async () => {
  const calls = [];
  const fetchMock = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    if (url.endsWith('/authenticate')) return jsonResponse(200, { value: { accessToken: 'access', refreshToken: 'refresh' } });
    return jsonResponse(200, { value: [{ bankTransactionId: '42.0' }] });
  };
  const client = new BankClient(config, fetchMock);
  const result = await client.transactions({ accountNumber: '12345' });
  assert.equal(result[0].bankTransactionId, '42.0');
  assert.deepEqual(calls[0].body, { accessKey: 'secret', applicationName: 'test-app' });
  assert.equal(calls[1].options.headers.Authorization, 'Bearer access');
});

test('refreshes after 401 and retries once with the new token', async () => {
  let transactionCalls = 0;
  const fetchMock = async (url, options) => {
    if (url.endsWith('/authenticate')) return jsonResponse(200, { value: { accessToken: 'old', refreshToken: 'refresh-1' } });
    if (url.endsWith('/refresh')) return jsonResponse(200, { value: { accessToken: 'new', refreshToken: null } });
    transactionCalls += 1;
    if (transactionCalls === 1) return jsonResponse(401, { message: 'expired' });
    assert.equal(options.headers.Authorization, 'Bearer new');
    return jsonResponse(200, { value: [] });
  };
  const client = new BankClient(config, fetchMock);
  assert.deepEqual(await client.transactions({ accountNumber: '12345' }), []);
  assert.equal(transactionCalls, 2);
});

test('coalesces concurrent refreshes after the same access token is rejected', async () => {
  let refreshes = 0;
  let transactionCalls = 0;
  const fetchMock = async (url, options) => {
    if (url.endsWith('/authenticate')) return jsonResponse(200, { value: { accessToken: 'old', refreshToken: 'refresh' } });
    if (url.endsWith('/refresh')) { refreshes += 1; await new Promise((resolve) => setTimeout(resolve, 10)); return jsonResponse(200, { value: { accessToken: 'new', refreshToken: 'refresh-2' } }); }
    transactionCalls += 1;
    return options.headers.Authorization === 'Bearer old' ? jsonResponse(401, { message: 'expired' }) : jsonResponse(200, { value: [] });
  };
  const client = new BankClient(config, fetchMock);
  await Promise.all([client.transactions({}), client.transactions({})]);
  assert.equal(refreshes, 1);
  assert.equal(transactionCalls, 4);
});

test('rejects oversized upstream responses and does not expose response codes', async () => {
  const oversized = new BankClient({ ...config, maxResponseBytes: 32 }, async () => new Response(JSON.stringify({ value: 'x'.repeat(100) })));
  await assert.rejects(() => oversized.accounts(), { code: 'bank_response_too_large' });

  const rejected = new BankClient({ ...config, maxResponseBytes: 1024 }, async () => new Response(JSON.stringify({ responseCode: 'internal-sensitive-marker', message: 'secret' }), { status: 400 }));
  await assert.rejects(() => rejected.accounts(), (error) => error.code === 'bank_error' && error.code !== 'internal-sensitive-marker');
});
