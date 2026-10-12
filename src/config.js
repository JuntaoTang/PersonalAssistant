import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function readEnv(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
  if (/^sk-[\w-]+$/.test(text)) return { DEEPSEEK_API_KEY: text };
  return parse(text);
}

export function loadConfig(root = projectRoot, environment = process.env) {
  const values = {
    ...readEnv(path.resolve(root, '../../.env')),
    ...readEnv(path.join(root, '.env')),
    ...environment,
  };
  const dataDir = path.resolve(root, values.ASSISTANT_DATA_DIR || 'data');
  return {
    root, dataDir,
    apiKey: values.DEEPSEEK_API_KEY || '',
    baseUrl: values.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    models: [values.DEEPSEEK_MODEL || 'deepseek-flash', values.DEEPSEEK_FALLBACK_MODEL || 'deepseek-v4-flash'],
    appId: values.FEISHU_APP_ID || '',
    appSecret: values.FEISHU_APP_SECRET || '',
    mailUser: values.MAIL_USERNAME || '',
    mailPassword: values.MAIL_PASSWORD || '',
    mailHost: values.MAIL_IMAP_HOST || 'imap.exmail.qq.com',
    mailPort: Number(values.MAIL_IMAP_PORT || 993),
    mailFolder: values.MAIL_FOLDER || 'INBOX',
    mailEnabled: values.MAIL_ENABLED === 'true',
    pollSeconds: Math.max(60, Number(values.MAIL_POLL_SECONDS || 300)),
    mailScope: values.MAIL_SCOPE || '',
    submitEnabled: values.FORM_SUBMIT_ENABLED === 'true',
  };
}

export function redact(text, config) {
  let result = String(text);
  for (const secret of [config.apiKey, config.appSecret, config.mailPassword]) {
    if (secret) result = result.replaceAll(secret, '[REDACTED]');
  }
  return result.replace(/([?&](?:access_key|ticket|token)=)[^\s&]+/gi, '$1[REDACTED]');
}
