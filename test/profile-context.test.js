import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Profile } from '../src/profile.js';
import { DeepSeek } from '../src/model.js';

test('profile search indexes the latest Markdown and returns source lines tied to the snapshot', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gse-context-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = new Profile(root);
  profile.set('姓名（英文）', 'Example Person', '用户确认');
  profile.set('拟就读学校', '未来大学', '用户确认', '未来计划');
  const result = profile.search('example');
  assert.equal(result.items.length, 1);
  const hit = result.items[0];
  assert.equal(hit.location.file, 'profile.md');
  assert.ok(profile.read().split('\n')[hit.location.line - 1].includes('Example Person'));
  assert.match(hit.source, /用户确认/);
  assert.equal(profile.search('未来大学').items[0].scope, '未来计划');
  fs.writeFileSync(profile.file, profile.read().replace('Example Person', 'Corrected Person'));
  assert.equal(profile.search('Example Person').total, 0);
  assert.equal(new Profile(root).search('Corrected Person').total, 1);
  assert.notEqual(profile.snapshot().hash, result.hash);
  assert.throws(() => profile.search(''), /关键词/);
});

test('field matching shares only available key names with the model, keeping values and provenance local', async () => {
  const config = { apiKey: 'test-only', baseUrl: 'https://example.org', models: ['test-model'] };
  const model = new DeepSeek(config, async (_, request) => {
    const body = JSON.parse(request.body);
    const input = JSON.parse(body.messages[1].content);
    assert.deepEqual(input.fact_keys, ['常用邮箱']);
    assert.equal(input.facts, undefined);
    assert.doesNotMatch(request.body, /private@example.org|private-source|future-private-value/);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"matches":[]}' } }] }) };
  });
  await model.match([{ id: 'f0', label: '邮箱' }], {
    常用邮箱: { value: 'private@example.org', scope: '', source: 'private-source' },
    拟就读学校: { value: 'future-private-value', scope: '未来计划' },
    未知: { value: '', scope: '' },
  });
});
