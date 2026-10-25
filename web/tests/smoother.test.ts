/**
 * 平滑输出守门。
 *
 * ## 为什么需要这层
 * SSE 的到达是**突发的**：代理会把几十个 token 攒成一包，网络抖动又会一次送来
 * 几百字。直接把每个 delta 追加到响应式字符串，Vue 每来一包就重渲染整段 Markdown，
 * 长回答时主线程被打满——观感是「一顿一顿，还卡」。
 *
 * 这里守三件事：
 *  1. 文本**不丢**（分片进入队列后逐字放出，总量一致）；
 *  2. 积压越多放得越快（不会越积越多追不上真实进度）；
 *  3. `drained()` 在真正放完之后才 resolve（否则结论 JSON 会残留进正文）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSmoother } from '@/lib/smoother'

/**
 * 手动驱动的 rAF。
 *
 * 真实环境里 rAF 靠屏幕刷新驱动；测试里必须手动推进，否则断言会依赖时序。
 */
let frameQueue: FrameRequestCallback[] = []

function runFrames(count: number): void {
  for (let i = 0; i < count; i++) {
    const batch = frameQueue
    frameQueue = []
    for (const cb of batch) cb(performance.now())
  }
}

/**
 * 一边推进帧、一边让出事件循环，直到条件满足。
 *
 * 为什么不能 `await smoother.drained()` 再手推帧：两者都在等对方——
 * drained 等帧、帧等 await 之后的代码，谁也动不了。真实环境里 rAF 由浏览器驱动，
 * 测试里必须**主动**驱动它，因此用轮询而不是「先 await」。
 */
async function pumpUntil(done: () => boolean, maxFrames = 400): Promise<void> {
  for (let i = 0; i < maxFrames; i++) {
    if (done()) return
    runFrames(1)
    // 让 Promise 回调（settle → resolve）先行跑完，再判断条件
    await new Promise((r) => setTimeout(r, 0))
  }
  throw new Error('pumpUntil 超时：条件始终未满足')
}

beforeEach(() => {
  frameQueue = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frameQueue.push(cb)
    return frameQueue.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
})

describe('createSmoother', () => {
  it('分片到达的文本不丢，总量与输入一致', () => {
    const out: string[] = []
    const smoother = createSmoother({ onFlush: (t) => out.push(t) })

    smoother.push('第一段')
    smoother.push('第二段')
    smoother.push('第三段')

    runFrames(20)
    expect(out.join('')).toBe('第一段第二段第三段')
    expect(smoother.pending).toBe(0)
  })

  it('一帧不会一次放完长文本（这正是「卡顿」的来源）', () => {
    const out: string[] = []
    const smoother = createSmoother({ onFlush: (t) => out.push(t) })

    smoother.push('字'.repeat(600))
    runFrames(1)

    // 首帧只放一小批，剩下的留在队列里
    expect(out.join('').length).toBeGreaterThan(0)
    expect(out.join('').length).toBeLessThan(600)
    expect(smoother.pending).toBeGreaterThan(0)
  })

  it('积压越多，每帧放出越多（追得上真实进度）', () => {
    const small: string[] = []
    const smallSmoother = createSmoother({ onFlush: (t) => small.push(t) })
    smallSmoother.push('字'.repeat(20))
    runFrames(1)
    const smallBatch = small.join('').length

    frameQueue = []
    const big: string[] = []
    const bigSmoother = createSmoother({ onFlush: (t) => big.push(t) })
    bigSmoother.push('字'.repeat(600))
    runFrames(1)
    const bigBatch = big.join('').length

    expect(bigBatch).toBeGreaterThan(smallBatch)
  })

  it('drain 之后 drained() 才 resolve，且此时队列已空', async () => {
    const out: string[] = []
    const smoother = createSmoother({ onFlush: (t) => out.push(t) })

    smoother.push('结'.repeat(300))

    let drained = false
    const wait = smoother.drained().then(() => {
      drained = true
    })

    smoother.drain()
    await pumpUntil(() => drained)
    await wait

    expect(drained).toBe(true)
    expect(smoother.pending).toBe(0)
    expect(out.join('').length).toBe(300)
  })

  it('push 之后不 drain 也能等排空（用于「流还在继续但想同步一次」）', async () => {
    const out: string[] = []
    const smoother = createSmoother({ onFlush: (t) => out.push(t) })

    smoother.push('短文本')

    let drained = false
    const wait = smoother.drained().then(() => {
      drained = true
    })
    await pumpUntil(() => drained)
    await wait

    expect(out.join('')).toBe('短文本')
  })

  it('stop 之后不再放出任何文本', () => {
    const out: string[] = []
    const smoother = createSmoother({ onFlush: (t) => out.push(t) })

    smoother.push('不应出现')
    smoother.stop()
    runFrames(10)

    expect(out).toEqual([])
    expect(smoother.pending).toBe(0)
  })

  it('积压 9–24 字时每帧仍有推进（回归：预算曾算成 0，界面卡死）', async () => {
    const out: string[] = []
    const smoother = createSmoother({ onFlush: (t) => out.push(t) })

    // 这个区间是短回答的典型积压量；早先 budget 会四舍五入到 0，
    // 表现为「调度了但一个字也不出」，队列永远排不空。
    smoother.push('一'.repeat(12))
    runFrames(1)
    expect(out.join('').length).toBeGreaterThan(0)

    let drained = false
    const wait = smoother.drained().then(() => {
      drained = true
    })
    await pumpUntil(() => drained)
    await wait
    expect(smoother.pending).toBe(0)
  })

  it('空文本不触发任何刷新', () => {
    const onFlush = vi.fn()
    const smoother = createSmoother({ onFlush })

    smoother.push('')
    runFrames(3)

    expect(onFlush).not.toHaveBeenCalled()
  })
})
