import { EhallError, EhallLoginRequired } from './ehall-errors.js';

const appOrigin = 'https://ehallapp.nju.edu.cn';
const entryPath = '/jwapp/sys/wdkb/*default/index.do';
export const timetableSource = 'https://ehall.nju.edu.cn/appShow?appId=4770397878132218';
const actions = [
  ['dqxnxq', 'jshkcb'], ['cxxszhxqkb', 'xskcb'], ['xsdkkc', 'xskcb'], ['xswpkc', 'xskcb'],
];

function checkRedirect(url) {
  const allowed = url.protocol === 'https:' && !url.username && !url.password && (
    (url.origin === 'https://ehall.nju.edu.cn' && url.pathname === '/appShow' && url.searchParams.get('appId') === '4770397878132218') ||
    (url.origin === appOrigin && url.pathname === entryPath) ||
    (url.origin === 'https://authserver.nju.edu.cn' && url.pathname === '/authserver/login')
  );
  if (!allowed) throw new EhallError('课表入口跳转已变化，已停止查询，请检查适配。');
}

async function openTimetable(context) {
  let url = new URL(timetableSource);
  for (let step = 0; step < 8; step++) {
    checkRedirect(url);
    const response = await context.get(url.href, { maxRedirects: 0, timeout: 20000 });
    if ([401, 403].includes(response.status())) throw new EhallLoginRequired();
    if ([301, 302, 303, 307, 308].includes(response.status())) {
      const location = response.headers().location;
      if (!location) throw new EhallError('课表登录跳转缺少地址，已停止查询。');
      url = new URL(location, url);
      continue;
    }
    if (!response.ok()) throw new EhallError(`课表入口未打开，HTTP ${response.status()}`);
    if (url.origin !== appOrigin || url.pathname !== entryPath) throw new EhallLoginRequired();
    return;
  }
  throw new EhallLoginRequired();
}

async function readAction(context, index, params = {}) {
  const [action, module] = actions[index];
  // These POST endpoints are read queries used by the school's own timetable page.
  // Neither command text nor model output can select an endpoint or add a student ID.
  const response = await context.post(`${appOrigin}/jwapp/sys/wdkb/modules/${module}/${action}.do`, {
    form: { ...params, pageSize: 1000, pageNumber: 1 }, maxRedirects: 0, timeout: 20000,
  });
  if ([301, 302, 303, 307, 308, 401, 403].includes(response.status())) throw new EhallLoginRequired();
  if (!response.ok()) throw new EhallError(`课表查询失败，HTTP ${response.status()}`);
  let data;
  try { data = await response.json(); } catch { throw new EhallLoginRequired(); }
  const section = data?.datas?.[action];
  if (String(data?.code) !== '0' || !section || String(section.extParams?.code) !== '1' || !Array.isArray(section.rows)) {
    throw new EhallError('课表响应未成功或格式已变化，未将其当作空课表。');
  }
  if (!['string', 'number'].includes(typeof section.totalSize) || !/^\d+$/.test(String(section.totalSize)) || !Number.isSafeInteger(Number(section.totalSize)) || Number(section.totalSize) !== section.rows.length || section.rows.length > 1000) {
    throw new EhallError('课表条目未完整返回，已停止展示，不能将部分数据当作完整课表。');
  }
  return section.rows;
}

function text(value) {
  if (value === null || value === undefined) return '';
  if (!['string', 'number'].includes(typeof value)) throw new EhallError('课表字段格式已变化，已停止展示。');
  return String(value).replace(/[\r\n\t]+/g, ' ').trim();
}

function course(row, term) {
  if (!row || !text(row.KCM) || (row.XNXQDM != null && text(row.XNXQDM) !== term)) throw new EhallError('课表课程名称或学期不兼容，已停止展示。');
  const start = text(row.KSJC), end = text(row.JSJC);
  return {
    name: text(row.KCM), code: text(row.KCH), weeks: text(row.ZCMC), day: text(row.SKXQ),
    periods: start ? (end && end !== start ? `${start}～${end}` : start) : '',
    location: text(row.JASMC), teacher: text(row.SKJS), note: text(row.SKSM),
    originalSchedule: text(row.ZCXQJCDD),
  };
}

export async function queryTimetable(client) {
  let context;
  try {
    context = await client.request.newContext({ storageState: client.stateFile });
    await openTimetable(context);
    const terms = await readAction(context, 0);
    if (terms.length !== 1 || !text(terms[0].DM) || !text(terms[0].MC)) throw new EhallError('学校未返回唯一的当前学期，已停止查询。');
    const term = { id: text(terms[0].DM), name: text(terms[0].MC) };
    const sections = [];
    for (let index = 1; index < actions.length; index++) {
      const rows = await readAction(context, index, { XNXQDM: term.id });
      sections.push(rows.map(row => course(row, term.id)));
    }
    return { term, scheduled: sections[0], pending: sections[1], unarranged: sections[2], source: timetableSource, at: new Date().toISOString() };
  } catch (error) {
    if (error instanceof EhallError || error instanceof EhallLoginRequired) throw error;
    // Transport diagnostics may contain cookies, CAS tickets and personal fields.
    throw new EhallError('课表请求未完成，请检查网络，必要时重新登录 ehall。');
  } finally { await context?.dispose().catch(() => {}); }
}

export function formatTimetable(result) {
  const lines = [`我的课表：${result.term.name}`, '范围：当前登录本科生账号；学校返回的当前学期全学期安排。'];
  const groups = [['已排课', result.scheduled], ['待开课程', result.pending], ['未排课', result.unarranged]];
  for (const [label, rows] of groups) {
    lines.push(`\n${label}（${rows.length} 条）`);
    if (!rows.length) { lines.push('学校接口未返回此类条目。'); continue; }
    rows.forEach((row, i) => {
      const day = /^[1-7]$/.test(row.day) ? `星期${'一二三四五六日'[Number(row.day) - 1]}` : (row.day ? `星期字段：${row.day}` : '星期未提供');
      lines.push(`${i + 1}. ${row.name}${row.code ? `（${row.code}）` : ''}`,
        `   ${row.weeks || '周次未提供'}；${day}；${row.periods ? `第 ${row.periods} 节` : '节次未提供'}`,
        `   地点：${row.location || '未提供'}；教师：${row.teacher || '未提供'}`);
      if (row.originalSchedule) lines.push(`   学校原始安排：${row.originalSchedule}`);
      if (row.note) lines.push(`   说明：${row.note}`);
    });
  }
  lines.push('\n未将节次换算为钟点；临时调课及最新安排请核对学校页面。', `来源：${result.source}`, `查询时间：${result.at}`);
  return lines.join('\n');
}
