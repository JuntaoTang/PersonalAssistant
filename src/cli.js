import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { loadConfig } from './config.js';
import { DeepSeek } from './model.js';
import { Assistant, initialize } from './app.js';

const config = loadConfig();
const command = process.argv[2] || 'doctor';
const pidFile = path.join(config.dataDir, 'process.json');
const stopFile = path.join(config.dataDir, 'stop');
const stateFile = path.join(config.dataDir, 'status.json');
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const running = () => { const record = readJson(pidFile); return record && alive(record.pid) ? record : null; };
function browserInstalled() {
  if (fs.existsSync(chromium.executablePath())) return true;
  try {
    const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.env.LOCALAPPDATA || config.dataDir, 'ms-playwright');
    return fs.readdirSync(cache).some(name => name.startsWith('chromium_headless_shell-'));
  } catch { return false; }
}

async function doctor() {
  const { profile, store } = initialize(config);
  const checks = {
    Node: process.version,
    DeepSeek密钥: config.apiKey ? '已配置' : '缺少',
    主模型: config.models[0], 备用调用名: config.models[1],
    飞书AppID: config.appId ? '已配置' : '缺少', 飞书AppSecret: config.appSecret ? '已配置' : '缺少',
    邮箱: config.mailUser, 邮箱客户端密码: config.mailPassword ? '已配置' : '缺少',
    自动邮件读取: config.mailEnabled && config.mailScope === 'all-new-english' ? '已开启：新增英文邮件' : '未开启',
    后台浏览器: browserInstalled() ? '已安装' : '请运行 npx playwright install chromium --only-shell',
    个人资料: profile.file,
  };
  console.log(JSON.stringify(checks, null, 2));
  if (process.argv.includes('--pairing') && !store.get('owner')) console.log(`请在机器人私聊发送：绑定 ${store.get('pairing_code')}`);
  store.close();
  if (process.argv.includes('--model')) {
    const model = new DeepSeek(config);
    const result = await model.json('只输出 JSON：{"ok":true}，这是不包含个人数据的接口连通测试。', { test: true });
    if (result.ok !== true) throw new Error('模型连通测试返回内容不符');
    console.log(`模型连通测试通过：${model.lastModel}`);
  }
}

async function daemon() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  if (running()) throw new Error('已有后台进程运行');
  if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
  const descriptor = fs.openSync(pidFile, 'wx');
  fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
  fs.closeSync(descriptor);
  fs.rmSync(stopFile, { force: true });
  let stopping = false;
  let busy = false;
  let assistant;
  const offline = process.argv.includes('--offline');
  const heartbeat = () => {
    fs.writeFileSync(stateFile, JSON.stringify({ pid: process.pid, heartbeat: new Date().toISOString(), mode: offline ? 'offline-test' : 'feishu', connection: assistant?.channel?.status() || 'offline' }));
    if (fs.existsSync(stopFile)) void cleanup();
  };
  const heartbeatTimer = setInterval(heartbeat, 1000);
  const cleanup = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeatTimer);
    if (busy) { setTimeout(() => process.exit(0), 5000).unref(); }
    else await assistant?.close();
    if (readJson(pidFile)?.pid === process.pid) fs.rmSync(pidFile, { force: true });
    fs.rmSync(stopFile, { force: true });
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  try {
    heartbeat();
    if (!offline) {
      assistant = new Assistant(config);
      await assistant.start();
    }
    console.log(`${new Date().toISOString()} 后台进程已启动（${offline ? '本地测试' : '飞书'}）。`);
    const worker = setInterval(async () => {
      if (fs.existsSync(stopFile)) { clearInterval(worker); await cleanup(); return; }
      if (busy || stopping || offline) return;
      busy = true;
      try { await assistant.tick(); } finally { busy = false; }
    }, 500);
  } catch {
    console.error('后台启动失败，请运行 npm run doctor 检查配置。');
    await cleanup();
  }
}

async function main() {
  if (command === 'doctor') return doctor();
  if (command === 'run') return daemon();
  if (command === 'status') {
    const record = running();
    console.log(record ? JSON.stringify({ ...readJson(stateFile), running: true }, null, 2) : '助手未运行');
    return;
  }
  if (command === 'stop') {
    if (running()) { fs.writeFileSync(stopFile, 'stop'); console.log('已请求停止后台助手'); }
    else console.log('助手未运行');
    return;
  }
  if (command === 'start') {
    if (running()) { console.log('助手已在后台运行'); return; }
    const offline = process.argv.includes('--offline');
    if (!offline && (!config.appId || !config.appSecret || !config.apiKey)) throw new Error('请先配置飞书应用和模型密钥；运行 npm run doctor 查看缺项');
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.rmSync(stopFile, { force: true });
    const logFile = path.join(config.dataDir, 'background.log');
    const output = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'run', ...(offline ? ['--offline'] : [])], {
      cwd: config.root, detached: true, windowsHide: true, stdio: ['ignore', output, output], env: process.env,
    });
    child.on('error', () => { console.error('后台进程未能启动，请检查 Node 安装。'); process.exitCode = 1; });
    child.unref();
    fs.closeSync(output);
    console.log(`已启动后台进程 PID ${child.pid}，不需要保持终端窗口。用 npm run status 核实状态。`);
    return;
  }
  throw new Error('命令：doctor [--model] [--pairing] | start | stop | status');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
