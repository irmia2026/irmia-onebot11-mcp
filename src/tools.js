/**
 * 27 个工具的唯一定义表。
 *
 * ⚠️ 参数签名**不是照 OneBot 官方文档抄的**，而是照 SnowLuma 实际实现的 action 表核的。
 * 差别举例：
 *   · 官方 `set_group_leave` 有 is_dismiss，SnowLuma **没有**；
 *   · 官方 `set_friend_add_request` 有 remark，SnowLuma **没有**；
 *   · SnowLuma 的 `get_forward_msg` 的 id / message_id 都是**字符串**，不是整数；
 *   · `set_group_card` 用的键是 `card`，`set_group_name` 是 `group_name`。
 *
 * 被刻意排除的一项：**set_restart** —— 它在 SnowLuma 里是个显式写死的空壳
 * （调用只会返回"不支持"），按"协议端不支持就不做"的原则剔除，
 * 宁可少给一个工具也不给一个必定失败的工具。
 *
 * 每条工具的三个标记：
 *   readOnly  —— true 时 ONEBOT_READONLY=1 下仍然注册；false 会被摘掉
 *   risk      —— 'read' 只读 / 'write' 会改状态 / 'credential' 只读但会吐凭据
 *   choices   —— JSON Schema 表达不了的"二选一"约束
 */

// ── 可复用的属性片段 ──────────────────────────────────────────────────
const PROP = {
  groupId: {
    type: 'integer',
    minimum: 1,
    description: '目标群号。用 get_group_list 取真实值，别凭记忆填',
  },
  userId: {
    type: 'integer',
    minimum: 1,
    description: '目标成员的 QQ 号',
  },
  noCache: {
    type: 'boolean',
    description: 'true=跳过协议端缓存、向 QQ 重新拉一次（更慢但更准），默认 false',
  },
  flagFriend: {
    type: 'string',
    minLength: 1,
    description: '申请事件的 flag：来自好友申请事件，是一次性句柄，别自己编',
  },
};

/** 生成一个标准 inputSchema */
function schema(properties, required = []) {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

const EMPTY_SCHEMA = schema({});

/** get_image / get_record / get_forward_msg 共用的"二选一"约束 */
const ID_OR_FILE = {
  keys: ['file', 'file_id'],
  message: 'file 和 file_id 至少要传一个',
  hint: '有图片的 file id 就传 file_id；只有文件名/缓存名就传 file。',
};
const ID_OR_FILE_EXCLUSIVE = { ...ID_OR_FILE, exclusive: true };

// ── 工具表 ────────────────────────────────────────────────────────────
export const TOOLS = [
  // ══ 查询类：只读 ═════════════════════════════════════════════════
  {
    name: 'get_login_info',
    action: 'get_login_info',
    readOnly: true,
    risk: 'read',
    description: '查询当前登录 QQ 的昵称与 QQ 号。只读，不改任何状态。',
    inputSchema: EMPTY_SCHEMA,
  },
  {
    name: 'get_status',
    action: 'get_status',
    readOnly: true,
    risk: 'read',
    description: '查询 OneBot 运行状态与收发统计。只读。',
    inputSchema: EMPTY_SCHEMA,
  },
  {
    name: 'get_version_info',
    action: 'get_version_info',
    readOnly: true,
    risk: 'read',
    description: '查询协议端版本与应用名。只读。',
    inputSchema: EMPTY_SCHEMA,
  },
  {
    name: 'get_friend_list',
    action: 'get_friend_list',
    readOnly: true,
    risk: 'read',
    description: '拉取全部好友列表。只读；好友多时结果会很长。',
    inputSchema: EMPTY_SCHEMA,
  },
  {
    name: 'get_group_list',
    action: 'get_group_list',
    readOnly: true,
    risk: 'read',
    description: '拉取已加入的群列表。只读；no_cache=true 强制刷新。',
    inputSchema: schema({ no_cache: PROP.noCache }),
  },
  {
    name: 'get_group_info',
    action: 'get_group_info',
    readOnly: true,
    risk: 'read',
    description: '按群号查群资料（群名、人数等）。只读。',
    inputSchema: schema({ group_id: PROP.groupId, no_cache: PROP.noCache }, ['group_id']),
  },
  {
    name: 'get_group_member_list',
    action: 'get_group_member_list',
    readOnly: true,
    risk: 'read',
    description: '拉某个群的成员列表。只读；大群一次几百上千条。',
    inputSchema: schema({ group_id: PROP.groupId, no_cache: PROP.noCache }, ['group_id']),
  },
  {
    name: 'get_group_member_info',
    action: 'get_group_member_info',
    readOnly: true,
    risk: 'read',
    description: '查指定 QQ 在某个群里的资料（名片、角色等）。只读。',
    inputSchema: schema({ group_id: PROP.groupId, user_id: PROP.userId, no_cache: PROP.noCache }, ['group_id', 'user_id']),
  },
  {
    name: 'get_msg',
    action: 'get_msg',
    readOnly: true,
    risk: 'read',
    description: '按 message_id 取一条消息的原文与发送者。只读。',
    inputSchema: schema(
      {
        message_id: {
          type: 'integer',
          description: '消息 id（不能是 0），来自事件里的 message_id',
        },
      },
      ['message_id'],
    ),
    assertions: [
      {
        field: 'message_id',
        message: 'message_id 不能是 0',
        hint: '0 不是有效消息 id（它是"这条不存在"的占位），请从真实消息事件里取值。',
      },
    ],
  },
  {
    name: 'get_forward_msg',
    action: 'get_forward_msg',
    readOnly: true,
    risk: 'read',
    description: '取合并转发中的内容；id 或 message_id 传一个即可。只读。',
    inputSchema: schema({
      id: { type: 'string', description: '转发消息的 id（字符串形态）' },
      message_id: { type: 'string', description: '转发消息的 message_id（字符串形态）' },
    }),
    choices: [
      {
        keys: ['id', 'message_id'],
        message: 'id 和 message_id 至少要传一个',
        hint: '两个都有的话只传 id；从转发消息的 data.id 或事件里的 message_id 取。',
        exclusive: true,
      },
    ],
  },
  {
    name: 'get_image',
    action: 'get_image',
    readOnly: true,
    risk: 'read',
    description: '取图片信息与下载地址；file 或 file_id 传一个。只读。',
    inputSchema: schema({
      file: { type: 'string', description: '图片文件名/缓存名' },
      file_id: { type: 'string', description: '图片的 file_id（优先用这个）' },
    }),
    choices: [ID_OR_FILE_EXCLUSIVE],
  },
  {
    name: 'get_record',
    action: 'get_record',
    readOnly: true,
    risk: 'read',
    description: '取语音信息；out_format 可转码。file/file_id 传一个。只读。',
    inputSchema: schema({
      file: { type: 'string', description: '语音文件名/缓存名' },
      file_id: { type: 'string', description: '语音的 file_id（优先用这个）' },
      out_format: {
        type: 'string',
        enum: ['mp3', 'amr', 'wma', 'm4a', 'spx', 'ogg', 'wav', 'flac'],
        description: '要转成的格式；不传就只给信息不转码',
      },
    }),
    choices: [ID_OR_FILE_EXCLUSIVE],
  },
  {
    name: 'get_cookies',
    action: 'get_cookies',
    readOnly: true,
    risk: 'credential',
    description: '取指定域名的 Cookie。等于交出登录凭据，别往群里或日志里贴。',
    inputSchema: schema({
      domain: { type: 'string', description: '域名，默认 qun.qq.com', default: 'qun.qq.com' },
    }),
  },
  {
    name: 'get_csrf_token',
    action: 'get_csrf_token',
    readOnly: true,
    risk: 'credential',
    description: '取 CSRF Token（bkn）。属于登录凭据，别外传。',
    inputSchema: EMPTY_SCHEMA,
  },

  // ══ 管理类：会改状态 ═════════════════════════════════════════════
  {
    name: 'delete_msg',
    action: 'delete_msg',
    readOnly: false,
    risk: 'write',
    description: '撤回一条已发出去的消息。会改变会话状态：消息会被抹掉。',
    inputSchema: schema(
      {
        message_id: {
          type: 'integer',
          description: '要撤回的消息 id；两分钟内的消息才有机会撤回成功',
        },
      },
      ['message_id'],
    ),
    assertions: [
      {
        field: 'message_id',
        message: 'message_id 不能是 0',
        hint: '0 不是有效消息 id，撤回不了任何东西。',
      },
    ],
  },
  {
    name: 'set_group_kick',
    action: 'set_group_kick',
    readOnly: false,
    risk: 'write',
    description: '把成员踢出群。会改变对方的状态，且不可撤销。',
    inputSchema: schema(
      {
        group_id: PROP.groupId,
        user_id: PROP.userId,
        reject_add_request: {
          type: 'boolean',
          description: 'true=同时拒绝他以后再加群，默认 false',
        },
      },
      ['group_id', 'user_id'],
    ),
  },
  {
    name: 'set_group_ban',
    action: 'set_group_ban',
    readOnly: false,
    risk: 'write',
    description: '禁言群成员（秒），0=解除禁言。会改变对方的状态。',
    inputSchema: schema(
      {
        group_id: PROP.groupId,
        user_id: PROP.userId,
        duration: {
          type: 'integer',
          minimum: 0,
          xHint: 'duration 是秒数：0=解除禁言，不传默认 1800（30 分钟）。负值一律拦下，别用负数表示"解除"。',
          description: '禁言时长（秒）；0 表示解除，不传默认 1800（30 分钟）',
        },
      },
      ['group_id', 'user_id'],
    ),
  },
  {
    name: 'set_group_whole_ban',
    action: 'set_group_whole_ban',
    readOnly: false,
    risk: 'write',
    description: '开或关全员禁言。会改变整个群的状态。',
    inputSchema: schema(
      {
        group_id: PROP.groupId,
        enable: { type: 'boolean', description: 'true=开启全员禁言，false=关闭，默认 true' },
      },
      ['group_id'],
    ),
  },
  {
    name: 'set_group_admin',
    action: 'set_group_admin',
    readOnly: false,
    risk: 'write',
    description: '设置或取消管理员。会改变对方在该群的权限。',
    inputSchema: schema(
      {
        group_id: PROP.groupId,
        user_id: PROP.userId,
        enable: { type: 'boolean', description: 'true=设为管理员，false=取消，默认 true' },
      },
      ['group_id', 'user_id'],
    ),
  },
  {
    name: 'set_group_card',
    action: 'set_group_card',
    readOnly: false,
    risk: 'write',
    description: '改成员的群名片，传空串可清除。会改变对方在该群的展示。',
    inputSchema: schema(
      {
        group_id: PROP.groupId,
        user_id: PROP.userId,
        card: { type: 'string', maxLength: 60, description: '新名片；传空字符串等于清掉自定义名片' },
      },
      ['group_id', 'user_id'],
    ),
  },
  {
    name: 'set_group_name',
    action: 'set_group_name',
    readOnly: false,
    risk: 'write',
    description: '改群名。会改变整个群的状态，所有人可见。',
    inputSchema: schema(
      {
        group_id: PROP.groupId,
        group_name: { type: 'string', minLength: 1, maxLength: 60, description: '新群名' },
      },
      ['group_id', 'group_name'],
    ),
  },
  {
    name: 'set_group_leave',
    action: 'set_group_leave',
    readOnly: false,
    risk: 'write',
    description: '退出指定群。会改变群的状态，退了得重新加。',
    inputSchema: schema({ group_id: PROP.groupId }, ['group_id']),
  },
  {
    name: 'set_group_special_title',
    action: 'set_group_special_title',
    readOnly: false,
    risk: 'write',
    description: '设置成员专属头衔，空串清除。会改变对方在群里的称谓。',
    inputSchema: schema(
      {
        group_id: PROP.groupId,
        user_id: PROP.userId,
        special_title: { type: 'string', maxLength: 18, description: '新头衔；传空字符串等于清除' },
      },
      ['group_id', 'user_id'],
    ),
  },
  {
    name: 'set_friend_add_request',
    action: 'set_friend_add_request',
    readOnly: false,
    risk: 'write',
    description: '同意或拒绝好友申请。会改变双方的好友关系。',
    inputSchema: schema(
      {
        flag: PROP.flagFriend,
        approve: { type: 'boolean', description: 'true=同意，false=拒绝，默认 true' },
      },
      ['flag'],
    ),
  },
  {
    name: 'set_group_add_request',
    action: 'set_group_add_request',
    readOnly: false,
    risk: 'write',
    description: '同意或拒绝加群申请。会改变群的成员构成。',
    inputSchema: schema(
      {
        flag: {
          type: 'string',
          minLength: 1,
          description: '申请事件的 flag：来自加群申请事件，是一次性句柄',
        },
        sub_type: { type: 'string', description: '申请类型：add=申请入群，invite=被邀请人；不传按 add 处理' },
        type: { type: 'string', description: '同 sub_type 的老写法，两者都没有时按 add' },
        approve: { type: 'boolean', description: 'true=同意，false=拒绝，默认 true' },
        reason: { type: 'string', maxLength: 200, description: '拒绝时给对方的理由，同意时忽略' },
      },
      ['flag'],
    ),
  },
  {
    name: 'send_like',
    action: 'send_like',
    readOnly: false,
    risk: 'write',
    description: '给好友点赞，默认 1 次。会改变对方的点赞数。',
    inputSchema: schema(
      {
        user_id: { type: 'integer', minimum: 1, description: '要点赞的 QQ 号（通常得是好友）' },
        times: { type: 'integer', minimum: 0, description: '点赞次数，默认 1；QQ 有每日上限' },
      },
      ['user_id'],
    ),
  },
  {
    name: 'set_group_sign',
    action: 'set_group_sign',
    readOnly: false,
    risk: 'write',
    description: '在指定群打卡签到。会留下你的签到记录。',
    inputSchema: schema({ group_id: PROP.groupId }, ['group_id']),
  },
];

// ── 索引与注册 ────────────────────────────────────────────────────────
export const TOOL_INDEX = new Map(TOOLS.map((t) => [t.name, t]));

/** 供 selfcheck 用的自检：description 长度、readOnly 与命名一致性 */
export function auditTools() {
  const problems = [];
  const seen = new Set();
  for (const t of TOOLS) {
    if (seen.has(t.name)) problems.push(`工具名重复：${t.name}`);
    seen.add(t.name);
    if (t.description.length > 100) problems.push(`${t.name} 的 description ${t.description.length} 字符，超过 100`);
    if (t.readOnly && !/^(get_)/.test(t.name)) problems.push(`${t.name} 标了 readOnly 但名字不是 get_ 开头`);
    if (!t.readOnly && !/^(set_|send_|delete_)/.test(t.name)) problems.push(`${t.name} 有副作用但名字不像写操作`);
    if (t.readOnly && t.risk === 'write') problems.push(`${t.name} 只读却标了 write 风险`);
    const required = t.inputSchema.required ?? [];
    for (const key of required) {
      if (!(key in t.inputSchema.properties)) problems.push(`${t.name} 必填参数 ${key} 不在 properties 里`);
    }
  }
  return problems;
}

/** MCP tools/list 的结果；ONEBOT_READONLY=1 时剥掉所有副作用工具 */
export function listTools({ readonly = false } = {}) {
  const visible = readonly ? TOOLS.filter((t) => t.readOnly) : TOOLS;
  return visible.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: stripExtensions(t.inputSchema),
  }));
}

/**
 * 只在内部使用的扩展关键字（如给"低于最小值"配的专属提示 xHint）不对外暴露：
 * 客户端拿到的是一份干净的、标准 JSON Schema。
 */
function stripExtensions(schema) {
  const clone = JSON.parse(JSON.stringify(schema));
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    delete node.xHint;
    for (const value of Object.values(node.properties ?? {})) walk(value);
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') walk(value);
    }
  };
  walk(clone);
  return clone;
}
