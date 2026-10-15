/**
 * 配置：只从环境变量读，一处也不写死。
 *
 * 必读的四个：
 *   ONEBOT_HTTP_URL       默认 http://127.0.0.1:3000
 *   ONEBOT_WS_URL         默认 ws://127.0.0.1:3001
 *   ONEBOT_ACCESS_TOKEN   HTTP 用 Authorization: Bearer <token>；WS 只能走 ?access_token=<token>
 *                         （Node 内置 WebSocket 不支持自定义握手头，这是唯一办法）
 *   ONEBOT_TIMEOUT_MS     默认 10000
 *
 * 这三个是**可选的**，不配就退回上面的值：
 *   ONEBOT_READONLY             =1 时只注册查询类工具（对外的写操作一个都不出现）
 *   ONEBOT_HTTP_ACCESS_TOKEN    HTTP 适配器令牌与 WS 不一样时用它覆盖
 *   ONEBOT_WS_ACCESS_TOKEN      同上，覆盖 WS
 *   ONEBOT_TRANSPORT            auto(默认) / http / ws，手动指定优先走哪条路
 *
 * 设计取舍：**配置错误不阻塞进程启动**。MCP 客户端在配错地址时也应当能列出工具清单、
 * 干干净净地看到"该怎么改"，而不是连服务端都起不来。所以这里把错误攒下来，
 * 第一次真正调用时再抛（见 server.js 的处理）。
 */
import { Failure } from './errors.js';

const TRUE_WORDS = new Set(['1', 'true', 'yes', 'on']);

export const DEFAULT_HTTP_URL = 'http://127.0.0.1:3000';
export const DEFAULT_WS_URL = 'ws://127.0.0.1:3001';
export const DEFAULT_TIMEOUT_MS = 10000;

/** 允许显式关掉某条通道：设成 none/off 即代表"这条我不用" */
const DISABLED_WORDS = new Set(['none', 'off', 'false', '0', 'null']);

export function isTrue(raw) {
  return TRUE_WORDS.has(String(raw ?? '').trim().toLowerCase());
}

function readInt(raw, name, fallback) {
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const trimmed = String(raw).trim();
  const value = Number(trimmed);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Failure({
      kind: 'config',
      message: `环境变量 ${name} 得是正整数（毫秒），现在是 ${JSON.stringify(trimmed)}`,
      hint: `改成类似 ${name}=10000 这种写法。想更快失败就设小一点，别低于 1000（协议端本身处理也要时间）。`,
      detail: `${name}=${trimmed}`,
    });
  }
  return value;
}

function readUrl(raw, fallback, name, protocols, example) {
  const trimmed = String(raw ?? '').trim();
  const source = raw === undefined || trimmed === '' ? fallback : trimmed;
  if (!source) return null;
  if (DISABLED_WORDS.has(source.toLowerCase())) return null;

  let parsed;
  try {
    parsed = new URL(source);
  } catch {
    throw new Failure({
      kind: 'config',
      message: `${name} 不是合法 URL：${JSON.stringify(source)}`,
      hint: `照这个格式写：${name}=${example}（${protocols.map((p) => p + '://').join(' 或 ')} 开头，别漏了主机名和端口）`,
      detail: `${name}=${source}`,
    });
  }
  const scheme = parsed.protocol.replace(/:$/, '');
  if (!protocols.includes(scheme)) {
    throw new Failure({
      kind: 'config',
      message: `${name} 的协议头不对：现在是 ${parsed.protocol}，只接受 ${protocols.join(' / ')}`,
      hint: `HTTP 那一栏填 ${protocols[0]}:// 开头，WebSocket 那一栏填 ${protocols[protocols.length - 1]}:// 开头，别把两个地址写反了。`,
      detail: `${name}=${source}`,
    });
  }
  // 去掉结尾多余的斜杠：下面拼 `${base}/${action}` 时才不会变成 //action
  return source.replace(/\/+$/, '');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{httpUrl:string|null, wsUrl:string|null, httpToken:string, wsToken:string,
 *            timeoutMs:number, readonly:boolean, transport:'auto'|'http'|'ws'}}
 */
export function loadConfig(env) {
  const e = env ?? process.env;

  const httpUrl = readUrl(e.ONEBOT_HTTP_URL, DEFAULT_HTTP_URL, 'ONEBOT_HTTP_URL', ['http', 'https'], 'http://127.0.0.1:3000');
  const wsUrl = readUrl(e.ONEBOT_WS_URL, DEFAULT_WS_URL, 'ONEBOT_WS_URL', ['ws', 'wss'], 'ws://127.0.0.1:3001');
  const timeoutMs = readInt(e.ONEBOT_TIMEOUT_MS, 'ONEBOT_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);

  const sharedToken = String(e.ONEBOT_ACCESS_TOKEN ?? '').trim();
  const httpToken = String(e.ONEBOT_HTTP_ACCESS_TOKEN ?? sharedToken).trim();
  const wsToken = String(e.ONEBOT_WS_ACCESS_TOKEN ?? sharedToken).trim();

  if (!httpUrl && !wsUrl) {
    throw new Failure({
      kind: 'config',
      message: 'ONEBOT_HTTP_URL 和 ONEBOT_WS_URL 都被关掉了，没有可用的通道',
      hint: '至少留一个：ONEBOT_HTTP_URL=http://127.0.0.1:3000 或 ONEBOT_WS_URL=ws://127.0.0.1:3001。',
    });
  }

  const rawTransport = String(e.ONEBOT_TRANSPORT ?? 'auto').trim().toLowerCase();
  let transport = 'auto';
  if (rawTransport === 'http' || rawTransport === 'ws') transport = rawTransport;
  else if (rawTransport !== '' && rawTransport !== 'auto') {
    throw new Failure({
      kind: 'config',
      message: `ONEBOT_TRANSPORT 只接受 auto / http / ws，现在是 ${JSON.stringify(rawTransport)}`,
      hint: '删掉这个变量就是默认的 auto（HTTP 优先、连不上再退 WS）。',
    });
  }
  // 只配了一条通道时，auto 等于走那条
  if (transport === 'auto') {
    if (!httpUrl) transport = 'ws';
    else if (!wsUrl) transport = 'http';
  } else if (transport === 'http' && !httpUrl) {
    throw new Failure({
      kind: 'config',
      message: 'ONEBOT_TRANSPORT=http，但 ONEBOT_HTTP_URL 是空的',
      hint: '补上 ONEBOT_HTTP_URL，或者把 ONEBOT_TRANSPORT 改成 ws / auto。',
    });
  } else if (transport === 'ws' && !wsUrl) {
    throw new Failure({
      kind: 'config',
      message: 'ONEBOT_TRANSPORT=ws，但 ONEBOT_WS_URL 是空的',
      hint: '补上 ONEBOT_WS_URL，或者把 ONEBOT_TRANSPORT 改成 http / auto。',
    });
  }

  return { httpUrl, wsUrl, httpToken, wsToken, timeoutMs, readonly: isTrue(e.ONEBOT_READONLY), transport };
}

/** 给 token 打码后输出，日志/报错里永不见明文 */
export function maskToken(token) {
  if (!token) return '(未设置)';
  if (token.length <= 8) return `***(${token.length} 字符)`;
  return `${token.slice(0, 3)}***${token.slice(-2)}(共 ${token.length} 字符)`;
}

/** 启动时打一行配置摘要到 stderr，方便对线用的运气 */
export function describeConfig(cfg) {
  return [
    `http=${cfg.httpUrl ?? '(关闭)'}`,
    `ws=${cfg.wsUrl ?? '(关闭)'}`,
    `token=${maskToken(cfg.httpToken || cfg.wsToken)}`,
    `timeout=${cfg.timeoutMs}ms`,
    `readonly=${cfg.readonly}`,
    `transport=${cfg.transport}`,
  ].join(' ');
}
