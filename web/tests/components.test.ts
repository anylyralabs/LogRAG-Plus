/**
 * 组件挂载测试。
 *
 * 目的不是截图比对，而是抓「模板里引用了不存在的字段 / 事件没接上」这类
 * 编译期查不出、运行时才白屏的错误。每个用例都对应一个真实交互路径。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import MessageItem from '@/components/chat/MessageItem.vue'
import Composer from '@/components/chat/Composer.vue'
import ConclusionSpine from '@/components/report/ConclusionSpine.vue'
import ScorePanel from '@/components/report/ScorePanel.vue'
import StepsPanel from '@/components/report/StepsPanel.vue'
import ThinkingPanel from '@/components/report/ThinkingPanel.vue'
import KnowledgeList from '@/components/admin/KnowledgeList.vue'
import type { ChatMessage } from '@/lib/types'

function assistant(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    role: 'assistant',
    content: '根因是 **模组冲突**。\n\n- 卸载 A\n- 更新 B',
    reasoning: '先看崩溃锚点',
    thinkingTotal: 7,
    tools: [
      { index: 1, name: 'grep_log_file', args: { query: 'SIGSEGV' }, summary: '命中 3 行', done: true, failed: false },
      { index: 2, name: 'rag_search', args: { query: 'mixin' }, summary: '工具调用失败: timeout', done: true, failed: true },
    ],
    conclusion: {
      rootCause: '模组 A 与 B 的 Mixin 注入冲突',
      confidence: 0.8,
      steps: ['卸载模组 A', '更新模组 B 到 2.0'],
      evidence: ['main.log:42 Mixin apply failed', 'libSDL3.so not found'],
    },
    score: {
      overall: 88,
      deliverable: true,
      dimensions: { grounding: 76, verification: 100, actionability: 90, economy: 100 },
      deductions: ['有 2 条断言缺少可核实标识'],
      missingAnchors: ['libSDL3.so'],
    },
    status: 'completed',
    error: null,
    notices: [],
    asks: [],
    createdAt: Date.now(),
    ...overrides,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('MessageItem', () => {
  it('按时间顺序：调查步骤 → 思维链 → 正文 → 结论', () => {
    const wrapper = mount(MessageItem, {
      props: { message: assistant(), canLocate: false, canRetry: false },
      global: { stubs: { MarkdownView: { template: '<div class="BODY">正文</div>' } } },
    })

    const html = wrapper.html()
    // 用**渲染出来的结构**判断顺序。不能用「调查过程」这类中文串：
    // 测试模式下模板注释也会渲染，会匹配到注释里的字样而假通过。
    const stepsAt = html.indexOf('class="steps')
    const thinkingAt = html.indexOf('class="thinking')
    const bodyAt = html.indexOf('class="BODY"')
    const verdictAt = html.indexOf('verdict__root')

    for (const [label, at] of [
      ['steps', stepsAt],
      ['thinking', thinkingAt],
      ['body', bodyAt],
      ['verdict', verdictAt],
    ]) {
      expect(at, `${label} 未渲染`).toBeGreaterThan(-1)
    }
    // 顺序即真实发生顺序：先查、边想边写、结论最后
    expect(stepsAt).toBeLessThan(thinkingAt)
    expect(thinkingAt).toBeLessThan(bodyAt)
    expect(bodyAt).toBeLessThan(verdictAt)
  })

  it('正文不折叠：它就是这个产品的答案主体', () => {
    const wrapper = mount(MessageItem, {
      props: { message: assistant(), canLocate: false, canRetry: false },
      global: { stubs: { MarkdownView: { template: '<div class="BODY">正文</div>' } } },
    })
    expect(wrapper.find('.BODY').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('完整分析')
  })

  it('判定句与步骤可见，依据默认收起', () => {
    const wrapper = mount(MessageItem, {
      props: { message: assistant(), canLocate: false, canRetry: false },
      global: { stubs: { MarkdownView: true } },
    })

    expect(wrapper.text()).toContain('模组 A 与 B 的 Mixin 注入冲突')
    expect(wrapper.text()).toContain('卸载模组 A')
    // 不再有「判定 / 处置」这类标签抢注意力（字级本身表达层级）
    expect(wrapper.text()).not.toContain('判定')
    expect(wrapper.text()).not.toContain('处置')
    // 依据默认收起（玩家先看该做什么）
    expect(wrapper.text()).toContain('依据 2 处')
    expect(wrapper.text()).not.toContain('main.log:42')
  })

  it('空正文 + 无结论显示「无结论」，不渲染成功态', () => {
    const wrapper = mount(MessageItem, {
      props: {
        message: assistant({ content: '', conclusion: null, error: '本次没有产出结论。', status: 'empty' }),
        canLocate: false,
        canRetry: true,
      },
      global: { stubs: { MarkdownView: true } },
    })
    expect(wrapper.text()).toContain('无结论')
    expect(wrapper.text()).toContain('重新分析')
  })

  it('失败时保留已有正文并标「未完成」', () => {
    const wrapper = mount(MessageItem, {
      props: {
        message: assistant({ status: 'error', error: '上游返回 502' }),
        canLocate: false,
        canRetry: true,
      },
      global: { stubs: { MarkdownView: true } },
    })
    expect(wrapper.text()).toContain('未完成')
    expect(wrapper.text()).toContain('上游返回 502')
  })

  it('用户消息中的引用块分开渲染', () => {
    const wrapper = mount(MessageItem, {
      props: {
        message: assistant({
          role: 'user',
          content: '为什么崩？\n\n引用日志 main.log:10-12：\n```\nERROR x\n```',
          conclusion: null,
          score: null,
          tools: [],
          thinkingTotal: 0,
        }),
        canLocate: false,
        canRetry: false,
      },
    })
    expect(wrapper.text()).toContain('为什么崩？')
    expect(wrapper.text()).toContain('引用日志 main.log:10-12')
  })
})

describe('Composer', () => {
  it('输入后回车发送，并清空', async () => {
    const wrapper = mount(Composer, {
      props: { busy: false, phase: '', hasLog: true, quote: '' },
    })
    const textarea = wrapper.find('textarea')
    await textarea.setValue('怎么彻底避免')
    await textarea.trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('send')?.[0]).toEqual(['怎么彻底避免'])
    expect((textarea.element as HTMLTextAreaElement).value).toBe('')
  })

  it('Shift+Enter 不发送', async () => {
    const wrapper = mount(Composer, {
      props: { busy: false, phase: '', hasLog: true, quote: '' },
    })
    const textarea = wrapper.find('textarea')
    await textarea.setValue('第一行')
    await textarea.trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(wrapper.emitted('send')).toBeUndefined()
  })

  it('流式中显示停止按钮而不是发送', async () => {
    const wrapper = mount(Composer, {
      props: { busy: true, phase: '正在检索：grep_log_file', hasLog: true, quote: '' },
    })
    expect(wrapper.find('[aria-label="停止分析"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('正在检索：grep_log_file')
  })

  it('引用条可取消', async () => {
    const wrapper = mount(Composer, {
      props: { busy: false, phase: '', hasLog: true, quote: '引用日志 main.log:1-2：\n```\nx\n```' },
    })
    expect(wrapper.text()).toContain('已引用日志片段')
    await wrapper.find('[aria-label="取消引用"]').trigger('click')
    expect(wrapper.emitted('clear-quote')).toHaveLength(1)
  })
})

describe('ConclusionSpine', () => {
  it('展开证据后可点击定位', async () => {
    const wrapper = mount(ConclusionSpine, {
      props: {
        conclusion: assistant().conclusion as NonNullable<ChatMessage['conclusion']>,
        canLocate: true,
        missingAnchors: ['libSDL3.so'],
      },
    })

    await wrapper.find('.evidence__toggle').trigger('click')
    const items = wrapper.findAll('.evidence__item')
    expect(items).toHaveLength(2)

    // 未命中的锚点不给「定位」，只标「未核对到」
    expect(wrapper.text()).toContain('未核对到')
    await wrapper.find('.evidence__locate').trigger('click')
    expect(wrapper.emitted('locate')?.[0]).toEqual(['main.log:42 Mixin apply failed'])
  })

  it('判定句不需要「判定」标签也读得懂（字级即层级）', () => {
    const wrapper = mount(ConclusionSpine, {
      props: {
        conclusion: assistant().conclusion as NonNullable<ChatMessage['conclusion']>,
      },
    })
    const root = wrapper.find('.verdict__root')
    expect(root.exists()).toBe(true)
    expect(root.text()).toContain('模组 A 与 B 的 Mixin 注入冲突')
    // 置信度作为判定句的脚注另起一行，不挤在句末（挤在句末会换行成孤字）
    expect(wrapper.find('.verdict__confidence').text()).toBe('把握较大')
  })

  it('对象形态的步骤与证据可归一化', () => {
    const wrapper = mount(ConclusionSpine, {
      props: {
        conclusion: {
          rootCause: 'x',
          steps: [{ action: '卸载模组', reason: '版本冲突' }],
          evidence: [{ quote: 'ERROR 行', source: 'main.log' }],
        },
      },
    })
    expect(wrapper.text()).toContain('卸载模组（版本冲突）')
  })
})

describe('ScorePanel', () => {
  it('grounding 为 null 时显示「不参与评分」而不是 0', async () => {
    const score = assistant().score!
    const wrapper = mount(ScorePanel, {
      props: {
        score: {
          ...score,
          dimensions: { ...score.dimensions, grounding: null },
        },
      },
    })
    await wrapper.find('.score__toggle').trigger('click')
    expect(wrapper.text()).toContain('不参与评分')
    expect(wrapper.text()).toContain('—')
  })
})

describe('StepsPanel（调查步骤）', () => {
  const tools = assistant().tools
  const limitNotice = [{ kind: 'limit' as const, text: '已达轮次上限' }]

  it('结束后收起成一行摘要，失败数与提示仍可见', () => {
    const wrapper = mount(StepsPanel, {
      props: { tools, live: false, notices: limitNotice },
    })

    expect(wrapper.text()).toContain('调查步骤')
    expect(wrapper.text()).toContain('2 步')
    expect(wrapper.text()).toContain('1 次失败')
    // 提示不折叠：它会改变结论可信度
    expect(wrapper.text()).toContain('已达轮次上限')
    // 收起态不渲染步骤正文
    expect(wrapper.find('.list').exists()).toBe(false)
  })

  it('输出中每次只显示当前这一步（完整步骤，不是截断）', () => {
    const liveTools = [
      { index: 1, name: 'grep_log_file', args: { query: 'SIGSEGV' }, summary: '命中 3 行', done: true, failed: false },
      { index: 2, name: 'rag_search', args: { query: 'mixin' }, done: false, failed: false },
    ]
    const wrapper = mount(StepsPanel, {
      props: { tools: liveTools, live: true, notices: [] },
    })

    expect(wrapper.text()).toContain('正在调查')
    // 位置感
    expect(wrapper.text()).toContain('第 2 / 2 步')
    // 只渲染一步，且是「未完成的那一步」
    expect(wrapper.findAll('.item')).toHaveLength(1)
    expect(wrapper.text()).toContain('知识库')
    expect(wrapper.text()).not.toContain('检索日志')
  })

  it('输出中单步不做高度限制（完整显示动作、参数与结果）', () => {
    const wrapper = mount(StepsPanel, {
      props: { tools, live: true, notices: [] },
    })
    const list = wrapper.find('.list')
    expect(list.classes()).toContain('list--single')
    // 参数与结果都在
    expect(wrapper.text()).toContain('mixin')
    expect(wrapper.text()).toContain('工具调用失败: timeout')
  })

  it('展开后显示完整时间线', async () => {
    const wrapper = mount(StepsPanel, {
      props: { tools, live: false, notices: [] },
    })
    await wrapper.find('.steps__head').trigger('click')

    expect(wrapper.findAll('.item')).toHaveLength(2)
    expect(wrapper.text()).toContain('检索日志')
    expect(wrapper.text()).toContain('知识库')
    expect(wrapper.find('.list').classes()).not.toContain('list--single')
  })

  it('结束后自动收起（流式 → 完成的切换）', async () => {
    const wrapper = mount(StepsPanel, {
      props: { tools, live: true, notices: [] },
    })
    expect(wrapper.findAll('.item')).toHaveLength(1)

    await wrapper.setProps({ live: false })
    expect(wrapper.find('.list').exists()).toBe(false)
  })

  it('用户手动展开后，结束时不自动收起', async () => {
    const wrapper = mount(StepsPanel, {
      props: { tools, live: true, notices: [] },
    })

    await wrapper.find('.steps__head').trigger('click')
    expect(wrapper.findAll('.item')).toHaveLength(2)

    await wrapper.setProps({ live: false })
    expect(wrapper.findAll('.item')).toHaveLength(2)
  })
})

describe('ThinkingPanel（思维链）', () => {
  it('输出中自动显示并跟随（preview 态）', () => {
    const wrapper = mount(ThinkingPanel, {
      props: { reasoning: '先看崩溃锚点', thinkingTotal: 7, live: true },
    })

    expect(wrapper.text()).toContain('正在思考')
    expect(wrapper.text()).toContain('先看崩溃锚点')
    expect(wrapper.find('.thinking__body').classes()).toContain('thinking__body--preview')
  })

  it('结束后自动收起成一行', async () => {
    const wrapper = mount(ThinkingPanel, {
      props: { reasoning: '先看崩溃锚点', thinkingTotal: 7, live: true },
    })
    await wrapper.setProps({ live: false })

    expect(wrapper.text()).toContain('思维链')
    expect(wrapper.find('.thinking__body').exists()).toBe(false)
  })

  it('展开后显示完整文本', async () => {
    const wrapper = mount(ThinkingPanel, {
      props: { reasoning: '先看崩溃锚点', thinkingTotal: 7, live: false },
    })
    await wrapper.find('.thinking__head').trigger('click')

    expect(wrapper.text()).toContain('先看崩溃锚点')
    expect(wrapper.find('.thinking__body').classes()).not.toContain('thinking__body--preview')
  })

  it('没有思维链时不占位', () => {
    const wrapper = mount(ThinkingPanel, {
      props: { reasoning: '', thinkingTotal: 0, live: true },
    })
    expect(wrapper.find('.thinking').exists()).toBe(false)
  })
})

describe('KnowledgeList', () => {
  it('按性质过滤，并显示停用与优先级', async () => {
    const wrapper = mount(KnowledgeList, {
      props: {
        busy: false,
        keyword: '',
        entries: [
          {
            id: 'dk_1',
            content: '事实型条目',
            enabled: true,
            priority: 10,
            tags: ['渲染器'],
            kind: 'fact',
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: 'dk_2',
            content: '方法论条目',
            enabled: false,
            priority: 0,
            tags: [],
            kind: 'method',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
    })

    expect(wrapper.text()).toContain('事实型条目')
    expect(wrapper.text()).toContain('已停用')

    const methodButton = wrapper.findAll('.kinds__item').find((b) => b.text() === '方法论')
    await methodButton?.trigger('click')
    expect(wrapper.text()).not.toContain('事实型条目')
    expect(wrapper.text()).toContain('方法论条目')
  })
})
