import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEnv, loadConfig, redact } from '../src/config.js';
import { Profile } from '../src/profile.js';
import { Store, digest } from '../src/store.js';
import { DeepSeek } from '../src/model.js';
import { buildPlan, publicUrl } from '../src/forms.js';

function temporary(t, beforeRemove = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gse-assistant-'));
  t.after(() => { beforeRemove(); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}

test('bare API key is loaded, local config overrides it, and logs redact credentials', t => {
  const root = temporary(t);
  const project = path.join(root, 'proj', 'assistant');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(root, '.env'), 'sk-test-secret');
  fs.writeFileSync(path.join(project, '.env'), 'FEISHU_APP_SECRET="feishu-secret"\nMAIL_PASSWORD=mail-secret');
  assert.deepEqual(readEnv(path.join(root, '.env')), { DEEPSEEK_API_KEY: 'sk-test-secret' });
  const config = loadConfig(project, {});
  assert.equal(config.apiKey, 'sk-test-secret');
  assert.equal(config.mailEnabled, false);
  assert.equal(redact('sk-test-secret feishu-secret mail-secret ?ticket=signed', config), '[REDACTED] [REDACTED] [REDACTED] ?ticket=[REDACTED]');
});

test('profile corrections persist, unknown facts stay absent, old versions are retained', t => {
  const root = temporary(t);
  const profile = new Profile(root);
  assert.deepEqual(profile.facts(), {});
  profile.set('常用邮箱', 'first@example.org');
  const previousHash = profile.hash();
  profile.set('常用邮箱', 'corrected@example.org');
  const reopened = new Profile(root);
  assert.equal(reopened.facts()['常用邮箱'].value, 'corrected@example.org');
  assert.notEqual(reopened.hash(), previousHash);
  assert.equal(reopened.facts()['姓名（中文）'], undefined);
  assert.equal(fs.readdirSync(path.join(root, 'profile-history')).length, 2);
  reopened.set('常用邮箱', '');
  assert.equal(reopened.facts()['常用邮箱'], undefined);
});

test('approval belongs to its user and exact plan; duplicate events and approvals do not replay', t => {
  let store;
  store = new Store(path.join(temporary(t, () => store.close()), 'state.sqlite'));
  assert.equal(store.enqueue('m1', 'owner', 'chat', 'hello'), true);
  assert.equal(store.enqueue('m1', 'owner', 'chat', 'hello'), false);
  assert.equal(store.nextMessage().id, 'm1');
  assert.equal(store.nextMessage(), undefined);
  const task = store.createTask('owner', 'chat', 'https://example.org');
  store.plan(task.id, { entries: [{ value: 'a' }] });
  assert.equal(store.approve(task.id, 'stranger', digest({ entries: [{ value: 'a' }] })), false);
  assert.equal(store.approve(task.id, 'owner', 'wrong'), false);
  const oldCode = digest(store.task(task.id).plan);
  store.plan(task.id, { entries: [{ value: 'b' }] });
  assert.equal(store.approve(task.id, 'owner', oldCode), false);
  const code = digest(store.task(task.id).plan);
  assert.equal(store.approve(task.id, 'owner', code), true);
  assert.equal(store.approve(task.id, 'owner', code), false);
  store.status(task.id, 'filling');
  store.recover();
  assert.equal(store.task(task.id).status, 'needs_review');
  assert.equal(store.nextMessage(), undefined);
  store.saveMail('stable-id', { subject: 'one' });
  store.saveMail('stable-id', { subject: 'two' });
  assert.equal(store.pendingMail().length, 1);
  store.mailDelivered('stable-id');
  assert.equal(store.pendingMail().length, 0);
});

test('model fallback handles unavailable service, but does not retry invalid credentials', async () => {
  const config = { apiKey: 'test', baseUrl: 'https://example.org', models: ['primary', 'fallback'] };
  const used = [];
  const model = new DeepSeek(config, async (_, request) => {
    const body = JSON.parse(request.body);
    used.push(body.model);
    assert.equal(body.thinking.type, 'disabled');
    return used.length === 1 ? { ok: false, status: 503 } : { ok: true, json: async () => ({ model: 'fallback', choices: [{ message: { content: '{"ok":true}' } }] }) };
  });
  assert.deepEqual(await model.json('JSON test', {}), { ok: true });
  assert.deepEqual(used, ['primary', 'fallback']);
  let calls = 0;
  const unauthorized = new DeepSeek(config, async () => { calls++; return { ok: false, status: 401 }; });
  await assert.rejects(unauthorized.json('JSON', {}), /401/);
  assert.equal(calls, 1);
});

test('generated values, uncertain/ambiguous matches, scoped facts and mismatched choices cannot enter a plan', () => {
  const fields = Array.from({ length: 6 }, (_, i) => ({ id: `f${i}`, label: `field${i}`, required: true }));
  fields[5].options = [{ label: 'Other', value: '1' }];
  const facts = { email: { value: 'known@example.org', scope: '' }, limited: { value: 'limited', scope: '2025 only' }, name: { value: 'Name', scope: '' } };
  const plan = buildPlan({ url: 'https://example.org', fields }, 'hash', facts, { matches: [
    { field_id: 'f0', fact_key: 'email', certain: true, value: 'invented' },
    { field_id: 'f1', fact_key: 'missing', certain: true },
    { field_id: 'f2', fact_key: 'name', certain: false },
    { field_id: 'f3', fact_key: 'limited', certain: true },
    { field_id: 'f4', fact_key: 'name', certain: true }, { field_id: 'f4', fact_key: 'email', certain: true },
    { field_id: 'f5', fact_key: 'name', certain: true },
  ] });
  assert.deepEqual(plan.entries.map(entry => entry.value), ['known@example.org', null, null, null, null, null]);
});
