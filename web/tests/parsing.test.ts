/**
 * 结论拆分与日志解析测试。
 */
import { describe, expect, it } from 'vitest'
import { confidenceLabel, normalizeConfidence, normalizeList, splitConclusion } from '@/lib/structured'
import { classify, findAnchor, nextError, parseLog, prevError, searchLines, sliceLines } from '@/lib/logdoc'

describe('splitConclusion', () => {
  it('拆分末尾围栏 JSON 块', () => {
    const text = ['根因分析正文。', '', '```json', '{"rootCause":"模组冲突","steps":["删掉 A"]}', '```'].join('\n')
    const r = splitConclusion(text)
    expect(r.body).toBe('根因分析正文。')
    expect(r.conclusion).toMatchObject({ rootCause: '模组冲突' })
    expect(r.raw).toContain('rootCause')
  })

  it('拆分裸 JSON 块', () => {
    const text = '正文\n{"rootCause":"内存不足"}'
    const r = splitConclusion(text)
    expect(r.body).toBe('正文')
    expect(r.conclusion?.rootCause).toBe('内存不足')
  })

  it('整段就是 JSON（没有正文）', () => {
    const r = splitConclusion('{"rootCause":"x","steps":[]}')
    expect(r.body).toBe('')
    expect(r.conclusion?.rootCause).toBe('x')
  })

  it('普通 JSON 不当作结论（缺 rootCause/steps）', () => {
    const r = splitConclusion('正文\n{"foo":"bar"}')
    expect(r.conclusion).toBeNull()
    expect(r.body).toContain('foo')
  })

  it('畸形 JSON 不吞掉正文', () => {
    const text = '正文\n```json\n{bad json}\n```'
    const r = splitConclusion(text)
    expect(r.conclusion).toBeNull()
    expect(r.body).toContain('正文')
  })

  it('空文本安全', () => {
    expect(splitConclusion('')).toEqual({ body: '', conclusion: null, raw: null })
  })

  it('多段末尾 JSON 块：全部剥离，只取最后一段作结论', () => {
    // 实测形态：模型先给一段中间态、再给最终结论。只剥最后一段会让
    // 前一段原样留在正文里，用户看到裸露的 {"rootCause":…}。
    const text = [
      '正文第一段。',
      '',
      '```json',
      '{"rootCause":"中间态","steps":["旧步骤"]}',
      '```',
      '',
      '正文第二段。',
      '',
      '```json',
      '{"rootCause":"最终结论","steps":["新步骤"]}',
      '```',
    ].join('\n')

    const r = splitConclusion(text)
    expect(r.conclusion?.rootCause).toBe('最终结论')
    expect(r.body).toBe('正文第一段。\n\n```json\n{"rootCause":"中间态","steps":["旧步骤"]}\n```\n\n正文第二段。')
  })

  it('末尾连续多个 JSON 块全部剥离', () => {
    const text = ['正文。', '', '```json', '{"rootCause":"A"}', '```', '', '```json', '{"rootCause":"B"}', '```'].join('\n')
    const r = splitConclusion(text)
    expect(r.conclusion?.rootCause).toBe('B')
    expect(r.body).toBe('正文。')
  })

  it('中间有坏 JSON 时停止剥离，不吞掉正文', () => {
    const text = ['正文。', '', '```json', '{坏数据}', '```'].join('\n')
    const r = splitConclusion(text)
    expect(r.conclusion).toBeNull()
    expect(r.body).toContain('正文。')
    expect(r.body).toContain('坏数据')
  })
})

describe('normalizeList', () => {
  it('字符串数组去空白', () => {
    expect(normalizeList([' a ', '', 'b'])).toEqual(['a', 'b'])
  })

  it('对象形态 { quote, source }', () => {
    expect(normalizeList([{ quote: 'main.log:12 ERROR', source: 'main.log' }])).toEqual([
      'main.log:12 ERROR  main.log',
    ])
  })

  it('对象形态 { action, reason }', () => {
    expect(normalizeList([{ action: '卸载模组', reason: '版本冲突' }])).toEqual(['卸载模组（版本冲突）'])
  })

  it('不认识的对象不产生 [object Object]', () => {
    expect(normalizeList([{ foo: 1 }])).toEqual([])
  })

  it('非数组返回空', () => {
    expect(normalizeList('x')).toEqual([])
  })
})

describe('normalizeConfidence', () => {
  it('0–1 原样保留', () => {
    expect(normalizeConfidence(0.8)).toBeCloseTo(0.8)
  })

  it('百分数换算', () => {
    expect(normalizeConfidence(75)).toBeCloseTo(0.75)
  })

  it('中文档位', () => {
    expect(normalizeConfidence('高')).toBeCloseTo(0.85)
    expect(normalizeConfidence('中')).toBeCloseTo(0.6)
    expect(normalizeConfidence('低')).toBeCloseTo(0.3)
  })

  it('非法值返回 null', () => {
    expect(normalizeConfidence(null)).toBeNull()
    expect(normalizeConfidence('???')).toBeNull()
    expect(normalizeConfidence(-1)).toBeNull()
  })

  it('档位文案', () => {
    expect(confidenceLabel(0.8)).toBe('把握较大')
    expect(confidenceLabel(0.6)).toBe('把握一般')
    expect(confidenceLabel(0.2)).toBe('把握不大')
    expect(confidenceLabel(null)).toBeNull()
  })
})

describe('parseLog', () => {
  const sample = [
    '===== latest.log =====',
    '[12:00:00] [main/INFO]: Loading',
    '[12:00:01] [main/ERROR]: java.lang.NoSuchMethodError',
    '  at com.example.CoolMod.onInit(CoolMod.java:42)',
    '[12:00:02] [main/WARN]: something odd',
    '===== crash-report.txt =====',
    '---- Minecraft Crash Report ----',
    '# SIGSEGV (0xb) at pc=0x00000000',
    '# Problematic frame:',
    '# C  [libmobileglues.so+0x593060]',
  ].join('\n')

  it('识别分节与中文角色', () => {
    const parsed = parseLog(sample)
    expect(parsed.sections).toHaveLength(2)
    expect(parsed.sections[0]?.role).toBe('游戏日志')
    expect(parsed.sections[1]?.role).toBe('崩溃现场')
  })

  it('统计错误与警告', () => {
    const parsed = parseLog(sample)
    expect(parsed.counts.error).toBeGreaterThanOrEqual(3)
    expect(parsed.counts.warn).toBeGreaterThanOrEqual(1)
    expect(parsed.errors).toContain(3)
  })

  it('堆栈帧被压暗而不是全部标红', () => {
    expect(classify('  at com.example.CoolMod.onInit(CoolMod.java:42)')).toBe('dim')
  })

  it('INFO 不上色', () => {
    expect(classify('[12:00:00] [main/INFO]: Loading')).toBe('plain')
  })

  it('sliceLines 为 1 基闭区间', () => {
    const parsed = parseLog(sample)
    expect(sliceLines(parsed, 2, 3)).toBe(
      '[12:00:00] [main/INFO]: Loading\n[12:00:01] [main/ERROR]: java.lang.NoSuchMethodError',
    )
  })

  it('错误行导航循环', () => {
    const parsed = parseLog(sample)
    const first = parsed.errors[0] ?? 0
    expect(nextError(parsed.errors, 0)).toBe(first)
    expect(prevError(parsed.errors, 2)).toBe(parsed.errors[parsed.errors.length - 1])
  })

  it('日志内搜索大小写不敏感', () => {
    const parsed = parseLog(sample)
    expect(searchLines(parsed.lines, 'nosuchmethoderror')).toEqual([3])
  })
})

describe('findAnchor', () => {
  const lines = [
    '[12:00:00] [main/INFO]: Loading',
    'java.lang.UnsatisfiedLinkError: dlopen failed: library "libSDL3.so" not found',
    '  at org.lwjgl.sdl.SDL.<clinit>(SDL.java:42)',
  ]

  it('整段锚点可定位', () => {
    expect(findAnchor(lines, 'libSDL3.so')).toBe(2)
  })

  it('过短的锚点不定位（避免到处命中）', () => {
    expect(findAnchor(lines, 'SDL')).toBeNull()
  })

  it('不存在的锚点返回 null', () => {
    expect(findAnchor(lines, 'libNotThere.so')).toBeNull()
  })

  it('拼接证据退回最长 token 查找', () => {
    expect(findAnchor(lines, '错误 UnsatisfiedLinkError 找不到库')).toBe(2)
  })
})
