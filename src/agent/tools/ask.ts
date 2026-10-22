/**
 * 反问工具 —— 让模型在信息不足时向用户提问，而非臆测。
 *
 * ## 依据（27 份实测发现）
 * 模型已能识别信息缺口，但**无处可问**，只能把不确定性甩给用户。实测原话：
 *  - `GmcGNRk.log`：「日志里看不到 mods 列表，**这一点我无法从日志核实，请你自查**」
 *  - `latest_game.log`：「本机构未检索到既有条目，**该项未核实**」
 *
 * 这类「甩锅式结论」是 C 端体验的硬伤——用户不知道该提供什么、为什么要提供。
 *
 * ## 实现说明
 * 聊天形态下，AI 提问本身就是一条普通回复，**不需要特殊机制**。
 * 本工具的价值在于：
 *  1. 给模型一个**显式的、被鼓励的**提问动作（否则模型倾向于硬答）
 *  2. 统一提问格式，让前端可以特殊渲染（如高亮成「需要你补充」卡片）
 *  3. 记录「问了什么」，供后续轮次判断用户是否已答复
 */

import { tool } from 'langchain';
import * as z from 'zod';

export interface AskUserContext {
  /** 已问过的问题（避免重复追问） */
  asked: string[];
}

/** 单次最多问的问题数（超过会让用户不知所措） */
const MAX_QUESTIONS = 3;

/**
 * 已知的高价值追问项。
 *
 * 依据实测中「日志缺少即无法判定」的字段整理——这些信息**通常不在日志里**，
 * 但直接决定结论方向。
 */
export const HIGH_VALUE_QUESTIONS: ReadonlyArray<{ field: string; why: string; example: string }> = [
  {
    field: '设备型号 / SoC',
    why: '移动端渲染器与驱动兼容性依赖具体 GPU/SoC，日志常不完整',
    example: '你的手机是什么型号？（设置 → 关于手机里能看到）',
  },
  {
    field: '渲染器名称与版本',
    why: '渲染器是移动端崩溃的首要原因，日志有时不记录',
    example: '启动器里当前用的是哪个渲染器？（如 MobileGlues / ANGLE / LTW）',
  },
  {
    field: 'Java 运行时版本',
    why: '版本不匹配会导致启动即崩，且 JVM 参数常不完整',
    example: '启动器设置的 Java 版本是多少？（如 Internal-17 / Internal-21）',
  },
  {
    field: '模组列表',
    why: '依赖冲突与版本错配无法从崩溃栈完整推断',
    example: '能把 mods 文件夹的截图发一下吗？或者告诉我大概装了多少个模组',
  },
  {
    field: '崩溃前的操作',
    why: '区分「一直如此」与「刚改过配置」决定修复方向',
    example: '崩溃前你做了什么操作？（比如刚装了模组、改了设置）',
  },
  {
    field: '是否必现',
    why: '偶发问题多为资源竞争或内存，必现多为配置/兼容性',
    example: '每次进游戏都这样，还是偶尔出现？',
  },
  {
    field: '启动器版本',
    why: '新版 MC 的兼容性修复通常随启动器更新发布',
    example: '启动器是哪个版本？（启动器设置 → 关于 里能看到）',
  },
  {
    field: '游戏版本与加载器',
    why: '决定模组兼容范围',
    example: '你玩的是哪个 Minecraft 版本？用的 Fabric 还是 Forge？',
  },
];

/**
 * 构建反问工具。
 */
export function buildAskTool(ctx: AskUserContext) {
  return tool(
    async ({ questions, reason }) => {
      const list = questions.slice(0, MAX_QUESTIONS);
      const asked = list.filter((q) => q.trim() !== '');

      if (asked.length === 0) {
        return '未提供有效问题。若要继续分析，请直接给出结论并标注未核实项。';
      }

      // 去重（避免追问已经问过的）
      const fresh = asked.filter((q) => !ctx.asked.includes(q));
      if (fresh.length === 0) {
        return '这些问题此前已问过。请基于用户已提供的信息给出结论，或换一个角度提问。';
      }

      for (const q of fresh) ctx.asked.push(q);

      // 返回给模型的提示：明确告知这是「向用户提问」，需在正文中体现
      return [
        `已向用户提出 ${fresh.length} 个问题：`,
        ...fresh.map((q, i) => `  ${i + 1}. ${q}`),
        '',
        reason !== undefined && reason !== '' ? `提问原因：${reason}` : '',
        '',
        '你的正文只需两三句：缺什么信息、为什么要、拿到后怎么判断。' +
          '直接对用户说话，**不要说是「调用工具」**——这是你自己在问，不是机器动作。',
        '日志里能查到的东西不要问；只问那些**日志里必然没有**的信息，不要臆测。',
        '',
        '⚠️ **不要复述上面这些问题**——它们已由工具结构化下发给界面，会渲染成可作答的输入框。' +
          '正文再写一遍就是同一件事说两次，用户会分不清该看哪份。',
        '⚠️ **不要给结论、不要输出结构化 JSON 块**：这一轮没有结论，给出来只能是猜的。',
        '⚠️ **本轮到此为止**：不要再调用任何工具。用户正在等回答，继续检索会让他干等。',
      ]
        .filter((s) => s !== '')
        .join('\n');
    },
    {
      name: 'ask_user',
      description:
        '当日志缺少关键信息、无法给出可靠结论时，向用户提问以补全信息。' +
        '**在以下情况应主动使用**：设备型号/SoC 不明、渲染器不明、Java 版本不明、模组列表缺失、' +
        '不知崩溃前的操作、不知是否必现。' +
        '不要臆测这些信息——问用户比猜更专业，也更省用户的时间。' +
        `一次最多问 ${MAX_QUESTIONS} 个问题，并按重要性排序。`,
      schema: z.object({
        questions: z
          .array(z.string())
          .min(1)
          .max(MAX_QUESTIONS)
          .describe(
            `要向用户提的问题，最多 ${MAX_QUESTIONS} 个。问题要具体、可回答，` +
              '例如「你的手机是什么型号？」而非「请提供更多信息」',
          ),
        reason: z
          .string()
          .optional()
          .describe('简要说明为什么要问这些（会让用户理解配合的价值）'),
      }),
    },
  );
}

/** 供提示词引用的追问清单（帮助模型知道该问什么） */
export function describeHighValueQuestions(): string {
  const lines = ['以下信息通常不在日志里，但直接决定结论方向——缺失时应向用户提问：', ''];
  for (const q of HIGH_VALUE_QUESTIONS) {
    lines.push(`- **${q.field}**：${q.why}`);
    lines.push(`  示例：「${q.example}」`);
  }
  return lines.join('\n');
}
