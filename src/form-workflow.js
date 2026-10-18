import fs from 'node:fs';
import path from 'node:path';
import { buildPlan, preview, formatEntries } from './forms.js';
import { redact } from './config.js';

const schoolHosts = new Set(['ehall.nju.edu.cn', 'ehallapp.nju.edu.cn', 'authserver.nju.edu.cn']);
const recordFile = (assistant, id) => path.join(assistant.config.dataDir, 'records', 'forms', `${id}.md`);

async function prepare(assistant, message, url, parent = null) {
  if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) {
    await assistant.reply(message, '链接格式不正确，请检查完整的 HTTP/HTTPS 地址。');
    return;
  }
  if (schoolHosts.has(new URL(url).hostname)) {
    await assistant.reply(message, '校内登录与事务请使用 ehall 后台指令。发送「ehall」查看用法；公开表单通道不能绕过 ehall 的登录和事务适配边界。');
    return;
  }
  const task = assistant.store.createTask(message.sender, message.chat, url);
  if (parent && ['awaiting_confirmation', 'needs_review', 'failed'].includes(parent.status)) {
    assistant.store.status(parent.id, 'superseded', `已由任务 ${task.id} 重新准备，旧确认无效。`);
  }
  await assistant.reply(message, `任务 ${task.id}：正在读取表单和最新个人资料，稍后给你填写预览。`, 'started');
  try {
    const snapshot = await assistant.forms.inspect(url);
    const context = assistant.profile.snapshot();
    const matches = await assistant.model.match(snapshot.fields, context.facts);
    const plan = buildPlan(snapshot, context.hash, context.facts, matches);
    if (parent) plan.previousTask = parent.id;
    assistant.store.plan(task.id, plan);
    await assistant.reply(message, preview(assistant.store.task(task.id), { stale: assistant.profile.hash() !== plan.profileHash }), 'preview');
  } catch (error) {
    const reason = redact(error.message, assistant.config);
    assistant.store.status(task.id, 'failed', reason);
    await assistant.reply(message, `任务 ${task.id} 未完成：${reason}`, 'error');
  }
}

function archive(assistant, task, result) {
  const file = recordFile(assistant, task.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = `# 表单填写记录\n\n任务：${task.id}\n记录时间：${new Date().toISOString()}\n页面：${task.plan.title}\n链接：${task.plan.url}\n资料版本：${task.plan.profileHash}\n准备时间：${task.plan.preparedAt || '旧任务未记录'}\n${task.plan.previousTask ? `前序任务：${task.plan.previousTask}\n` : ''}\n${result}\n\n## 当时确认的字段与依据\n\n${formatEntries(task.plan)}\n\n本记录仅证明程序当时核对了填写值，未保存草稿、未提交，不代表报名成功。原文行号对应当时资料版本；历史记录不作为新的个人事实。后台页面不会随此记录恢复。\n`;
  fs.writeFileSync(file + '.tmp', content, 'utf8');
  fs.renameSync(file + '.tmp', file);
}

async function fill(assistant, message, task, code) {
  if (assistant.profile.hash() !== task.plan?.profileHash) {
    await assistant.reply(message, `个人资料已经变化，旧确认无效。请发送：重新准备 ${task.id}`);
    return;
  }
  if (!assistant.store.approve(task.id, message.sender, code)) {
    await assistant.reply(message, '确认码或任务状态不匹配，请查看最新预览；已处理的确认不会重复执行。');
    return;
  }
  task = assistant.store.task(task.id);
  assistant.store.status(task.id, 'filling');
  const screenshot = path.join(assistant.config.dataDir, `${task.id}.png`);
  let result;
  try {
    await assistant.reply(message, `任务 ${task.id}：开始填写。`, 'started');
    result = await assistant.forms.fill(task, assistant.profile, screenshot);
    archive(assistant, task, result);
    assistant.store.status(task.id, 'filled', result);
  } catch (error) {
    const reason = redact(error.message, assistant.config);
    assistant.store.status(task.id, 'needs_review', reason);
    await assistant.reply(message, `任务 ${task.id} 需要核实：${reason}\n请先核实页面，再重新准备。`, 'error');
    return;
  }
  // A delivery failure must not erase a completed fill or cause it to be replayed.
  await assistant.reply(message, `${task.id}：${result}\n填写记录已保存到本机个人数据库。发送「填表结果 ${task.id}」重看字段与依据；后台页面不等于最终提交。`, 'result');
  await assistant.channel.image(message.chat, screenshot, `${message.id}:image`);
}

export async function handleFormWorkflow(assistant, message) {
  const text = message.content;
  if (/^https?:\/\/\S+$/i.test(text)) { await prepare(assistant, message, text); return true; }
  const command = /^(填表预览|填表结果|重新准备|确认填表)\s+([a-f0-9-]+)(?:\s+([a-f0-9]+))?$/.exec(text);
  if (!command) return false;
  const [, action, id, code] = command;
  const task = assistant.store.task(id);
  if (!task || task.owner !== message.sender || task.kind !== 'form') {
    await assistant.reply(message, '未找到属于你的公开表单任务；这不是公开表单填写任务，不能使用此指令。');
    return true;
  }
  if (action === '重新准备' && !code) await prepare(assistant, message, task.url, task);
  else if (action === '填表预览' && !code) {
    await assistant.reply(message, task.plan ? preview(task, { stale: assistant.profile.hash() !== task.plan.profileHash }) : '该任务没有可用预览，请重新准备。');
  } else if (action === '填表结果' && !code) {
    const file = recordFile(assistant, task.id);
    await assistant.reply(message, fs.existsSync(file) ? `${task.status === 'filled' ? '填写历史记录；尚未提交。' : '历史记录；后台页面可能已关闭，不能据此再次填写。'}\n${fs.readFileSync(file, 'utf8')}` : task.result || '该任务尚无填写结果。');
  } else if (action === '确认填表' && code) await fill(assistant, message, task, code);
  else await assistant.reply(message, '查看／重新准备只需任务编号；确认填写还需对应预览的确认码。');
  return true;
}
