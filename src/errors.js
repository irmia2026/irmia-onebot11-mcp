/**
 * 统一失败对象。
 *
 * 这里存在的唯一理由：**一次调用只可能有两种结局——成功、失败**，而失败必须带着"下一步干什么"
 * 回到调用方。所以本文件给「失败」定了死规矩：`kind` 说明是哪一类错，`message` 说人话，
 * `hint` 说可照做的补救动作，`detail` 放协议端的原话（wording / HTTP 状态 / 原始 error），
 * 但**绝不许把 kind==='onebot' 的失败包装成成功**——上层一律按失败上报。
 *
 * kind 取值：
 *   - 'config'   环境变量配错了（地址非法、超时非整数）
 *   - 'connect'  连不上（服务没起 / 端口不对 / 被防火墙挡）
 *   - 'auth'     access_token 不对或没配
 *   - 'address'  URL 的路径前缀不对（404 那种）
 *   - 'onebot'   协议端回了一条失败响应（retcode != 0）
 *   - 'timeout'  超过 ONEBOT_TIMEOUT_MS 没等到回包
 *   - 'param'    工具参数没通过本服务端的 JSON Schema 校验
 */
export class Failure extends Error {
  constructor({ kind, message, hint = '', detail = '', retcode = null, transport = null }) {
    super(message);
    this.name = 'Failure';
    this.kind = kind;
    this.message = message;
    this.hint = hint;
    this.detail = detail;
    this.retcode = retcode;
    this.transport = transport;
  }

  /** 拼成给 MCP 客户端看的一段话（工具失败时的正文） */
  toText() {
    const parts = [`[失败:${this.kind}] ${this.message}`];
    if (this.transport) parts.push(`传输：${this.transport}`);
    if (this.retcode !== null && this.retcode !== undefined) parts.push(`retcode=${this.retcode}`);
    if (this.detail) parts.push(`协议端原文：${this.detail}`);
    if (this.hint) parts.push(`怎么办：${this.hint}`);
    return parts.join('\n');
  }

  /** 转成抛给 MCP 客户端的 JSON-RPC 错误体（用于 tools/call 之外的场景） */
  toJsonRpc(code = -32000) {
    const payload = { code, message: this.message };
    if (this.hint) payload.message += ` ｜ 怎么办：${this.hint}`;
    return payload;
  }
}

/** Node 自带的 network error code → 人话 + 可照做的动作 */
export function explainNetworkError(error) {
  const cause = error?.cause ?? error;
  const code = String(cause?.code ?? error?.code ?? '');
  switch (code) {
    case 'ECONNREFUSED':
      return {
        message: '连不上：对方把连接拒了（ECONNREFUSED）',
        hint: '多半是 SnowLuma 没起、或端口不是这个。先看任务管理器里有没有 SnowLuma 进程；再看协议端 WebUI 里 HTTP 适配器是不是真的在这个端口上听。',
      };
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return {
        message: '连不上：主机名解析不了（DNS 失败）',
        hint: '把 ONEBOT_HTTP_URL / ONEBOT_WS_URL 的主机名写成 127.0.0.1 这种 IP，别写 host 名。',
      };
    case 'ECONNRESET':
      return {
        message: '连到一半被断开了（ECONNRESET）',
        hint: '协议端可能正在重启或被杀；等它起来再试。',
      };
    case 'ETIMEDOUT':
      return {
        message: '连不上：TCP 握手超时（ETIMEDOUT）',
        hint: '地址或端口不对，或者有防火墙挡着。确认是 127.0.0.1 而不是别的网段。',
      };
    case 'EPIPE':
      return { message: '写数据时管道断了（EPIPE）', hint: '协议端可能刚退出，重跑一次；反复出现去看协议端日志。' };
    case 'UND_ERR_CONNECT_TIMEOUT':
      return { message: '连不上：连接超时', hint: '同 ECONNREFUSED：确认协议端在这个地址上听（探针先 curl 一下那个 URL）。' };
    default:
      return {
        message: `连不上：${error?.message ?? String(error)}`,
        hint: '先确认 SnowLuma 在跑、ONEBOT_HTTP_URL / ONEBOT_WS_URL 写对了；两者都试一遍能排除是单个适配器没开。',
      };
  }
}
