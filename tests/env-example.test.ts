/**
 * `.env.example` 与 `src/config.ts` 的一致性守门。
 *
 * ## 为什么值得单独守一条
 * 环境变量写错名字**不会有任何报错**——`env('RAG_INDEX_PATHS', ...)` 只是永远
 * 取到默认值。于是「文档里写了、实际不生效」这类问题只能靠人肉比对发现。
 *
 * 本测试从 `config.ts` 源码里抽出全部 `env(...)` / `envInt(...)` / `envBool(...)`
 * 的变量名，要求 `.env.example` 至少把每一个都提到一次（允许注释掉）。
 * 反向不检查：样例里可以出现配置代码里暂时没用的变量，但配置里新增而样例漏写
 * 就会红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CONFIG_SRC = new URL('../src/config.ts', import.meta.url);
const EXAMPLE = new URL('../.env.example', import.meta.url);

/** 抽出配置代码里读取的全部环境变量名 */
function configVars(): string[] {
  const src = readFileSync(CONFIG_SRC, 'utf8');
  const out = new Set<string>();
  const re = /\benv(?:Int|Bool)?\(\s*'([A-Z0-9_]+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    out.add(m[1]!);
  }
  return [...out].sort();
}

/** 抽出样例文件里出现的全部环境变量名（含被注释的行） */
function exampleVars(): Set<string> {
  const text = readFileSync(EXAMPLE, 'utf8');
  // 形如 `VAR=value`，行首允许 `#` 与空白（注释掉的也认，它仍是「提到过」）
  const re = /^\s*#?\s*([A-Z][A-Z0-9_]*)=/gm;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.add(m[1]!);
  }
  return out;
}

test('config.ts 读取的每个环境变量都在 .env.example 里有说明', () => {
  const declared = configVars();
  assert.ok(declared.length > 40, `抽取到的变量数异常（${declared.length}），正则可能失效`);

  const documented = exampleVars();
  const missing = declared.filter((v) => !documented.has(v));

  assert.deepEqual(
    missing,
    [],
    `以下变量在 src/config.ts 中被读取，但 .env.example 未提及：\n  ${missing.join('\n  ')}`,
  );
});

test('.env.example 不含任何明显不属于本服务的变量', () => {
  // 样例是从 config.ts 派生的；出现配置代码里读不到的名字通常是拼写错误，
  // 而拼写错误正是「文档写了却不生效」的成因。
  const declared = new Set(configVars());
  const extra = [...exampleVars()].filter((v) => !declared.has(v)).sort();
  assert.deepEqual(
    extra,
    [],
    `以下变量出现在 .env.example 但 src/config.ts 并未读取（疑似拼写错误）：\n  ${extra.join('\n  ')}`,
  );
});

test('.env.example 不包含真实的密钥值', () => {
  const text = readFileSync(EXAMPLE, 'utf8');
  // 只允许空值或明显是占位符的值
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m === null) continue;
    const [, name, value] = m as unknown as [string, string, string];
    // 只检查「值本身就是凭据」的变量。用 `_KEY` 结尾而非包含 `KEY`——
    // 否则 REDIS_KEY_PREFIX 这种名字里带 KEY 的普通配置会被误判。
    if (!/_(TOKEN|TOKENS|KEY|PASSWORD|SECRET)$/.test(name)) continue;
    assert.ok(
      value.trim() === '' || /^(changeme|xxx+|your-|\.\.\.|<.*>)/i.test(value.trim()),
      `${name} 疑似包含真实密钥，不应写进样例文件`,
    );
  }
});

/**
 * 守「测试不得读开发者本机 .env」。
 *
 * ## 这条守门是怎么来的（实测踩到过）
 * 给 `config.ts` 加 `.env` 支持后，`tests/quota.test.ts` 立刻挂了两项
 * （「上传配额低于直接提问」「会话轮次上限」）。
 * 成因：开发者的 `.env` 里放宽了配额，测试没显式设这两个变量，
 * 于是读到了本机值 —— 表现为「业务逻辑坏了」，实际是环境串味。
 *
 * 因此 `loadDotEnv()` 在测试进程里直接返回（见 `src/config.ts:isTestProcess`）。
 * 本测试在**有 .env 的机器上**会真实生效；在 CI（无 .env）上会跳过，
 * 这是刻意的不对称：它防的正是「只有开发机才有 .env」这种情形。
 */
test('测试进程不加载 .env（防环境串味）', async (t) => {
  const exampleDir = new URL('..', import.meta.url);
  let envText: string;
  try {
    envText = readFileSync(new URL('.env', exampleDir), 'utf8');
  } catch {
    t.skip('.env 不存在（CI 环境），本机无串味风险');
    return;
  }

  // 取 .env 里一个**测试不会主动设置**的变量作为哨兵
  const lines = envText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#') && l.includes('='));

  const sentinels: Array<[string, string]> = [];
  for (const line of lines) {
    const i = line.indexOf('=');
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (value === '') continue;
    // 只用测试绝不会碰的键，避免与其它测试文件的赋值冲突
    if (key !== 'ADMIN_TOKEN' && key !== 'PORT' && key !== 'DATA_DIR') continue;
    sentinels.push([key, value]);
  }

  assert.ok(sentinels.length > 0, '.env 里应至少有一个可用作哨兵的键');
  for (const [key, value] of sentinels) {
    assert.notEqual(
      process.env[key],
      value,
      `测试进程读到了 .env 的值（${key}=${value}）——loadDotEnv() 的测试进程跳过逻辑失效了`,
    );
  }
});
