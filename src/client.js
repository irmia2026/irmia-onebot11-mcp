/**
 * 调谁的手续（transport）。两条路，一条 HTTP 一条正向 WebSocket，都是 Node 22 自带的
 * （全局 fetch + 全局 WebSocket），**零第三方依赖**。
 *
 * 为什么两条都要：
 *   · SnowLuma 的 HTTP 与正向 WS 是**两个各自独立的适配器**，令牌也各生成一份；
 *     只留一条，另一条挂了就整个 MCP 全瞎。
 *   · 但是 WS 有一个硬限制：Node 内置的 WebSocket **不支持自定义握手头**， SnowLuma
 *     认的是 `Authorization: Bearer` 或 `?access_token=`，所以 WS 只能走 query 形态。
 *
 * 选路的规矩（ONEBOT_TRANSPORT=auto 时）：
 *   1. 先走 HTTP；
 *   2. 只有「连不上」这种传输层错误才降级到 WS —— **协议端回了失败不算**（比如鉴权失败、
 *      参数错、目标不存在），那是对结果的判决，换条路重发只是把同一个错再犯一遍，
 *      还可能真把它做成两遍；
 *   3. 两条都试过了还不行，就把两次的原因一起摆出来。
 */
import { randomUUID } from 'node:crypto';

import { Failure, explainNetworkError } from './errors.js';
import { explainFailure, explainHttpStatus } from './translate.js';

/** 这种错才是"换条通道再试试"的理由 */
function isTransportDown(error) {
  return error instanceof Failure && (error.kind === 'connect' || error.kind === 'timeout' || error.kind === 'address');
}

function isNetworkError(error) {
  const code = error?.cause?.code ?? error?.code;
  return error instanceof TypeError || Boolean(code);
}

// ── HTTP ──────────────────────────────────────────────────────────────
/**
 * POST `${base}/${action}`，Bearer 鉴权。
 * SnowLuma 认这两种都可以：Authorization 头、URL 上的 ?access_token=；这里用前者，
 * 免得 token 出现在 URL 里被日志顺手记下来。
 */
async function callViaHttp(cfg, action, params) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  let res;
  try {
    res = await fetch(`${cfg.httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.httpToken ? { Authorization: `Bearer ${cfg.httpToken}` } : {}),
      },
      body: JSON.stringify({ action, params }),
      keepalive: false,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw new Failure({
        kind: 'timeout',
        transport: 'http',
        message: `HTTP 调用 ${action} 超过 ${cfg.timeoutMs}ms 没有回包`,
        hint: '协议端忙到超时，或者后端这条 action 卡住了。把 ONEBOT_TIMEOUT_MS 调大一点再试；一直这样去看协议端日志。',
      });
    }
    if (isNetworkError(error)) {
      const why = explainNetworkError(error);
      throw new Failure({
        kind: 'connect',
        transport: 'http',
        message: `${why.message}（${cfg.httpUrl}）`,
        hint: why.hint,
        detail: String(error?.cause?.code ?? error?.code ?? error?.message ?? error),
      });
    }
    throw new Failure({
      kind: 'connect',
      transport: 'http',
      message: `HTTP 调用失败：${error?.message ?? String(error)}`,
      hint: '确认 ONEBOT_HTTP_URL 写的是 HTTP 适配器的地址（默认 http://127.0.0.1:3000）。',
    });
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 200) {
    let json;
    try {
      json = await res.json();
    } catch {
      throw new Failure({
        kind: 'onebot',
        transport: 'http',
        message: '协议端回了 200，但响应体不是合法 JSON',
        hint: '多半是 URL 打到了别的服务的网页上。检查 ONEBOT_HTTP_URL 的端口是不是被别的东西占了。',
      });
    }
    return unwrap(action, json, 'http');
  }

  // 非 200：先按 HTTP 状态码说人话
  const { text, hint } = explainHttpStatus(res.status);
  let retcode = null;
  let wording = '';
  try {
    const body = await res.json();
    retcode = body?.retcode ?? null;
    wording = String(body?.wording ?? '');
  } catch {
    /* 响应体不是 JSON 也认，状态码已经够说明问题了 */
  }
  const kind = res.status === 401 || res.status === 403 ? 'auth' : res.status === 404 ? 'address' : 'onebot';
  throw new Failure({
    kind,
    transport: 'http',
    retcode,
    message: `${text}${wording ? `｜${wording}` : ''}（${cfg.httpUrl}/${action}）`,
    hint,
    detail: wording || `HTTP ${res.status}`,
  });
}

/**
 * 判定成功或失败：**retcode===0 且 status 不是 failed 才算成功**。
 * 两边只要有一个说失败，就按失败报 —— 绝不含糊地把失败当成功返回。
 */
function unwrap(action, json, transport) {
  if (!json || typeof json !== 'object') {
    throw new Failure({
      kind: 'onebot',
      transport,
      message: `协议端对 ${action} 的响应是空的或格式不对`,
      hint: '看协议端日志，多半是那条 action 内部炸了。',
    });
  }
  const retcode = Number.isFinite(Number(json.retcode)) ? Number(json.retcode) : null;
  const ok = retcode === 0 && json.status !== 'failed';
  if (ok) return { data: json.data ?? null, echo: json.echo ?? null, retcode: 0, transport };

  const { text, hint } = explainFailure({ retcode, wording: json.wording, status: json.status });
  throw new Failure({
    kind: 'onebot',
    transport,
    retcode,
    message: `${action} 没做成：${text}`,
    hint,
    detail: json.wording ? String(json.wording) : `status=${json.status}`,
  });
}

// ── 正向 WebSocket ────────────────────────────────────────────────────
/** 复用同一条 WS 连接：握手一次，之后每个动作靠 echo 配对回包 */
let wsState = null;

function rejectBadToken(reason) {
  return /access ?token|unauthor|1008/i.test(String(reason ?? ''));
}

async function ensureWs(cfg) {
  if (wsState?.socket && wsState.socket.readyState === 1 && wsState.url === cfg.wsUrl) return wsState;

  if (typeof WebSocket === 'undefined') {
    throw new Failure({
      kind: 'connect',
      transport: 'ws',
      message: '当前 Node 没有内置 WebSocket',
      hint: '换成 Node >= 22.4.0（`node -v` 看一眼），或者在环境变量里只留 ONEBOT_HTTP_URL、把 ONEBOT_WS_URL 设成 none。',
    });
  }

  const url = new URL(cfg.wsUrl);
  if (cfg.wsToken) url.searchParams.set('access_token', cfg.wsToken);
  // 注意别往 URL 上加 /api 路径：那条是"纯 API、不订阅事件"的分支，
  // 而 SnowLuma 校验的是 expectedPath，路径对不上会被直接拒。根路径就是万能的 Universal 角色。
  const target = url.toString();
  const socket = new WebSocket(target);

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* 关闭失败就算了 */
      }
      reject(
        new Failure({
          kind: 'timeout',
          transport: 'ws',
          message: `WS 握手超过 ${Math.min(cfg.timeoutMs, 5000)}ms 没有完成`,
          hint: '端口在听但不是 WebSocket（比如你填成了 HTTP 的 3000），或者协议端卡住了。WS 默认是 3001，别填反。',
        }),
      );
    }, Math.min(cfg.timeoutMs, 5000));

    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener('error', (event) => {
      clearTimeout(timer);
      const detail = String(event?.message ?? '');
      // 握手本身就没被接受（401/非 101 响应）时，协议端不会给你 Reason，
      // 只会留下一句 "non-101" —— 这种几乎全是令牌问题，别让它看起来像网络故障
      const handshakeRejected = /non-101|401|unauthor|access ?token/i.test(detail);
      reject(
        new Failure({
          kind: handshakeRejected ? 'auth' : 'connect',
          transport: 'ws',
          message: handshakeRejected
            ? `WS 握手就没被接受：协议端没同意这次升级（${cfg.wsUrl}）`
            : `WS 握手失败：${detail || '连不上'}（${cfg.wsUrl}）`,
          hint: handshakeRejected
            ? cfg.wsToken
              ? '令牌不对。去协议端 WebUI 复制 WS 适配器「那一份」令牌（HTTP 和 WS 是两份各自生成的），别带首尾空格；确认不同就用 ONEBOT_WS_ACCESS_TOKEN 分开配。'
              : '你没设 ONEBOT_ACCESS_TOKEN，但这路的 WS 适配器是要令牌的。把令牌填进 ONEBOT_ACCESS_TOKEN（或只对 WS 用 ONEBOT_WS_ACCESS_TOKEN）再试。'
            : '确认 ONEBOT_WS_URL 是正向 WS 的地址（默认 ws://127.0.0.1:3001），且协议端开了这一路；别把它填成 HTTP 的 3000。',
          detail,
        }),
      );
    });
    socket.addEventListener('close', (event) => {
      clearTimeout(timer);
      if (rejectBadToken(event.reason)) {
        reject(
          new Failure({
            kind: 'auth',
            transport: 'ws',
            message: 'WS 连接刚建就被关闭：令牌不对',
            hint: '去协议端 WebUI 把 WS 适配器那一份令牌复制出来；复制时别把首尾空格带上，也别用成 HTTP 那份。',
            detail: `close=${event.code} ${event.reason}`,
          }),
        );
      }
    });
  });

  const state = { socket, url: cfg.wsUrl, listeners: new Map() };
  socket.addEventListener('message', (event) => {
    let frame;
    try {
      frame = JSON.parse(String(event.data ?? ''));
    } catch {
      return; // 心跳/meta_event 之类不是 JSON 的，直接忽略
    }
    if (!frame || typeof frame !== 'object') return;
    const echo = frame.echo;
    if (echo && state.listeners.has(String(echo))) {
      // 只有带着我们发的 echo 的那一条才是回包，其他都是事件，别管
      const settle = state.listeners.get(String(echo));
      state.listeners.delete(String(echo));
      settle(frame);
    }
  });
  socket.addEventListener('close', () => {
    wsState = null;
    for (const settle of state.listeners.values()) {
      settle(null);
    }
    state.listeners.clear();
  });

  await ready;
  wsState = state;
  return state;
}

async function callViaWs(cfg, action, params) {
  const state = await ensureWs(cfg);
  const echo = randomUUID();

  const pending = new Promise((resolve) => {
    state.listeners.set(echo, resolve);
    const timer = setTimeout(() => {
      state.listeners.delete(echo);
      resolve('__timeout__');
    }, cfg.timeoutMs);
    // 超时把计时器清掉，省得挂在 event loop 上
    void timer.unref?.();
  });

  try {
    state.socket.send(JSON.stringify({ action, params, echo }));
  } catch (error) {
    throw new Failure({
      kind: 'connect',
      transport: 'ws',
      message: `WS 发送失败：${error?.message ?? String(error)}`,
      hint: '连接已经断了（协议端刚退出？）。重跑一次会自动重连。',
    });
  }

  const frame = await pending;
  if (frame === '__timeout__') {
    throw new Failure({
      kind: 'timeout',
      transport: 'ws',
      message: `WS 调用 ${action} 超过 ${cfg.timeoutMs}ms 没有回包`,
      hint: '协议端没答话：可能在忙、账号掉线了，或者这条 action 它不认（不认的时候它有可能只给 1404、也可能压根不回）。可以先跑一遍 get_status 确认链路活着。',
    });
  }
  if (frame === null) {
    wsState = null;
    throw new Failure({
      kind: 'connect',
      transport: 'ws',
      message: `WS 连接在等 ${action} 的回包时断了`,
      hint: '协议端可能重启或被关闭了。重跑一次会自动重连；反复断开看协议端自身日志。',
    });
  }
  return unwrap(action, frame, 'ws');
}

// ── 对外唯一入口 ──────────────────────────────────────────────────────
/**
 * @returns {Promise<{data:unknown, retcode:number, transport:'http'|'ws'}>}
 * @throws {Failure}
 */
export async function callAction(cfg, action, params) {
  const attempts = [];

  if (cfg.transport !== 'ws' && cfg.httpUrl) {
    try {
      return await callViaHttp(cfg, action, params);
    } catch (error) {
      if (!isTransportDown(error)) throw error;
      attempts.push(error);
      logTransportFallback('http', error);
    }
  }

  if (cfg.transport !== 'http' && cfg.wsUrl) {
    try {
      return await callViaWs(cfg, action, params);
    } catch (error) {
      attempts.push(error);
    }
  }

  if (attempts.length === 0) {
    throw new Failure({
      kind: 'config',
      message: `没有任何可用通道能调 ${action}`,
      hint: 'ONEBOT_HTTP_URL / ONEBOT_WS_URL 至少配一个，别两个都设成 none。',
    });
  }

  const first = attempts[0];
  if (attempts.length === 1) throw first;

  const summary = attempts.map((e) => `[${e.transport}] ${e.message}`).join('；');
  const kind = attempts.every((e) => e.kind === 'auth') ? 'auth' : attempts.every((e) => e.kind === 'connect') ? 'connect' : 'onebot';
  const hint =
    kind === 'auth'
      ? attempts[0].hint
      : 'HTTP 和 WS 两条路都不通。先确认 SnowLuma 在跑（任务管理器/http://localhost:5099），再确认两个端口（默认 3000/3001）跟 ONEBOT_HTTP_URL / ONEBOT_WS_URL 对得上。';
  throw new Failure({
    kind,
    transport: 'http+ws',
    message: `${action} 两条路都没走通：${summary}`,
    hint,
    detail: attempts.map((e) => e.detail).filter(Boolean).join(' | '),
  });
}

function logTransportFallback(from, error) {
  process.stderr.write(`[onebot11-mcp] ${from} 通道不通（${error.kind}：${error.message}），降级到 ${from === 'http' ? 'ws' : 'http'}\n`);
}

/** 测试用：把上次复用的 WS 连接清掉 */
export function resetConnection() {
  try {
    wsState?.socket?.close();
  } catch {
    /* ignore */
  }
  wsState = null;
}

