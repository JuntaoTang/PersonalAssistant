import test from 'node:test';
import assert from 'node:assert/strict';
import { queryTimetable, formatTimetable, timetableSource } from '../src/ehall-timetable.js';
import { EhallLoginRequired } from '../src/ehall.js';

const term = { DM: '2099-2100-1', MC: '2099-2100学年 第1学期' };
const sample = { KCM: '课程甲', KCH: 'TEST001', XNXQDM: term.DM, ZCMC: '3-9周(单)', SKXQ: '2', KSJC: '3', JSJC: '4', JASMC: '测试楼101', SKJS: '教师甲', SKSM: null };
const section = rows => ({ rows, totalSize: rows.length, extParams: { code: 1 } });

function fixture(change = () => {}) {
  const calls = [];
  let disposed = false;
  const context = {
    async get(url, options) {
      calls.push({ method: 'GET', url, options });
      const first = url === timetableSource;
      const result = { status: first ? 302 : 200, location: first ? 'https://ehallapp.nju.edu.cn/jwapp/sys/wdkb/*default/index.do' : null };
      change(result, 'entry', calls);
      return { status: () => result.status, ok: () => result.status === 200, headers: () => ({ location: result.location }) };
    },
    async post(url, options) {
      calls.push({ method: 'POST', url, options });
      const action = /\/([^/]+)\.do$/.exec(url)[1];
      const result = { status: 200, body: { code: '0', datas: { [action]: section(action === 'dqxnxq' ? [term] : action === 'cxxszhxqkb' ? [sample] : []) } } };
      change(result, action, calls);
      return { status: () => result.status, ok: () => result.status === 200, json: async () => result.body };
    },
    async dispose() { disposed = true; },
  };
  return { calls, disposed: () => disposed, client: { stateFile: 'private-state.json', request: { async newContext(options) { assert.deepEqual(options, { storageState: 'private-state.json' }); return context; } } } };
}

test('personal timetable follows only known SSO pages and queries all three course groups for the server term', async () => {
  const f = fixture();
  const result = await queryTimetable(f.client);
  assert.equal(f.disposed(), true);
  assert.equal(result.scheduled[0].weeks, '3-9周(单)');
  const output = formatTimetable(result);
  assert.match(output, /课程甲[\s\S]*星期二；第 3～4 节/);
  assert.match(output, /待开课程（0 条）[\s\S]*未排课（0 条）/);
  assert.match(output, /2099-2100学年/);
  assert.match(output, /未将节次换算为钟点/);
  const posts = f.calls.filter(c => c.method === 'POST');
  assert.deepEqual(posts.map(c => new URL(c.url).pathname), [
    '/jwapp/sys/wdkb/modules/jshkcb/dqxnxq.do', '/jwapp/sys/wdkb/modules/xskcb/cxxszhxqkb.do',
    '/jwapp/sys/wdkb/modules/xskcb/xsdkkc.do', '/jwapp/sys/wdkb/modules/xskcb/xswpkc.do',
  ]);
  assert.ok(f.calls.every(c => c.options.maxRedirects === 0));
  assert.deepEqual(posts[1].options.form, { XNXQDM: term.DM, pageSize: 1000, pageNumber: 1 });
  assert.ok(posts.every(c => !('XH' in c.options.form)));
});

test('valid empty timetable is distinct from incompatible, failed, truncated or wrong-term responses', async () => {
  const empty = fixture((result, action) => { if (action === 'cxxszhxqkb') result.body.datas[action] = section([]); });
  assert.equal((await queryTimetable(empty.client)).scheduled.length, 0);
  const cases = [
    (r, a) => { if (a === 'cxxszhxqkb') r.body.code = '1'; },
    (r, a) => { if (a === 'cxxszhxqkb') delete r.body.datas[a].extParams; },
    (r, a) => { if (a === 'cxxszhxqkb') r.body.datas[a].totalSize = 1001; },
    (r, a) => { if (a === 'cxxszhxqkb') r.body.datas[a] = { ...section([]), totalSize: null }; },
    (r, a) => { if (a === 'cxxszhxqkb') r.body.datas[a].rows = [{ ...sample, XNXQDM: 'wrong-term' }]; },
    (r, a) => { if (a === 'dqxnxq') r.body.datas[a] = section([]); },
    (r, a) => { if (a === 'cxxszhxqkb') r.body.datas[a].rows = [{ unexpected: true }]; },
  ];
  for (const mutate of cases) {
    const f = fixture(mutate);
    await assert.rejects(queryTimetable(f.client), /停止|格式|未成功|完整/);
    assert.equal(f.disposed(), true);
  }
});

test('expired login, unexpected redirects and transport diagnostics fail without exposing tickets or cookies', async () => {
  const expired = fixture((r, action) => { if (action === 'dqxnxq') r.status = 302; });
  await assert.rejects(queryTimetable(expired.client), EhallLoginRequired);
  const redirect = fixture((r, action, calls) => { if (action === 'entry' && calls.length === 1) r.location = 'https://example.org/steal?ticket=private-ticket'; });
  await assert.rejects(queryTimetable(redirect.client), /入口跳转已变化/);
  assert.equal(redirect.calls.length, 1);
  const leak = fixture(() => { throw new Error('Cookie: private-cookie; ticket=private-ticket'); });
  await assert.rejects(queryTimetable(leak.client), error => {
    assert.match(error.message, /请求未完成/);
    assert.doesNotMatch(error.message, /private-cookie|private-ticket|Cookie/);
    return true;
  });
  assert.equal(leak.disposed(), true);
});
