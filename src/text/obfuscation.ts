/**
 * 混淆特征检测 —— 解决反混淆的时序竞争。
 *
 * ## 问题
 * LogShare 的反混淆是**异步**的（EventQueue → DeobfuscateHandler），且不写任何
 * 「已完成」状态位。用户上传后立刻跳转，本服务可能读到**未反混淆**的日志。
 *
 * 混淆栈对分析是灾难：模组名全是 `com.example.a.b`，无法定位问题。
 * 实测中 `launcher_crash.log` 就是纯混淆栈（`z06 cannot be cast to i8b`）。
 *
 * ## 方案（不需改 PHP）
 * 用 Yarn 官方映射的命名特征检测：未反混淆的 Minecraft 日志含大量
 * `class_NNNN` / `method_NNNN` / `field_NNNN`（Yarn 的 intermediary 命名）。
 * 正常日志偶有命中，混淆日志成百上千。
 *
 * 配合重试：created 距今 < 60s 时等待重试，否则明确告知用户。
 */

/** Yarn intermediary 命名：class_1234 / method_5678 / field_9012 */
const INTERMEDIARY = /\b(?:class|method|field)_\d{3,6}\b/g;

/** 阈值：正常日志偶有命中（如日志中提及 class_1234 作为示例），混淆日志远超此值 */
const OBFUSCATION_THRESHOLD = 20;

export interface ObfuscationReport {
  /** 是否疑似未反混淆 */
  obfuscated: boolean;
  /** 命中数量 */
  matches: number;
  /** 命中的样例（供诊断与用户提示） */
  samples: string[];
}

/**
 * 检测日志是否疑似未反混淆。
 *
 * 注意：仅对 Minecraft Java 版日志有意义。启动器自身的混淆栈（如 Zalith 的
 * `z06 cannot be cast to i8b`）不产生 `class_NNNN`，不会被此检测识别——
 * 那类日志本身就无法反混淆，应在提示词层面引导模型识别。
 */
export function detectObfuscation(content: string): ObfuscationReport {
  const found = content.match(INTERMEDIARY) ?? [];
  const unique = [...new Set(found)];

  return {
    obfuscated: found.length > OBFUSCATION_THRESHOLD,
    matches: found.length,
    samples: unique.slice(0, 5),
  };
}

export interface ReadinessInput {
  /** 日志内容 */
  content: string;
  /** 日志创建时间（秒级时间戳） */
  createdAt: number;
  /** 当前时间（秒级时间戳），默认取系统时间 */
  now?: number;
  /** 等待宽限期（秒）：期间内视为「反混淆可能仍在进行」 */
  graceSeconds?: number;
}

export interface ReadinessVerdict {
  /** 可以开始分析 */
  ready: boolean;
  /** 未就绪时的处理建议 */
  action: 'proceed' | 'retry' | 'warn';
  /** 面向用户的说明 */
  message: string;
  report: ObfuscationReport;
}

/**
 * 判定日志是否就绪（反混淆完成）。
 *
 * - 未检出混淆 → 就绪
 * - 检出混淆且仍在宽限期内 → retry（反混淆可能还在跑）
 * - 检出混淆且已超宽限期 → warn（反混淆失败或该日志无需反混淆）
 */
export function checkReadiness(input: ReadinessInput): ReadinessVerdict {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const grace = input.graceSeconds ?? 60;
  const report = detectObfuscation(input.content);

  if (!report.obfuscated) {
    return {
      ready: true,
      action: 'proceed',
      message: '日志已就绪。',
      report,
    };
  }

  const age = now - input.createdAt;

  if (age < grace) {
    return {
      ready: false,
      action: 'retry',
      message: '日志正在预处理（反混淆）中，请稍候…',
      report,
    };
  }

  return {
    ready: true, // 允许继续，但明确告知限制
    action: 'warn',
    message: [
      '⚠️ 该日志包含大量未反混淆的类名（如 class_1234），分析能力将受限。',
      '可能原因：映射表未覆盖此版本，或反混淆处理失败。',
      '建议：稍后重试，或在 LogShare 侧确认反混淆状态。',
    ].join('\n'),
    report,
  };
}
