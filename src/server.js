/**
 * MCP 服务端本体：stdio 上的 JSON-RPC 2.0。
 *
 * 两条刻在骨头上的纪律：
 *   ① **stdout 只许吐 JSON-RPC 消息**。多一个空格都算破坏协议 —— 所有日志走 stderr，
 *      所以这个文件里一处 console.log 都没有，`process.stdout.write` 也只出现在一个地方。
 *   ② **单个请求炸了不许把进程带崩**。任何异常都在各自的处理函数里被吃掉，
 *      转成 JSON-RPC 错误体吐回去（客户端要的是"这条失败的具体原因"，不是断开连接）。
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

import { loadConfig, describeConfig } from './config.js';
import { callAction, resetConnection } from './client.js';
import { Failure } from './errors.js';
import { TOOL_INDEX, auditTools, listTools } from './tools.js';
import { checkChoices, formatErrors, validateAgainst } from './validate.js';

const pkgUrl = new URL('../package.json', import.meta.url);
const PKG = JSON.parse(readFileSync(pkgUrl, 'utf8'));

const SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05'];
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

function log(...args) {
  process.stderr.write(`[onebot11-mcp] ${args.join(' ')}\n`);
}

// ── 写回都在这一处 ────────────────────────────────────────────────────
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function ok(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  send({ jsonrpc: '2.0', id, error });
}

const JSON_RPC_ERRORS = {
  parse: (id = null) => fail(id, -32700, '收到一段不是合法 JSON 的文本'),
  invalidRequest: (id = null, msg = '不是合法的 JSON-RPC 2.0 请求') => fail(id, -32600, msg),
  methodNotFound: (id, method) => fail(id, -32601, `不认识这个方法：${method}`),
  invalidParams: (id, message) => fail(id, -32602, message),
  internal: (id, message) => fail(id, -32603, message),
};

// ── tools/call 的主体 ─────────────────────────────────────────────────
/**
 * 返回 MCP 规定的 CallToolResult。**失败一定带 isError:true**，
 * 不会因为怕难看就把失败写成成功。
 */
async function callTool(name, rawArgs) {
  const tool = TOOL_INDEX.get(name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: 'text', text: `没有叫 ${name} 的工具。用 tools/list 看看有哪些。` }],
    };
  }

  // 1) 配置（每次调用重新读，出问题也好改）
  let cfg;
  try {
    cfg = loadConfig();
  } catch (error) {
    if (error instanceof Failure) return failureResult(error);
    return failureResult(new Failure({ kind: 'config', message: String(error?.message ?? error), hint: '检查 ONEBOT_* 环境变量。' }));
  }

  // 2) 只读模式下，有副作用的工具等于没注册
  if (cfg.readonly && !tool.readOnly) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text:
            `${name} 是会改状态的写操作，而当前 ONEBOT_READONLY=1，所以这个工具没有注册。\n` +
            '怎么办：把 ONEBOT_READONLY 去掉（或设成 0）重启本 MCP server，再调用。',
        },
      ],
    };
  }

  // 3) 参数校验：缺参、类型、多余字段、二选一、message_id != 0
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? { ...rawArgs } : {};
  const errors = [
    ...validateAgainst(tool.inputSchema, args, '参数'),
    ...checkChoices(args, tool.choices ?? []),
    ...checkAssertions(args, tool.assertions ?? []),
  ];
  if (errors.length > 0) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `${name} 的参数不对，已经拦下（没往协议端发）：\n${formatErrors(errors)}`,
        },
      ],
    };
  }

  // 4) 只把填了的参数发出去；默认值由协议端自己决定，不替它猜
  const params = {};
  for (const key of Object.keys(tool.inputSchema.properties ?? {})) {
    if (args[key] !== undefined) params[key] = args[key];
  }

  // 5) 真的调用
  try {
    const result = await callAction(cfg, tool.action, params);
    log(`${name} ok via ${result.transport}`);
    return {
      isError: false,
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true, action: tool.action, transport: result.transport, data: result.data }, null, 2),
        },
      ],
    };
  } catch (error) {
    const failure = error instanceof Failure ? error : new Failure({ kind: 'connect', message: String(error?.message ?? error), hint: '看协议端是否还活着。' });
    return failureResult(failure, tool.action);
  }
}

function failureResult(failure, action) {
  const text = failure.toText();
  const tail = action ? `\n（调用未产生任何效果：${action} 没有被协议端接受）` : '';
  log(`调用失败 kind=${failure.kind} ${failure.message}`);
  return { isError: true, content: [{ type: 'text', text: text + tail }] };
}

function checkAssertions(args, assertions) {
  const errors = [];
  for (const rule of assertions) {
    const value = args?.[rule.field];
    let bad = false;
    try {
      bad = rule.test ? rule.test(value, args) : value === 0;
    } catch {
      bad = true;
    }
    if (bad) errors.push({ path: rule.field, message: rule.message, hint: rule.hint });
  }
  return errors;
}

// ── 请求分发 ──────────────────────────────────────────────────────────
async function handleRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return JSON_RPC_ERRORS.invalidRequest(request?.id ?? null);
  const { id, method, params } = request;
  if (request.jsonrpc !== '2.0' || typeof method !== 'string') return JSON_RPC_ERRORS.invalidRequest(id ?? null);

  try {
    switch (method) {
      case 'initialize':
        return handleInitialize(id, params ?? {});

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null; // 通知不回包，这是协议规定

      case 'ping':
        return ok(id, {});

      case 'tools/list':
        return ok(id, { tools: listTools({ readonly: readReadonlyFlag() }) });

      case 'tools/call': {
        const name = params?.name;
        if (typeof name !== 'string' || !name) return JSON_RPC_ERRORS.invalidParams(id, 'tools/call 缺参数 name');
        const result = await callTool(name, params.arguments ?? {});
        return ok(id, { content: result.content, ...(result.isError ? { isError: true } : {}) });
      }

      case 'resources/list':
        return ok(id, { resources: [] });
      case 'resources/templates/list':
        return ok(id, { resourceTemplates: [] });
      case 'prompts/list':
        return ok(id, { prompts: [] });

      case 'shutdown':
        resetConnection();
        return ok(id, {});

      default:
        return JSON_RPC_ERRORS.methodNotFound(id, method);
    }
  } catch (error) {
    return JSON_RPC_ERRORS.internal(id, String(error?.message ?? error));
  }
}

function readReadonlyFlag() {
  try {
    return loadConfig().readonly;
  } catch {
    // 配错了也照样能列工具：让客户端先看得见、再改配置
    return false;
  }
}

function handleInitialize(id, params) {
  const requested = String(params?.protocolVersion ?? '');
  const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
  if (requested && !SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
    log(`客户端请求的 protocolVersion=${requested} 不在支持列表里，按 ${protocolVersion} 应答`);
  }
  return ok(id, {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'onebot11-mcp', version: PKG.version },
    instructions:
      'OneBot v11（SnowLuma）管理/查询类动作的 MCP 入口，只包"收发消息之外"的那些 action。' +
      '名字以 set_/send_/delete_ 开头的工具都会真实改动群或对方的状态，调用前务必确认群号与 QQ 号；' +
      'get_cookies / get_csrf_token 会吐出登录凭据，别把结果贴到别处。' +
      '所有失败都会原样带出 retcode 与协议端原话并以 isError:true 返回，不会假装成功。',
  });
}

// ── 主循环 ────────────────────────────────────────────────────────────
export async function run() {
  const problems = auditTools();
  if (problems.length > 0) {
    for (const p of problems) log(`工具表自检没过：${p}`);
  }
  try {
    log(`启动 v${PKG.version}｜${describeConfig(loadConfig())}`);
  } catch (error) {
    log(`启动失败于配置：${error instanceof Failure ? error.toText() : String(error?.message ?? error)}`);
  }
  log('stdio 通道就绪，等待 JSON-RPC 请求');

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let payload;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      JSON_RPC_ERRORS.parse(null);
      return;
    }

    // 批量请求：逐条处理，逐条回，顺序保持
    if (Array.isArray(payload)) {
      (async () => {
        for (const item of payload) {
          await handleRequest(item);
        }
      })().catch((error) => log(`批量请求处理失败：${error?.stack ?? error}`));
      return;
    }

    Promise.resolve(handleRequest(payload)).catch((error) => log(`请求处理失败：${error?.stack ?? error}`));
  });

  rl.on('close', () => {
    resetConnection();
    log('stdin 关闭，退出');
  });
}

/** 给 selfcheck 之类的内部调用用：只看配置是否成立，不发起网络连接 */
export function selfDiagnostic() {
  try {
    const cfg = loadConfig();
    return { ok: true, cfg };
  } catch (error) {
    return { ok: false, error };
  }
}
