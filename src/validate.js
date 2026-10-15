/**
 * 一个够用的 JSON Schema 校验器（零依赖）。
 *
 * 只实现 tools 用到的那几个关键字：type / enum / minimum / maximum / minLength /
 * maxLength / properties / required / additionalProperties / items / format(整数校验)。
 * 少做的好处是"错就是真错"，不会出现自己都解释不清的行为。
 *
 * 两条刻意的宽松（都记日志）：
 *   1) 整数/数字位接受纯数字字符串 —— MCP 客户端（尤其手写 JSON 的）经常把 12345 传成 "12345"，
 *      为这个判失败太蠢；
 *   2) 布尔位接受 "true"/"false" 字符串。
 * 但**只改值、不改结构**：多的字段、缺的必填，一律照真错处理，并把"多出来的那个参数名"
 * 写进提示里 —— 这正是最常见的踩坑点（比如把 group_name 写成 name）。
 */

const TYPE_NAMES = {
  object: '对象',
  array: '数组',
  string: '字符串',
  number: '数字',
  integer: '整数',
  boolean: '布尔值',
  null: 'null',
};

/**
 * 那点刻意的宽松：把 "12345" 这种纯字符串转成数字、"true"/"false" 转成布尔。
 * 返回 null 表示"不需要转"（该报错的由 type 分支管）。
 */
function tryCoerce(schema, value) {
  const expected = Array.isArray(schema?.type) ? schema.type : schema.type ? [schema.type] : [];
  if (expected.length === 0) return null;
  const actual = typeOf(value);
  if (expected.includes(actual)) return null;
  if (expected.includes('integer') && isInteger(value)) return Number(String(value).trim());
  if (expected.includes('number') && toNumber(value) !== null) return toNumber(value);
  if (expected.includes('boolean') && typeof value === 'string' && /^(true|false)$/i.test(value.trim())) {
    return value.trim().toLowerCase() === 'true';
  }
  return null;
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isFinite(value)) return 'number';
  return typeof value;
}

function isInteger(value) {
  if (typeof value === 'number') return Number.isInteger(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return true;
  return false;
}

function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value.trim()))) return Number(value.trim());
  return null;
}

/**
 * 返回 [{path, message, hint}]，空数组代表通过。
 * 同时把宽松 coercion 过的值写进 `value`（object 就地改），调用方直接用改过的那份。
 */
export function validateAgainst(schema, value, path = '参数') {
  const errors = [];
  const push = (message, hint) => errors.push({ path, message, hint });

  if (!schema || typeof schema !== 'object') return errors;

  // ── type ────────────────────────────────────────────────────────────
  const expected = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (expected.length > 0) {
    const actual = typeOf(value);
    const coerced = tryCoerce(schema, value);

    if (!expected.includes(actual)) {
      if (coerced === null) {
        const names = expected.map((t) => TYPE_NAMES[t] ?? t).join(' 或 ');
        push(`${path} 应该是 ${names}，实际是 ${TYPE_NAMES[actual] ?? actual}（${JSON.stringify(value)}）`, '按工具描述里的类型重传。');
        return errors;
      }
      value = coerced;
    } else if (expected.includes('integer') && actual === 'number' && !Number.isInteger(value)) {
      push(`${path} 得是整数，不能是小数（${value}）`, '去掉小数部分，或换个整数值（例如 QQ 号、群号都不能带小数点）。');
      return errors;
    }
  }

  // ── enum ────────────────────────────────────────────────────────────
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && !schema.enum.includes(value)) {
    push(`${path} 只能是：${schema.enum.join(' / ')}，你传的是 ${JSON.stringify(value)}`, '从上面这几个值里挑一个。');
  }

  // ── 字符串长度 ──────────────────────────────────────────────────────
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      push(`${path} 至少 ${schema.minLength} 个字符（现在 ${value.length}）`, '空字符串不行，这个参数必须有内容。');
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      push(`${path} 最多 ${schema.maxLength} 个字符（现在 ${value.length}）`, '截短一点再传（QQ 的头衔/名片有长度上限）。');
    }
  }

  // ── 数值范围 ────────────────────────────────────────────────────────
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      // 允许 schema 自带更贴切的一句提示，没写就用通用的那句
      const hint = schema.xHint ?? '群号/QQ 号从 1 起，message_id 不能是 0，不能填负数。';
      push(`${path} 最小 ${schema.minimum}（现在是 ${value}）`, hint);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      push(`${path} 最大 ${schema.maximum}（现在是 ${value}）`, '超出协议端能接受的上限，换个值。');
    }
  }

  // ── 对象：required / properties / additionalProperties ──────────────
  if (schema.type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const props = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) {
        errors.push({
          path: `${path}.${key}`,
          message: `缺少必填参数 ${key}`,
          hint: describeRequired(key, props[key]),
        });
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (value[key] === undefined) continue;
      // 宽松转换必须**写回实参**：否则"通过了校验"却把字符串原样发给协议端，
      // 等于校验器撒了个谎 —— 协议端那边就会拿不合规则的类型去报错
      const coerced = tryCoerce(sub, value[key]);
      if (coerced !== null) value[key] = coerced;
      errors.push(...validateAgainst(sub, value[key], `${path}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) {
          const guess = suggestKey(key, Object.keys(props));
          errors.push({
            path: `${path}.${key}`,
            message: `多了一个协议端不认的参数：${key}`,
            hint: guess ? `你是不是想写 ${guess}？这个工具只接受：${Object.keys(props).join(', ')}。` : `这个工具只接受：${Object.keys(props).join(', ')}。`,
          });
        }
      }
    }
  }

  return errors;
}

function describeRequired(key, propSchema) {
  if (!propSchema) return `补上 ${key}。`;
  const type = propSchema.type ?? '值';
  if (propSchema.description) return `${key}（${propSchema.description}）是必填的，类型是 ${TYPE_NAMES[type] ?? type}。`;
  return `补上 ${key}，类型 ${TYPE_NAMES[type] ?? type}。`;
}

/** 拼写相近的候选，用来给"多出来的参数"一个像样的提示 */
function suggestKey(actual, candidates) {
  const lower = actual.toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const key of candidates) {
    const k = key.toLowerCase();
    if (k === lower) return key;
    if (k.includes(lower) || lower.includes(k)) return key;
    let score = 0;
    for (let i = 0; i < Math.min(k.length, lower.length); i += 1) if (k[i] === lower[i]) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = key;
    }
  }
  return bestScore >= 3 ? best : null;
}

/**
 * 互斥/二选一校验：至少一个选项存在。
 * @param {object} value 实参
 * @param {Array<{keys:string[], message:string, hint:string}>} rules
 */
export function checkChoices(value, rules) {
  const errors = [];
  for (const rule of rules) {
    const present = rule.keys.filter((k) => value?.[k] !== undefined && value?.[k] !== '');
    if (present.length === 0) errors.push({ path: rule.keys.join('|'), message: rule.message, hint: rule.hint });
    if (present.length > 1 && rule.exclusive) {
      errors.push({ path: rule.keys.join('|'), message: `${rule.keys.join(' 和 ')} 只用传一个`, hint: `留 ${present[0]} 就行。` });
    }
  }
  return errors;
}

export function formatErrors(errors) {
  return errors.map((e) => `- ${e.message}${e.hint ? `\n  怎么办：${e.hint}` : ''}`).join('\n');
}
