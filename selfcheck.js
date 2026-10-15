#!/usr/bin/env node
/**
 * 自测：把 index.js 当真的 MCP server 拉起来，用 stdio 跟它走一遍完整协议，
 * 再对着 SnowLuma 真跑一次 get_login_info / get_group_list。
 *
 * 为什么是"起子进程"而不是直接 import：**这样连 stdio 协议本身也一并验了**。
 * 只会少一次互 impersonation：真出问题的话，你会知道是协议层坏了还是协议端那一侧坏了。
 *
 * 用法：node selfcheck.js
 *
 * 退出码：0 = 全过；1 = 关键项失败（握手/工具清单/两个真动作）或自测本身出错。
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, 'index.js');

const EXPECTED_TOOL_COUNT = 27; // 见 README：原本 28 个，set_restart 因 SnowLuma 明确不支持而剔除
const EXPECTED_READ_TOOLS = ['get_login_info', 'get_status', 'get_version_info', 'get_friend_list', 'get_group_list', 'get_group_info', 'get_group_member_list', 'get_group_member_info', 'get_msg', 'get_forward_msg', 'get_image', 'get_record', 'get_cookies', 'get_csrf_token'];
const EXPECTED_WRITE_TOOLS = ['delete_msg', 'set_group_kick', 'set_group_ban', 'set_group_whole_ban', 'set_group_admin', 'set_group_card', 'set_group_name', 'set_group_leave', 'set_group_special_title', 'set_friend_add_request', 'set_group_add_request', 'send_like', 'set_group_sign'];

const checks = [];
function check(label, passed, detail = '') {
  checks.push({ label, passed, detail });
  const mark = passed ? '通过' : '失败';
  process.stdout.write(`${mark}  ${label}${detail ? `：${detail}` : ''}\n`);
}

function section(title) {
  process.stdout.write(`\n── ${title} ──────────────────────────────\n`);
}

// ── 起子进程并搭一条最小的 stdio JSON-RPC 通道 ───────────────────────
const timeoutMs = Number.parseInt(process.env.ONEBOT_TIMEOUT_MS ?? '10000', 10) || 10000;
const child = spawn(process.execPath, [SERVER], {
  cwd: HERE,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env },
});

let seq = 0;
const waiting = new Map();

createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    process.stderr.write(`[服务端 stdout 出现非法 JSON] ${trimmed.slice(0, 200)}\n`);
    return;
  }
  const id = msg?.id ?? null;
  const settle = id !== null ? waiting.get(id) : null;
  if (settle) {
    waiting.delete(id);
    settle(msg);
  }
});

createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', (line) => {
  process.stderr.write(`   [server] ${line}\n`);
});

child.on('exit', (code, signal) => {
  if (!finished) {
    process.stderr.write(`\n服务端提前退出（code=${code} signal=${signal}），自测中止。\n`);
    process.exit(1);
  }
});

function request(method, params, waitMs = timeoutMs + 8000) {
  seq += 1;
  const id = seq;
  const payload = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`${method} 等了 ${waitMs}ms 没回包`));
    }, waitMs);
    waiting.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) })}\n`);
}

/** 从 tools/call 的结果里把 JSON 正文掏出来 */
function toolPayload(result) {
  const text = result?.result?.content?.[0]?.text ?? '';
  try {
    return { raw: text, json: JSON.parse(text) };
  } catch {
    return { raw: text, json: null };
  }
}

let finished = false;

async function main() {
  section('1. 握手（initialize）');
  const initRes = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'selfcheck', version: '1.0.0' },
  });
  const init = initRes.result;
  check('protocolVersion 是 2024-11-05', init?.protocolVersion === '2024-11-05', String(init?.protocolVersion));
  check('serverInfo 回来了', Boolean(init?.serverInfo?.name), `${init?.serverInfo?.name ?? '?'}@${init?.serverInfo?.version ?? '?'}`);
  check('capabilities 里声明了 tools', Boolean(init?.capabilities?.tools), JSON.stringify(init?.capabilities?.tools ?? null));
  notify('notifications/initialized', {});
  process.stdout.write(`   说明文案：${String(init?.instructions ?? '').slice(0, 60)}…\n`);

  section('2. 工具清单（tools/list）');
  const listRes = await request('tools/list', {});
  const tools = listRes.result?.tools ?? [];
  const names = new Set(tools.map((t) => t.name));
  check(`工具数量等于 ${EXPECTED_TOOL_COUNT}`, tools.length === EXPECTED_TOOL_COUNT, `实际 ${tools.length}`);

  const missingRead = EXPECTED_READ_TOOLS.filter((n) => !names.has(n));
  const missingWrite = EXPECTED_WRITE_TOOLS.filter((n) => !names.has(n));
  check('14 个查询类工具都在', missingRead.length === 0, missingRead.join(','));
  check('13 个管理类工具都在', missingWrite.length === 0, missingWrite.join(','));
  check('不支持的 set_restart 确实没注册', !names.has('set_restart'), names.has('set_restart') ? '它居然在里面' : '已剔除');

  const tooLong = tools.filter((t) => String(t.description ?? '').length > 100);
  check('每个 description 都不超过 100 字符', tooLong.length === 0, tooLong.map((t) => `${t.name}:${t.description.length}`).join(','));
  const noSchema = tools.filter((t) => !t.inputSchema || t.inputSchema.type !== 'object');
  check('每个工具都带 JSON Schema', noSchema.length === 0, noSchema.map((t) => t.name).join(','));

  section('3. 参数围栏（不该发出去的请求会被拦下）');
  const bad = await request('tools/call', { name: 'get_group_info', arguments: { group_iid: 123 } });
  const badText = String(bad?.result?.content?.[0]?.text ?? '');
  check('缺/写错参数时 isError=true 且没打到协议端', bad?.result?.isError === true && badText.includes('参数不对'), badText.split('\n')[0]);
  const unknown = await request('tools/call', { name: 'get_nothing', arguments: {} });
  check('不存在的工具返回明确提示', unknown?.result?.isError === true, String(unknown?.result?.content?.[0]?.text ?? '').slice(0, 40));

  section('4. 真跑 gets（对着 SnowLuma）');
  const loginRes = await request('tools/call', { name: 'get_login_info', arguments: {} });
  const login = toolPayload(loginRes);
  const loginOk = loginRes?.result?.isError !== true;
  check('get_login_info 成功', loginOk, loginOk ? '' : login.raw.split('\n').slice(0, 3).join(' ｜ '));
  if (loginOk) {
    const d = login.json?.data ?? {};
    process.stdout.write(`   我：${d.nickname ?? '?'}（QQ ${d.user_id ?? '?'}）｜ via ${login.json?.transport}\n`);
  }

  const groupRes = await request('tools/call', { name: 'get_group_list', arguments: {} });
  const groups = toolPayload(groupRes);
  const groupOk = groupRes?.result?.isError !== true;
  check('get_group_list 成功', groupOk, groupOk ? '' : groups.raw.split('\n').slice(0, 3).join(' ｜ '));
  if (groupOk) {
    const list = Array.isArray(groups.json?.data) ? groups.json.data : [];
    process.stdout.write(`   共 ${list.length} 个群｜ via ${groups.json?.transport}\n`);
    for (const g of list.slice(0, 5)) {
      process.stdout.write(`     - ${g.group_name ?? '(无名)'}｜群号 ${g.group_id}｜成员 ${g.member_count ?? '?'}\n`);
    }
    if (list.length > 5) process.stdout.write(`     …… 还有 ${list.length - 5} 个\n`);
  }

  finished = true;
  child.stdin.end();

  const failed = checks.filter((c) => !c.passed);
  section('结果');
  process.stdout.write(`共 ${checks.length} 项，通过 ${checks.length - failed.length}，失败 ${failed.length}\n`);
  if (failed.length > 0) {
    for (const c of failed) process.stdout.write(`  x ${c.label}${c.detail ? `：${c.detail}` : ''}\n`);
    process.stdout.write('\n失败项多半是配置问题：确认 SnowLuma 在跑、ONEBOT_ACCESS_TOKEN 与适配器令牌一致。\n');
    process.exit(1);
  }
  process.stdout.write('全部通过：协议层、工具清单、两个真实查询都对得上。\n');
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`\n自测本身炸了：${error?.stack ?? error}\n`);
  try {
    child.stdin.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
