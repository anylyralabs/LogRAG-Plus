/**
 * 日志文档的解析：分节、严重度粗筛、行窗口。
 *
 * ## 为什么要有「分节」
 *
 * LogShare 的 raw 接口把多份文件拼成一份，用 `===== 文件名 =====` 分节。
 * 实测一份 2604 行的移动端日志是四份拼起来的：
 *
 * ```
 * 第    1 行  ===== launcher_log.txt =====
 * 第  661 行  ===== hs_err_pid4316.log =====      ← 真正的崩溃现场（JVM 原生层）
 * 第 1972 行  ===== latest.log =====              ← 游戏日志主体
 * 第 2590 行  ===== authlib-injector.log =====    ← 登录注入器
 * ```
 *
 * 也就是说「日志」并不是一份平铺的文件，而是**有几节、节名就是文件名**。面板如果
 * 只给一个滚动条，用户要在 2604 行里靠肉眼找那一节；给出节名就是把这个结构还回去。
 *
 * ## 为什么严重度只分四档，且 INFO 不高亮
 *
 * 日志里 INFO 占绝大多数。**高亮的行数一多，高亮就等于没有**——这是本项目
 * 反复踩的同一类问题（「出现频率高 ≠ 有价值」）。所以只有 ERROR / WARN 上色，
 * 堆栈帧与 DEBUG/TRACE 反而压暗，形成「暗底上少数亮线」的层次。
 *
 * 需要说清的是：**这里的判断只是「帮你找到该看哪」的粗筛**，不是结论。
 * 真正的根因判断由模型给出（它读的是全文，不只这一屏）。
 */

export type Severity = 'error' | 'warn' | 'info' | 'dim' | 'plain';

export interface LogSection {
  /** 节名（原始文件名） */
  name: string;
  /** 中文角色，如「崩溃现场」 */
  role: string;
  /** 起始行号（1 基，含） */
  start: number;
  /** 结束行号（1 基，含） */
  end: number;
}

export interface ParsedLog {
  /** 原始行（不含换行符） */
  lines: string[];
  sections: LogSection[];
  /** 严重度按行号索引（0 基） */
  severity: Severity[];
  /** 错误行号（1 基），供「上一处 / 下一处错误」跳转 */
  errors: number[];
  counts: { error: number; warn: number };
}

const SECTION_RE = /^={3,}\s*(.+?)\s*={3,}$/;

const ROLE_BY_NAME: Array<{ test: RegExp; role: string }> = [
  { test: /hs_err|crash|crash-report|fatal/i, role: '崩溃现场' },
  { test: /launcher|launcher_log|fcl|zl2|axolotl/i, role: '启动器日志' },
  { test: /latest|\.log$/i, role: '游戏日志' },
  { test: /authlib|injector/i, role: '登录注入器' },
];

function roleOf(name: string): string {
  for (const r of ROLE_BY_NAME) if (r.test.test(name)) return r.role;
  return '其它';
}

/**
 * 行内级别判定。
 *
 * 覆盖本项目实际见到的几种形状（顺序即优先级）：
 *   `[12:34:56] [main/ERROR]: …`      日志框架
 *   `[12:34:56] [Render thread/WARN]:`
 *   `E/AndroidRuntime: FATAL EXCEPTION`  Android logcat
 *   `#  EXCEPTION_ACCESS_VIOLATION`      hs_err 头（行首 `#` 是它的注释符）
 *   `Caused by: java.lang.…`            异常链
 *   `\tat com.foo.Bar(Baz.java:1)`      堆栈帧
 */
export function classify(line: string): Severity {
  const t = line.trim();

  if (t === '') return 'plain';

  // 堆栈帧与 hs_err 的值行：压暗。它们数量大且单独看没有意义
  if (/^at\s+[\w$.<>/]+\s*\(/.test(t)) return 'dim';
  if (/^\.\.\.\s+\d+\s+more$/.test(t)) return 'dim';
  if (/^#[ \t]+[A-Z]\w*\s+\[/.test(t)) return 'dim';
  if (/^#\s*$/.test(t)) return 'dim';

  // hs_err 里带 `#` 的报错行
  if (/^#[ \t]*(EXCEPTION_|SIGSEGV|SIGBUS|SIGILL|SIGFPE)/i.test(t)) return 'error';
  if (/^#[ \t]*Problematic frame:/i.test(t)) return 'error';
  if (/^#[ \t]*(Internal Error|Out of Memory Error)/i.test(t)) return 'error';

  // 异常链：`Caused by:` 与 `Suppressed:` 都是错误的一部分
  if (/^(Caused by|Suppressed):/.test(t)) return 'error';

  // Android：`E/…`、`W/…`
  if (/^E\/[\w.$-]+.*(FATAL EXCEPTION|Exception|Error)/.test(t)) return 'error';
  if (/^(FATAL|ERROR|SEVERE)\b/.test(t)) return 'error';
  if (/^W\/[\w.$-]+/.test(t)) return 'warn';
  if (/^(WARN|WARNING)\b/.test(t)) return 'warn';

  // 日志框架：`[时间] [线程/级别]:`
  const level = /\[(?:[^\]/]*\/)?(FATAL|ERROR|SEVERE|WARN|WARNING|INFO|DEBUG|TRACE|NOTICE)\]/i.exec(t.slice(0, 80));
  if (level !== null) {
    const lv = (level[1] ?? '').toUpperCase();
    if (lv === 'FATAL' || lv === 'ERROR' || lv === 'SEVERE') return 'error';
    if (lv === 'WARN' || lv === 'WARNING') return 'warn';
    // INFO 不上色：它占绝大多数，上色则等于无层次
    if (lv === 'DEBUG' || lv === 'TRACE') return 'dim';
    return 'plain';
  }

  // 无级别的裸错误特征（模组/加载器常直接抛一行）
  if (/\b(FATAL|ERROR|SEVERE|Exception|Error)\b/.test(t.slice(0, 120))) {
    if (/^(Failed|Could not|Unable to|Missing|No |Cannot)\b/.test(t)) return 'warn';
  }

  return 'plain';
}

/** 解析一次，结果给面板与「跳转」共用 */
export function parseLog(content: string): ParsedLog {
  const lines = content.split('\n');

  const severity: Severity[] = new Array(lines.length);
  const errors: number[] = [];
  let errCount = 0;
  let warnCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const s = classify(lines[i] ?? '');
    severity[i] = s;
    if (s === 'error') {
      errCount++;
      errors.push(i + 1);
    } else if (s === 'warn') {
      warnCount++;
    }
  }

  const sections: LogSection[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = SECTION_RE.exec((lines[i] ?? '').trim());
    if (m === null || m[1] === undefined) continue;
    const prev = sections[sections.length - 1];
    if (prev !== undefined) prev.end = i; // 上一节到本标记前一行结束
    sections.push({ name: m[1], role: roleOf(m[1]), start: i + 1, end: lines.length });
  }

  return { lines, sections, severity, errors, counts: { error: errCount, warn: warnCount } };
}

/**
 * 取一段行的原文（1 基、闭区间），用于「引用这几行」。
 *
 * 返回的文本**不带行号**——行号是界面的坐标，模型不需要；
 * 带了反而会让模型把行号也当成日志内容引用出来。
 * 调用方负责在引用块外写清「哪份文件、第几行到第几行」。
 */
export function sliceLines(parsed: ParsedLog, from: number, to: number): string {
  const a = Math.max(1, Math.min(from, to));
  const b = Math.min(parsed.lines.length, Math.max(from, to));
  return parsed.lines.slice(a - 1, b).join('\n');
}

/** 从 `from` 起往后找第一处错误（找不到则回绕到开头）；`from` 已是错误则取四处 */
export function nextError(errors: number[], from: number): number | null {
  if (errors.length === 0) return null;
  for (const n of errors) if (n > from) return n;
  return errors[0] ?? null;
}

export function prevError(errors: number[], from: number): number | null {
  if (errors.length === 0) return null;
  for (let i = errors.length - 1; i >= 0; i--) {
    const n = errors[i];
    if (n !== undefined && n < from) return n;
  }
  return errors[errors.length - 1] ?? null;
}
