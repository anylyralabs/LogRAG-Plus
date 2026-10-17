/**
 * 输出净化测试。
 *
 * 核心用例来自生产实测的**真实缺陷**：
 * `KUetpQq`（overall=94）的答案中泄漏了 `[system: empty tool message processed, continue]`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { StreamingSanitizer, hasInternalMarkers, sanitizeOutput } from '../src/agent/sanitize.ts';

test('移除 production 实测的泄漏标记', () => {
  // KUetpQq 的真实形态
  const text = `我需要先查看日志后半部分（582-1018行），确认真正的错误在哪里。

[system: empty tool message processed, continue]

让我查看文件末尾部分。`;

  const r = sanitizeOutput(text);
  assert.ok(!r.text.includes('empty tool message'));
  assert.ok(!r.text.includes('[system:'));
  assert.ok(r.text.includes('我需要先查看日志后半部分'));
  assert.ok(r.text.includes('让我查看文件末尾部分'));
  assert.deepEqual(r.removed, ['empty-tool-message']);
});

test('过滤器不影响正常文本', () => {
  const text = '这份日志显示模组缺失前置。[这是一个正常的方括号内容] 请安装它。';
  const r = sanitizeOutput(text);
  assert.equal(r.text, text);
  assert.deepEqual(r.removed, []);
});

test('大小写不敏感', () => {
  const r = sanitizeOutput('text [SYSTEM: EMPTY TOOL MESSAGE PROCESSED, CONTINUE] more');
  assert.ok(!r.text.includes('EMPTY TOOL'));
});

test('移除后清理多余空行', () => {
  const text = 'A段\n\n[system: empty tool message processed, continue]\n\nB段';
  const r = sanitizeOutput(text);
  assert.ok(!r.text.includes('\n\n\n'), '不应留下连续空行');
  assert.ok(r.text.includes('A段') && r.text.includes('B段'));
});

test('hasInternalMarkers 检测', () => {
  assert.equal(hasInternalMarkers('[system: empty tool message processed, continue]'), true);
  assert.equal(hasInternalMarkers('正常文本'), false);
});

test('空文本安全', () => {
  assert.deepEqual(sanitizeOutput(''), { text: '', removed: [] });
});

// ── 流式净化（关键：标记会被分片跨越） ──

test('流式：标记完整落在一个块内', () => {
  const s = new StreamingSanitizer();
  const out = s.push('A段 [system: empty tool message processed, continue] B段');
  const tail = s.flush();
  const full = out + tail;
  assert.ok(!full.includes('empty tool message'));
  assert.ok(full.includes('A段'));
  assert.ok(full.includes('B段'));
});

test('流式：标记被拆到多个块（逐字符推送）', () => {
  const marker = '[system: empty tool message processed, continue]';
  const text = `前文内容${marker}后文内容`;

  const s = new StreamingSanitizer();
  let out = '';
  for (const ch of text) {
    out += s.push(ch);
  }
  out += s.flush();

  assert.ok(!out.includes('empty tool message'), `标记应被过滤，实际：${out}`);
  assert.ok(out.includes('前文内容'));
  assert.ok(out.includes('后文内容'));
});

test('流式：标记被拆成两半（前半滞留，后半到达后完成匹配）', () => {
  const s = new StreamingSanitizer();
  let out = '';
  // 第一次推送标记的前半（未闭合）
  out += s.push('前文 [system: empty tool');
  // 第二次推送后半（闭合）
  out += s.push(' message processed, continue] 后文');
  out += s.flush();

  assert.ok(!out.includes('empty tool'), `实际：${out}`);
  assert.ok(out.includes('前文'));
  assert.ok(out.includes('后文'));
});

test('流式：普通方括号不误伤', () => {
  const s = new StreamingSanitizer();
  let out = '';
  for (const ch of '这是 [普通方括号] 内容') {
    out += s.push(ch);
  }
  out += s.flush();
  assert.equal(out, '这是 [普通方括号] 内容');
});

test('流式：不丢失内容（无标记场景逐字符推送）', () => {
  const text = '一段完全没有标记的正常文本，逐字符推送不应丢失任何内容。';
  const s = new StreamingSanitizer();
  let out = '';
  for (const ch of text) {
    out += s.push(ch);
  }
  out += s.flush();
  assert.equal(out, text, '逐字符推送必须完整还原');
});

test('流式：不丢失内容（分块推送）', () => {
  const text = '模组缺失前置 fabric-language-kotlin，需要安装。';
  const s = new StreamingSanitizer();
  let out = '';
  // 按 5 字符分块
  for (let i = 0; i < text.length; i += 5) {
    out += s.push(text.slice(i, i + 5));
  }
  out += s.flush();
  assert.equal(out, text);
});

test('流式：didRemove 标记', () => {
  const s = new StreamingSanitizer();
  s.push('[system: empty tool message processed, continue]');
  s.flush();
  assert.equal(s.didRemove, true);

  const s2 = new StreamingSanitizer();
  s2.push('正常内容');
  s2.flush();
  assert.equal(s2.didRemove, false);
});

test('流式：长文本不会被无限滞留', () => {
  const s = new StreamingSanitizer();
  const long = 'A'.repeat(1000);
  const out = s.push(long);
  // 应输出绝大部分（仅滞留少量以防标记跨块）
  assert.ok(out.length > 900, `应输出大部分内容，实际输出 ${out.length}`);
});
