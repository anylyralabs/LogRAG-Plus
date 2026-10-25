/**
 * 上传准备与本地历史测试。
 *
 * 上传校验与后端 `src/upload/validate.ts` 是同一组规则。两边不一致会造成
 * 「本服务放行、LogShare 拒绝」的困惑，因此这里钉住边界值。
 */
import { describe, expect, it } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import {
  MAX_FILES,
  UploadError,
  baseName,
  isSafeFileName,
  looksLikeLog,
  prepareUpload,
} from '@/lib/upload'

function makeFile(name: string, content: string | Uint8Array): File {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
  return new File([bytes as unknown as BlobPart], name)
}

describe('isSafeFileName', () => {
  it('拒绝路径分隔符', () => {
    expect(isSafeFileName('a/b.log')).toBe(false)
    expect(isSafeFileName('a\\b.log')).toBe(false)
  })

  it('拒绝 .. 与控制字符', () => {
    expect(isSafeFileName('..')).toBe(false)
    expect(isSafeFileName('a\0b')).toBe(false)
    expect(isSafeFileName('a\nb')).toBe(false)
  })

  it('接受中文与常见符号', () => {
    expect(isSafeFileName('崩溃报告（1）.txt')).toBe(true)
    expect(isSafeFileName('latest.log')).toBe(true)
  })

  it('拒绝超长', () => {
    expect(isSafeFileName('a'.repeat(129))).toBe(false)
  })
})

describe('baseName', () => {
  it('剥掉目录', () => {
    expect(baseName('logs/latest.log')).toBe('latest.log')
    expect(baseName('a\\b\\crash.txt')).toBe('crash.txt')
  })
})

describe('prepareUpload', () => {
  it('主日志取最大的 .log，其余作为附件', async () => {
    const main = makeFile('latest.log', 'x'.repeat(2000))
    const report = makeFile('crash-report.txt', 'crash report')
    const prepared = await prepareUpload([report, main])
    expect(prepared.content).toBe('x'.repeat(2000))
    expect(prepared.files.map((f) => f.name)).toEqual(['crash-report.txt'])
  })

  it('没有 .log 时取最大文本文件', async () => {
    const a = makeFile('a.txt', 'short')
    const b = makeFile('b.txt', 'longer content')
    const prepared = await prepareUpload([a, b])
    expect(prepared.content).toBe('longer content')
  })

  it('忽略空文件并提示', async () => {
    const prepared = await prepareUpload([makeFile('empty.log', ''), makeFile('latest.log', 'line')])
    expect(prepared.content).toBe('line')
    expect(prepared.notes.join()).toContain('已忽略空文件')
  })

  it('重名文件自动改名', async () => {
    const prepared = await prepareUpload([
      makeFile('latest.log', 'a'),
      makeFile('latest.log', 'b'),
    ])
    const names = [prepared.content, ...prepared.files.map((f) => f.data)]
    expect(names).toHaveLength(2)
    expect(prepared.notes.join()).toContain('重名文件已改名')
  })

  it('ZIP 自动解压并跳过目录与 __MACOSX', async () => {
    const zip = zipSync({
      'logs/latest.log': strToU8('hello from zip'),
      'logs/crash-report.txt': strToU8('crash'),
      'logs/': new Uint8Array(),
      '__MACOSX/._latest.log': strToU8('junk'),
    })
    const prepared = await prepareUpload([makeFile('logs.zip', zip)])
    expect(prepared.content).toBe('hello from zip')
    expect(prepared.files.map((f) => f.name)).toEqual(['crash-report.txt'])
  })

  it('损坏的 ZIP 给出可读错误', async () => {
    await expect(prepareUpload([makeFile('bad.zip', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))])).rejects.toBeInstanceOf(UploadError)
  })

  it('全是空文件时报错', async () => {
    await expect(prepareUpload([makeFile('empty.log', '')])).rejects.toBeInstanceOf(UploadError)
  })

  it('文件数超过上限时报错', async () => {
    const files = Array.from({ length: MAX_FILES + 1 }, (_, i) => makeFile(`f${i}.txt`, `content ${i}`))
    await expect(prepareUpload(files)).rejects.toThrow(/最多/)
  })

  it('来源标识非法时被丢弃（不阻断上传）', async () => {
    const prepared = await prepareUpload([makeFile('latest.log', 'x')], { source: 'bad source!!' })
    expect(prepared.source).toBe('')
  })

  it('合法来源标识保留', async () => {
    const prepared = await prepareUpload([makeFile('latest.log', 'x')], { source: 'fcl/1.3.4' })
    expect(prepared.source).toBe('fcl/1.3.4')
  })
})

describe('looksLikeLog', () => {
  it('时间戳开头的多行文本判为日志', () => {
    const text = Array.from({ length: 20 }, (_, i) => `[12:00:${String(i).padStart(2, '0')}] [main/INFO]: line ${i}`).join('\n')
    expect(looksLikeLog(text)).toBe(true)
  })

  it('普通问题不判为日志', () => {
    expect(looksLikeLog('我的游戏崩溃了，怎么办？'.repeat(30))).toBe(false)
  })

  it('短文本不判为日志', () => {
    expect(looksLikeLog('[12:00:00] [main/ERROR]: x')).toBe(false)
  })
})
