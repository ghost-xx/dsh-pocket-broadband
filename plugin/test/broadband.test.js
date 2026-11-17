import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { BROADBAND_CHECK_URL, createBroadbandStatus, isPublicIPv4, parsePublicIPv4 } from '../lib/broadband.mjs';
import { installPocketRpc } from '../lib/web-rpc.js';

const IP = '8.8.4.4'; // Public fixture only; never stores a user's broadband address.
const response = (text = `Current IP Address: ${IP}`) => new Response(text);
const service = { status: async () => ({ proxyPort: 3092, proxyRunning: true }) };
const fakeQr = async url => `data:image/png;base64,${Buffer.from(url).toString('base64')}`;
const fixture = (options = {}) => createBroadbandStatus({ service, encodeQr: fakeQr, fetchImpl: async () => response(), ...options });

test('strict parsing accepts Oray/plain IP and rejects private, reserved, malformed and HTML', () => {
  for (const ip of [IP, '8.8.8.8', '1.1.1.1', '223.255.255.254']) assert.equal(isPublicIPv4(ip), true, ip);
  for (const ip of ['0.1.2.3', '10.1.2.3', '100.64.0.1', '100.127.255.255', '127.0.0.1', '169.254.1.1', '172.16.0.1', '172.31.255.254', '192.168.1.1', '192.0.0.9', '192.0.2.1', '192.88.99.1', '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1', '255.255.255.255', '::1', '1.2.3', '01.2.3.4', '256.1.2.3', '1.2.3.4:80']) assert.equal(isPublicIPv4(ip), false, ip);
  assert.equal(parsePublicIPv4(`Current IP Address: ${IP}\r\n`), IP);
  assert.equal(parsePublicIPv4(IP), IP);
  for (const text of [`<html>${IP}</html>`, `${IP} extra`, `error ${IP}`, '', 'Current IP Address: 192.168.1.1']) assert.throws(() => parsePublicIPv4(text));
});

test('host query URL fixed, actual proxy port used, QR has no password', async () => {
  let request;
  const lookup = fixture({ fetchImpl: async (...args) => { request = args; return response(); } });
  const result = await lookup.status();
  assert.equal(request[0], BROADBAND_CHECK_URL);
  assert.equal(request[1].redirect, 'error');
  assert.ok(request[1].signal instanceof AbortSignal);
  assert.equal(result.ip, IP);
  assert.equal(result.url, `http://${IP}:3092`);
  assert.equal(Buffer.from(result.qr.split(',')[1], 'base64').toString(), result.url);
  assert.equal(new URL(result.url).search, '');
  assert.equal(typeof result.checkedAt, 'number');
  assert.equal(result.error, null);
});

test('60-second cache, explicit refresh, concurrent request coalescing and immutable snapshots', async () => {
  let clock = 1000, calls = 0, release;
  const lookup = fixture({ now: () => clock, fetchImpl: async () => { calls++; if (release) await new Promise(resolve => release.resolve = resolve); return response(); } });
  const first = await lookup.status();
  first.ip = 'mutated';
  clock += 59_999;
  assert.equal((await lookup.status()).ip, IP);
  assert.equal(calls, 1);
  clock++;
  await lookup.status();
  assert.equal(calls, 2);
  release = {};
  const a = lookup.status({ refresh: true }), b = lookup.status({ refresh: true }), c = lookup.status();
  assert.equal(calls, 3);
  release.resolve();
  assert.deepEqual(await a, await b);
  await c;
  assert.equal(calls, 3);
});

test('failures clear every previous address/QR, cache failure and allow refresh recovery', async () => {
  let clock = 1000, calls = 0, broken = false;
  const lookup = fixture({ now: () => clock, fetchImpl: async () => { calls++; if (broken) throw new Error('secret-upstream-detail'); return response(); } });
  assert.equal((await lookup.status()).ip, IP);
  broken = true;
  clock += 60_000;
  const failed = await lookup.status();
  assert.deepEqual({ ...failed, error: null }, { ip: null, url: null, qr: null, checkedAt: clock, error: null });
  assert.ok(failed.error);
  assert.ok(!failed.error.includes('secret'));
  await lookup.status();
  assert.equal(calls, 2);
  broken = false;
  assert.equal((await lookup.status({ refresh: true })).ip, IP);
  assert.equal(calls, 3);
});

test('HTTP, reserved IP, oversized body, unavailable proxy and QR errors fail closed', async () => {
  const cases = [
    { fetchImpl: async () => new Response('bad', { status: 503 }) },
    { fetchImpl: async () => response('Current IP Address: 192.168.0.1') },
    { fetchImpl: async () => response('x'.repeat(4097)) },
    { service: { status: async () => ({ proxyPort: null }) } },
    { service: { status: async () => ({ proxyPort: 3081, proxyRunning: false }) } },
    { service: { status: async () => ({ proxyPort: '3081' }) } },
    { encodeQr: async () => { throw new Error('QR unavailable'); } },
  ];
  for (const options of cases) {
    const value = await fixture(options).status();
    assert.equal(value.ip, null);
    assert.equal(value.url, null);
    assert.equal(value.qr, null);
    assert.ok(value.error);
  }
});

test('timeout aborts host fetch, returns promptly and permits a new refresh', async () => {
  let signal;
  const lookup = fixture({ timeoutMs: 20, fetchImpl: async (_url, init) => { signal = init.signal; return new Promise(() => {}); } });
  const value = await lookup.status();
  assert.equal(signal.aborted, true);
  assert.equal(value.ip, null);
  assert.match(value.error, /timed out/);
  assert.match((await lookup.status({ refresh: true })).error, /timed out/);
});

test('RPC direct route preserves authentication; new endpoints use host cache and return numeric checkedAt', async () => {
  const originalFetch = globalThis.fetch;
  let externalCalls = 0, route;
  globalThis.fetch = async (url, options) => {
    if (String(url) === BROADBAND_CHECK_URL) { externalCalls++; return response(); }
    return originalFetch(url, options);
  };
  let reject = 401;
  const dispose = installPocketRpc({
    connection: { requestRejection: () => reject },
    webServer: { register: r => { route = r; return () => {}; } },
  }, { service });
  const server = createServer((req, res) => route.handler(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${server.address().port}/dsh-pocket`;
  async function call(method) {
    return originalFetch(`${endpoint}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rpcId: 'test', method, payload: {} }) });
  }
  try {
    assert.equal((await call('broadband/status')).status, 401);
    assert.equal(externalCalls, 0);
    reject = undefined;
    for (const method of ['broadband/status', 'broadband/status', 'broadband/refresh']) {
      const result = await (await call(method)).json();
      assert.equal(result.result.ok, true);
      const value = result.result.value;
      assert.equal(value.error, null);
      assert.equal(value.ip, IP);
      assert.equal(value.url, `http://${IP}:3092`);
      assert.match(value.qr, /^data:image\/png;base64,/);
      assert.equal(typeof value.checkedAt, 'number');
    }
    assert.equal(externalCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    dispose();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
