import { ehallOrigin, formatCatalog } from './ehall.js';
import { redact } from './config.js';

export const ehallHelp = `ehall 后台助手
ehall 登录：仅首次或失效时，在电脑上打开独立登录窗口
ehall 登录完成：核验并保存状态，关闭登录窗口
ehall 状态：查看本机是否保存过登录状态
ehall 服务 关键词：查询当前账号可见的服务目录
ehall 结果 任务编号：重新查看本人的查询结果
进度：查看任务状态

服务目录不是个人成绩或课表内容。具体事务适配尚未启用；材料准备和填写须先完成首个真实事务的适配。当前没有提交、退课或撤销执行能力。`;

export async function handleEhall(assistant, message) {
  const text = message.content;
  if (!/^ehall(?:\s|$)/i.test(text)) return false;
  const command = text.replace(/^ehall/i, 'ehall');
  const reply = (text, suffix) => assistant.reply(message, text, suffix);
  try {
    if (command === 'ehall 登录') { await reply(await assistant.ehall.beginLogin()); return true; }
    if (command === 'ehall 登录完成') { await reply(await assistant.ehall.finishLogin()); return true; }
    if (command === 'ehall 状态') {
      const status = assistant.ehall.status();
      await reply(`${status.loginWindow ? '电脑上有待完成的 ehall 登录窗口。\n' : ''}${status.saved ? `本机保存过登录状态（${status.savedAt}）；有效性将在实际查询时由服务端检查。` : '本机尚未保存 ehall 登录状态。请发送「ehall 登录」。'}`);
      return true;
    }
    const result = /^ehall 结果 ([a-f0-9-]+)$/.exec(command);
    if (result) {
      const task = assistant.store.task(result[1]);
      await reply(task?.owner === message.sender && task.kind === 'ehall_query' ? task.result || '该查询还没有结果，请查看进度。' : '未找到属于你的 ehall 查询任务。');
      return true;
    }
    const search = /^ehall 服务\s+(.+)$/.exec(command);
    if (search) {
      const task = assistant.store.createTask(message.sender, message.chat, ehallOrigin, 'ehall_query');
      assistant.store.status(task.id, 'querying');
      await reply(`任务 ${task.id}：后台正在查询 ehall 服务目录。`, 'started');
      let content;
      try {
        const result = await assistant.ehall.catalog(search[1]);
        content = `任务 ${task.id}\n${formatCatalog(result)}`;
        assistant.store.status(task.id, 'queried', content);
      } catch (error) {
        const reason = redact(error.message, assistant.config);
        assistant.store.status(task.id, 'failed', reason);
        await reply(`任务 ${task.id} 未完成：${reason}`, 'error');
        return true;
      }
      await reply(content, 'result');
      return true;
    }
    await reply(ehallHelp);
  } catch (error) { await reply(redact(error.message, assistant.config), 'error'); }
  return true;
}
