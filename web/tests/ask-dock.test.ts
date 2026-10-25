/**
 * 追问面板（`ask_user`）交互守门。
 *
 * ## 位置决定形态
 * 追问贴在**输入框上方**、与输入框同宽，而不是半屏弹层：
 * 弹层会盖住输入框，而用户要做的恰恰是「在输入框里回答」，两者抢同一块位置。
 * 也不内联在消息流里——那样用户得滚回去找。
 *
 * 这里守四件事：
 *  1. 面板常驻不动（不是 modal，不需要点开），新问题到达即可作答；
 *  2. 只填部分项也能提交，按「问题 + 换行 + 答案」拼成普通用户消息；
 *  3. 可以收起（稍后再答），收起后仍有入口；
 *  4. 流式中不可提交。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

import AskDock from '@/components/chat/AskDock.vue'
import type { AskPayload } from '@/lib/types'

const ASKS: AskPayload[] = [
  {
    questions: ['你的手机是什么型号？', '启动器里用的是哪个渲染器？'],
    reason: '渲染器兼容性依赖具体 GPU，日志里没有记录',
  },
]

function mountDock(props: Record<string, unknown> = {}) {
  return mount(AskDock, {
    props: { asks: ASKS, ...props },
    attachTo: document.body,
  })
}

function inputs(): HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>('.ask__input')]
}

function buttonByText(wrapper: ReturnType<typeof mountDock>, text: string) {
  return wrapper.findAll('button').find((b) => b.text().includes(text))
}

/** 在受控 input 上模拟输入（Vue 的 v-model 监听 input 事件） */
async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value
  input.dispatchEvent(new Event('input'))
  await nextTick()
}

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ''
})

describe('AskDock', () => {
  it('常驻显示，不是需要点开的弹层', () => {
    const wrapper = mountDock()
    // 没有 dialog / overlay
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.querySelector('.modal-overlay')).toBeNull()
    // 问题与输入位直接可见
    expect(wrapper.text()).toContain('需要你补充 2 项信息')
    expect(inputs()).toHaveLength(2)
  })

  it('原因一并展示，用户知道为什么要答', () => {
    const wrapper = mountDock()
    expect(wrapper.text()).toContain('渲染器兼容性依赖具体 GPU')
  })

  it('只填一项即可提交，格式为「问题 + 换行 + 答案」', async () => {
    const wrapper = mountDock()
    await typeInto(inputs()[0]!, 'Pixel 8')

    const submit = buttonByText(wrapper, '提交并继续')
    expect(submit).toBeDefined()
    await submit!.trigger('click')

    const emitted = wrapper.emitted('answer')
    expect(emitted).toHaveLength(1)
    expect(emitted?.[0]?.[0]).toBe('你的手机是什么型号？\nPixel 8')
  })

  it('一项都没填时提交按钮禁用', () => {
    const wrapper = mountDock()
    expect(buttonByText(wrapper, '提交并继续')?.attributes('disabled')).toBeDefined()
  })

  it('在任一输入框按回车提交整份答案', async () => {
    const wrapper = mountDock()
    await typeInto(inputs()[0]!, 'Pixel 8')
    await typeInto(inputs()[1]!, 'MobileGlues')

    await inputs()[1]!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, bubbles: true }),
    )
    await nextTick()

    const emitted = wrapper.emitted('answer')
    expect(emitted).toHaveLength(1)
    expect(emitted?.[0]?.[0]).toContain('Pixel 8')
    expect(emitted?.[0]?.[0]).toContain('MobileGlues')
  })

  it('可以收起，收起后仍能展开', async () => {
    const wrapper = mountDock()
    await wrapper.find('[aria-label="稍后再答"]').trigger('click')

    expect(inputs()).toHaveLength(0)
    expect(wrapper.text()).toContain('需要你补充 2 项信息')

    await wrapper.find('.dock__reopen').trigger('click')
    expect(inputs()).toHaveLength(2)
  })

  it('重复的问题只渲染一次', () => {
    const wrapper = mountDock({
      asks: [
        { questions: ['同一个问题？'] },
        { questions: ['同一个问题？', '另一个问题？'] },
      ],
    })
    expect(wrapper.findAll('.ask')).toHaveLength(2)
  })

  it('流式中禁止提交', async () => {
    const wrapper = mountDock({ disabled: true })
    await typeInto(inputs()[0]!, 'Pixel 8')
    expect(buttonByText(wrapper, '提交并继续')?.attributes('disabled')).toBeDefined()
  })
})
