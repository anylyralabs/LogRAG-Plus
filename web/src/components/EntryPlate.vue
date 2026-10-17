<script setup lang="ts">
/**
 * 入口面板：尚未绑定日志时的那一屏。
 *
 * ## 为什么不是「撒三张大卡片」
 *
 * 三条入口（LogShare 跳转 / 上传文件 / 粘贴文本）不是三个卖点，是**三条不同的
 * 操作路径**，各自只对一类用户成立。所以这里用一张发丝线表格来排：左边是途径，
 * 中间是它长什么样（真实的文件名与 URL 形状），右边才是按钮。
 * 「长什么样」这一列是关键——用户认的是 `main.log` 这个文件名和自己的地址栏，
 * 不是「上传文件」这四个字。
 *
 * ## 为什么这一屏刻意安静
 *
 * 这个产品的记忆点应该在**日志面板与结论脊柱**上（那份 2600 行的日志能被指认），
 * 而不是首屏。首屏若也用力，两处就互相抵消了；留白 + 一张表，正好把注意力
 * 交给用户接下来的动作。
 */
import { ref } from 'vue';
import Icon from './Icon.vue';

const emit = defineEmits<{
  useId: [id: string];
  pickFile: [];
  openPaste: [];
}>();

const idInput = ref('');

function submitId(): void {
  const v = idInput.value.trim();
  if (v === '') return;
  // 允许直接粘整条链接：从 LogShare 复制过来的常常是完整 URL
  const m = /\/([0-9A-Za-z]{7})(?:[/?#]|$)/.exec(v);
  emit('useId', m?.[1] ?? v);
  idInput.value = '';
}
</script>

<template>
  <section class="entry">
    <h1 class="entry__h">读 Minecraft 崩溃日志</h1>
    <p class="entry__lede">
      给出根因与处置步骤，每条判断都指到日志里的具体行。客户端与服务端都能读，
      Fabric / Forge / NeoForge 都在覆盖范围内，手机启动器（FCL、ZL2、axolotl）写出的日志同样可以。
    </p>

    <div class="routes">
      <div class="route">
        <span class="route__name">从 LogShare 跳转</span>
        <span class="route__shape mono">/logshare/<em>1Z9zcMS</em></span>
        <form class="route__act" @submit.prevent="submitId">
          <input
            v-model="idInput"
            class="input route__input"
            type="text"
            inputmode="text"
            placeholder="粘贴链接或日志 ID"
            aria-label="日志 ID 或链接"
          />
          <button class="btn" type="submit" :disabled="idInput.trim() === ''">读取</button>
        </form>
      </div>

      <div class="route">
        <span class="route__name">上传文件</span>
        <span class="route__shape mono">main.log · 崩溃报告 · 启动器日志</span>
        <div class="route__act">
          <button class="btn" type="button" @click="emit('pickFile')">
            <Icon name="upload" :size="14" />选择文件
          </button>
        </div>
      </div>

      <div class="route">
        <span class="route__name">粘贴文本</span>
        <span class="route__shape mono">从启动器里复制的一段</span>
        <div class="route__act">
          <button class="btn" type="button" @click="emit('openPaste')">
            <Icon name="clipboard" :size="14" />粘贴
          </button>
        </div>
      </div>
    </div>

    <p class="hint entry__hint">
      上传的日志会先经 LogShare 做敏感信息脱敏与去重；粘贴的文本不写入服务器，只随本次对话送出。
    </p>
  </section>
</template>

<style scoped>
.entry {
  display: flex;
  flex-direction: column;
  gap: var(--s5);
  padding: var(--s6) 0 var(--s4);
}

.entry__h {
  font-size: var(--t-h3);
  max-width: 24ch;
}

@media (max-width: 560px) {
  .entry__h {
    font-size: var(--t-h4);
  }
}

.entry__lede {
  max-width: 56ch;
  color: var(--text-2);
}

.routes {
  border-top: 1px solid var(--line);
}

/* 一行一条路径：名称 / 形状 / 动作。窄屏自动折成两段 */
.route {
  display: grid;
  grid-template-columns: 9em minmax(0, 1fr) auto;
  gap: var(--s4);
  align-items: center;
  padding: var(--s4) 0;
  border-bottom: 1px solid var(--line);
}

@media (max-width: 720px) {
  .route {
    grid-template-columns: 1fr;
    gap: var(--s2);
    align-items: start;
  }
}

.route__name {
  font-size: var(--t-small);
  color: var(--text);
}

.route__shape {
  font-size: var(--t-caption);
  color: var(--text-3);
  overflow-wrap: anywhere;
}

.route__shape em {
  color: var(--text-2);
  font-style: normal;
}

.route__act {
  display: flex;
  gap: var(--s2);
  align-items: center;
}

.route__input {
  width: 15em;
  padding: var(--s2) var(--s3);
}

@media (max-width: 720px) {
  .route__input {
    width: 100%;
    flex: 1;
  }
}

.entry__hint {
  max-width: 64ch;
}
</style>
