/**
 * 输入区形态守门。
 *
 * ## 三条都是实测出来的观感缺陷
 * 1. **聚焦后必须真的变高**：早先只换背景与内边距，空输入框聚焦后仍是一行，
 *    用户看不到「进入输入状态」。现在靠 `:focus-within` + JS 焦点双通道驱动。
 * 2. **上传入口要带加号与文字**：纸夹子图标不表达「上传」，而这是新手最需要
 *    发现的入口之一。
 * 3. **发送键与输入框底对齐**：早先动作区自固定高度，与文字基线差半行。
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import Composer from '@/components/chat/Composer.vue'

const WEB = resolve(process.cwd())

function read(rel: string): string {
  return readFileSync(`${WEB}/${rel}`, 'utf8')
}

describe('输入区', () => {
  const css = read('src/components/chat/Composer.vue')

  it('聚焦时展开到三行高（:focus-within 驱动，不依赖 JS 状态）', () => {
    // 纯视觉反馈必须由浏览器判定，否则某个 blur 没被处理就永远不展开
    expect(css).toContain(':focus-within')
    // 三行 ≈ 三行文字 + 内外 padding，实测值 92px
    expect(css).toMatch(/\.composer:focus-within\s*\{[^}]*min-height:\s*92px/s)
  })

  it('输入框本身也随之变高（不只是外框）', () => {
    expect(css).toMatch(/\.composer:focus-within \.composer__input\s*\{[^}]*min-height:/s)
  })

  it('blur 延迟处理，避免点按钮时先塌回去', () => {
    expect(css).toContain('onBlur')
    expect(css).toMatch(/setTimeout\([\s\S]{0,200}focused\.value = false/)
  })

  it('上传入口是「加号 + 文字」', () => {
    expect(css).toContain('composer__attach-text')
    expect(css).toContain('<Plus')
    expect(css).toContain('上传日志')
  })

  it('按钮与输入框底部对齐（grid align-items: end）', () => {
    expect(css).toMatch(/\.composer\s*\{[^}]*align-items:\s*end/s)
    // 早先这里写死 height: 24px，是「发送键比文字高半行」的来源
    expect(css).not.toMatch(/\.composer__actions\s*\{[^}]*height:\s*24px/s)
  })
})

describe('复制按钮位置', () => {
  const item = read('src/components/chat/MessageItem.vue')

  it('贴在内容末尾的动作行里，而不是消息头部右上角', () => {
    // 头部只保留状态
    expect(item).toMatch(/<header v-if="status !== null" class="report__head">/)
    // 复制在结论之后的 report__actions 里
    expect(item).toContain('report__actions')
    const actionsAt = item.indexOf('report__actions')
    const verdictAt = item.indexOf('<ConclusionSpine')
    expect(verdictAt).toBeGreaterThan(-1)
    expect(actionsAt).toBeGreaterThan(verdictAt)
  })
})

describe('网格不拉伸按钮', () => {
  const css = read('src/components/chat/Composer.vue')

  it('加号不随网格拉伸（否则展开态 hover 底色会铺满整行）', () => {
    // 展开态 attach 那一格横跨整行；grid 项默认 justify-self: stretch，
    // 按钮会被拉成整行宽，hover 时看起来像「选中了一整行」。
    const block = /\.composer__attach\s*\{([^}]*)\}/s.exec(css)?.[1] ?? ''
    expect(block).toContain('justify-self: start')
    expect(block).toContain('align-self: end')
  })

  it('发送/停止同样不被拉伸', () => {
    const block = /\.composer__send,\s*\n\.composer__stop\s*\{([^}]*)\}/s.exec(css)?.[1] ?? ''
    expect(block).toContain('justify-self: end')
    expect(block).toContain('align-self: end')
  })
})

describe('加号的位置随状态变化', () => {
  it('收起：加号在发送键左侧，且只显示图标', () => {
    const wrapper = mount(Composer, {
      props: { busy: false, phase: '', hasLog: false, quote: '' },
    })

    expect(wrapper.find('.composer').classes()).not.toContain('composer--expanded')

    // DOM 顺序就是视觉顺序：input → attach → send
    const html = wrapper.html()
    expect(html.indexOf('composer__input')).toBeLessThan(html.indexOf('composer__attach'))
    expect(html.indexOf('composer__attach')).toBeLessThan(html.indexOf('composer__send'))

    // 收起态不显示「上传日志」四个字（CSS 控制，但文本节点仍在）
    expect(wrapper.find('.composer__attach-text').exists()).toBe(true)
  })

  it('展开：加号与文字沉到左下，发送留在右下', async () => {
    const wrapper = mount(Composer, {
      props: { busy: false, phase: '', hasLog: false, quote: '' },
    })
    await wrapper.find('textarea').trigger('focus')

    expect(wrapper.find('.composer').classes()).toContain('composer--expanded')
    // 展开时「上传日志」四字必须可见（加号单独出现会被读成「新建对话」）
    expect(wrapper.find('.composer__attach').text()).toContain('上传日志')
  })

  it('两种布局用同一个按钮元素（不复制 DOM，避免焦点丢失）', async () => {
    const wrapper = mount(Composer, {
      props: { busy: false, phase: '', hasLog: false, quote: '' },
    })
    expect(wrapper.findAll('.composer__attach')).toHaveLength(1)

    await wrapper.find('textarea').trigger('focus')
    expect(wrapper.findAll('.composer__attach')).toHaveLength(1)
  })
})
