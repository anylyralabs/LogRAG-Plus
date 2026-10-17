/**
 * LogShare 日志 ID 的编解码（与 PHP `App\Id` 逐位对齐）。
 *
 * 编码（PHP Id::get()）：
 *   index = array_search(storageId, chars)
 *   foreach (rawId as ch) index += array_search(ch, chars)
 *   fullId = chars[index % count(chars)] . rawId
 *
 * 解码（PHP Id::decode()）：
 *   rawId = substr(fullId, 1)
 *   encodedStorageId = substr(fullId, 0, 1)
 *   index = array_search(encodedStorageId, chars) + strlen(rawId) * count(chars)
 *   foreach (rawId as ch) index -= array_search(ch, chars)
 *   storageId = chars[index % count(chars)]
 *
 * 注意：`id.characters` 与 `id.length` 是历史契约，不可变更（既有日志 ID 依赖它们）。
 * 本模块只做「解析存储后端」这一件事——用于判断该 ID 是否指向 MariaDB（'s'）
 * 还是文件系统（'f'）。仅当为 's' 时才直读 MariaDB。
 */

/** 与 Config.inc.php 的 id.characters 完全一致（顺序不可变） */
export const ID_CHARACTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';

/** 与 Config.inc.php 的 id.length 一致（rawId 长度） */
export const ID_RAW_LENGTH = 6;

/** 完整 ID 长度 = 1（存储标识）+ rawId 长度 */
export const ID_FULL_LENGTH = ID_RAW_LENGTH + 1;

export interface DecodedLogId {
  /** 完整 ID（如 "2usuLih"） */
  fullId: string;
  /** 去掉首位存储标识后的原始 ID */
  rawId: string;
  /** 存储后端标识：'s' = MariaDB，'f' = 文件系统 */
  storageId: string;
}

const CHAR_INDEX = new Map<string, number>(
  [...ID_CHARACTERS].map((ch, i) => [ch, i]),
);

/** 格式校验：长度与字符集都必须合法 */
export function isValidLogId(id: string): boolean {
  if (id.length !== ID_FULL_LENGTH) return false;
  for (const ch of id) {
    if (!CHAR_INDEX.has(ch)) return false;
  }
  return true;
}

/**
 * 解码完整 ID。格式非法时返回 null（调用方应回 404，而非抛异常——
 * 这是面向公网的输入，不可信任）。
 */
export function decodeLogId(fullId: string): DecodedLogId | null {
  if (!isValidLogId(fullId)) return null;

  const chars = ID_CHARACTERS;
  const count = chars.length;
  const rawId = fullId.slice(1);
  const encodedStorageId = fullId.slice(0, 1);

  const encodedIndex = CHAR_INDEX.get(encodedStorageId);
  if (encodedIndex === undefined) return null;

  // PHP 的 array_search 返回 false 时会参与算术（false == 0），但这里字符已在
  // isValidLogId 中校验过，故必然命中。
  let index = encodedIndex + rawId.length * count;
  for (const ch of rawId) {
    const chIndex = CHAR_INDEX.get(ch);
    if (chIndex === undefined) return null;
    index -= chIndex;
  }

  // JS 的 % 对负数返回负值，PHP 的 % 同样返回负值，但 array 索引取模在 PHP 中
  // 会得到正索引（$chars[-1] 实际是倒数第一个）。为与 PHP 行为一致，先归一化为正。
  const normalized = ((index % count) + count) % count;

  return {
    fullId,
    rawId,
    storageId: chars[normalized]!,
  };
}

/** 该 ID 是否指向 MariaDB（需要直读数据库） */
export function isMariaDbLogId(fullId: string): boolean {
  const decoded = decodeLogId(fullId);
  return decoded !== null && decoded.storageId === 's';
}
