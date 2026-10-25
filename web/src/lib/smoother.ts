/**
 * 流式文本的平滑输出。
 *
 * ## 为什么需要它
 * SSE 到达的节奏是**突发的**：代理缓冲会把几十个 token 攒成一包，网络抖动又会
 * 一次送来几百字。直接把每个 delta 追加到响应式字符串上，会得到「一顿一顿」的
 * 观感——Vue 每来一包就重渲染整段 Markdown，长回答时主线程被打满。
 *
 * ## 做法
 * 收到的文本先进**队列**，由 `requestAnimationFrame` 按**固定字数/帧**放出：
 *  - 队列短时逐字放出，看起来像在「打字」；
 *  - 队列长时加速（一帧多放几个字），保证不会越积越多、追不上真实进度；
 *  - 流结束时 `drain()` 一次性放完剩余，避免结尾拖尾。
 *
 * 关键取舍：**不做逐字符平均延迟**。真实模型的输出速度差异很大，
 * 强行匀速会让人觉得「比实际慢」；这里只做「削峰」——快到不卡、慢到不空。
 */

export interface SmootherOptions {
  /** 每帧至少放出几个字符（决定最慢的观感） */
  minPerFrame?: number
  /** 每帧最多放出几个字符（决定追帧上限） */
  maxPerFrame?: number
  /**
   * `drain()` 之后每帧放出的字数。
   *
   * 与 `maxPerFrame` 分开：后者控制**正常流式**的观感（太大了像一次性蹦出来），
   * 而 drain 是「流已经结束，把剩下的尽快放完」——此时不再需要考虑观感，
   * 只需要在 1–2 帧内收尾，避免用户等一段已经生成完的文本「慢慢打完」。
   */
  drainPerFrame?: number
  /** 每输出一批调用一次（用于驱动响应式更新） */
  onFlush: (text: string) => void
  /** 队列排空后调用（仅在 requestDrain 之后） */
  onDrained?: () => void
}

export interface Smoother {
  /** 追加新到的文本 */
  push: (text: string) => void
  /** 立刻放出全部剩余（流结束、出错、用户点停止时调用） */
  drain: () => void
  /**
   * 排空完成的 Promise。
   *
   * 为什么需要它：`drain()` 只是「进入排空模式」，真正放出发生在下一帧。
   * 调用方必须在放出**之后**才做最终解析（拆结论 JSON），否则会把还没
   * 显示的文本当成不存在。这个 Promise 就是那个时序点。
   */
  drained: () => Promise<void>
  /** 停止计时并丢弃队列（组件卸载） */
  stop: () => void
  /** 队列里还有多少字符没放出 */
  readonly pending: number
}

/** 首帧放出量：小于它直接全放，避免短回答被拆成很多帧 */
const INSTANT_THRESHOLD = 8

export function createSmoother(options: SmootherOptions): Smoother {
  const minPerFrame = options.minPerFrame ?? 2
  const maxPerFrame = options.maxPerFrame ?? 24
  const drainPerFrame = options.drainPerFrame ?? 4000

  /** 待放出的文本（用数组拼接，避免频繁字符串相加） */
  let queue: string[] = []
  let pendingChars = 0
  let frame: number | null = null
  let stopped = false
  let draining = false
  /**
   * 等待「队列排空」的 resolve 列表。
   *
   * 语义是**「什么时候放完」**，与是否调用过 `drain()` 无关：
   * `drained()` 在积压期间被调用时也要能等到排空（否则调用方永久挂起），
   * 队列已经空时则立即 resolve。
   */
  let drainWaiters: Array<() => void> = []

  const raf =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16) as unknown as number
  const cancel =
    typeof cancelAnimationFrame === 'function'
      ? cancelAnimationFrame
      : (id: number) => clearTimeout(id)

  function schedule(): void {
    if (frame !== null || stopped || pendingChars === 0) return
    frame = raf(tick)
  }

  /**
   * 每帧放出多少：随积压量线性增长，积压越多放得越快。
   *
   * ⚠️ 必须保证**至少放出 1 个字符**。
   * 早先写成 `min(1, (pending - 24) / 216)`：积压 9–24 字时该值为负，
   * 四舍五入后 budget = 0，于是每帧都「调度一次、放出 0 字」——
   * 队列永远排不空，界面看起来完全卡死。这是被单测抓出来的（不是推演出来的）：
   * 短回答（几行）恰好落在这个区间，所以「短回答反而更容易卡」。
   */
  function budget(): number {
    if (pendingChars <= INSTANT_THRESHOLD) return pendingChars
    const t = Math.max(0, Math.min(1, (pendingChars - 24) / 216))
    return Math.max(1, Math.round(minPerFrame + (maxPerFrame - minPerFrame) * t))
  }

  function settle(): void {
    draining = false
    options.onDrained?.()
    const waiters = drainWaiters
    drainWaiters = []
    for (const resolve of waiters) resolve()
  }

  function tick(): void {
    frame = null
    if (stopped) return

    if (pendingChars === 0) {
      settle()
      return
    }

    // drain 时不再限速：一次放出（上限 4000 字，避免单帧渲染巨量 Markdown）
    const take = Math.min(draining ? drainPerFrame : budget(), pendingChars)
    let out = ''
    let left = take

    while (left > 0 && queue.length > 0) {
      const head = queue[0]!
      if (head.length <= left) {
        out += head
        left -= head.length
        queue.shift()
      } else {
        out += head.slice(0, left)
        queue[0] = head.slice(left)
        left = 0
      }
    }

    pendingChars -= take
    if (out !== '') options.onFlush(out)

    if (pendingChars > 0) {
      schedule()
      return
    }

    /*
     * 这一帧把队列放空了 —— 必须**当场** settle。
     *
     * 早先只在「下一帧入口发现 pending === 0」时 settle，于是最后一次放空
     * 之后不会再有帧（没有积压就不再 schedule），`drained()` 永远等不到——
     * 调用方会卡在「分析完成但不收尾」。
     */
    settle()
  }

  return {
    push(text: string): void {
      if (text === '' || stopped) return
      queue.push(text)
      pendingChars += text.length
      schedule()
    },

    /**
     * 进入「尽快放完」模式。
     *
     * 实现上只是把预算拉满（draining 时每帧取上限），而不做一次性同步输出：
     * 一次性输出会让最后一帧渲染巨量 Markdown，恰恰是要避免的卡顿。
     */
    drain(): void {
      if (stopped) return
      if (pendingChars === 0) {
        options.onDrained?.()
        return
      }
      draining = true
      if (frame === null) schedule()
    },

    drained(): Promise<void> {
      /*
       * 队列已空 → 立即 resolve。
       *
       * 这条不能漏：`settle()` 只在「有积压→放空」那一刻通知等待者，
       * 若调用方在排空**之后**才问（流刚好结束、或短回答一帧就放完了），
       * 就永远等不到通知——调用方会挂在那里，表现为「分析完成但不收尾」。
       */
      if (stopped || pendingChars === 0) return Promise.resolve()

      return new Promise<void>((resolve) => {
        drainWaiters.push(resolve)
        // 未在 drain 状态时也允许等待；确保有帧在跑
        if (frame === null) schedule()
      })
    },

    stop(): void {
      stopped = true
      if (frame !== null) {
        cancel(frame)
        frame = null
      }
      queue = []
      pendingChars = 0
      const waiters = drainWaiters
      drainWaiters = []
      for (const resolve of waiters) resolve()
    },

    get pending(): number {
      return pendingChars
    },
  }
}
