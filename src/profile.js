import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const fields = ['姓名（中文）', '姓名（英文）', '学校', '院系', '专业', '学历层次', '入学年份', '学号', '常用邮箱', '联系电话'];
const clean = value => String(value).replaceAll('|', '／').replace(/[\r\n]/g, ' ').trim();

export function parseFacts(markdown) {
  const facts = {};
  for (const [index, line] of markdown.split('\n').entries()) {
    const cells = line.split('|').slice(1, -1).map(value => value.trim());
    if (cells.length === 4 && cells[0] && cells[1] && !['字段', '事项', '规则'].includes(cells[0]) && !/^[-:]+$/.test(cells[0])) {
      facts[cells[0]] = { value: cells[1], scope: cells[2], source: cells[3], location: { file: 'profile.md', line: index + 1 } };
    }
  }
  return facts;
}

export class Profile {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'profile.md');
    fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(this.file)) {
      const rows = fields.map(key => `| ${key} | | | |`).join('\n');
      fs.writeFileSync(this.file, `# 个人资料\n\n空值表示未知；有适用范围或有效期的信息注明限制。\n\n| 字段 | 已核实的值 | 适用范围／有效期 | 来源与确认日期 |\n| --- | --- | --- | --- |\n${rows}\n`, 'utf8');
    }
  }
  read() { return fs.readFileSync(this.file, 'utf8'); }
  hash() { return createHash('sha256').update(this.read()).digest('hex'); }
  snapshot() {
    const markdown = this.read();
    return { markdown, hash: createHash('sha256').update(markdown).digest('hex'), facts: parseFacts(markdown) };
  }
  facts() { return this.snapshot().facts; }
  search(keyword) {
    keyword = String(keyword).trim();
    if (!keyword || keyword.length > 80) throw new Error('请提供 1～80 个字符的资料关键词，例如：查资料 姓名');
    const snapshot = this.snapshot();
    const query = keyword.toLocaleLowerCase();
    const items = Object.entries(snapshot.facts).filter(([key, fact]) => [key, fact.value, fact.scope, fact.source].some(value => value.toLocaleLowerCase().includes(query))).map(([key, fact]) => ({ key, ...fact }));
    return { keyword, hash: snapshot.hash, items: items.slice(0, 20), total: items.length };
  }
  set(key, value, source = '用户明确提供', scope = '') {
    key = clean(key); value = clean(value);
    if (!key || ['字段', '事项', '规则'].includes(key) || key.length > 60 || value.length > 4000) throw new Error('资料字段或值不合适');
    const rows = this.read().split('\n');
    const record = `| ${key} | ${value} | ${clean(scope)} | ${clean(source)}；${new Date().toISOString().slice(0, 10)} |`;
    const index = rows.findIndex(line => line.split('|')[1]?.trim() === key);
    if (index >= 0) rows[index] = record;
    else rows.push(record);
    const history = path.join(path.dirname(this.file), 'profile-history');
    fs.mkdirSync(history, { recursive: true });
    fs.copyFileSync(this.file, path.join(history, `${Date.now()}-${this.hash().slice(0, 8)}.md`));
    const temp = this.file + '.tmp';
    fs.writeFileSync(temp, rows.join('\n'), 'utf8');
    fs.renameSync(temp, this.file);
  }
}
