import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

export function likelyEnglish(text) {
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const chinese = (text.match(/[\u3400-\u9fff]/g) || []).length;
  return latin >= 40 && latin > chinese * 4;
}

export function formatSummary(email, summary) {
  if (typeof summary?.purpose !== 'string' || !['actions', 'deadlines', 'requirements', 'uncertainties'].every(key => Array.isArray(summary[key]))) throw new Error('模型摘要字段不完整，已停止发送');
  const list = (title, items) => items?.length ? `\n${title}\n${items.map(item => `• ${item}`).join('\n')}\n` : '';
  return `英文邮件要点\n主题：${email.subject}\n发件人：${email.from}\n\n${summary.purpose || '未提供摘要'}\n`
    + list('需要你做的事', summary.actions)
    + list('时间要求', summary.deadlines?.map(item => `${item.original}：${item.explanation}`))
    + list('重要要求', summary.requirements)
    + list('待核实', summary.uncertainties)
    + `\n原邮件：${email.messageId || email.subject}\n打开邮箱：https://mail.nju.edu.cn/`;
}

export async function collectMail(config, store) {
  if (!config.mailEnabled || !config.mailPassword || config.mailScope !== 'all-new-english') return;
  const client = new ImapFlow({ host: config.mailHost, port: config.mailPort, secure: true, auth: { user: config.mailUser, pass: config.mailPassword }, logger: false, socketTimeout: 30000 });
  try {
    await client.connect();
    await client.mailboxOpen(config.mailFolder, { readOnly: true });
    const validity = String(client.mailbox.uidValidity);
    const prefix = `mail:${config.mailUser}:${config.mailFolder}:${validity}`;
    const checkpoint = store.get(prefix);
    if (checkpoint === undefined) {
      store.set(prefix, Math.max(0, client.mailbox.uidNext - 1));
      return;
    }
    const ids = await client.search({ uid: `${Number(checkpoint) + 1}:*` }, { uid: true });
    for (const uid of ids.filter(id => id > Number(checkpoint)).sort((a, b) => a - b).slice(0, 20)) {
      const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!message?.source) continue;
      if (message.source.length > 5 * 1024 * 1024) { store.set(prefix, uid); continue; }
      const parsed = await simpleParser(message.source, { skipImageLinks: true });
      const body = parsed.text || '';
      if (likelyEnglish(`${parsed.subject || ''}\n${body}`)) {
        store.saveMail(`${prefix}:${uid}`, { subject: parsed.subject || '无主题', from: parsed.from?.text || '', messageId: parsed.messageId || '', date: parsed.date?.toISOString(), text: body.slice(0, 40000) });
      }
      store.set(prefix, uid);
    }
  } finally { await client.logout().catch(() => {}); }
}
