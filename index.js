#!/usr/bin/env node
/**
 * onebot11-mcp —— 把 SnowLuma（OneBot v11）里"除收发消息之外"的那批 action 包成 MCP 工具。
 *
 * 入口要求：**必须能 `node <绝对路径>/index.js` 直接跑起来**（Windows 上尤其如此，
 * 这里刻意不用 npx、不依赖 *.cmd、不需要任何 npm install）。
 *
 * stdout 从此刻起只归 JSON-RPC 所有 —— 包括报错在内的一切日志都写 stderr。
 */
import process from 'node:process';

import { run } from './src/server.js';

const [major, minor] = process.versions.node.split('.').map((n) => Number.parseInt(n, 10) || 0);
if (major < 22 || (major === 22 && minor < 4)) {
  process.stderr.write(
    `[onebot11-mcp] 警告：当前 Node 是 ${process.versions.node}。低于 22.4.0 没有内置 WebSocket，` +
      '正向 WS 那条路会走不了（HTTP 还能用）。建议升级到 Node 22 LTS 或更高。\n',
  );
}

process.on('uncaughtException', (error) => {
  process.stderr.write(`[onebot11-mcp] 未捕获异常：${error?.stack ?? error}\n`);
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[onebot11-mcp] 未处理的 Promise 拒绝：${reason?.stack ?? reason}\n`);
});

await run();
