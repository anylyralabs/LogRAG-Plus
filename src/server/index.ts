/**
 * HTTP 服务。
 *
 * 用 Node 内置 `node:http`（无框架依赖）——路由简单，无需引入 Express/Fastify。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { describeConfig, isDev, security, defaultProvider, logshare, agent as agentCfg } from '../config.ts';
import { SseWriter } from './sse.ts';
import { resolveClientIp } from '../security/clientIp.ts';
import { SsrfError, normalizeBaseUrl, validateProviderUrl } from '../security/ssrf.ts';
import { runAgent } from '../agent/runner.ts';
import { createToolContext } from '../agent/tools/index.ts';
import { listTopics, stats as ragStats } from '../rag/search.ts';
import { buildLogWindow } from '../text/window.ts';
import { checkReadiness } from '../text/obfuscation.ts';
import { anonymousId, consume, secondsUntilTomorrow, type QuotaKind } from '../quota/limiter.ts';
import { validateUpload } from '../upload/validate.ts';
import {
  appendMessage,
  checkRoundsAllowed,
  cleanupExpired,
  findOrCreateSession,
  getHistory,
  getSession,
  sessionTtlSeconds,
} from '../store/session.ts';
import { fetchLog, uploadLog } from '../logshare/client.ts';
import { isValidLogId } from '../logshare/id.ts';
import {
  classifyEntry,
  createDomainKnowledge,
  domainKnowledgeAudit,
  domainKnowledgeStats,
  listDomainKnowledge,
  removeDomainKnowledge,
  renderDomainKnowledgeSection,
  searchDomainKnowledge,
  updateDomainKnowledge,
  type EntryKind,
} from '../knowledge/domain.ts';
import { adminActor, checkAdmin } from '../security/adminAuth.ts';
import { serveWeb } from './static.ts';
import { compress } from './compress.ts';
import {
  analysisStats,
  countAnalysisRecordsMatching,
  getAnalysisRecord,
  listAnalysisRecords,
  purgeAnalysisRecords,
  saveAnalysisRecord,
} from '../eval/records.ts';
import type { RecordFilter } from '../eval/records.ts';
import { getDb } from '../store/db.ts';
import { extractConclusion } from '../agent/structured.ts';

/** 请求体大小上限（10MB 日志 + JSON 包装余量） */
const MAX_BODY_BYTES = 24 * 1024 * 1024;

interface ChatRequest {
  message: string;
  /** 日志正文（可选）——与 logId 二选一；两者都给时以 logContent 为准 */
  logContent?: string;
  /**
   * LogShare 日志 ID（可选）。
   *
   * 只给 logId 不给 logContent 时，服务端会**自动取回日志正文**
   * （公开 raw 路径）——这是主入口 `agent.logshare.cn/logshare/{id}` 的形态。
   */
  logId?: string;
  /**
   * 会话 ID（多轮对话）。
   *
   * 传入时复用该会话（保留历史与日志绑定）；省略时按 `logId` 查找未过期会话，
   * 找不到则新建。返回值中总是带回 `sessionId`，客户端应保存并回传。
   */
  sessionId?: string;
  /** 自定义供应商（可选，覆盖服务端默认） */
  provider?: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  /** 设备指纹（可选，用于配额归属；无则回退 IP+UA） */
  fingerprint?: string;
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`请求体超过上限 ${MAX_BODY_BYTES} 字节`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  const contentType = 'application/json; charset=utf-8';

  // 压缩（`/v1/log/{id}` 单次可达 265KB，移动端不压很浪费）
  const packed = compress(body, res.req?.headers['accept-encoding'] as string | undefined, contentType);

  const headers: Record<string, string | number> = {
    'content-type': contentType,
    'content-length': packed === null ? Buffer.byteLength(body) : packed.body.byteLength,
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  };
  if (packed !== null) {
    headers['content-encoding'] = packed.encoding;
    // 同一 URL 依 Accept-Encoding 返回不同字节，必须声明
    headers['vary'] = 'accept-encoding';
  }
  res.writeHead(status, headers);
  res.end(packed === null ? body : packed.body);
}

/** 健康检查 */
function handleHealth(res: ServerResponse): void {
  const rag = ragStats();
  json(res, 200, {
    ok: true,
    service: 'lograg-plus',
    version: '0.1.0',
    rag: rag ?? { available: false },
    config: describeConfig(),
  });
}

/** 知识库主题 */
function handleTopics(res: ServerResponse): void {
  json(res, 200, { ok: true, topics: listTopics() });
}

/** 日志面板返回的一份文档（主日志或某个附件） */
interface LogDoc {
  name: string;
  bytes: number;
  lines: number;
  content: string;
  /** 该份文档被截断（超过单份上限） */
  truncated: boolean;
}

/** 单份文档上限：面板是阅读与指认用的，不是分析通道 */
const LOG_DOC_MAX_BYTES = 2 * 1024 * 1024;
/** 一次响应的总预算：主日志 + 附件都算在内 */
const LOG_TOTAL_MAX_BYTES = 6 * 1024 * 1024;
/** 进程内缓存：TTL 与条数上限 */
const LOG_CACHE_TTL_MS = 5 * 60 * 1000;
const LOG_CACHE_MAX = 12;

const logCache = new Map<string, { at: number; payload: Record<string, unknown> }>();

function countLinesOf(text: string): number {
  if (text === '') return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * 读取日志正文与附件（供前端「日志面板」展示与指认）。
 *
 * 为什么需要这个端点：主入口是 `agent.logshare.cn/logshare/{id}`——从 LogShare
 * 跳转过来，地址栏里只有一个 ID。`/v1/chat` 里服务端会自行取回正文，但**前端拿不到**，
 * 于是「在日志里圈出某几行、把那几行当证据送进对话」这件事在主入口上根本不成立。
 * 新设计把「日志是一份可以被指认的文档」当作核心交互，故补这个只读端点。
 *
 * 几个刻意的取舍：
 *  - **不消耗分析配额**：看一眼日志不等于分析一次。配额按 chat / upload 计，
 *    否则用户点开面板就被扣一次额度，而他还什么都没问。
 *  - **进程内短期缓存**：取一份大日志要几百毫秒到数秒，而面板在刷新、切换会话时
 *    会重复请求。键就是日志 ID，不存在越权——能读到什么完全取决于 ID。
 *  - **每份截断到 2MB、总量 6MB**：截断时明确回报 `truncated` 与 `omitted`，
 *    界面据此说明「面板只显示前 2MB」，而不是悄悄少几行让用户以为日志就这么长。
 */
async function handleLog(res: ServerResponse, logId: string, refresh = false): Promise<void> {
  if (!isValidLogId(logId)) {
    json(res, 400, { ok: false, error: '日志 ID 格式非法' });
    return;
  }

  // `refresh=1` 跳过缓存：刚上传的日志可能仍在异步反混淆，界面上的「刷新」
  // 必须真的回到上游读一次，否则用户会一直看到同一份未反混淆的正文，
  // 而界面还显示「反混淆处理中」——看起来像刷新按钮坏了。
  const cached = refresh ? undefined : logCache.get(logId);
  if (cached !== undefined && Date.now() - cached.at < LOG_CACHE_TTL_MS) {
    json(res, 200, cached.payload);
    return;
  }

  const fetched = await fetchLog(logId);
  if (!fetched.ok || fetched.content === undefined || fetched.content === '') {
    json(res, 404, {
      ok: false,
      error: fetched.error ?? '未能读取该日志（可能已过期）。',
    });
    return;
  }

  const docs: LogDoc[] = [];
  const omitted: string[] = [];
  let budget = LOG_TOTAL_MAX_BYTES;

  const push = (name: string, text: string): void => {
    if (text === '') return;
    if (budget <= 0) {
      omitted.push(name);
      return;
    }
    const cap = Math.min(LOG_DOC_MAX_BYTES, budget);
    const sliced = text.length > cap;
    const body = sliced ? text.slice(0, cap) : text;
    budget -= body.length;
    docs.push({
      name,
      bytes: Buffer.byteLength(text, 'utf8'),
      lines: countLinesOf(text),
      content: body,
      truncated: sliced,
    });
  };

  push('main.log', fetched.content);
  for (const f of fetched.files ?? []) {
    if (typeof f.data === 'string' && f.data !== '') push(f.name, f.data);
  }

  const payload = {
    ok: true,
    logId,
    source: fetched.source ?? '',
    createdAt: fetched.createdAt ?? 0,
    maybeObfuscating: fetched.maybeObfuscating ?? false,
    docs,
    omitted,
  };

  if (logCache.size >= LOG_CACHE_MAX) {
    const oldest = logCache.keys().next();
    if (!oldest.done) logCache.delete(oldest.value);
  }
  logCache.set(logId, { at: Date.now(), payload });

  json(res, 200, payload);
}

/**
 * 会话回放（前端刷新 / 重连时恢复对话）。
 *
 * 实测缺陷（2026-10-17 修复）：`getSession` 与 `getHistory` 此前**只被测试调用**，
 * `src/` 中零引用——前端一旦刷新就丢失整个对话，且没有任何接口能取回历史。
 *
 * 只返回展示所需字段：思维链一并返回（前端「深度分析」面板要展示推理过程），
 * 但不返回内部计数器等实现细节。
 */
function handleSession(res: ServerResponse, sessionId: string): void {
  const session = getSession(sessionId);
  if (session === null) {
    json(res, 404, { ok: false, error: '会话不存在或已过期' });
    return;
  }

  const messages = getHistory(session.id, 200).map((m) => ({
    role: m.role,
    content: m.content,
    ...(m.reasoning !== null && m.reasoning !== '' ? { reasoning: m.reasoning } : {}),
    ...(m.score !== null ? { score: m.score } : {}),
    ...(m.meta !== null ? { meta: m.meta } : {}),
    createdAt: m.createdAt,
  }));

  json(res, 200, {
    ok: true,
    session: {
      id: session.id,
      logId: session.logId,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    },
    // 轮次余量：前端据此提示「本会话还剩 N 轮」
    rounds: checkRoundsAllowed(session.id),
    messages,
  });
}

/**
 * 对话端点（SSE 流式）。
 *
 * 与 LogShare 的 SSE 协议兼容（见 src/server/sse.ts）。
 */
async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: ChatRequest;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw) as ChatRequest;
  } catch (e) {
    json(res, 400, { ok: false, error: `请求解析失败：${e instanceof Error ? e.message : String(e)}` });
    return;
  }

  if (typeof body.message !== 'string' || body.message.trim() === '') {
    json(res, 400, { ok: false, error: 'message 不能为空' });
    return;
  }

  // 客户端 IP（配额与日志用）
  const clientIp = resolveClientIp({
    remoteAddress: req.socket.remoteAddress,
    headers: req.headers as Record<string, string | string[] | undefined>,
    trustedProxies: security.trustedProxies,
  });

  // 匿名主体（指纹优先、IP+UA 兜底）。
  //
  // 必须在会话解析**之前**算出来：会话自动复用要限定在同一主体内。
  // 日志 ID 是公开的（就在 URL 里），若只按 logId 复用，任何打开同一份日志的
  // 人都会进入同一个会话——看到彼此的追问、共享轮次额度。
  const anonId = anonymousId(clientIp, String(req.headers['user-agent'] ?? ''), body.fingerprint);

  // ── 会话解析（三重优先级）─────────────────────────────
  //
  //  1. 客户端显式传入的 `sessionId`（多轮延续 / 换设备回放）
  //  2. 按 `logId` 查找**同一匿名主体**的未过期会话（同一日志不重复建会话）
  //  3. 新建
  //
  // 实测缺陷（2026-10-17 修复）：此前 `body.sessionId` 只作为响应字段回传，
  // **从未被读取**，导致客户端无法延续会话——每轮都新建，上一轮历史与轮次
  // 计数全部失效（多轮对话与「每会话 N 轮」上限形同虚设）。
  const logId = typeof body.logId === 'string' && body.logId.trim() !== '' ? body.logId.trim() : null;
  const providedSessionId =
    typeof body.sessionId === 'string' && body.sessionId.trim() !== '' ? body.sessionId.trim() : '';

  let session = providedSessionId !== '' ? getSession(providedSessionId) : null;
  if (session === null) {
    // 未传或已过期：在**同一主体内**按 logId 复用/新建。
    // 显式 sessionId 走的是 bearer 语义（知道 ID 即可回放），这是无登录产品
    // 支持「换设备继续」的必要取舍；但自动复用不能跨人。
    session = findOrCreateSession(logId, sessionTtlSeconds(logId), anonId);
  }

  // 会话已绑定的日志优先——客户端延续会话时可省略 logId，
  // 否则日志工具会因丢失绑定而失效。
  const effectiveLogId = logId ?? session.logId;

  // 轮次上限检查
  const rounds = checkRoundsAllowed(session.id);
  if (!rounds.allowed) {
    json(res, 429, {
      ok: false,
      sessionId: session.id,
      error: '本次会话的对话轮次已用完。请开启新会话继续。',
      remaining: 0,
    });
    return;
  }

  // 历史消息（多轮上下文）
  const history = getHistory(session.id, 20).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  // 记录用户消息
  //
  // 注意：这里保持「前置检查之前落库」的既有语义。它与「失败不留痕」的直觉相反，
  // 但 tests/server.test.ts 明确覆盖了该行为：显式 sessionId 的请求即使因
  // 日志取不到而 404，用户消息仍要落到该会话（保证客户端重试时上下文连续）。
  // 若要改成「失败不留痕」，必须同时改掉那条测试与轮次口径，不能只改一处。
  appendMessage(session.id, 'user', body.message);

  // 日志正文来源判定：显式正文优先；只给 ID 时稍后自动取回
  const providedContent =
    typeof body.logContent === 'string' && body.logContent.trim() !== '' ? body.logContent : null;

  // ── 供应商解析与校验（必须早于配额）────────────────────
  //
  // 顺序理由：供应商地址非法是**配置问题，不是一次分析**。若先扣配额再返回
  // 400/503，用户填错一次端点就白掉一次额度，而界面显示的是「分析失败」——
  // 排查方向会被引到额度上。
  //
  // 自定义供应商是**公网用户输入**，服务端要拿它发起请求，因此必须过 SSRF
  // 校验（`validateProviderUrl` 每次请求都重新解析，防 DNS Rebinding）。
  // 服务端默认供应商来自运维配置，属可信来源，不做此校验——否则本机自建模型
  // （127.0.0.1）在未开 ALLOW_LOOPBACK_PROVIDER 时会被自己的配置挡掉。
  const provider =
    body.provider !== undefined
      ? {
          baseUrl: normalizeBaseUrl(String(body.provider.baseUrl ?? '')),
          apiKey: String(body.provider.apiKey ?? ''),
          model: String(body.provider.model ?? '').trim(),
        }
      : {
          baseUrl: defaultProvider.baseUrl,
          apiKey: defaultProvider.apiKey,
          model: defaultProvider.model,
        };

  if (provider.baseUrl === '' || provider.model === '') {
    json(res, 503, {
      ok: false,
      error: '未配置模型供应商。请在设置中填写，或联系管理员配置服务端默认供应商。',
    });
    return;
  }

  if (body.provider !== undefined) {
    try {
      await validateProviderUrl(provider.baseUrl, { allowLoopback: security.allowLoopbackProvider });
    } catch (e) {
      if (e instanceof SsrfError) {
        json(res, 400, { ok: false, error: `自定义供应商地址不可用：${e.message}` });
        return;
      }
      throw e;
    }
  }

  // 配额检查（按成本分级：带日志 > 纯对话）
  //
  // 超配额不硬拒，而是降级为「快速模式」（提示词层面约束工具使用），
  // 避免 CGNAT 场景下误伤真实用户（项目自身已有此教训）。
  //
  // 配额种类只依据「客户端是否指向一份日志」（正文或 ID），不等取回结果——
  // 取回发生在配额之后，避免「取日志」这一动作本身不被计数。
  const quotaKind: QuotaKind = providedContent !== null || effectiveLogId !== null ? 'logId' : 'chat';
  const quota = await consume(quotaKind, anonId, clientIp);

  if (isDev) {
    console.log(
      `[quota] kind=${quotaKind} remaining=${quota.remaining}/${quota.limit} allowed=${quota.allowed}`,
    );
  }

  // ── 日志正文获取 ──────────────────────────────────────
  //
  // 只给 logId 时自动取回正文——这是主入口 `agent.logshare.cn/logshare/{id}`
  // 的形态。实测缺陷（2026-10-17 修复）：`fetchLog` 此前**从未被调用**，
  // 只给 ID 时模型既拿不到正文、日志工具也被禁用（工具按 logContent 门控），
  // 「深度分析」实际退化成无日志的泛泛回答。
  //
  // 取不到就明确报错：不能假装有日志继续分析——那会产出「日志无异常」这类
  // 误导性结论，比直接失败更糟。
  let logContent = providedContent;
  let sourceNote: string | undefined;

  if (logContent === null && effectiveLogId !== null) {
    const fetched = await fetchLog(effectiveLogId);

    if (!fetched.ok || fetched.content === undefined || fetched.content === '') {
      json(res, 404, {
        ok: false,
        sessionId: session.id,
        error:
          fetched.error ??
          '未能读取该日志（可能已过期）。请重新上传，或直接把日志内容粘贴进来分析。',
      });
      return;
    }

    logContent = fetched.content;

    // 反混淆是 LogShare 的异步事件队列任务，刚落库的日志可能尚未处理完
    if (fetched.maybeObfuscating === true) {
      sourceNote = '该日志刚落库，LogShare 的异步反混淆可能尚未完成；若结果异常请稍后重试。';
    }
  }

  // 日志窗口处理
  let userMessage = body.message;
  const hasLog = logContent !== null;
  let logSummary: string | undefined;

  if (logContent !== null) {
    // 反混淆就绪检查（基于混淆特征，与正文来源无关）
    const readiness = checkReadiness({
      content: logContent,
      createdAt: Math.floor(Date.now() / 1000), // 保守取当前时间
    });

    const window = buildLogWindow(logContent);
    const lines = logContent.split('\n');

    userMessage = [
      body.message,
      '',
      '---',
      `日志内容（共 ${lines.length} 行${window.hasWindow && window.anchorLine !== null ? `，已聚焦第 ${window.startLine}-${window.endLine} 行（锚点第 ${window.anchorLine} 行，命中来源：${window.matchedBy ?? '未知'}）` : '，未定位到崩溃标记，以下为概况'}）：`,
      '',
      window.body,
    ].join('\n');

    logSummary = [
      `- 总行数：${lines.length}`,
      window.anchorLine !== null
        ? `- 崩溃锚点：第 ${window.anchorLine} 行（${window.structural ? '结构性标记' : '启发式'}：${window.matchedBy}）`
        : '- 未匹配到确定性崩溃标记',
      readiness.ready ? '' : `- ${readiness.message}`,
      sourceNote !== undefined ? `- ${sourceNote}` : '',
    ]
      .filter((s) => s !== '')
      .join('\n');
  }

  // 建立 SSE
  const sse = new SseWriter(res, { heartbeatMs: 15_000 });

  // 客户端断开检测
  const ac = new AbortController();
  req.on('close', () => {
    if (!res.writableEnded) {
      ac.abort();
    }
  });

  try {
    const result = await runAgent({
      userMessage,
      history,
      provider,
      toolContext: createToolContext(logContent, effectiveLogId),
      promptContext: {
        hasLog,
        ...(logSummary !== undefined ? { logSummary } : {}),
        ...(quota.allowed ? {} : { fastMode: true }),
      },
      // 轮次上限取自配置（`AGENT_MAX_ROUNDS`）。此前硬编码 30，配置项形同虚设。
      maxRounds: agentCfg.maxRounds,
      sse,
      signal: ac.signal,
    });

    if (result.ok) {
      // 自评摘要：与 done 帧下发的字段**保持同一形状**，回放时可直接复用。
      // 评分失败（result.score === undefined）时为 undefined，不写空壳。
      const scoreSummary =
        result.score !== undefined
          ? {
              overall: result.score.overall,
              deliverable: result.score.deliverable,
              dimensions: {
                grounding: result.score.dimensions.grounding.score,
                verification: result.score.dimensions.verification.score ?? 0,
                actionability: result.score.dimensions.actionability.score ?? 0,
                economy: result.score.dimensions.economy.score ?? 0,
              },
              deductions: result.score.deductions.slice(0, 5),
              missingAnchors: result.score.groundingDetail.anchors.missing.slice(0, 8).map((a) => a.text),
            }
          : undefined;

      // 追问要落库：它是**用户需要回答的东西**，只存在于流里的话刷新后就答不了了。
      const messageMeta =
        result.asks.length > 0 ? { asks: result.asks } : undefined;

      // 记录助手回复（含思维链、自评与结构化附加信息，供后续轮次与回溯）
      appendMessage(
        session.id,
        'assistant',
        result.content,
        result.reasoning,
        scoreSummary,
        messageMeta,
      );

      // 落分析记录 + 看板数据。
      // 记录失败绝不能影响用户拿到答案——它是观测，不是交付路径。
      let recordId: string | null = null;
      try {
        if (result.score !== undefined) {
          recordId = saveAnalysisRecord({
            sessionId: session.id,
            logId: effectiveLogId,
            provider: provider.baseUrl,
            model: provider.model,
            rounds: result.rounds,
            answerChars: result.content.length,
            score: result.score,
            conclusion: extractConclusion(result.content),
            toolCalls: result.toolCalls,
          });
        }
      } catch (e) {
        if (isDev) console.error('[chat] 分析记录落库失败:', e instanceof Error ? e.message : String(e));
      }

      sse.done({
        sessionId: session.id,
        remaining: quota.remaining,
        ...(quota.nearLimit ? { nearLimit: true } : {}),
        ...(result.asks.length > 0 ? { asks: result.asks } : {}),
        // 自评随 done 帧下发：前端可以直接呈现「哪些引用没在日志里找到」，
        // 而不是只给一个分数。
        ...(result.score !== undefined
          ? {
              score: {
                ...scoreSummary,
                ...(recordId !== null ? { recordId } : {}),
              },
            }
          : {}),
      });
    } else {
      sse.error(result.error ?? '分析失败');
    }

    if (isDev) {
      console.log(
        `[chat] ip=${clientIp} log=${hasLog ? 'yes' : 'no'} ` +
          `content=${result.content.length}字 reasoning=${result.reasoning.length}字 tools=${result.toolCalls.length}`,
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!sse.isClosed) sse.error(msg);
    if (isDev) console.error('[chat] 异常:', msg);
  } finally {
    sse.close();
  }
}

/**
 * 处理日志上传（`POST /v1/upload`）。
 *
 * ## 为什么必须经过 LogShare
 *
 * 上传内容要走 LogShare 的完整写入流水线：脱敏（IPv4/路径/用户名等）→ 去重指纹
 * → 异步反混淆（SpinYarn）→ 异步安全审核 → 分区落库。本服务**不自行落盘**，
 * 因为一旦本地也存一份，就等于多出一条未经脱敏与审核的数据路径——那是最容易
 * 泄露用户日志的地方。
 *
 * ## 为什么本服务还要自己校验一遍
 *
 * LogShare 侧当然也会校验，但：
 *  1. 在跨网转发**之前**拦住，省掉一次 12MB 的白跑；
 *  2. 能给「哪个文件、超了多少」这类可定位的提示，而不是一句笼统的 400；
 *  3. 本服务自己要解析这坨 JSON，不校验就等于放任任意大小的请求体走一遍解析。
 *
 * ## 超配额为什么在这里是硬拒（与对话不同）
 *
 * 对话超配额降级为「快速模式」，因为用户仍能拿到有价值的答案（CGNAT 场景下
 * 硬拒会误伤真实用户，项目已有此教训）。上传没有可降级的中间态——不能只存一半，
 * 而它又是唯一会消耗存储与边缘带宽的动作，因此这里明确拒绝并给出重试时间。
 */
async function handleUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const clientIp = resolveClientIp({
    remoteAddress: req.socket.remoteAddress,
    headers: req.headers as Record<string, string | string[] | undefined>,
    trustedProxies: security.trustedProxies,
  });

  let raw: unknown;
  try {
    raw = JSON.parse(await readBody(req));
  } catch (e) {
    json(res, 400, {
      ok: false,
      error: `请求解析失败：${e instanceof Error ? e.message : String(e)}`,
    });
    return;
  }

  // 能力检查在配额之前：未配置 LogShare 属于**部署问题**，不该先消耗用户当天的
  // 上传次数——否则管理员配好之前，每次试探都白掉一次额度。
  if (!logshare.canUpload) {
    json(res, 503, {
      ok: false,
      error:
        '未配置 LogShare 上传能力（LOGSHARE_INTERNAL_URL 与 LOGSHARE_PUBLIC_API_URL 均为空）。' +
        '日志必须经 LogShare 完整写入流水线处理，本服务不自行落盘。',
    });
    return;
  }

  // 配额先于校验：校验本身要遍历整份内容，不能让超配额请求白蹭这次遍历。
  const fingerprint =
    raw !== null && typeof raw === 'object' && typeof (raw as { fingerprint?: unknown }).fingerprint === 'string'
      ? ((raw as { fingerprint: string }).fingerprint)
      : undefined;
  const anonId = anonymousId(clientIp, String(req.headers['user-agent'] ?? ''), fingerprint);
  const quota = await consume('upload', anonId, clientIp);

  if (!quota.allowed) {
    res.setHeader('retry-after', String(secondsUntilTomorrow()));
    json(res, 429, {
      ok: false,
      error: '今日上传次数已用完，请明天再试；也可以直接把日志内容粘贴到对话框中分析。',
      retryAfterSeconds: secondsUntilTomorrow(),
    });
    return;
  }

  const validated = validateUpload(raw);
  if (!validated.ok) {
    json(res, 400, { ok: false, error: validated.error, remaining: quota.remaining });
    return;
  }

  const uploaded = await uploadLog(validated.value.content, {
    ...(validated.value.source !== '' ? { source: validated.value.source } : {}),
    ...(validated.value.files.length > 0 ? { files: validated.value.files } : {}),
  });

  if (!uploaded.ok || uploaded.id === undefined) {
    // 502 而非 400：请求本身是合法的，是上游没能完成写入。
    json(res, 502, {
      ok: false,
      error: uploaded.error ?? 'LogShare 未能完成写入',
      remaining: quota.remaining,
    });
    return;
  }

  if (isDev) {
    console.log(
      `[upload] ip=${clientIp} id=${uploaded.id} files=${validated.value.files.length} ` +
        `bytes=${validated.value.content.length}`,
    );
  }

  json(res, 200, {
    ok: true,
    // 字段名与 API.md 对齐：`logId` 比裸 `id` 更明确（上传响应里还有 token 等其它 ID）。
    // 历史上这里返回 `id`，而文档与前端都按 `logId` 读取，导致上传成功后跳到
    // `/undefined`——契约漂移的典型后果，故在服务端这一侧收敛。
    logId: uploaded.id,
    maybeObfuscating: true,
    ...(uploaded.token !== undefined ? { token: uploaded.token } : {}),
    ...(validated.notes.length > 0 ? { notes: validated.notes } : {}),
    remaining: quota.remaining,
  });
}

// ── 管理接口 ──────────────────────────────────────────────
//
// 全部管理接口挂在 `/v1/admin/` 前缀下，**门禁在入口处统一做一次**。
// 逐条路由各加一道检查是漏洞的常见来源（新增子路由时忘加），
// 集中在前缀上检查则不存在「忘记」的可能。
// 逐条路由各加一道检查是漏洞的常见来源（新增子路由时忘加），
// 集中在前缀上检查则不存在「忘记」的可能。

/**
 * 管理路由门禁。
 *
 * 返回 `false` 时响应已写好，调用方直接 return。
 */
function adminGuard(req: IncomingMessage, res: ServerResponse): boolean {
  const check = checkAdmin(req);
  if (check === 'not-found') {
    // 与普通 404 同形。若这里回 401，未启用管理接口的部署反而暴露了
    // 「本服务存在管理接口，只是没开」——没必要给的攻击面提示。
    json(res, 404, { ok: false, error: '未知路由' });
    return false;
  }
  if (check === 'unauthorized') {
    json(res, 401, { ok: false, error: '管理令牌无效或缺失' });
    return false;
  }
  return true;
}

/** 解析 JSON 请求体；失败时写出 400 并返回 null */
async function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch (e) {
    json(res, 400, { ok: false, error: e instanceof Error ? e.message : '请求体读取失败' });
    return null;
  }

  if (raw.trim() === '') return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      json(res, 400, { ok: false, error: '请求体必须是 JSON 对象' });
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
    return null;
  }
}

const VALID_KINDS: EntryKind[] = ['fact', 'method', 'unclear'];

function parseKind(value: unknown): EntryKind | undefined {
  return typeof value === 'string' && (VALID_KINDS as string[]).includes(value)
    ? (value as EntryKind)
    : undefined;
}

function parseTags(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t !== '');
  }
  return undefined;
}

function parsePriority(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return undefined;
}

/**
 * 处理 `/v1/admin/domain-knowledge*` 下的全部请求。
 *
 * 鉴权已由调用方（统一前缀门禁）完成，本函数不再重复检查。
 * 子路由顺序敏感：字面量段（`analyze` / `audit` / `injection` / `search`）
 * 必须排在 `{id}` 之前，否则会被当成 ID。
 */
async function handleDomainKnowledge(
  req: IncomingMessage,
  res: ServerResponse,
  sub: string,
  url: URL,
): Promise<void> {
  const method = req.method ?? 'GET';

  // 列表 + 统计
  if (sub === '' && method === 'GET') {
    const limitRaw = url.searchParams.get('limit');
    const limit = limitRaw === null ? undefined : Number(limitRaw);
    const entries = listDomainKnowledge({
      enabledOnly: url.searchParams.get('enabledOnly') === '1',
      tag: url.searchParams.get('tag') ?? undefined,
      keyword: url.searchParams.get('keyword') ?? undefined,
      limit: limit !== undefined && Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : undefined,
    });
    json(res, 200, { ok: true, entries, stats: domainKnowledgeStats() });
    return;
  }

  // 新建
  if (sub === '' && method === 'POST') {
    const body = await readJsonBody(req, res);
    if (body === null) return;

    const content = typeof body.content === 'string' ? body.content : '';
    const result = createDomainKnowledge({
      content,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      priority: parsePriority(body.priority),
      tags: parseTags(body.tags),
      actor: adminActor(req),
      kindOverride: parseKind(body.kindOverride),
    });

    json(res, result.ok ? 201 : 400, result);
    return;
  }

  // 试算：只做校验与性质判定，不落库（让管理员先看到提醒）
  if (sub === 'analyze' && method === 'POST') {
    const body = await readJsonBody(req, res);
    if (body === null) return;

    const content = typeof body.content === 'string' ? body.content.trim() : '';
    const analysis = classifyEntry(content);
    json(res, 200, {
      ok: true,
      content,
      chars: [...content].length,
      ...analysis,
    });
    return;
  }

  // 变更留痕
  if (sub === 'audit' && method === 'GET') {
    const limitRaw = url.searchParams.get('limit');
    const limit = limitRaw === null ? 50 : Number(limitRaw);
    json(res, 200, {
      ok: true,
      records: domainKnowledgeAudit(Number.isFinite(limit) ? limit : 50),
    });
    return;
  }

  // 查看「实际注入提示词的原文」——这是管理员最需要确认的东西：
  // 自己写的条目到底以什么形态进入模型上下文。
  if (sub === 'injection' && method === 'GET') {
    const injection = renderDomainKnowledgeSection();
    json(res, 200, {
      ok: true,
      chars: injection.chars,
      injected: injection.injected.map((e) => ({ id: e.id, content: e.content, priority: e.priority })),
      skipped: injection.skipped.map((e) => ({ id: e.id, content: e.content, priority: e.priority })),
      text: injection.text,
    });
    return;
  }

  // 预览 expert_knowledge 工具的返回（验证检索是否命中）
  if (sub === 'search' && method === 'GET') {
    const q = url.searchParams.get('q') ?? '';
    const hits = searchDomainKnowledge(q, 20);
    json(res, 200, { ok: true, query: q, hits });
    return;
  }

  // 以下按 ID 操作
  let id: string;
  try {
    id = decodeURIComponent(sub);
  } catch {
    json(res, 400, { ok: false, error: '条目 ID 编码非法' });
    return;
  }
  if (id === '') {
    json(res, 400, { ok: false, error: '缺少条目 ID' });
    return;
  }

  if (method === 'GET') {
    const entry = listDomainKnowledge().find((e) => e.id === id);
    if (entry === undefined) {
      json(res, 404, { ok: false, error: '条目不存在' });
      return;
    }
    json(res, 200, { ok: true, entry });
    return;
  }

  if (method === 'PUT' || method === 'PATCH') {
    const body = await readJsonBody(req, res);
    if (body === null) return;

    const result = updateDomainKnowledge(id, {
      content: typeof body.content === 'string' ? body.content : undefined,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      priority: parsePriority(body.priority),
      tags: parseTags(body.tags),
      actor: adminActor(req),
      kindOverride: parseKind(body.kindOverride),
    });
    json(res, result.ok ? 200 : 400, result);
    return;
  }

  if (method === 'DELETE') {
    const result = removeDomainKnowledge(id, adminActor(req));
    json(res, result.ok ? 200 : 404, result);
    return;
  }

  json(res, 405, { ok: false, error: `不支持的方法：${method}` });
}

/**
 * 处理 `/v1/admin/records*` 下的全部请求——分析记录的检索与看板。
 *
 * ## 为什么这些端点值得存在
 *
 * LogShare 的分析记录是「Redis ZSET + 602MB 单文件归档」，任何统计都得把
 * 整文件读一遍，因此「低分样本长什么样」在实践中没人问得起——
 * 证据分等于工具调用次数这个缺陷就这样长期无人发现。
 *
 * 这里把评分结果落进结构化表，下列问题从「读 602MB」变成一次索引扫描：
 * 哪个维度没有区分度、哪种扣分理由最常见、哪份日志的分析质量在变化。
 */
async function handleRecords(
  req: IncomingMessage,
  res: ServerResponse,
  sub: string,
  url: URL,
): Promise<void> {
  const method = req.method ?? 'GET';

  const num = (name: string): number | undefined => {
    const raw = url.searchParams.get(name);
    if (raw === null || raw.trim() === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.trunc(n) : undefined;
  };

  // 看板聚合
  if (sub === 'stats' && method === 'GET') {
    const sinceDays = num('days');
    const since = sinceDays === undefined ? undefined : Math.floor(Date.now() / 1000) - sinceDays * 86400;
    json(res, 200, { ok: true, stats: analysisStats(since) });
    return;
  }

  // 列表检索
  if (sub === '' && method === 'GET') {
    const deliverableRaw = url.searchParams.get('deliverable');
    const orderByRaw = url.searchParams.get('orderBy');
    const orderBy =
      orderByRaw === 'created' || orderByRaw === 'overall' || orderByRaw === 'rounds' || orderByRaw === 'tool_calls'
        ? orderByRaw
        : undefined;

    // 筛选条件只构造一次：列表与 `total` 必须来自同一个集合，
    // 否则「筛选后共 3 条」仍会显示 20 页，翻页后全是空页。
    const filter: RecordFilter = {
      minScore: num('minScore'),
      maxScore: num('maxScore'),
      ...(deliverableRaw === '1' ? { deliverable: true } : {}),
      ...(deliverableRaw === '0' ? { deliverable: false } : {}),
      logId: url.searchParams.get('logId') ?? undefined,
      model: url.searchParams.get('model') ?? undefined,
      ...(orderBy !== undefined ? { orderBy } : {}),
      ascending: url.searchParams.get('ascending') === '1',
    };

    const recordsList = listAnalysisRecords({
      ...filter,
      limit: num('limit'),
      offset: num('offset'),
    });

    json(res, 200, {
      ok: true,
      records: recordsList,
      total: countAnalysisRecordsMatching(filter),
    });
    return;
  }

  // 清空过期记录
  if (sub === 'purge' && method === 'POST') {
    json(res, 200, { ok: true, deleted: purgeAnalysisRecords() });
    return;
  }

  // 按 ID
  let id: string;
  try {
    id = decodeURIComponent(sub);
  } catch {
    json(res, 400, { ok: false, error: '记录 ID 编码非法' });
    return;
  }

  const record = getAnalysisRecord(id);
  if (record === null) {
    json(res, 404, { ok: false, error: '记录不存在' });
    return;
  }

  if (method === 'GET') {
    json(res, 200, { ok: true, record });
    return;
  }

  if (method === 'DELETE') {
    const db = getDb();
    db.prepare('DELETE FROM analysis_records WHERE id = ?').run(id);
    json(res, 200, { ok: true, deleted: id });
    return;
  }

  json(res, 405, { ok: false, error: `不支持的方法：${method}` });
}

/**
 * 管理接口总入口。
 *
 * **一次门禁覆盖全部子路由**：新增管理端点只需在这里加一个分支，
 * 不可能「忘记加鉴权」——因为鉴权根本不在分支里。
 */
async function handleAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  rest: string,
  url: URL,
): Promise<void> {
  if (!adminGuard(req, res)) return;

  if (rest === 'domain-knowledge' || rest.startsWith('domain-knowledge/')) {
    const sub = rest === 'domain-knowledge' ? '' : rest.slice('domain-knowledge/'.length);
    await handleDomainKnowledge(req, res, sub, url);
    return;
  }

  if (rest === 'records' || rest.startsWith('records/')) {
    const sub = rest === 'records' ? '' : rest.slice('records/'.length);
    await handleRecords(req, res, sub, url);
    return;
  }

  if (rest === '' && req.method === 'GET') {
    json(res, 200, {
      ok: true,
      endpoints: [
        'GET    /v1/admin/domain-knowledge',
        'POST   /v1/admin/domain-knowledge',
        'POST   /v1/admin/domain-knowledge/analyze',
        'GET    /v1/admin/domain-knowledge/audit',
        'GET    /v1/admin/domain-knowledge/injection',
        'GET    /v1/admin/domain-knowledge/search?q=',
        'GET    /v1/admin/domain-knowledge/{id}',
        'PUT    /v1/admin/domain-knowledge/{id}',
        'DELETE /v1/admin/domain-knowledge/{id}',
        'GET    /v1/admin/records',
        'GET    /v1/admin/records/stats',
        'GET    /v1/admin/records/{id}',
        'DELETE /v1/admin/records/{id}',
        'POST   /v1/admin/records/purge',
      ],
    });
    return;
  }

  json(res, 404, { ok: false, error: '未知管理接口' });
}

/** 构建服务 */
export function createHttpServer(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    // CORS 预检
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'access-control-max-age': '86400',
      });
      res.end();
      return;
    }

    void (async () => {
      try {
        if (path === '/health' && req.method === 'GET') {
          handleHealth(res);
          return;
        }

        if (path === '/v1/topics' && req.method === 'GET') {
          handleTopics(res);
          return;
        }

        // 日志正文与附件（只读，供前端日志面板展示与「指认某几行」）。
        if (path.startsWith('/v1/log/') && req.method === 'GET') {
          let logId: string;
          try {
            logId = decodeURIComponent(path.slice('/v1/log/'.length));
          } catch {
            json(res, 400, { ok: false, error: '日志 ID 编码非法' });
            return;
          }
          await handleLog(res, logId, url.searchParams.get('refresh') === '1');
          return;
        }

        // 会话回放：/v1/session/{id}
        // 注意：sessionId 由前端原样回传，此处做一次 URI 解码并捕获畸形输入，
        // 避免 decodeURIComponent 抛错冒泡成 500。
        if (path.startsWith('/v1/session/') && req.method === 'GET') {
          let sessionId: string;
          try {
            sessionId = decodeURIComponent(path.slice('/v1/session/'.length));
          } catch {
            json(res, 400, { ok: false, error: '会话 ID 编码非法' });
            return;
          }
          if (sessionId === '') {
            json(res, 400, { ok: false, error: '缺少会话 ID' });
            return;
          }
          handleSession(res, sessionId);
          return;
        }

        // 管理接口。门禁在 handleAdmin 内部统一处理；未启用管理接口时
        // 返回与其它未知路由同形的 404（不暴露管理面存在）。
        if (path === '/v1/admin' || path.startsWith('/v1/admin/')) {
          const rest = path === '/v1/admin' ? '' : path.slice('/v1/admin/'.length);
          await handleAdmin(req, res, rest, url);
          return;
        }

        if (path === '/v1/chat' && req.method === 'POST') {
          await handleChat(req, res);
          return;
        }

        // 上传日志。内容**必须**经 LogShare 的完整写入流水线（脱敏 → 去重 →
        // 异步反混淆 → 安全审核），本服务只做转发与前置校验，绝不自行落盘。
        if (path === '/v1/upload' && req.method === 'POST') {
          await handleUpload(req, res);
          return;
        }

        // 前端页面（`web/dist`）。未构建时静默跳过——此时 `/logshare/*` 会落到
        // 下面的 404，语义清楚，不会伪装成「页面加载失败」。
        if (serveWeb(path, req.method ?? 'GET', res)) return;

        json(res, 404, { ok: false, error: `未知路由：${req.method} ${path}` });      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[server] 未捕获异常:', msg);
        if (!res.headersSent) {
          json(res, 500, { ok: false, error: '内部错误' });
        } else {
          res.end();
        }
      }
    })();
  });
}

/** 过期会话清理间隔（10 分钟） */
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * 启动过期会话清理。
 *
 * 实测缺陷（2026-10-17 修复）：`cleanupExpired` 此前**只被测试调用**，
 * 生产路径中从不执行——`sessions` / `messages` 两张表只增不减，
 * 独立会话（48h TTL）与日志会话（7 天 TTL）都不会被回收。
 *
 * 用 `unref()` 释放事件循环引用，避免测试或 CLI 场景下进程被定时器挂住。
 * 清理失败只记日志不抛出——回收是维护动作，不该影响请求处理。
 */
export function startSessionCleanup(): void {
  const run = (): void => {
    try {
      const removed = cleanupExpired();
      if (removed > 0 && isDev) {
        console.log(`[cleanup] 已清理 ${removed} 个过期会话`);
      }
    } catch (e) {
      console.error('[cleanup] 会话清理失败:', e instanceof Error ? e.message : String(e));
    }
  };

  run(); // 启动时先清一次（进程可能已长时间未重启）
  setInterval(run, CLEANUP_INTERVAL_MS).unref();
}
