/**
 * 路径基准测试。
 *
 * 守的是**编译产物才会暴露**的一类缺陷：源码里用「模块文件位置」推算路径，
 * `tsx` 直跑时恰好正确，编译到 `dist/src/` 后就指向错误位置，
 * 而失败方式是**静默回落默认值**——没有报错、服务照常启动。
 *
 * 实测到的两个实例（编译产物第一次运行就同时暴露）：
 *
 * | 位置 | 原实现（源码直跑正确） | 编译后实际指向 | 后果 |
 * |---|---|---|---|
 * | `.env` | `<root>/.env` | `dist/.env`（不存在） | 配置全部回落默认：默认模型「未配置」、配额 1000/日 → 30/日 |
 * | 前端产物目录 | `<root>/web/.output/public` | `dist/web/.output/public`（不存在） | 页面 404，但接口一切正常 |
 *
 * 因此这里的断言分两层：
 * 1. **值**：默认基准必须落在工作目录下（与 `DATA_DIR`/`PROMPTS_DIR` 一致）。
 * 2. **来源**：这些路径**不得由 `import.meta.url` 推算**——第 1 层断言在源码直跑下
 *    对错误的实现也成立（两者都等于 `<root>/…`），只有第 2 层能拦住「改回去」。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { dotEnvPath, storage } from '../src/config.ts';
import { webDir } from '../src/server/static.ts';

const ROOT = process.cwd();

test('.env 的位置由工作目录决定', () => {
  assert.equal(dotEnvPath(), join(ROOT, '.env'));
});

test('前端产物目录默认落在工作目录下的 web/.output/public', () => {
  // 测试进程未设 WEB_DIR，故走默认分支。
  // Nuxt 的静态产物在 `web/.output/public`（Vite 时代是 `web/dist`），
  // 这条断言绑定的是「后端默认去哪个目录找产物」，换前端框架必须同步改这里。
  assert.equal(webDir(), resolve(ROOT, 'web', '.output', 'public'));
});

test('数据目录基准同为工作目录（三处约定一致）', () => {
  // `./data` 是相对路径，与 `dotEnvPath()` / `webDir()` 的绝对路径等价：
  // 都表示「工作目录 = 项目根」。这里断言的是约定本身，不是实现细节。
  assert.equal(storage.dataDir, './data');
  assert.equal(resolve(ROOT, storage.dataDir), join(ROOT, 'data'));
});

test('路径基准不得由 import.meta.url 推算（编译后会指错且静默回落）', () => {
  const sources = ['../src/config.ts', '../src/server/static.ts'];
  for (const rel of sources) {
    const text = readFileSync(new URL(rel, import.meta.url), 'utf8');
    // 只关心「用模块位置拼路径」这一形态；日志/注释里的提及不算
    const offenders = text
      .split('\n')
      .map((line, i) => ({ line, no: i + 1 }))
      .filter(({ line }) => line.includes('import.meta.url') && !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'));

    assert.deepEqual(
      offenders.map((o) => `${rel}:${o.no}: ${o.line.trim()}`),
      [],
      '路径基准必须来自 process.cwd() 或环境变量，不能由模块文件位置推算',
    );
  }
});
