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
    if (keys.length === 1) {
      factKey = keys[0]; value = facts[factKey].value;
      if (field.options?.length) {
        const options = field.options.filter(option => option.label.trim() === value.trim());
        if (options.length === 1) optionValue = options[0].value;
        else value = null;
      }
    }
    return { ...field, value, factKey: value === null ? null : factKey, optionValue };
  });
  return { url: snapshot.url, title: snapshot.title, fingerprint: digest(snapshot.fields), profileHash, entries };
}

export function preview(task) {
  const plan = task.plan;
  const lines = plan.entries.map(entry => `${entry.label}${entry.required ? '（必填）' : ''}：${entry.value === null ? '留空（没有确定资料）' : entry.value}`);
  return `任务 ${task.id}\n${plan.title}\n${plan.url}\n\n${lines.join('\n')}\n\n确认前不会输入网页。核对后回复：\n确认填表 ${task.id} ${digest(plan)}`;
}

export class Forms {
  constructor({ allowLocal = false } = {}) { this.allowLocal = allowLocal; this.sessions = new Map(); }
  async open(raw) {
    const url = await publicUrl(raw, this.allowLocal);
    this.browser ||= await chromium.launch({ headless: true });
    const context = await this.browser.newContext({ viewport: { width: 1100, height: 900 }, locale: 'zh-CN' });
    const page = await context.newPage();
    const checked = new Map();
    await context.route('**/*', async route => {
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
      return { page, context };
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
    const { page, context } = await this.open(task.plan.url);
    try {
      const current = await this.snapshot(page);
      if (current.url !== task.plan.url || digest(current.fields) !== task.plan.fingerprint) throw new Error('表单内容发生变化，请重新读取并确认');
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
      await page.screenshot({ path: screenshotPath, fullPage: true });
      if (this.sessions.has(task.id)) await this.sessions.get(task.id).context.close();
      this.sessions.set(task.id, { page, context });
      return `已填写 ${task.plan.entries.filter(entry => entry.value !== null).length} 项；不确定项保持空白，未提交。`;
    } catch (error) { await context.close(); throw error; }
  }
  async close() { if (this.browser) await this.browser.close(); this.sessions.clear(); }
}
