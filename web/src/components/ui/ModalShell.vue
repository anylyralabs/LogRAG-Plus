<script setup lang="ts">
/**
 * 弹层基座。
 *
 * 用 Reka UI 的 Dialog 原语，而不是自己写 `position: fixed` + 点击遮罩：
 * 自己写的版本缺少**焦点陷阱**与 **Esc 关闭**，键盘用户会 tab 到背后的页面，
 * 屏幕阅读器也不知道这是一个对话框。这些是「看不见但必须对」的部分。
 *
 * 三种形态共用同一套原语，只换容器样式：
 *  - `drawer`：右侧抽屉（设置、会话栏、窄屏案卷）
 *  - `center`：居中对话框（编辑器）
 *  - `detail`：右侧详情（分析记录）
 *
 * 曾有 `sheet`（底部半屏）给追问用，已删：追问最终落在输入框正上方（AskDock），
 * 弹层会盖住用户要用来回答的输入框。
 */
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui'

const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    description?: string
    variant?: 'drawer' | 'center' | 'detail'
    /** 标题已在内容里视觉呈现时，只保留给屏幕阅读器的版本 */
    hideTitle?: boolean
  }>(),
  { variant: 'drawer', hideTitle: false },
)

const emit = defineEmits<{ 'update:open': [value: boolean] }>()

void props
</script>

<template>
  <DialogRoot :open="open" @update:open="emit('update:open', $event)">
    <DialogPortal>
      <DialogOverlay class="modal-overlay" />
      <DialogContent class="modal" :class="`modal--${variant}`">
        <DialogTitle :class="hideTitle ? 'visually-hidden' : 'modal__title'">{{ title }}</DialogTitle>
        <DialogDescription v-if="description !== undefined" class="modal__description">
          {{ description }}
        </DialogDescription>
        <slot />
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  /* 轻一点：遮罩太黑会让底下的纸面发脏 */
  background: var(--overlay);
  backdrop-filter: blur(1.5px);
  animation: fade var(--dur) var(--ease);
}

/*
 * 弹层是纸面上**再抬一层**：无边框，只用阴影与圆角表达「浮起来了」。
 * 早先是 1px 边框 + 2px 圆角，看起来像被裁切的一块，而不是悬浮物。
 */
.modal {
  position: fixed;
  z-index: 51;
  display: flex;
  flex-direction: column;
  /* 内容从顶部开始排，空余留在底部（不要居中） */
  justify-content: flex-start;
  background: var(--paper-raised);
  border: 0;
  box-shadow:
    0 1px 2px rgba(28, 27, 22, 0.08),
    0 24px 56px rgba(28, 27, 22, 0.18);
  outline: none;
  animation: rise 180ms var(--ease);
}

.modal--drawer,
.modal--detail {
  top: var(--sp-2);
  right: var(--sp-2);
  bottom: var(--sp-2);
  width: min(430px, calc(100vw - 16px));
  border-radius: var(--radius-field);
}

.modal--detail {
  width: min(470px, calc(100vw - 16px));
}

.modal--center {
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: min(620px, calc(100vw - 32px));
  max-height: 92dvh;
  border-radius: var(--radius-field);
}

.modal__title {
  padding: 16px 20px 6px;
  font-size: var(--fs-lead);
  font-weight: 600;
  letter-spacing: -0.01em;
}

.modal--center .modal__title {
  padding-right: 52px;
}

.modal__description {
  padding: 0 20px 10px;
  color: var(--ink-3);
  font-size: var(--fs-meta);
  line-height: 1.65;
}

@keyframes fade {
  from {
    opacity: 0;
  }
}

@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}

.modal--center {
  animation-name: pop;
}

@keyframes pop {
  from {
    opacity: 0;
    transform: translate(-50%, -48%);
  }
}

@media (max-width: 599px) {
  .modal--center {
    top: auto;
    bottom: 0;
    left: 0;
    transform: none;
    width: 100%;
    max-height: 94dvh;
    border-radius: var(--radius-field) var(--radius-field) 0 0;
    animation-name: rise;
  }

  .modal--drawer,
  .modal--detail {
    top: 0;
    right: 0;
    bottom: 0;
    width: 100%;
    border-radius: 0;
  }
}
</style>
