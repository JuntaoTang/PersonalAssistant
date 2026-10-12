import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Assistant } from '../src/app.js';
import { incomingText } from '../src/feishu.js';

test('only raw user private text becomes an instruction', () => {
  const raw = { sender: { sender_type: 'user', sender_id: { open_id: 'owner' } }, message: { chat_type: 'p2p', message_type: 'text', message_id: 'm1', chat_id: 'chat', content: '{"text":"资料"}' } };
  assert.deepEqual(incomingText(raw), { id: 'm1', sender: 'owner', chat: 'chat', text: '资料' });
  assert.equal(incomingText({ ...raw, sender: { ...raw.sender, sender_type: 'app' } }), null);
  assert.equal(incomingText({ ...raw, message: { ...raw.message, chat_type: 'group' } }), null);
  assert.equal(incomingText({ ...raw, message: { ...raw.message, content: 'bad' } }), null);
});

test('unpaired or other users cannot read profile; correction survives a new app instance; duplicate events do not repeat', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gse-app-'));
  const sent = [];
  const config = { dataDir, pollSeconds: 300, mailEnabled: false, apiKey: '', appSecret: '', mailPassword: '' };
  const channel = { text: async (chat, text) => sent.push({ chat, text }), close() {}, image() {} };
  const forms = { async close() {} };
  let assistant = new Assistant(config, { channel, forms });
  t.after(async () => { await assistant.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  assistant.receive({ id: 'm1', sender: 'stranger', chat: 'c1', text: '资料' });
  await assistant.tick();
  assert.equal(sent.length, 0);
  assistant.receive({ id: 'm2', sender: 'owner', chat: 'c2', text: `绑定 ${assistant.store.get('pairing_code')}` });
  await assistant.tick();
  assert.equal(assistant.store.get('owner'), 'owner');
  assistant.receive({ id: 'm3', sender: 'owner', chat: 'c2', text: '资料 常用邮箱=known@example.org' });
  await assistant.tick();
  const count = sent.length;
  assistant.receive({ id: 'm3', sender: 'owner', chat: 'c2', text: '资料 常用邮箱=changed@example.org' });
  await assistant.tick();
  assert.equal(sent.length, count);
  assistant.receive({ id: 'm4', sender: 'stranger', chat: 'c1', text: '资料' });
  await assistant.tick();
  assert.equal(sent.length, count);
  await assistant.close();
  assistant = new Assistant(config, { channel, forms });
  assert.equal(assistant.profile.facts()['常用邮箱'].value, 'known@example.org');
  assert.equal(assistant.store.get('owner'), 'owner');
});
