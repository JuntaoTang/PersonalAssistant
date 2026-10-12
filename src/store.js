import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 10);

export class Store {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, sender TEXT, chat TEXT, content TEXT, status TEXT NOT NULL DEFAULT 'queued');
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, owner TEXT, chat TEXT, url TEXT, status TEXT, plan TEXT, approval TEXT, result TEXT, created TEXT);
      CREATE TABLE IF NOT EXISTS mail (id TEXT PRIMARY KEY, payload TEXT, summary TEXT, delivered INTEGER NOT NULL DEFAULT 0);
    `);
  }
  get(key) { return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value; }
  set(key, value) { this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value)); }
  bind(owner, chat) {
    if (this.get('owner') && this.get('owner') !== owner) throw new Error('助手已绑定其他用户');
    this.set('owner', owner); this.set('chat', chat);
  }
  enqueue(id, sender, chat, content) {
    return this.db.prepare('INSERT OR IGNORE INTO inbox (id,sender,chat,content) VALUES (?,?,?,?)').run(id, sender, chat, content).changes > 0;
  }
  nextMessage() {
    const row = this.db.prepare("SELECT * FROM inbox WHERE status='queued' ORDER BY rowid LIMIT 1").get();
    if (row) this.db.prepare("UPDATE inbox SET status='processing' WHERE id=?").run(row.id);
    return row;
  }
  finishMessage(id) { this.db.prepare("UPDATE inbox SET status='done' WHERE id=?").run(id); }
  createTask(owner, chat, url) {
    const id = randomUUID().slice(0, 8);
    this.db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?)').run(id, owner, chat, url, 'inspecting', null, null, null, new Date().toISOString());
    return this.task(id);
  }
  task(id) {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (row?.plan) row.plan = JSON.parse(row.plan);
    return row;
  }
  plan(id, plan) {
    this.db.prepare("UPDATE tasks SET status='awaiting_confirmation',plan=?,approval=NULL WHERE id=?").run(JSON.stringify(plan), id);
    return digest(plan);
  }
  approve(id, owner, code) {
    const task = this.task(id);
    if (!task || task.owner !== owner || task.status !== 'awaiting_confirmation' || digest(task.plan) !== code) return false;
    return this.db.prepare("UPDATE tasks SET status='approved',approval=? WHERE id=? AND status='awaiting_confirmation'").run(code, id).changes === 1;
  }
  status(id, status, result = '') { this.db.prepare('UPDATE tasks SET status=?,result=? WHERE id=?').run(status, result, id); }
  recent(owner) { return this.db.prepare('SELECT id,status,created FROM tasks WHERE owner=? ORDER BY created DESC LIMIT 10').all(owner); }
  recover() {
    this.db.prepare("UPDATE inbox SET status='interrupted' WHERE status='processing'").run();
    this.db.prepare("UPDATE tasks SET status='needs_review',result='上次执行被中断，请核实页面状态后重新发起，未自动重试' WHERE status IN ('filling','inspecting')").run();
    this.db.prepare("UPDATE tasks SET status='awaiting_confirmation',approval=NULL WHERE status='approved'").run();
    this.db.prepare("UPDATE tasks SET status='needs_review',result='后台浏览器已关闭；填写结果未提交，请重新发起' WHERE status='filled'").run();
  }
  saveMail(id, payload) { this.db.prepare('INSERT OR IGNORE INTO mail (id,payload) VALUES (?,?)').run(id, JSON.stringify(payload)); }
  pendingMail() { return this.db.prepare('SELECT * FROM mail WHERE delivered=0 ORDER BY rowid LIMIT 10').all(); }
  mailSummary(id, summary) { this.db.prepare('UPDATE mail SET summary=? WHERE id=?').run(JSON.stringify(summary), id); }
  mailDelivered(id) { this.db.prepare('UPDATE mail SET delivered=1 WHERE id=?').run(id); }
  close() { this.db.close(); }
}
