# irmia-onebot11-mcp

> **适配 I.R.M.I.A 框架的 OneBot 协议功能补充 MCP —— 目前仅适配 SnowLuma。**

把 **SnowLuma（OneBot v11 协议端）** 里**除了收发消息之外**的那批 action 包成 **MCP 工具**：
查登录号 / 群 / 成员 / 消息 / 凭据，以及踢人、禁言、改群名片、改群名、退群、处理加好友与加群申请等管理操作。

- **协议**：MCP over **stdio**（JSON-RPC 2.0，`protocolVersion` = `2024-11-05`）
- **依赖**：**零运行时依赖** —— 只用 Node 22 内置的 `fetch` 与 `WebSocket`，**不需要 `npm install`**
- **纪律**：**stdout 只输出协议消息**，一切日志走 stderr（改代码时别破这条）
- **配置**：只走**环境变量**；`access_token` 不落盘、不打印（日志里打码）

> **它刻意不碰"收发消息"。** `send_msg` / `send_group_msg` / `send_private_msg` / `send_forward_msg`
> 一类一个都没有 —— 发消息是框架主链自己那件事，本服务只做**收发之外**的查询与管理。
>
> **目前只适配 SnowLuma。** 它按 SnowLuma 的 action 表与返回话术核过，**不保证**与其他 OneBot v11
> 实现（NapCat / Lagrange / go-cqhttp 等）逐字段同形。

---

## 一、它是什么 / 为什么会有它

I.R.M.I.A 框架自己负责**收发消息**那半条链路（会话、唤醒、已读、平台消息 id…）。
可 OneBot 协议里还有**另一半**：那些"**收发之外**"的 action —— 查这个登录号是谁、群里有谁、
某条消息原文是什么，以及踢人 / 禁言 / 改名片 / 退群 / 批申请这类**会真的动到别人或群**的管理动作。

这一半不适合塞进框架主链（它们是**按需调用**的运维面，且风险等级完全不同），
所以做成一个**独立的 MCP server**：框架按需拉起它、按需调用其中的一件工具，
权限与风险都收在"模型决定要不要调这一件"这一层。

**与框架的关系**：I.R.M.I.A 通过 `config.json` 的 `mcp.servers` 声明它，
模型侧通过框架的 `mcp` 工具访问（不带 `server` 看全部、带 `server` 看它的工具清单、
`server + tool` 就是调用）。

---

## 二、前置条件

| 项 | 要求 |
| --- | --- |
| Node | **≥ 22.4.0**（低于这个版本没有内置 `WebSocket`，只能用 HTTP 那条路，启动时会打印警告） |
| SnowLuma | 已在跑，且**至少开了一条**：HTTP 适配器（默认 `http://127.0.0.1:3000`）或正向 WS（默认 `ws://127.0.0.1:3001`） |
| 鉴权 | 知道对应适配器的 `access_token`（HTTP 与 WS 是**两份独立生成**的令牌） |

---

## 三、环境变量

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `ONEBOT_ACCESS_TOKEN` | **是** | 无 | 两条通道令牌相同时就用它 |
| `ONEBOT_HTTP_URL` | 否 | `http://127.0.0.1:3000` | HTTP 适配器地址；设 `none` 表示这条不用 |
| `ONEBOT_WS_URL` | 否 | `ws://127.0.0.1:3001` | 正向 WS 地址；设 `none` 表示这条不用 |
| `ONEBOT_HTTP_ACCESS_TOKEN` | 否 | 同上 | HTTP 与 WS 令牌不一致时覆盖 HTTP 那条 |
| `ONEBOT_WS_ACCESS_TOKEN` | 否 | 同上 | 同上，覆盖 WS 那条 |
| `ONEBOT_TIMEOUT_MS` | 否 | `10000` | 单次调用超时（毫秒，正整数） |
| `ONEBOT_READONLY` | 否 | 空 | `=1` 时**只注册查询类工具**，写操作一个都不出现在 `tools/list` 里 |
| `ONEBOT_TRANSPORT` | 否 | `auto` | `auto`（HTTP 优先，连不上才退 WS）/ `http` / `ws` |

**降级规则**：只有"连不上 / 超时 / 路径不对"才换另一条通道；
协议端**明确回了失败**（鉴权失败、参数错、目标不存在…）**不换路重试** —— 那是对结果的判决，换条路只是把同一个错再犯一遍。

> WS 那条只能走 `?access_token=` 查询参数形态：Node 内置 `WebSocket` 不支持自定义握手头。
> URL 里**不要**加 `/api` 一类路径前缀，根路径（`Universal` 角色）就能既收事件又调 API。

---

## 四、跑起来

```bash
# 任意平台（Windows PowerShell / Git Bash / Linux / macOS 同理）
export ONEBOT_ACCESS_TOKEN="<你的适配器令牌>"
node "<本仓库绝对路径>/index.js"
```

Windows PowerShell 等价写法：

```powershell
$env:ONEBOT_ACCESS_TOKEN = "<你的适配器令牌>"
node "<本仓库绝对路径>\index.js"
```

刻意**不用 `npx`、不依赖 `*.cmd`**：`node <绝对路径>/index.js` 就够了（Windows 上尤其如此）。

起来以后它**什么都不打印，只在等 stdin**。看到下面两行 stderr 说明活着：

```
[onebot11-mcp] 启动 v1.0.0｜http=http://127.0.0.1:3000 ws=ws://127.0.0.1:3001 token=AbC***yz(共 32 字符) timeout=10000ms readonly=false transport=auto
[onebot11-mcp] stdio 通道就绪，等待 JSON-RPC 请求
```

想单独验一下协议层通不通，手敲一行也行（回包是 JSON）：

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node "<本仓库绝对路径>/index.js"
```

### 只想看、不想改？

```bash
export ONEBOT_READONLY=1
node "<本仓库绝对路径>/index.js"      # 此时 tools/list 只会列出 14 个 get_* 工具
```

只读模式下调用写操作**不会被"假装执行"**，而是直接告诉调用方它没注册：

```
set_group_kick 是会改状态的写操作，而当前 ONEBOT_READONLY=1，所以这个工具没有注册。
怎么办：把 ONEBOT_READONLY 去掉（或设成 0）重启本 MCP server，再调用。
```

---

## 五、接进 I.R.M.I.A（以及别的 MCP 客户端）

### 5.1 接进 I.R.M.I.A

在 I.R.M.I.A 的 `config.json` 里加一条 `mcp.servers`（**本项目实际被使用的接法就是这样**）：

```json
{
  "mcp": {
    "servers": [
      {
        "name": "onebot11-mcp",
        "command": "<node.exe 绝对路径>",
        "args": ["<本仓库绝对路径>\\index.js"],
        "env": {
          "ONEBOT_HTTP_URL": "http://127.0.0.1:3000",
          "ONEBOT_WS_URL": "ws://127.0.0.1:3001",
          "ONEBOT_HTTP_ACCESS_TOKEN": "<HTTP 适配器令牌>",
          "ONEBOT_WS_ACCESS_TOKEN": "<WS 适配器令牌>",
          "ONEBOT_TIMEOUT_MS": "10000"
        },
        "desc": "OneBot v11 里「收发消息之外」的那批 action：查登录号/群/成员/消息，以及踢人、禁言、改群名片、退群等管理操作。"
      }
    ]
  }
}
```

要点：

- `command` 用 **node.exe 的绝对路径**（`where node` / `which node` 拿），`args` 是**本仓库 `index.js` 的绝对路径**；
- `env` 里放令牌。**令牌只写在这里**，别写进任何会被 git 跟踪的文件；
- 加完 server 之后，模型侧用框架的 `mcp` 工具就能看到它的工具清单（框架会把"已见 N 件工具"记进上下文索引）；
- 只想给它只读权限：在 `env` 里加 `"ONEBOT_READONLY": "1"`。

### 5.2 接进别的 MCP 客户端

外层键名常见的是 `mcpServers`（WorkBuddy / Claude Code / Cursor 等）：

```json
{
  "mcpServers": {
    "onebot11": {
      "command": "<node.exe 绝对路径>",
      "args": ["<本仓库绝对路径>\\index.js"],
      "env": {
        "ONEBOT_HTTP_URL": "http://127.0.0.1:3000",
        "ONEBOT_WS_URL": "ws://127.0.0.1:3001",
        "ONEBOT_ACCESS_TOKEN": "<粘贴你的令牌>",
        "ONEBOT_TIMEOUT_MS": "10000"
      }
    }
  }
}
```

改完**重启客户端**才生效。Claude Desktop 的配置在 `%APPDATA%\Claude\claude_desktop_config.json`。

---

## 六、工具一览与风险

一共 **27 件**。

### 查询类（14 件，只读）

| 工具 | 干什么 | 注意 |
| --- | --- | --- |
| `get_login_info` | 查当前登录账号的昵称与号 | 排查链路的第一步 |
| `get_status` | 查协议端运行状态与收发统计 | 判断"还是活的吗" |
| `get_version_info` | 查协议端版本与应用名 | |
| `get_friend_list` | 拉好友列表 | 好友多时结果很长 |
| `get_group_list` | 拉已加入的群列表 | `no_cache=true` 强制刷新（更慢更准） |
| `get_group_info` | 查群资料（群名 / 人数等） | |
| `get_group_member_list` | 拉群成员列表 | 大群一次几百上千条 |
| `get_group_member_info` | 查某成员在群里的资料 | |
| `get_msg` | 按 `message_id` 取一条消息原文 | `message_id` 不能是 0 |
| `get_forward_msg` | 取合并转发里的内容 | `id` / `message_id` 传一个，**都是字符串** |
| `get_image` | 取图片信息与下载地址 | `file` / `file_id` 传一个 |
| `get_record` | 取语音信息，可 `out_format` 转码 | 带 base64 时响应可能很大 |
| `get_cookies` | 取指定域名的 Cookie | ⚠ **会吐出登录凭据**，别贴到别处 |
| `get_csrf_token` | 取 CSRF Token（bkn） | ⚠ **会吐出登录凭据**，别贴到别处 |

### 管理类（13 件，会改状态 —— 全部高危）

| 工具 | 干什么 | 副作用 / 风险 |
| --- | --- | --- |
| `delete_msg` | 撤回一条已发消息 | **改会话状态**；一般只有两分钟内有效 |
| `set_group_kick` | 把成员踢出群 | **改对方状态**，不可撤销 |
| `set_group_ban` | 禁言群成员（秒），`duration=0` 解除 | **改对方状态**；不传默认 1800 秒 |
| `set_group_whole_ban` | 开 / 关全员禁言 | **改整个群的状态**；`enable` 不传默认 true |
| `set_group_admin` | 设 / 撤管理员 | **改对方权限**；需要群主身份 |
| `set_group_card` | 改群名片（空串清除） | **改对方在该群的展示** |
| `set_group_name` | 改群名 | **改整个群的状态**，所有人可见 |
| `set_group_leave` | 退出群 | **改群状态**，退了要重新加 |
| `set_group_special_title` | 设专属头衔（空串清除） | **改对方称谓** |
| `set_friend_add_request` | 同意 / 拒绝好友申请 | **改双方好友关系**；`flag` 是事件里的一次性句柄 |
| `set_group_add_request` | 同意 / 拒绝加群申请 | **改群成员构成**；`flag` 同上 |
| `send_like` | 给好友点赞（默认 1 次） | **改对方点赞数**；有每日上限 |
| `set_group_sign` | 群签到打卡 | **留下你的签到记录** |

一句话：**名字不是 `get_` 开头的，都会真的动到别人或群里去。**
每件工具的 description 里都写明了"会改变对方或群的状态"，让模型在调用前有机会刹车。

---

## 七、失败怎么报

**失败一定说失败。** 只要 `retcode !== 0` 或 `status === 'failed'`，`tools/call` 的结果就是
`isError: true`，并带上 `retcode`、`kind`、协议端原话与"怎么办"，绝不含糊地当成成功。

| `kind` | 什么时候 | 典型提示 |
| --- | --- | --- |
| `param` | 参数没过 JSON Schema | 缺必填 / 类型不对 / 多写了协议端不认的字段（会猜你是不是想写别的键） |
| `config` | 环境变量配错 | URL 非法、`ONEBOT_TIMEOUT_MS` 不是正整数、两条通道都关了 |
| `connect` | 连不上 | `ECONNREFUSED`（服务没起或端口不对）、DNS 失败、被重置 |
| `auth` | 令牌不对 | HTTP 401 / WS 被 1008 踢 —— 提醒 HTTP 与 WS 是**两份令牌** |
| `address` | URL 路径不对 | HTTP 404：协议端有它期望的路径，跟 URL 前缀对不上 |
| `onebot` | 协议端回了失败 | 见下表 |
| `timeout` | 超时没回包 | 建议调大 `ONEBOT_TIMEOUT_MS` |

### retcode 对照

| retcode | 含义 | 怎么办 |
| --- | --- | --- |
| `0` | 成功 | —— |
| `100` | 动作没做成（ACTION_FAILED） | 协议端吞一切业务失败的总出口；看 wording：多半是**权限不足**或目标不对 |
| `1200` | 协议端内部错误 | 不是参数问题；看协议端日志，重试大概率还是这条 |
| `1400` | 请求格式不对 | 缺必填 / 类型不对 / HTTP 方法错了 |
| `1401` | **令牌不对或没给**（unauthorized） | 检查环境变量有没有真的设上、值有没有首尾空格、HTTP 与 WS 是不是两份令牌 |
| `1403` | 被拒绝（denied） | 通常权限不足：这个操作要管理员 / 群主 |
| `1404` | 目标不存在，或这个 action 不认 | 先用 `get_group_list` 核群号；也可能是协议端没实现 |

除了 retcode，还会从协议端的**人工话术**（`wording`）里再做一层关键词判读，把四类情况直接点出来：
**权限不足 / 目标不存在 / 频率限制 / 未登录** —— 因为协议端的原话常常比 retcode 更具体
（同样是 `100`，可能是"权限不足"，也可能是"被风控"）。

---

## 八、自测

```bash
export ONEBOT_ACCESS_TOKEN="<你的令牌>"
node "<本仓库绝对路径>/selfcheck.js"
```

它会**真的把 `index.js` 当子进程拉起来**，用 stdio 走一遍完整协议，然后对着协议端跑两个真查询：

```
── 1. 握手（initialize） ───────
通过  protocolVersion 是 2024-11-05：2024-11-05
通过  serverInfo 回来了：onebot11-mcp@1.0.0
── 2. 工具清单（tools/list） ───
通过  工具数量等于 27：实际 27
通过  不支持的 set_restart 确实没注册：已剔除
── 3. 参数围栏 ─────────────────
通过  缺/写错参数时 isError=true 且没打到协议端
── 4. 真跑 gets ────────────────
   我：<昵称>（<号>）｜ via http
   共 N 个群｜ via http
```

**退出码 0 = 全过，非 0 = 有失败项**（缺 token、服务没起、工具数不对都会是非 0，并把原因打清楚）。
⚠ 它打印的是**真实数据**，别把那段输出贴到公开的地方。

---

## 九、几个刻意的取舍（也算自查记录）

1. **`set_restart` 不做。** 它在适配目标里是显式写死的空壳（调用只会返回"不支持"）。
   按"协议端不支持就不做"的原则剔除 —— 宁可少给一件工具，也不给一件**百分百失败**的工具。
2. **参数签名按目标协议端的 action 表核，而不是照 OneBot 官方文档抄。** 已知差异举例：
   `set_group_leave` **没有** `is_dismiss`；`set_friend_add_request` **没有** `remark`；
   `get_forward_msg` 的两个 id 是**字符串**；`set_group_card` 的键是 `card`、`set_group_name` 是 `group_name`。
3. **可选的默认值不替协议端猜。** 调用方没传的参数就不发，由协议端套它自己的默认值。
4. **数字允许字符串传进来。** 手写 JSON 时 `12345` 与 `"12345"` 太容易混，做一次宽松转换；
   但**缺参 / 多传 / 类型完全不对**一律照错处理。
5. **不做频率限制、不做偷偷重试。** 限速是协议端 / 平台侧的事，本服务只把"被限速了"这句人话原样带回 ——
   偷偷重试会把一次失败放大成一场雪崩。
6. **失败不包装成成功**（见第七节）：`kind === 'onebot'` 的失败绝不许被上层当成成功。

---

## 十、它不做的事

- 不读不写任何配置文件（只从进程环境变量读配置）；
- 不打印、不落盘、不提交 `access_token`（日志里一律打码成 `AbC***yz(共 32 字符)`）；
- **不收发消息** —— 不做 `send_*` 一类；也不做登录 / 扫码 / 事件订阅；
- 不实现协议端自己都没实现的 action；
- 目前**只适配 SnowLuma**，不对其他 OneBot v11 实现做兼容承诺。

---

## 十一、许可与致谢

- **许可证：AGPL-3.0**（GNU Affero General Public License v3.0）—— 全文见 [LICENSE](LICENSE)。
  本项目是 **I.R.M.I.A 项目的一部分**，与主仓库同许可。
- **本项目代码为原创**：零运行时依赖，没有引入或改写任何第三方库的代码
  （只用 Node 内置的 `fetch` 与 `WebSocket`）。
- **致谢 [SnowLuma](https://github.com/SnowLuma/SnowLuma)**：它是本项目的**适配目标**，
  其 OneBot v11 协议端实现与 action 表是参数签名与返回话术的依据。
  **本项目不包含它的任何代码**，与它之间只是"客户端 ↔ 协议端"的关系。
- 致谢 [OneBot v11 标准](https://github.com/botuniverse/onebot-11)：工具命名与语义以此为共同语言。
