/**
 * 把 OneBot 的 retcode 翻成人话。
 *
 * 表里的四个码是**对着 SnowLuma 的实现核过的**：
 * `ACTION_FAILED=100 / INTERNAL_ERROR=1200 / BAD_REQUEST=1400 / UNKNOWN_ACTION=1404`；
 * HTTP 鉴权失败走 `401 + retcode 1401 + wording 'unauthorized'`。
 * 没见过的码不乱编：一律标「协议端返回了未收录的 retcode」，把原话带回去。
 *
 * 另外 SnowLuma 那条人工话术（wording）往往比 retcode 更具体，所以这里再做一层
 * 关键词分类，把需求里点名的四种情况挑出来：**权限不足 / 目标不存在 / 频率限制 / 未登录**。
 */
const RETCODES = {
  0: { name: '成功', hint: '' },
  100: {
    name: '动作没做成（ACTION_FAILED）',
    hint: '这是协议端吞了一切业务失败的总出口。往 wording 里找具体原因：多半是**权限不足**（我不是管理员/我不是群主）、目标不在群里、或者 QQ 侧直接拒了。',
  },
  1200: {
    name: '协议端内部错误（INTERNAL_ERROR）',
    hint: '不是你的参数问题。看协议端自己的日志（SnowLuma WebUI 的日志页）；重发一次大概率还是这条。',
  },
  1400: {
    name: '请求格式不对（BAD_REQUEST）',
    hint: '缺必填参数、类型不对、或者 HTTP 方法用错了。对照工具的 JSON Schema 再传一次。',
  },
  1401: {
    name: 'access_token 不对或没给（unauthorized）',
    hint: '检查 ONEBOT_ACCESS_TOKEN：1) 环境变量真的设上了（换成 `-- ${process.pid}` 那种新 shell 会丢）；2) 值和协议端 WebUI 里那个适配器显示的令牌一字不差；3) HTTP 和 WS 是两个**各自独立**的令牌，不一致就用 ONEBOT_HTTP_ACCESS_TOKEN / ONEBOT_WS_ACCESS_TOKEN 分开配。',
  },
  1403: {
    name: '被拒绝（denied）',
    hint: '通常是**权限不足**：这个操作要管理员或群主身份，当前登录的号不够格。',
  },
  1404: {
    name: '目标不存在，或这个 action 协议端不认（UNKNOWN_ACTION）',
    hint: '两种可能：① 群号/QQ 号/message_id 写错或已失效；② 这个 action 在 SnowLuma 里没实现。用 get_group_list 核一次真实群号。',
  },
};

/** 关键词 → 需求点名的四类失败；命中就在正文里点出来 */
const WORDING_RULES = [
  { re: /(权限|permission|denied|forbidden|no right|not admin|管理员|群主)/i, tag: '权限不足' },
  { re: /(频率|频繁|rate.?limit|too many|slow down|429|limited)/i, tag: '触发频率限制' },
  { re: /(未登录|离线|下线|not logged|login first|offline|请先登录|sign in)/i, tag: '账号未登录' },
  { re: /(不存在|not found|查无|无此|unknown|没有找到|已失效|过期)/i, tag: '目标不存在' },
  { re: /(风控|risk.?control|打击)/i, tag: '命中风控' },
  { re: /(超时|timeout|timed out)/i, tag: '超时' },
  { re: /(不支持|not supported|unsupported|尚未实现|未实现)/i, tag: '协议端未支持' },
];

/**
 * @param {{retcode?:number, wording?:string, status?:string, transport?:string}} resp
 * @returns {{text:string, hint:string, tags:string[], retcode:number|null}}
 */
export function explainFailure(resp) {
  const retcode = Number.isFinite(Number(resp?.retcode)) ? Number(resp.retcode) : null;
  const wording = String(resp?.wording ?? '').trim();
  const known = retcode === null ? null : RETCODES[retcode];

  const tags = [];
  for (const rule of WORDING_RULES) {
    if (wording && rule.re.test(wording) && !tags.includes(rule.tag)) tags.push(rule.tag);
  }

  let text;
  if (known) {
    text = `${known.name}（retcode=${retcode}）`;
  } else if (retcode === null) {
    text = '协议端回了一条没有 retcode 的响应';
  } else {
    text = `协议端返回了未收录的 retcode=${retcode}`;
  }
  if (tags.length > 0) text += `，判读为：${tags.join('+')}`;
  if (wording) text += `｜协议端原话：${wording}`;

  let hint = known?.hint ?? '';
  if (tags.includes('权限不足')) hint = '先确认这个号在群里有没有对应权限：禁言/踢人要管理员，转让/解散要群主。权限不够就别重试，改由有权限的号执行。';
  else if (tags.includes('触发频率限制')) hint = '被限速了。间隔几秒到几十秒再试；刚才是同一动作连发的话，把它排到后面去，别重试雪崩。';
  else if (tags.includes('账号未登录')) hint = 'QQ 账号掉线了。去协议端 WebUI 看一眼登录状态/扫码；没登录时所有查询也会空。';
  else if (tags.includes('目标不存在')) hint = '拿 get_group_list / get_group_member_list 核一次真实群号和 QQ 号，别用记忆里的旧号。';
  else if (tags.includes('命中风控')) hint = '被风控拦了，短时间内同方向操作都会失败。先停手，隔一阵再说。';
  else if (tags.includes('协议端未支持')) hint = '这个动作在 SnowLuma 里没实现，换别的工具或用协议端自家的 WebUI 做。';

  return { text, hint, tags, retcode };
}

/** HTTP 状态码先于 OneBot retcode 生效时的翻译 */
export function explainHttpStatus(status) {
  switch (status) {
    case 401:
      return { text: 'HTTP 401：access_token 不匹配', hint: '检查 ONEBOT_ACCESS_TOKEN 的值与前缀（Bearer 后一个空格，不要换行符），另外别把 sample 里的空格粘进去。' };
    case 403:
      return { text: 'HTTP 403：被拒绝', hint: 'token 对但不允许，多半是 HTTP 适配器限制了来源；看协议端配置。' };
    case 404:
      return { text: 'HTTP 404：路径不对', hint: 'ONEBOT_HTTP_URL 里多/少了路径前缀（协议端有个「expected path」配置），改成协议端显示的那个完整地址。' };
    case 405:
      return { text: 'HTTP 405：方法不允许', hint: '协议端那条路由只接受 POST/GET 的一个，通常是 URL 写错落到别的路由上了。' };
    case 503:
      return { text: 'HTTP 503：协议端正在关闭或还没就绪', hint: '协议端在重启/退出中，等它起来再调用。' };
    default:
      return { text: `HTTP ${status}`, hint: '看协议端日志里对应那一行的原因。' };
  }
}
