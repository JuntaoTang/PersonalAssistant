import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Assistant } from '../src/app.js';
import { Store } from '../src/store.js';

test('phone commands run through the owner queue, deduplicate queries, persist results and reject unsupported actions', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gse-ehall-app-'));
  const sent = [];
  const called = [];
  const config = { dataDir, pollSeconds: 300, mailEnabled: false, apiKey: '', appSecret: '', mailPassword: '' };
  const dependencies = {
    channel: { text: async (chat, text) => sent.push({ chat, text }), close() {} },
    forms: { async close() {}, async inspect() { throw new Error('ehall must not use the public forms route'); } },
    ehall: {
      async beginLogin() { called.push('login'); return '请在本机登录'; },
      async finishLogin() { called.push('finish'); return '已验证登录'; },
      status() { return { saved: false, loginWindow: false }; },
      async catalog(keyword) { called.push(keyword); return { keyword, at: '2026-10-18T00:00:00Z', source: 'https://ehall.nju.edu.cn', scope: '服务目录', items: [{ id: 'test-course', name: '课程服务', type: '应用' }] }; },
      async close() {},
    },
  };
  let app = new Assistant(config, dependencies);
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const receive = async (id, text, sender = 'owner') => {
    app.receive({ id, sender, chat: 'chat', text });
    await app.tick();
  };
  await receive('unpaired', 'ehall 登录');
  assert.deepEqual(called, []);
  app.store.bind('owner', 'chat');
  await receive('outsider', 'ehall 登录', 'stranger');
  await receive('login', 'ehall 登录');
  await receive('finish', 'ehall 登录完成');
  await receive('query', 'ehall 服务 课程');
  await receive('query', 'ehall 服务 课程');
  assert.deepEqual(called, ['login', 'finish', '课程']);
  const tasks = app.store.recent('owner');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].kind, 'ehall_query');
  assert.equal(tasks[0].status, 'queried');
  await receive('withdraw', 'ehall 退课');
  await receive('submit', 'ehall 提交');
  await receive('link', 'https://ehall.nju.edu.cn/example');
  await receive('wrong-confirmation', `确认填表 ${tasks[0].id} deadbeef`);
  assert.deepEqual(called, ['login', 'finish', '课程']);
  assert.match(sent.at(-1).text, /不是公开表单/);
  await app.close();
  app = new Assistant(config, dependencies);
  await receive('result', `ehall 结果 ${tasks[0].id}`);
  assert.match(sent.at(-1).text, /课程服务/);
  assert.deepEqual(called, ['login', 'finish', '课程']);
  const count = sent.length;
  await receive('private-result', `ehall 结果 ${tasks[0].id}`, 'stranger');
  assert.equal(sent.length, count);
});

test('legacy tasks migrate without loss and interrupted queries are not replayed', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gse-store-upgrade-'));
  const file = path.join(root, 'state.sqlite');
  const legacy = new DatabaseSync(file);
  legacy.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, owner TEXT, chat TEXT, url TEXT, status TEXT, plan TEXT, approval TEXT, result TEXT, created TEXT); INSERT INTO tasks VALUES ('old', 'owner', 'chat', 'https://example.org', 'awaiting_confirmation', NULL, NULL, NULL, '2026-10-12')");
  legacy.close();
  let store = new Store(file);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal(store.task('old').kind, 'form');
  const query = store.createTask('owner', 'chat', 'https://ehall.nju.edu.cn', 'ehall_query');
  store.status(query.id, 'querying');
  store.recover();
  assert.equal(store.task(query.id).status, 'needs_review');
  assert.match(store.task(query.id).result, /未自动重试/);
  store.close();
  store = new Store(file);
  assert.equal(store.task('old').kind, 'form');
  assert.equal(store.task(query.id).kind, 'ehall_query');
});
