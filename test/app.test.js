import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { incomingText } from '../src/feishu.js';

test('only raw user private text becomes an instruction', () => {
  const raw = { sender: { sender_type: 'user', sender_id: { open_id: 'owner' } }, message: { chat_type: 'p2p', message_type: 'text', message_id: 'm1', chat_id: 'chat', content: '{"text":"资料"}' } };
  assert.deepEqual(incomingText(raw), { id: 'm1', sender: 'owner', chat: 'chat', text: '资料' });
  assert.equal(incomingText({ ...raw, sender: { ...raw.sender, sender_type: 'app' } }), null);
  assert.equal(incomingText({ ...raw, message: { ...raw.message, chat_type: 'group' } }), null);
  assert.equal(incomingText({ ...raw, message: { ...raw.message, content: 'bad' } }), null);
});
