import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Ehall, EhallLoginRequired, formatCatalog } from '../src/ehall.js';

test('ehall queries use private saved state, report scope, and fail closed on expiry or unknown schemas', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gse-ehall-'));
  let loggedIn = true;
  let compatible = true;
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    requests.push({ method: request.method, path: url.pathname, keyword: url.searchParams.get('searchKey'), cookie: request.headers.cookie });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ result: 'success', hasLogin: loggedIn, data: compatible ? { appList: [{ appId: 'timetable', appName: '本科生课表' }], serviceList: [] } : { unknown: [] } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const ehall = new Ehall({ dataDir: root }, { origin });
  t.after(async () => { await ehall.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  await assert.rejects(ehall.catalog('课表'), EhallLoginRequired);
  assert.equal(requests.length, 0);
  fs.mkdirSync(ehall.directory, { recursive: true });
  fs.writeFileSync(ehall.stateFile, JSON.stringify({ cookies: [{ name: 'session', value: 'test-only', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] }));
  const result = await ehall.catalog('课表');
  assert.equal(result.items[0].name, '本科生课表');
  assert.match(formatCatalog(result), /不是个人成绩/);
  assert.match(requests[0].cookie, /session=test-only/);
  assert.equal(requests[0].keyword, '课表');
  assert.equal(requests[0].method, 'GET');
  compatible = false;
  await assert.rejects(ehall.catalog('课表'), /格式已变化/);
  loggedIn = false;
  await assert.rejects(ehall.catalog('课表'), EhallLoginRequired);
});

test('ehall login must be verified server-side before state is saved or the window is closed', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gse-login-'));
  let authenticated = false;
  let closed = 0;
  let launched = 0;
  const browserType = { async launch(options) {
    launched++;
    assert.equal(options.headless, false);
    return { async newContext() { return {
      async newPage() { return { isClosed: () => false, async goto() {} }; },
      request: { async get() { return { status: () => 200, ok: () => true, json: async () => ({ result: 'success', hasLogin: authenticated, data: { hasLogin: authenticated, userId: authenticated ? 'test-owner' : null } }) }; } },
      async storageState({ path: file }) { fs.writeFileSync(file, '{"cookies":[],"origins":[]}'); },
    }; }, async close() { closed++; } };
  } };
  const ehall = new Ehall({ dataDir: root }, { browserType });
  t.after(async () => { await ehall.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await ehall.beginLogin();
  await ehall.beginLogin();
  assert.equal(launched, 1);
  await assert.rejects(ehall.finishLogin(), EhallLoginRequired);
  assert.equal(fs.existsSync(ehall.stateFile), false);
  assert.equal(closed, 0);
  authenticated = true;
  await ehall.finishLogin();
  assert.equal(ehall.status().saved, true);
  assert.equal(ehall.status().loginWindow, false);
  assert.equal(closed, 1);
});

test('request diagnostics cannot expose ehall cookies in user-visible errors', async () => {
  const ehall = new Ehall({ dataDir: os.tmpdir() }, { request: { async newContext() { return {
    async get() { throw new Error('Timeout: GET /query; Cookie: CAS-test-private-value'); },
    async dispose() {},
  }; } } });
  await assert.rejects(ehall.api('/jsonp/ywtb/searchAppAndService'), error => {
    assert.match(error.message, /请求未完成/);
    assert.doesNotMatch(error.message, /CAS-test-private-value|Cookie/);
    return true;
  });
});
