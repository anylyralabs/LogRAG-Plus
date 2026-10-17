/**
 * 上传内容校验。
 *
 * ## 为什么要有这一层（LogShare 已经有校验了）
 *
 * 1. **纵深防御**：LogShare 是最终把关者，但它返回的是 400 + 一句错误；
 *    本服务在转发**之前**校验，能给用户「哪个文件、超了多少」的具体提示。
 * 2. **省一次跨网传输**：12MB 的包发过去再被拒，白耗带宽与配额。
 * 3. **本服务自身的内存安全**：不校验就等于让任意大小的请求体走一遍
 *    JSON 解析 + 正则预处理。
 *
 * ## 限制值来源
 * 与 LogShare 的 `UploadParser` 保持一致（10MB / 50000 行 / 200 文件 / 12MB 合计）。
 * 两边不一致会造成「本服务放行、LogShare 拒绝」的困惑，故此处刻意照抄而非自定。
 *
 * ## 文件名处理
 * 文件名会进入 LogShare 的存储层与 ZIP 展开路径。此处**拒绝**而非「清洗」含
 * 路径分隔符或 `..` 的名字——清洗会诱导调用方以为「什么都传得进来」，
 * 而拒绝能把问题暴露在上传方。这与 LogShare 对 ZIP 条目的处理策略一致。
 */

/** 主日志正文上限（字节） */
export const MAX_CONTENT_BYTES = 10 * 1024 * 1024;
/** 主日志行数上限 */
export const MAX_LINES = 50_000;
/** 附加文件数量上限 */
export const MAX_FILES = 200;
/** 附加文件合计字节上限 */
export const MAX_FILES_TOTAL_BYTES = 12 * 1024 * 1024;
/** 单个附加文件名字符数上限 */
export const MAX_FILENAME_CHARS = 128;
/** 来源标识格式：`启动器/版本`，如 `fcl/1.3.4.0` */
const SOURCE_RE = /^[A-Za-z0-9._-]{1,32}\/[A-Za-z0-9._+-]{1,32}$/;

export interface UploadFile {
  name: string;
  data: string;
}

export interface UploadInput {
  content: string;
  files: UploadFile[];
  source: string;
}

export interface ValidateOk {
  ok: true;
  value: UploadInput;
  /** 面向用户的提示（如「已忽略 N 个空文件」），非错误 */
  notes: string[];
}

export interface ValidateFail {
  ok: false;
  error: string;
}

export type ValidateResult = ValidateOk | ValidateFail;

/** 字节数：按 UTF-8 计算（与 LogShare 的存储计量一致） */
function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function lineCount(s: string): number {
  if (s === '') return 0;
  let n = 1;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) n++;
  }
  return n;
}

/**
 * 文件名是否安全。
 *
 * 拒绝而不是清洗的三个理由：
 *  - `..` 与分隔符只可能来自构造的攻击意图，或上传方写错了字段；
 *  - 清洗后可能产生重名（`a/../b` 与 `b` 都变成 `b`），掩盖真实问题；
 *  - 允许 NUL / 控制字符会让下游日志与文件名比较行为不可预期。
 */
export function isSafeFileName(name: string): boolean {
  if (name === '' || name.length > MAX_FILENAME_CHARS) return false;
  if (name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (name.includes('\0')) return false;
  // 控制字符（含换行）会破坏日志行结构与下游比较
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 32 || c === 127) return false;
  }
  return true;
}

/** 校验并归一化上传输入 */
export function validateUpload(raw: unknown): ValidateResult {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, error: '请求体必须是 JSON 对象' };
  }
  const obj = raw as Record<string, unknown>;

  // ── 主日志正文 ──
  let content = '';
  if (obj['content'] !== undefined) {
    if (typeof obj['content'] !== 'string') {
      return { ok: false, error: 'content 必须是字符串' };
    }
    content = obj['content'];
  }

  // ── 附加文件 ──
  const notes: string[] = [];
  const files: UploadFile[] = [];
  const rawFiles = obj['files'];

  if (rawFiles !== undefined) {
    if (!Array.isArray(rawFiles)) {
      return { ok: false, error: 'files 必须是数组' };
    }
    if (rawFiles.length > MAX_FILES) {
      return { ok: false, error: `附加文件最多 ${MAX_FILES} 个，实际 ${rawFiles.length} 个` };
    }

    for (let i = 0; i < rawFiles.length; i++) {
      const item = rawFiles[i];
      if (item === null || typeof item !== 'object') {
        return { ok: false, error: `files[${i}] 必须是对象` };
      }
      const f = item as Record<string, unknown>;
      const name = f['name'];
      const data = f['data'];

      if (typeof name !== 'string') {
        return { ok: false, error: `files[${i}].name 必须是字符串` };
      }
      if (typeof data !== 'string') {
        return { ok: false, error: `files[${i}].data 必须是字符串` };
      }
      if (!isSafeFileName(name)) {
        return {
          ok: false,
          error:
            `files[${i}].name 非法（${JSON.stringify(name)}）：` +
            '文件名不能包含路径分隔符、`..`、控制字符，且长度不超过 ' +
            `${MAX_FILENAME_CHARS}`,
        };
      }

      // 空文件直接丢弃：它只会占用存储与配额，且对分析无贡献。
      // 注意这是「提示」而非错误——用户从文件夹全选上传时夹带空文件很常见。
      if (data === '') {
        notes.push(`已忽略空文件 ${name}`);
        continue;
      }

      files.push({ name, data });
    }
  }

  // ── 至少要有一份内容 ──
  if (content === '' && files.length === 0) {
    return { ok: false, error: 'content 与 files 不能同时为空，没有可分析的日志内容' };
  }

  // ── 主日志大小与行数 ──
  const contentBytes = utf8Bytes(content);
  if (contentBytes > MAX_CONTENT_BYTES) {
    return {
      ok: false,
      error:
        `主日志 ${(contentBytes / 1024 / 1024).toFixed(1)}MB 超过上限 ` +
        `${MAX_CONTENT_BYTES / 1024 / 1024}MB`,
    };
  }
  const lines = lineCount(content);
  if (lines > MAX_LINES) {
    return { ok: false, error: `主日志 ${lines} 行超过上限 ${MAX_LINES} 行` };
  }

  // ── 附加文件合计 ──
  let totalBytes = contentBytes;
  for (const f of files) {
    totalBytes += utf8Bytes(f.data);
  }
  if (totalBytes > MAX_FILES_TOTAL_BYTES) {
    return {
      ok: false,
      error:
        `日志与附加文件合计 ${(totalBytes / 1024 / 1024).toFixed(1)}MB 超过上限 ` +
        `${MAX_FILES_TOTAL_BYTES / 1024 / 1024}MB`,
    };
  }

  // ── 来源标识 ──
  // 不合法就丢弃而不是报错：source 只影响分类统计，不该阻断上传。
  // 与 LogShare 的处理一致（无来源时统一记「未指定」）。
  let source = '';
  const rawSource = obj['source'];
  if (typeof rawSource === 'string' && SOURCE_RE.test(rawSource.trim())) {
    source = rawSource.trim();
  } else if (rawSource !== undefined && rawSource !== '' && rawSource !== null) {
    notes.push('来源标识格式不符（应形如 fcl/1.3.4.0），已忽略');
  }

  return { ok: true, value: { content, files, source }, notes };
}
