import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEnv, loadConfig, redact } from '../src/config.js';
import { Profile } from '../src/profile.js';
import { Store, digest } from '../src/store.js';

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
