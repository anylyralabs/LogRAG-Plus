/**
 * 检索排序守门：高频查询的首条结果必须对题。
 *
 * ## 为什么需要这条测试
 *
 * 知识库里**有**答案，不代表模型能拿到。实测过两个真实错位：
 *
 * | 查询（生产真实频次） | 曾排第一 | 正确答案 |
 * |---|---|---|
 * | `UnsupportedClassVersionError class file version 65.0`（13 次） | `format/latest-log.md` | `patterns/version-mismatch.md` |
 * | `libGL error` | `format/launcher-log.md` | `patterns/system-environment-failure.md` |
 *
 * 成因是**职责越界**：格式类文件（`format/`）本应只说明「日志长什么样」，
 * 却在「签名」小节里逐字抄了完整报错原文——BM25 按字面匹配，抄得越完整分越高，
 * 于是把真正的判据挤到后面。
 *
 * 模型看到首条不相关就可能不再往下看，所以「有没有答案」与「答案排第几」是两件事。
 *
 * ## 这些查询词从哪来
 *
 * 全部取自 `data/corpus/search_targets.jsonl` 里生产环境真实的 `rag_search` 调用
 * （14612 次调用、12493 个不同查询），选的是频次最高且答案明确的那批。
 * 不是编的测试数据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { search } from '../src/rag/search.ts'

/** 高频查询 → 首条结果必须来自哪个文件（正则） */
const CASES: Array<{ query: string; expect: RegExp; freq: number; why: string }> = [
  {
    query: 'GL_FRAMEBUFFER_UNSUPPORTED',
    expect: /opengl-framebuffer-failure/,
    freq: 161,
    why: '生产最高频查询，FBO 创建失败',
  },
  {
    query: 'zip END header not found',
    expect: /mod-jar-corruption/,
    freq: 68,
    why: 'jar 文件损坏',
  },
  {
    query: 'Failed to load required shader programs',
    expect: /shader-compile-failure/,
    freq: 45,
    why: '着色器编译失败',
  },
  {
    query: 'Missing or unsupported mandatory dependencies',
    expect: /mod-dependency-failure/,
    freq: 32,
    why: 'Forge 强制依赖缺失',
  },
  {
    query: 'Could not create the Java Virtual Machine',
    expect: /pc-launcher-issues|java-runtime-mobile/,
    freq: 25,
    why: 'JVM 创建失败，启动器或 Java 运行时层',
  },
  {
    query: 'OutOfMemoryError Java heap space',
    expect: /out-of-memory/,
    freq: 17,
    why: '堆内存不足',
  },
  {
    // 这道题有**三个**都算对的答案：判据卡（version-mismatch）、
    // 实况案例（cases/native-and-java，含两个真实 logId 的同一异常）、
    // 启动器层（pc-launcher-issues，讲选错 Java 的后果）。
    // 但**不能**是 format/ —— 那是本条测试的立身之本：曾错排到 format/latest-log.md。
    query: 'UnsupportedClassVersionError class file version 65.0',
    expect: /version-mismatch|native-and-java|pc-launcher-issues/,
    freq: 13,
    why: '曾错排到 format/latest-log.md（格式文档抢了判据的位置）',
  },
  {
    query: 'Duplicate mods found',
    expect: /mod-conflict/,
    freq: 13,
    why: '重复 mod id',
  },
  {
    query: 'CustomSkinLoader NoClassDefFoundError IFakeIResourceManager',
    expect: /mod-runtime-api-mismatch/,
    freq: 12,
    why: '模组与运行时接口不匹配',
  },
  // 下列三条对应的条目是 2026-10-21 新增的（此前完全没有覆盖）
  {
    query: '__THESEUS_UTF8__ InvalidPathException',
    expect: /path-encoding-failure/,
    freq: 128,
    why: '启动器路径编码前缀未解码（新增条目前完全无覆盖）',
  },
  {
    query: 'ExceptionInInitializerError Could not initialize class',
    expect: /static-init-failure/,
    freq: 351,
    why: '静态初始化失败（最容易误判成「缺 jar」）',
  },
  {
    query: 'VpnService SecurityException Android 16',
    expect: /system-environment-failure/,
    freq: 85,
    why: '系统层缺陷',
  },
]

for (const c of CASES) {
  test(`首条对题：${c.query.slice(0, 46)}（生产 ${c.freq} 次）`, async () => {
    const r = await search({ query: c.query, k: 5 })
    assert.ok(r.hits.length > 0, `「${c.query}」没有任何命中——知识库缺条目`)
    const top = r.hits[0]?.source ?? ''
    assert.match(
      top,
      c.expect,
      `「${c.query}」首条是 ${top}，期望匹配 ${String(c.expect)}。\n` +
        `原因：${c.why}\n` +
        `全部命中：${r.hits.map((h) => h.source).join(' | ')}`,
    )
  })
}

test('格式类文档不得抢占故障判据的首位（职责边界）', async () => {
  // 抽样一批「明确属于某个 patterns 条目」的报错，要求首条不能来自 format/ 或 launcher/
  const patternsOnly = [
    ['NoSuchMethodError', /version-mismatch|mod-runtime-api|graphics-shader/],
    ['Reference map could not be read', /mixin-refmap/],
    ['IncompatibleClassChangeError Found interface but class', /version-mismatch|mod-conflict/],
  ]
  for (const [q, expect] of patternsOnly) {
    const r = await search({ query: q as string, k: 3 })
    const top = r.hits[0]?.source ?? ''
    assert.match(
      top,
      expect as RegExp,
      `「${String(q)}」首条是 ${top}，判据类查询不应由格式文档回答`,
    )
  }
})
