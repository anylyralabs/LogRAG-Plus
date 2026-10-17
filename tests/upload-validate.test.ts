/**
 * 上传校验测试。
 *
 * 这些用例守的是**上传入口的边界**。校验层的价值不在于「拦住明显非法的请求」
 * （那部分 LogShare 也会拦），而在于：
 *  1. 在跨网转发**之前**拦住，避免白耗带宽与配额；
 *  2. 给出「哪个文件、超了多少」这类可操作提示；
 *  3. **拒绝路径类文件名**，不让 `../` 之类的构造进入下游存储层。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_CONTENT_BYTES,
  MAX_FILES,
  MAX_FILENAME_CHARS,
  isSafeFileName,
  validateUpload,
} from '../src/upload/validate.ts';

test('主日志：正常内容通过', () => {
  const r = validateUpload({ content: 'hello\nworld' });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.content, 'hello\nworld');
    assert.deepEqual(r.value.files, []);
  }
});

test('主日志：content 与 files 同时为空时拒绝', () => {
  const r = validateUpload({});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /没有可分析的日志内容/);
});

test('主日志：仅有附加文件（无正文）时通过', () => {
  const r = validateUpload({ files: [{ name: 'latest.log', data: 'line1\nline2' }] });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.content, '');
    assert.equal(r.value.files.length, 1);
  }
});

test('主日志：超过 10MB 拒绝', () => {
  const r = validateUpload({ content: 'x'.repeat(MAX_CONTENT_BYTES + 1) });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /超过上限/);
});

test('主日志：行数超过 50000 拒绝', () => {
  const r = validateUpload({ content: '\n'.repeat(50_001) });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /行超过上限/);
});

test('大小按 UTF-8 字节计（中文一字三字节）', () => {
  // 400 万个中文字符 = 12MB > 10MB，但字符数只有 400 万
  const bytes = Buffer.byteLength('中'.repeat(4_000_000), 'utf8');
  assert.ok(bytes > MAX_CONTENT_BYTES, '前提：该字符串确实超过 10MB');
  const r = validateUpload({ content: '中'.repeat(4_000_000) });
  assert.equal(r.ok, false, '若按字符数而非字节数计量，这里会误放行');
});

test('文件名：拒绝路径遍历', () => {
  for (const bad of ['../etc/passwd', 'a/b.log', '..', '.', 'a\\b.log']) {
    assert.equal(isSafeFileName(bad), false, `${bad} 应被拒绝`);
    const r = validateUpload({ files: [{ name: bad, data: 'x' }] });
    assert.equal(r.ok, false, `${bad} 应使整个请求被拒绝`);
  }
});

test('文件名：拒绝 NUL 与控制字符', () => {
  for (const bad of ['a\0b.log', 'a\nb.log', 'a\tb.log', 'a\x7fb.log']) {
    assert.equal(isSafeFileName(bad), false, `${JSON.stringify(bad)} 应被拒绝`);
  }
});

test('文件名：拒绝超长', () => {
  assert.equal(isSafeFileName('a'.repeat(MAX_FILENAME_CHARS)), true);
  assert.equal(isSafeFileName('a'.repeat(MAX_FILENAME_CHARS + 1)), false);
});

test('文件名：中文与常见符号可用', () => {
  for (const ok of ['latest.log', '崩溃报告.txt', 'hs_err_pid1234.log', 'a b-c_d.log']) {
    assert.equal(isSafeFileName(ok), true, `${ok} 应被接受`);
  }
});

test('附加文件：超过 200 个拒绝', () => {
  const files = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({
    name: `f${i}.log`,
    data: 'x',
  }));
  const r = validateUpload({ content: 'a', files });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /最多 200 个/);
});

test('附加文件：合计超过 12MB 拒绝', () => {
  // 注意：上限判定是 `>`，正好 12MB 应当放行。因此这里用 7MB × 2 = 14MB。
  const chunk = 'x'.repeat(7 * 1024 * 1024);
  const r = validateUpload({
    files: [
      { name: 'a.log', data: chunk },
      { name: 'b.log', data: chunk },
    ],
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /合计/);
});

test('附加文件：合计正好等于 12MB 时放行（边界不含等于）', () => {
  const chunk = 'x'.repeat(6 * 1024 * 1024);
  const r = validateUpload({
    files: [
      { name: 'a.log', data: chunk },
      { name: 'b.log', data: chunk },
    ],
  });
  assert.equal(r.ok, true, '上限语义是「不超过」，正好等于不该被拒');
});

test('空附加文件被忽略并给出提示（不是错误）', () => {
  const r = validateUpload({
    content: 'main',
    files: [
      { name: 'empty.log', data: '' },
      { name: 'real.log', data: 'x' },
    ],
  });
  assert.equal(r.ok, true, '夹带空文件是常见操作，不该导致整次上传失败');
  if (r.ok) {
    assert.equal(r.value.files.length, 1);
    assert.equal(r.value.files[0]?.name, 'real.log');
    assert.ok(r.notes.some((n) => n.includes('empty.log')));
  }
});

test('来源标识：合法格式保留', () => {
  const r = validateUpload({ content: 'x', source: 'fcl/1.3.4.0' });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.source, 'fcl/1.3.4.0');
});

test('来源标识：非法格式被丢弃但不阻断上传', () => {
  const r = validateUpload({ content: 'x', source: 'not a source!!' });
  assert.equal(r.ok, true, 'source 只影响分类统计，不该阻断上传');
  if (r.ok) {
    assert.equal(r.value.source, '');
    assert.ok(r.notes.some((n) => n.includes('来源标识')));
  }
});

test('类型错误：逐项报出可定位的错误', () => {
  assert.equal(validateUpload(null).ok, false);
  assert.equal(validateUpload([]).ok, false);
  assert.equal(validateUpload({ content: 123 }).ok, false);
  assert.equal(validateUpload({ files: 'nope' }).ok, false);
  assert.equal(validateUpload({ files: [null] }).ok, false);
  assert.equal(validateUpload({ files: [{ name: 'a.log' }] }).ok, false);
  assert.equal(validateUpload({ files: [{ name: 1, data: 'x' }] }).ok, false);
});

test('类型错误：报出是第几个文件出错（可定位）', () => {
  const r = validateUpload({
    files: [
      { name: 'ok.log', data: 'x' },
      { name: '../evil.log', data: 'x' },
    ],
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /files\[1\]/, '应指出具体是第几个文件');
});

test('校验不修改入参（无副作用）', () => {
  const input = { content: 'x', files: [{ name: 'a.log', data: 'y' }], source: 'fcl/1.0' };
  const snapshot = JSON.stringify(input);
  validateUpload(input);
  assert.equal(JSON.stringify(input), snapshot);
});
