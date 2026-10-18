import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { Profile, parseFacts } from './profile.js';
import { Store } from './store.js';
import { DeepSeek } from './model.js';
import { Forms, buildPlan, preview } from './forms.js';
import { Feishu } from './feishu.js';
import { collectMail, formatSummary } from './mail.js';
import { redact } from './config.js';
import { Ehall, ehallOrigin } from './ehall.js';
import { handleEhall } from './ehall-commands.js';

export const help = `个人助手指令
资料：查看持久化个人资料
资料 字段=值：保存你明确提供的事实；资料 字段= 可清空
直接发送 HTTP/HTTPS 表单链接：先读取字段并展示拟填写内容
确认填表 任务编号 确认码：执行对应预览
ehall：查看 ehall 登录与后台查询指令
进度：查看最近任务
帮助：查看本说明
当前版本填写后返回截图，最终提交尚未接入。`;

export function initialize(config) {
  const profile = new Profile(config.dataDir);
  const store = new Store(path.join(config.dataDir, 'assistant.sqlite'));
  if (!store.get('pairing_code')) store.set('pairing_code', randomBytes(12).toString('hex'));
  return { profile, store };
}

const labels = {
  inspecting: '读取表单中', awaiting_confirmation: '待你确认', approved: '已确认',
  filling: '填写中', filled: '已填写，未提交', needs_review: '需要核实后重新发起', failed: '未完成',
  querying: '查询中', queried: '已查询，可用 ehall 结果 任务编号 重看',
};

export class Assistant {
  constructor(config, dependencies = {}) {
    this.config = config;
    Object.assign(this, initialize(config));
    this.model = dependencies.model || new DeepSeek(config);
    this.forms = dependencies.forms || new Forms();
    this.ehall = dependencies.ehall || new Ehall(config);
    this.channel = dependencies.channel || null;
    this.stopping = false;
    this.lastMailCheck = 0;
    this.lastMailError = 0;
  }
  receive(message) { this.store.enqueue(message.id, message.sender, message.chat, message.text); }
  async reply(message, text, suffix = 'reply') { await this.channel.text(message.chat, text, `${message.id}:${suffix}`); }
  async handle(message) {
    const text = message.content;
    if (!this.store.get('owner')) {
      if (text !== `绑定 ${this.store.get('pairing_code')}`) return; // Do not disclose anything to an unpaired account.
      this.store.bind(message.sender, message.chat);
      await this.reply(message, `绑定成功。\n${help}`);
      return;
    }
    if (this.store.get('owner') !== message.sender) return;
    this.store.set('chat', message.chat);
    if (await handleEhall(this, message)) return;
    if (text === '帮助') return this.reply(message, help);
    if (text === '资料') return this.reply(message, this.profile.read());
    if (text.startsWith('资料 ')) {
      const match = /^资料\s+([^=]+)=([\s\S]*)$/.exec(text);
      if (!match) return this.reply(message, '请使用：资料 字段=值；清空某项可将等号后留空。');
      this.profile.set(match[1], match[2], '用户在飞书明确提供');
      return this.reply(message, `已保存「${match[1].trim()}」。后续会话会读取这份 Markdown；已有填表预览需重新发起。`);
    }
    if (text === '进度') {
      const tasks = this.store.recent(message.sender);
      return this.reply(message, tasks.length ? tasks.map(task => `${task.id}：${labels[task.status] || task.status}`).join('\n') : '目前没有任务。');
    }
    const approval = /^确认填表\s+([a-f0-9-]+)\s+([a-f0-9]+)$/.exec(text);
    if (approval) {
      if (this.store.task(approval[1])?.kind !== 'form') return this.reply(message, '这不是公开表单填写任务，不能使用此确认指令。');
      if (!this.store.approve(approval[1], message.sender, approval[2])) return this.reply(message, '确认码或任务状态不匹配，请查看最新预览；已处理的确认不会重复执行。');
      const task = this.store.task(approval[1]);
      this.store.status(task.id, 'filling');
      await this.reply(message, `任务 ${task.id}：开始填写。`, 'started');
      const screenshot = path.join(this.config.dataDir, `${task.id}.png`);
      try {
        const result = await this.forms.fill(task, this.profile, screenshot);
        this.store.status(task.id, 'filled', result);
        await this.reply(message, `${task.id}：${result}\n结果保留在后台浏览器，本版暂不提供最终提交。`, 'result');
        await this.channel.image(message.chat, screenshot, `${message.id}:image`);
      } catch (error) {
        this.store.status(task.id, 'needs_review', redact(error.message, this.config));
        await this.reply(message, `任务 ${task.id} 需要核实：${redact(error.message, this.config)}\n请重新发送链接生成预览。`, 'error');
      }
      return;
    }
    if (/^https?:\/\/\S+$/i.test(text)) {
      if (!URL.canParse(text)) return this.reply(message, '链接格式不正确，请检查完整的 HTTP/HTTPS 地址。');
      const host = new URL(text).hostname;
      if ([new URL(ehallOrigin).hostname, 'ehallapp.nju.edu.cn', 'authserver.nju.edu.cn'].includes(host)) return this.reply(message, '校内登录与事务请使用 ehall 后台指令。发送「ehall」查看用法；公开表单通道不能绕过 ehall 的登录和事务适配边界。');
      const task = this.store.createTask(message.sender, message.chat, text);
      await this.reply(message, `任务 ${task.id}：正在读取表单，稍后给你填写预览。`, 'started');
      try {
        const snapshot = await this.forms.inspect(text);
        // Hash and facts come from one snapshot, so concurrent manual edits invalidate approval.
        const original = this.profile.read();
        const facts = parseFacts(original);
        const hash = createHash('sha256').update(original).digest('hex');
        const matches = await this.model.match(snapshot.fields, facts);
        this.store.plan(task.id, buildPlan(snapshot, hash, facts, matches));
        await this.reply(message, preview(this.store.task(task.id)), 'preview');
      } catch (error) {
        this.store.status(task.id, 'failed', redact(error.message, this.config));
        await this.reply(message, `任务 ${task.id} 未完成：${redact(error.message, this.config)}`, 'error');
      }
      return;
    }
    return this.reply(message, help);
  }
  async tick() {
    const message = this.store.nextMessage();
    if (message) {
      try { await this.handle(message); }
      catch { console.error(`${new Date().toISOString()} 消息处理未完成；请在手机重试或查看进度。`); }
      finally { this.store.finishMessage(message.id); }
    }
    if (!this.store.get('owner') || !this.config.mailEnabled || this.config.mailScope !== 'all-new-english' || Date.now() - this.lastMailCheck < this.config.pollSeconds * 1000) return;
    this.lastMailCheck = Date.now();
    try {
      await collectMail(this.config, this.store);
      for (const mail of this.store.pendingMail()) {
        const email = JSON.parse(mail.payload);
        const summary = mail.summary ? JSON.parse(mail.summary) : await this.model.summarize(email);
        const text = formatSummary(email, summary);
        this.store.mailSummary(mail.id, summary);
        await this.channel.text(this.store.get('chat'), text, mail.id);
        this.store.mailDelivered(mail.id);
      }
    } catch {
      console.error(`${new Date().toISOString()} 邮件检查或摘要未完成，稍后重试。`);
      if (Date.now() - this.lastMailError > 3600000) {
        this.lastMailError = Date.now();
        await this.channel.text(this.store.get('chat'), '邮件检查或摘要暂未完成，请检查邮箱客户端密码、网络及模型余额。', `mail-error:${Math.floor(Date.now() / 3600000)}`).catch(() => {});
      }
    }
  }
  async start() {
    this.store.recover();
    this.channel ||= new Feishu(this.config);
    await this.channel.start(message => this.receive(message));
  }
  async close() {
    this.stopping = true;
    this.channel?.close();
    await this.forms.close();
    await this.ehall.close();
    this.store.close();
  }
}
