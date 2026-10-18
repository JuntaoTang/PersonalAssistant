import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Profile } from './profile.js';
import { Store } from './store.js';
import { DeepSeek } from './model.js';
import { Forms } from './forms.js';
import { Feishu } from './feishu.js';
import { collectMail, formatSummary } from './mail.js';
import { Ehall } from './ehall.js';
import { handleEhall } from './ehall-commands.js';
import { handleFormWorkflow } from './form-workflow.js';

export const help = `个人助手指令
资料：查看持久化个人资料
查资料 关键词：检索最新资料、来源及原文位置
资料 字段=值：保存你明确提供的事实；资料 字段= 可清空
直接发送 HTTP/HTTPS 表单链接：先读取字段并展示拟填写内容
确认填表 任务编号 确认码：执行对应预览
填表预览 任务编号：重看拟填字段与资料来源
重新准备 任务编号：读取最新资料和网页，生成新任务
填表结果 任务编号：重看本机归档的填写记录
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
  superseded: '已由新预览替换，旧确认无效',
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
    if (/^查资料(?:\s|$)/.test(text)) {
      try {
        const result = this.profile.search(text.replace(/^查资料\s*/, ''));
        const items = result.items.map(item => `${item.key}：${item.value}\n适用范围：${item.scope || '未注明限制'}\n原文：${item.location.file}:L${item.location.line}；${item.source || '未注明来源'}`);
        return this.reply(message, `个人资料检索：${result.keyword}\n资料版本：${result.hash.slice(0, 12)}\n\n${items.join('\n\n') || '未找到已核实的匹配资料；未知项不会推断。'}${result.total > 20 ? '\n仅展示前 20 条，请缩小关键词。' : ''}`);
      } catch (error) { return this.reply(message, error.message); }
    }
    if (text.startsWith('资料 ')) {
      const match = /^资料\s+([^=]+)=([\s\S]*)$/.exec(text);
      if (!match) return this.reply(message, '请使用：资料 字段=值；清空某项可将等号后留空。');
      this.profile.set(match[1], match[2], '用户在飞书明确提供');
      return this.reply(message, `已保存「${match[1].trim()}」。后续会话会读取这份 Markdown；已有填表预览已失效，请发送「重新准备 任务编号」。`);
    }
    if (text === '进度') {
      const tasks = this.store.recent(message.sender);
      return this.reply(message, tasks.length ? tasks.map(task => `${task.id}：${labels[task.status] || task.status}`).join('\n') : '目前没有任务。');
    }
    if (await handleFormWorkflow(this, message)) return;
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
