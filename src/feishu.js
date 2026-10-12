import fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as lark from '@larksuiteoapi/node-sdk';

// SDK diagnostics can contain signed connection URLs; retain only our own status.
const quietLogger = Object.fromEntries(['fatal', 'error', 'warn', 'info', 'debug', 'trace'].map(key => [key, () => {}]));
const uuid = key => createHash('md5').update(key).digest('hex');

export function incomingText(event) {
  const message = event?.message;
  if (event?.sender?.sender_type !== 'user' || message?.chat_type !== 'p2p' || message?.message_type !== 'text') return null;
  let text;
  try { text = JSON.parse(message.content).text; } catch { return null; }
  const sender = event.sender.sender_id?.open_id;
  if (!sender || !message.message_id || !message.chat_id || typeof text !== 'string') return null;
  return { id: message.message_id, sender, chat: message.chat_id, text: text.trim() };
}

export class Feishu {
  constructor(config) {
    const credentials = { appId: config.appId, appSecret: config.appSecret, domain: lark.Domain.Feishu, logger: quietLogger };
    this.client = new lark.Client(credentials);
    this.ws = new lark.WSClient({ ...credentials, autoReconnect: true, handshakeTimeoutMs: 20000 });
  }
  async start(receive) {
    const dispatcher = new lark.EventDispatcher({ logger: quietLogger }).register({
      'im.message.receive_v1': async event => {
        const message = incomingText(event);
        if (message) receive(message); // Persist before acknowledging; do slow work in the worker.
      },
    });
    await this.ws.start({ eventDispatcher: dispatcher });
  }
  status() { return this.ws.getConnectionStatus().state; }
  async send(chat, content, type, key) {
    const result = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chat, msg_type: type, content: JSON.stringify(content), uuid: uuid(key) },
    });
    if (result?.code !== undefined && result.code !== 0) throw new Error(`飞书发送失败，错误码 ${result.code}`);
  }
  async text(chat, text, key) {
    // Keep each chunk below Feishu's message-size limit; deterministic UUIDs suppress retries.
    const chunks = String(text).match(/[\s\S]{1,3500}/g) || [''];
    for (let index = 0; index < chunks.length; index++) await this.send(chat, { text: chunks[index] }, 'text', `${key}:${index}`);
  }
  async image(chat, file, key) {
    const result = await this.client.im.image.create({ data: { image_type: 'message', image: fs.createReadStream(file) } });
    const imageKey = result?.data?.image_key || result?.image_key;
    if (!imageKey) throw new Error('飞书图片上传失败，请检查图片资源权限');
    await this.send(chat, { image_key: imageKey }, 'image', key);
  }
  close() { this.ws.close({ force: true }); }
}
