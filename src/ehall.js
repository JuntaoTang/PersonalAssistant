import fs from 'node:fs';
import path from 'node:path';
import { chromium, request } from 'playwright';

export const ehallOrigin = 'https://ehall.nju.edu.cn';
const accountPath = '/jsonp/ywtb/info/getUserInfoAndSchoolInfo';
const searchPath = '/jsonp/ywtb/searchAppAndService';

export class EhallLoginRequired extends Error {
  constructor() { super('ehall 尚未登录或登录已失效。请发送「ehall 登录」，在这台电脑弹出的独立窗口中手动登录，再发送「ehall 登录完成」。密码和验证码不要发到飞书。'); }
}

function catalogItems(data) {
  const items = [];
  for (const [key, type] of [['appList', '应用'], ['serviceList', '办事事项']]) {
    if (!Array.isArray(data?.[key])) throw new Error('ehall 服务目录格式已变化，未将响应当作查询结果');
    for (const row of data[key]) {
      const name = row.appName || row.serviceName || row.name;
      const id = row.wid || row.appId || row.id;
      if (typeof name !== 'string' || !name.trim() || !['string', 'number'].includes(typeof id)) throw new Error('ehall 服务条目格式未识别，需要检查接口适配');
      items.push({ id: String(id), name: name.trim(), type });
    }
  }
  return items;
}

export class Ehall {
  constructor(config, options = {}) {
    this.origin = options.origin || ehallOrigin;
    this.directory = path.join(config.dataDir, 'ehall');
    this.stateFile = path.join(this.directory, 'state.json');
    this.browserType = options.browserType || chromium;
    this.request = options.request || request;
    this.login = null;
  }
  status() {
    const exists = fs.existsSync(this.stateFile);
    return { saved: exists, loginWindow: Boolean(this.login), savedAt: exists ? fs.statSync(this.stateFile).mtime.toISOString() : null };
  }
  async api(pathname, params = {}, context = null) {
    const own = !context;
    context ||= await this.request.newContext({ storageState: fs.existsSync(this.stateFile) ? this.stateFile : undefined });
    try {
      const response = await context.get(this.origin + pathname, { params, timeout: 20000, maxRedirects: 0 });
      if ([301, 302, 303, 307, 308, 401, 403].includes(response.status())) throw new EhallLoginRequired();
      if (!response.ok()) throw new Error(`ehall 查询失败，HTTP ${response.status()}`);
      let result;
      try { result = await response.json(); } catch { throw new Error('ehall 未返回可识别的数据，可能需要重新登录'); }
      if (result.hasLogin !== true || result.data?.hasLogin === false) throw new EhallLoginRequired();
      if (result.result !== 'success') throw new Error('ehall 查询未成功，请稍后重试');
      return result.data;
    } finally { if (own) await context.dispose(); }
  }
  async beginLogin() {
    if (this.login && !this.login.page.isClosed()) return 'ehall 登录窗口已打开，请在电脑上完成登录，然后在飞书发送「ehall 登录完成」。';
    this.login = null;
    const browser = await this.browserType.launch({ channel: 'msedge', headless: false });
    try {
      const context = await browser.newContext({ storageState: fs.existsSync(this.stateFile) ? this.stateFile : undefined, serviceWorkers: 'block' });
      const page = await context.newPage();
      await page.goto(this.origin, { waitUntil: 'domcontentloaded', timeout: 45000 });
      this.login = { browser, context, page };
      return '已在 Windows 电脑打开独立的 ehall 登录窗口。请自行点击登录并完成身份认证，然后在飞书发送「ehall 登录完成」。这只用于首次或失效后的登录；日常查询在后台执行。';
    } catch { await browser.close(); throw new Error('ehall 登录窗口未能打开，请检查 Edge 安装及网络连接'); }
  }
  async finishLogin() {
    if (!this.login || this.login.page.isClosed()) { await this.close(); throw new EhallLoginRequired(); }
    // Verify server state rather than trusting the completion message or page title.
    const account = await this.api(accountPath, {}, this.login.context.request);
    if (account.hasLogin !== true || !account.userId) throw new EhallLoginRequired();
    fs.mkdirSync(this.directory, { recursive: true });
    const temporary = this.stateFile + '.tmp';
    await this.login.context.storageState({ path: temporary, indexedDB: true });
    fs.renameSync(temporary, this.stateFile);
    await this.close();
    return 'ehall 登录状态已保存到本机，登录窗口已关闭。现在可发送「ehall 服务 关键词」查询可见的服务目录。登录失效时会再次提醒你，不保存密码。';
  }
  async catalog(keyword) {
    keyword = String(keyword).trim();
    if (!keyword || keyword.length > 80) throw new Error('请提供 1～80 个字符的服务关键词，例如：ehall 服务 课表');
    if (!fs.existsSync(this.stateFile)) throw new EhallLoginRequired();
    const data = await this.api(searchPath, { searchKey: keyword });
    return { keyword, at: new Date().toISOString(), source: this.origin, scope: '当前账号可见的服务目录；不是个人成绩、课表内容或办件状态', items: catalogItems(data) };
  }
  async close() {
    const login = this.login;
    this.login = null;
    await login?.browser.close();
  }
}

export function formatCatalog(result) {
  const rows = result.items.slice(0, 20).map((item, index) => `${index + 1}. ${item.name}（${item.type}；ID：${item.id}）`);
  return `ehall 服务查询：${result.keyword}\n${rows.length ? rows.join('\n') : '当前账号未查到匹配的服务。'}${result.items.length > 20 ? '\n仅展示前 20 条，请缩小关键词。' : ''}\n\n范围：${result.scope}\n来源：${result.source}\n查询时间：${result.at}\n服务出现在目录中不代表已适配办理；发送「ehall」查看已支持的能力。`;
}
