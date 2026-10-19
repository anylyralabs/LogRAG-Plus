<script setup lang="ts">
/**
 * Markdown 渲染。
 *
 * **全程不用 `v-html`**：模型输出必然混着用户日志原文（`<`、`&`、用户自己贴的 HTML
 * 都是常态）。这里把文本解析成结构化节点，交给 Vue 模板渲染——Vue 默认转义，
 * XSS 从机制上不成立，而不是靠过滤器拦。
 *
 * 只支持模型实际会用的子集：段落、标题、列表、代码块、行内代码、粗体。
 * 引入完整 Markdown 库会带来 raw HTML 选项，那正是要避免的。
 */
const props = defineProps<{ text: string }>()

type Block =
  | { kind: 'p'; inline: Inline[] }
  | { kind: 'h'; level: number; inline: Inline[] }
  | { kind: 'ul'; items: Inline[][] }
  | { kind: 'ol'; items: Inline[][] }
  | { kind: 'code'; lang: string; content: string }

type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; text: string }

/** 行内解析：`code` 与 **strong**，其余按文本 */
function parseInline(raw: string): Inline[] {
  const out: Inline[] = []
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)/g
  let last = 0
  let m: RegExpExecArray | null

  while ((m = re.exec(raw)) !== null) {
    if (m.index > last) out.push({ kind: 'text', text: raw.slice(last, m.index) })
    const token = m[0]
    if (token.startsWith('`')) {
      out.push({ kind: 'code', text: token.slice(1, -1) })
    } else {
      out.push({ kind: 'strong', text: token.slice(2, -2) })
    }
    last = m.index + token.length
  }
  if (last < raw.length) out.push({ kind: 'text', text: raw.slice(last) })
  return out
}

const blocks = computed<Block[]>(() => {
  const lines = props.text.split('\n')
  const out: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ''

    // 围栏代码块
    if (/^```/.test(line.trim())) {
      const lang = line.trim().slice(3).trim()
      const body: string[] = []
      i++
      while (i < lines.length && !/^```/.test((lines[i] ?? '').trim())) {
        body.push(lines[i] ?? '')
        i++
      }
      i++
      out.push({ kind: 'code', lang, content: body.join('\n') })
      continue
    }

    // 标题
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h !== null) {
      out.push({ kind: 'h', level: (h[1] ?? '#').length, inline: parseInline(h[2] ?? '') })
      i++
      continue
    }

    // 无序列表
    if (/^[-*]\s+/.test(line)) {
      const items: Inline[][] = []
      while (i < lines.length && /^[-*]\s+/.test(lines[i] ?? '')) {
        items.push(parseInline((lines[i] ?? '').replace(/^[-*]\s+/, '')))
        i++
      }
      out.push({ kind: 'ul', items })
      continue
    }

    // 有序列表
    if (/^\d+\.\s+/.test(line)) {
      const items: Inline[][] = []
      while (i < lines.length && /^\d+\.\s+/.test(lines[i] ?? '')) {
        items.push(parseInline((lines[i] ?? '').replace(/^\d+\.\s+/, '')))
        i++
      }
      out.push({ kind: 'ol', items })
      continue
    }

    // 空行
    if (line.trim() === '') {
      i++
      continue
    }

    // 段落：连续非空行合并
    const para: string[] = []
    while (i < lines.length && (lines[i] ?? '').trim() !== '' && !/^(#{1,4}\s|[-*]\s|\d+\.\s|```)/.test(lines[i] ?? '')) {
      para.push(lines[i] ?? '')
      i++
    }
    out.push({ kind: 'p', inline: parseInline(para.join(' ')) })
  }

  return out
})
</script>

<template>
  <div class="flex flex-col gap-3">
    <template v-for="(b, i) in blocks" :key="i">
      <h3
        v-if="b.kind === 'h'"
        class="font-semibold text-[var(--ui-text-highlighted)]"
        :class="b.level <= 2 ? 'text-base mt-1' : 'text-sm'"
      >
        <template v-for="(seg, j) in b.inline" :key="j">
          <code v-if="seg.kind === 'code'" class="bg-[var(--ui-bg-muted)] px-1 font-mono text-[0.9em]">{{ seg.text }}</code>
          <strong v-else-if="seg.kind === 'strong'">{{ seg.text }}</strong>
          <template v-else>{{ seg.text }}</template>
        </template>
      </h3>

      <p v-else-if="b.kind === 'p'" class="leading-relaxed break-words">
        <template v-for="(seg, j) in b.inline" :key="j">
          <code v-if="seg.kind === 'code'" class="bg-[var(--ui-bg-muted)] px-1 py-0.5 font-mono text-[0.9em] text-[var(--ui-primary)]">{{ seg.text }}</code>
          <strong v-else-if="seg.kind === 'strong'" class="font-semibold text-[var(--ui-text-highlighted)]">{{ seg.text }}</strong>
          <template v-else>{{ seg.text }}</template>
        </template>
      </p>

      <ul v-else-if="b.kind === 'ul'" class="flex list-disc flex-col gap-1.5 pl-5">
        <li v-for="(item, j) in b.items" :key="j" class="leading-relaxed break-words">
          <template v-for="(seg, k) in item" :key="k">
            <code v-if="seg.kind === 'code'" class="bg-[var(--ui-bg-muted)] px-1 font-mono text-[0.9em]">{{ seg.text }}</code>
            <strong v-else-if="seg.kind === 'strong'" class="font-semibold">{{ seg.text }}</strong>
            <template v-else>{{ seg.text }}</template>
          </template>
        </li>
      </ul>

      <ol v-else-if="b.kind === 'ol'" class="flex list-decimal flex-col gap-1.5 pl-5">
        <li v-for="(item, j) in b.items" :key="j" class="leading-relaxed break-words">
          <template v-for="(seg, k) in item" :key="k">
            <code v-if="seg.kind === 'code'" class="bg-[var(--ui-bg-muted)] px-1 font-mono text-[0.9em]">{{ seg.text }}</code>
            <strong v-else-if="seg.kind === 'strong'" class="font-semibold">{{ seg.text }}</strong>
            <template v-else>{{ seg.text }}</template>
          </template>
        </li>
      </ol>

      <pre
        v-else-if="b.kind === 'code'"
        class="overflow-x-auto border-l-2 border-[var(--ui-border-accented)] bg-[var(--ui-bg-muted)] py-2.5 pl-3 font-mono text-[11px] leading-[1.65] text-[var(--ui-text-toned)]"
      >{{ b.content }}</pre>
    </template>
  </div>
</template>
