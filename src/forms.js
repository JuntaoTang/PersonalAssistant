import { chromium } from 'playwright';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { digest } from './store.js';

function privateAddress(address) {
  const ip = address.toLowerCase().replace(/^::ffff:/, '');
  return /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)
    || ip === '::1' || ip === '::' || /^(fc|fd|fe[89ab])/.test(ip);
}

export async function publicUrl(raw, allowLocal = false) {
  const url = new URL(raw);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('只接受不含登录凭据的 HTTP/HTTPS 表单链接');
  if (!allowLocal) {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true });
    if (!addresses.length || addresses.some(item => privateAddress(item.address))) throw new Error('该链接指向本机或私有网络，暂不支持');
  }
  url.hash = '';
  return url.href;
}

export function buildPlan(snapshot, profileHash, facts, matches) {
  const entries = snapshot.fields.map(field => {
    const candidates = (Array.isArray(matches?.matches) ? matches.matches : []).filter(match => match.field_id === field.id && match.certain === true && facts[match.fact_key]?.value && !facts[match.fact_key]?.scope);
    const keys = [...new Set(candidates.map(match => match.fact_key))];
    let value = null; let factKey = null; let optionValue = null;
    let blankReason = keys.length > 1 ? '资料匹配有歧义' : '没有确定且适用的资料';
    if (keys.length === 1) {
      factKey = keys[0]; value = facts[factKey].value;
      if (field.options?.length) {
        const options = field.options.filter(option => option.label.trim() === value.trim());
        if (options.length === 1) optionValue = options[0].value;
        else { value = null; blankReason = '资料值与页面选项不能唯一匹配'; }
      }
    }
    const fact = value === null ? null : facts[factKey];
    return { ...field, value, factKey: fact ? factKey : null, optionValue,
      factSource: fact ? { source: fact.source || '', location: fact.location || null } : null,
      blankReason: value === null ? blankReason : null };
  });
  return { url: snapshot.url, title: snapshot.title, fingerprint: digest(snapshot.fields), profileHash, preparedAt: new Date().toISOString(), entries };
}

export function formatEntries(plan) {
  return plan.entries.map(entry => {
    const label = `${entry.label}${entry.required ? '（必填）' : ''}`;
    if (entry.value === null) return `${label}：留空（${entry.blankReason || '没有确定资料'}）`;
    const location = entry.factSource?.location;
    const source = location ? `${location.file}:L${location.line}` : '旧预览未保存原文定位';
    return `${label}：${entry.value}\n  依据：${entry.factKey}；${source}${entry.factSource?.source ? `；${entry.factSource.source}` : ''}`;
  }).join('\n');
}

export function preview(task, { stale = false } = {}) {
  const plan = task.plan;
  const next = stale ? `资料已经变化，本预览失效。请发送：重新准备 ${task.id}`
    : task.status === 'awaiting_confirmation' ? `确认前不会输入网页。填写会把以下值输入网页，可能包含个人信息；本流程阻断填写触发的联网，不保存草稿或提交。核对后回复：\n确认填表 ${task.id} ${digest(plan)}`
      : `这是历史预览，不能再次确认。如需新任务，请发送：重新准备 ${task.id}`;
  return `任务 ${task.id}\n${plan.title}\n${plan.url}\n资料版本：${plan.profileHash.slice(0, 12)}（原文位置对应准备时的版本）\n\n${formatEntries(plan)}\n\n${next}`;
}

export class Forms {
  constructor({ allowLocal = false } = {}) { this.allowLocal = allowLocal; this.sessions = new Map(); }
  async open(raw) {
    const url = await publicUrl(raw, this.allowLocal);
    this.browser ||= await chromium.launch({ headless: true });
    const context = await this.browser.newContext({ viewport: { width: 1100, height: 900 }, locale: 'zh-CN', serviceWorkers: 'block' });
    const page = await context.newPage();
    let inputStarted = false;
    const checked = new Map();
    await context.routeWebSocket('**/*', socket => socket.close());
    await context.route('**/*', async route => {
      if (inputStarted) return route.abort();
      const target = route.request().url();
      if (!/^https?:/.test(target)) return route.continue();
      try {
        const host = new URL(target).host;
        if (!checked.has(host)) checked.set(host, publicUrl(target, this.allowLocal));
        await checked.get(host);
        await route.continue();
      } catch { await route.abort(); }
    });
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.locator('body').waitFor();
      await page.locator('input:not([type=hidden]),textarea,select').first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      const finalUrl = await publicUrl(page.url(), this.allowLocal);
      if (new URL(finalUrl).origin !== new URL(url).origin) throw new Error('页面跳转到了其他网站，请直接提供目标表单链接');
      return { page, context, lockNetwork: () => { inputStarted = true; } };
    } catch (error) { await context.close(); throw error; }
  }
  async snapshot(page) {
    const fields = await page.evaluate(() => {
      const result = []; const radios = new Set();
      const visible = element => element.getClientRects().length > 0 && !element.disabled && !element.readOnly;
      const label = element => {
        const container = element.closest('.field, .div_question, fieldset, [role=group]');
        const title = container?.querySelector('.topichtml, .div_title_question, legend, .field-label');
        return (title?.textContent || [...(element.labels || [])].map(item => item.textContent).join(' ') || element.getAttribute('aria-label') || element.placeholder || element.name || element.id || '').replace(/\s+/g, ' ').trim();
      };
      for (const element of document.querySelectorAll('input,textarea,select')) {
        if (!visible(element)) continue;
        const type = element.type || element.tagName.toLowerCase();
        if (['hidden', 'password', 'file', 'button', 'submit', 'reset', 'checkbox', 'image', 'range', 'color'].includes(type)) continue;
        if (type === 'radio') {
          const name = element.name;
          if (!name || radios.has(name)) continue;
          radios.add(name);
          const group = [...document.querySelectorAll('input[type=radio]')].filter(item => item.name === name && visible(item));
          const id = `f${result.length}`;
          const options = group.map((item, index) => {
            item.setAttribute('data-pa-option', `${id}-${index}`);
            return { value: String(index), label: [...(item.labels || [])].map(node => node.textContent).join(' ').trim() || item.value };
          });
          result.push({ id, label: label(element), kind: 'radio', required: group.some(item => item.required), options });
          continue;
        }
        const id = `f${result.length}`;
        element.setAttribute('data-pa-field', id);
        const options = element.tagName === 'SELECT' ? [...element.options].filter(option => !option.disabled && option.value).map(option => ({ label: option.textContent.trim(), value: option.value })) : [];
        result.push({ id, label: label(element), kind: element.tagName === 'SELECT' ? 'select' : 'text', required: element.required || false, options });
      }
      return result;
    });
    if (!fields.length) throw new Error('未发现可填写的字段：表单可能已关闭、需要登录，或使用了当前不支持的控件');
    return { url: page.url().split('#')[0], title: await page.title(), fields };
  }
  async inspect(url) {
    const { page, context } = await this.open(url);
    try { return await this.snapshot(page); }
    finally { await context.close(); }
  }
  async fill(task, profile, screenshotPath) {
    if (task.status !== 'approved' || task.approval !== digest(task.plan)) throw new Error('本次填写尚未获得对应预览的确认');
    if (profile.hash() !== task.plan.profileHash) throw new Error('个人资料已经变化，请重新生成预览并确认');
    const { page, context, lockNetwork } = await this.open(task.plan.url);
    try {
      const current = await this.snapshot(page);
      if (current.url !== task.plan.url || digest(current.fields) !== task.plan.fingerprint) throw new Error('表单内容发生变化，请重新读取并确认');
      if (profile.hash() !== task.plan.profileHash) throw new Error('个人资料已经变化，请重新生成预览并确认');
      lockNetwork();
      for (const entry of task.plan.entries) {
        if (entry.value === null) continue;
        if (entry.kind === 'radio') await page.locator(`[data-pa-option="${entry.id}-${entry.optionValue}"]`).check();
        else if (entry.kind === 'select') await page.locator(`[data-pa-field="${entry.id}"]`).selectOption(entry.optionValue);
        else await page.locator(`[data-pa-field="${entry.id}"]`).fill(entry.value);
      }
      for (const entry of task.plan.entries) {
        if (entry.kind === 'radio') {
          const checked = await page.locator(`[data-pa-option^="${entry.id}-"]:checked`).count();
          if (entry.value === null ? checked !== 0 : !await page.locator(`[data-pa-option="${entry.id}-${entry.optionValue}"]`).isChecked()) throw new Error('单选字段与确认内容不一致，已停止');
        } else {
          const value = await page.locator(`[data-pa-field="${entry.id}"]`).inputValue();
          const expected = entry.value === null ? '' : entry.kind === 'select' ? entry.optionValue : entry.value;
          if (value !== expected) throw new Error('页面字段与确认内容不一致（可能有预填值或格式限制），已停止');
        }
      }
      if (page.url().split('#')[0] !== task.plan.url) throw new Error('填写过程中页面发生跳转，请核实结果');
      if (profile.hash() !== task.plan.profileHash) throw new Error('个人资料已经变化，请重新生成预览并确认');
      await page.screenshot({ path: screenshotPath, fullPage: true });
      if (this.sessions.has(task.id)) await this.sessions.get(task.id).context.close();
      this.sessions.set(task.id, { page, context });
      return `已填写 ${task.plan.entries.filter(entry => entry.value !== null).length} 项；不确定项保持空白，未提交。`;
    } catch (error) { await context.close(); throw error; }
  }
  async close() { if (this.browser) await this.browser.close(); this.sessions.clear(); }
}
