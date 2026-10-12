import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEnv, loadConfig, redact } from '../src/config.js';

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
