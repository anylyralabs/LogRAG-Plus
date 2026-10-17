/** 展示层格式化：体积、时间、ID、配额文案。全部只做展示，不参与判断逻辑。 */

/** 人类可读体积。日志体积跨度很大（几百字节到 10MB），必须带单位且不四舍五入到 0 */
export function bytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 相对时间：列表里的「刚刚 / 12 分钟前 / 3 天前」比绝对时间好读 */
export function relativeTime(secondsOrMs: number): string {
  const ms = secondsOrMs > 1e12 ? secondsOrMs : secondsOrMs * 1000;
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

/** 剩余有效期文案（会话 48h / 带日志会话跟随日志 TTL） */
export function ttlText(expiresAtSeconds: number): string {
  const left = expiresAtSeconds * 1000 - Date.now();
  if (left <= 0) return '已过期';
  if (left < 3_600_000) return `${Math.max(1, Math.floor(left / 60_000))} 分钟后过期`;
  if (left < 86_400_000) return `${Math.floor(left / 3_600_000)} 小时后过期`;
  return `${Math.floor(left / 86_400_000)} 天后过期`;
}

/** 工具参数一行摘要：只用于列表展示，超长截断 */
export function inlineArgs(args: unknown, max = 90): string {
  if (args === null || args === undefined) return '';
  let text: string;
  try {
    text = typeof args === 'string' ? args : JSON.stringify(args);
  } catch {
    text = String(args);
  }
  // JSON.stringify 在循环引用时会抛错并落到上面分支；对象则可能是 [object Object]
  if (text === undefined || text === '') return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 分数着色档位（与后端 `deliverable` 判据保持一致的呈现，不重算分数） */
export function scoreTone(overall: number): 'success' | 'warning' | 'danger' {
  if (overall >= 80) return 'success';
  if (overall >= 60) return 'warning';
  return 'danger';
}

/** 设备指纹：仅用于配额归属，不含任何可识别个人的信息，且不离开本机（随请求发给服务端） */
export function deviceFingerprint(): string {
  const key = 'lograg.fingerprint';
  const cached = localStorage.getItem(key);
  if (cached !== null && cached !== '') return cached;

  const parts = [
    navigator.userAgent,
    String(navigator.hardwareConcurrency ?? 0),
    String(screen.width),
    String(screen.height),
    Intl.DateTimeFormat().resolvedOptions().timeZone ?? '',
    String(new Date().getTimezoneOffset()),
  ].join('|');

  // 非加密哈希即可：它只用来把「同一台设备」归到一起，不承担安全职责
  let h = 2166136261;
  for (let i = 0; i < parts.length; i++) {
    h ^= parts.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const value = `d${(h >>> 0).toString(36)}`;
  localStorage.setItem(key, value);
  return value;
}
