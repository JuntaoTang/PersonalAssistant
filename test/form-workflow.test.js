import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Assistant } from '../src/app.js';
import { Forms } from '../src/forms.js';
import { digest } from '../src/store.js';

test('phone → profile → browser → confirmation → private record survives corrections, new sessions and a second form', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gse-workflow-'));
  const sent = [], images = [], outbound = [];
  let upgrades = 0;
  const server = http.createServer((request, response) => {
    if (request.url.startsWith('/save') || request.url === '/submit') outbound.push(request.url);
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    const second = request.url === '/second';
    response.end(`<title>${second ? '活动乙' : '活动甲'}</title>
      <form action="/submit" method="post">
      <label>${second ? '真实姓名' : '姓名'}<input name="name" required></label>
      <label>${second ? '联系邮箱' : '邮箱'}<input type="email" name="email"></label>
      <label>联系电话<input name="phone" required></label>
      <label>学校<input name="school"></label><button type="submit">提交</button></form>
      <script>
      window.attempted=0; window.finished=0;
      const socket=new WebSocket('ws://'+location.host+'/ws');
      document.addEventListener('input',()=>{
        for(const url of ['/save-get','/save-post','/submit']) {
          window.attempted++;
          fetch(url,{method:url==='/save-get'?'GET':'POST'}).finally(()=>window.finished++).catch(()=>{});
        }
        navigator.sendBeacon('/save-beacon','private-fixture');
      });
      </script>`);
  });
  server.on('upgrade', (_, socket) => { upgrades++; socket.destroy(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = { dataDir, pollSeconds: 300, mailEnabled: false, apiKey: '', appSecret: '', mailPassword: '' };
  const channel = { async text(chat, text) { sent.push({ chat, text }); }, async image(chat, file) { images.push({ chat, file }); }, async start() {}, close() {} };
  const model = { async match(fields) { return { matches: fields.map(field => ({ field_id: field.id, fact_key: /姓名/.test(field.label) ? '姓名（中文）' : /邮箱/.test(field.label) ? '常用邮箱' : field.label, certain: true })) }; } };
  const dependencies = () => ({ channel, model, forms: new Forms({ allowLocal: true }) });
  let app = new Assistant(config, dependencies());
  t.after(async () => { await app.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const receive = async (id, text, sender = 'owner') => { app.receive({ id, text, sender, chat: 'private-chat' }); await app.tick(); };
  app.store.bind('owner', 'private-chat');
  app.profile.set('常用邮箱', 'fixture@example.org', '测试用户确认');
  app.profile.set('学校', '未来大学', '测试用户确认', '仅未来升学计划');
  await receive('search', '查资料 邮箱');
  assert.match(sent.at(-1).text, /profile.md:L\d+/);
  assert.match(sent.at(-1).text, /fixture@example.org/);
  await receive('first', origin + '/first');
  const first = app.store.recent('owner')[0];
  const original = app.store.task(first.id);
  assert.equal(original.plan.entries[0].value, null);
  assert.equal(app.forms.sessions.size, 0);
  await receive('correct', '资料 姓名（中文）=测试甲');
  await receive('stale-preview', `填表预览 ${first.id}`);
  assert.match(sent.at(-1).text, /预览失效/);
  assert.doesNotMatch(sent.at(-1).text, /确认填表/);
  await receive('stale-approval', `确认填表 ${first.id} ${digest(original.plan)}`);
  assert.equal(app.forms.sessions.size, 0);
  await receive('reprepare', `重新准备 ${first.id}`);
  const prepared = app.store.task(app.store.recent('owner')[0].id);
  assert.notEqual(prepared.id, first.id);
  assert.equal(prepared.plan.previousTask, first.id);
  assert.equal(app.store.task(first.id).status, 'superseded');
  assert.equal(prepared.plan.entries[0].value, '测试甲');
  assert.equal(prepared.plan.entries[2].value, null);
  assert.equal(prepared.plan.entries[3].value, null);
  assert.match(sent.at(-1).text, /依据：姓名（中文）；profile.md:L\d+/);
  const count = sent.length;
  for (const command of [`查资料 姓名`, `填表预览 ${prepared.id}`, `填表结果 ${prepared.id}`, `重新准备 ${prepared.id}`, `确认填表 ${prepared.id} ${digest(prepared.plan)}`]) await receive('other-' + command, command, 'stranger');
  assert.equal(sent.length, count);
  await receive('wrong', `确认填表 ${prepared.id} deadbeef`);
  assert.equal(app.forms.sessions.size, 0);
  const approval = `确认填表 ${prepared.id} ${digest(prepared.plan)}`;
  await receive('approved', approval);
  assert.equal(app.store.task(prepared.id).status, 'filled');
  const page = app.forms.sessions.get(prepared.id).page;
  await page.waitForFunction(() => window.attempted > 0 && window.attempted === window.finished);
  assert.equal(await page.locator('[name=name]').inputValue(), '测试甲');
  assert.equal(await page.locator('[name=email]').inputValue(), 'fixture@example.org');
  assert.equal(await page.locator('[name=phone]').inputValue(), '');
  assert.equal(await page.locator('[name=school]').inputValue(), '');
  assert.equal(outbound.length, 0);
  assert.equal(upgrades, 0);
  const record = path.join(dataDir, 'records', 'forms', `${prepared.id}.md`);
  assert.match(fs.readFileSync(record, 'utf8'), /测试甲[\s\S]*profile.md:L\d+/);
  assert.match(fs.readFileSync(record, 'utf8'), /未提交/);
  assert.equal(images.length, 1);
  await receive('approved', approval);
  await receive('approved-again', approval);
  assert.equal(images.length, 1);
  await app.close();
  app = new Assistant(config, dependencies());
  await app.start();
  assert.equal(app.store.task(prepared.id).status, 'needs_review');
  await receive('history', `填表结果 ${prepared.id}`);
  assert.match(sent.at(-1).text, /历史记录[\s\S]*测试甲[\s\S]*未提交/);
  await receive('another-correction', '资料 姓名（中文）=测试乙');
  await receive('second-form', origin + '/second');
  const second = app.store.task(app.store.recent('owner')[0].id);
  assert.equal(second.plan.entries[0].value, '测试乙');
  await receive('approve-second', `确认填表 ${second.id} ${digest(second.plan)}`);
  assert.equal(app.store.task(second.id).status, 'filled');
  assert.equal(await app.forms.sessions.get(second.id).page.locator('[name=name]').inputValue(), '测试乙');
  await receive('old-record', `填表结果 ${prepared.id}`);
  assert.match(sent.at(-1).text, /测试甲/);
  assert.doesNotMatch(sent.at(-1).text, /测试乙/);
  assert.equal(app.profile.facts()['姓名（中文）'].value, '测试乙');
  assert.equal(fs.readdirSync(path.dirname(record)).length, 2);
  assert.equal(outbound.length, 0);
});

test('a screenshot delivery failure preserves the completed record and never makes a duplicate confirmation refill', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gse-delivery-'));
  let fills = 0;
  const config = { dataDir, pollSeconds: 300, mailEnabled: false, apiKey: '', appSecret: '', mailPassword: '' };
  const app = new Assistant(config, {
    channel: { async text() {}, async image() { throw new Error('delivery unavailable'); }, close() {} },
    forms: { async fill() { fills++; return '已填写，未提交。'; }, async close() {} },
  });
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  app.store.bind('owner', 'chat');
  const task = app.store.createTask('owner', 'chat', 'https://example.org');
  app.store.plan(task.id, { title: '测试', url: task.url, profileHash: app.profile.hash(), entries: [] });
  const message = { sender: 'owner', chat: 'chat', text: `确认填表 ${task.id} ${digest(app.store.task(task.id).plan)}` };
  app.receive({ ...message, id: 'one' });
  await app.tick();
  assert.equal(app.store.task(task.id).status, 'filled');
  assert.ok(fs.existsSync(path.join(dataDir, 'records', 'forms', `${task.id}.md`)));
  app.receive({ ...message, id: 'two' });
  await app.tick();
  assert.equal(fills, 1);
});
