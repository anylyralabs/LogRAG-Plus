/**
 * 对话状态机。
 *
 * 一条消息在界面上有三个来源，必须分清（混在一起就会出「答案里夹着思维链」这类问题）：
 *
 * | 来源 | SSE 帧 | 呈现位置 |
 * |---|---|---|
 * | 思维链 | `status.type=thinking` | 可折叠的「工作过程」，**不进正文** |
 * | 工具调用/返回 | `status.type=tool` / `tool_result` | 「工作过程」里的行 |
 * | 正文 | 无 event 行的 `choices[].delta.content` | 答案气泡，可复制 |
 *
 * 另外两条与后端一致的口径：
 *
 * - **空正文就是失败**。后端在撞轮次上限、上游截断、模型没吐字这三种情况下都会
 *   先试收尾轮，仍为空则返回失败。前端不得把「没有正文」渲染成一张空成功卡片——
 *   那正是线上真实事故（0 字答案 + 288 个事件 + 报 completed）的界面版本。
 * - **会话 ID 必须回传**。服务端 `done` 帧带回 `sessionId`，多轮才成立
 *   （历史、轮次上限都挂在会话上）。此前服务端有个缺陷就是从不读取它。
 */

import { computed, ref } from 'vue';
import { ApiError, replay, streamChat, upload as uploadApi } from '../api/client.ts';
import type { Conclusion, DonePayload, ScorePayload, StatusPayload } from '../api/types.ts';
import { deviceFingerprint } from '../lib/format.ts';
import { splitConclusion } from '../lib/structured.ts';
import { useSettings } from './settings.ts';

/** 「工作过程」里的一行 */
export interface TimelineItem {
  kind: 'thinking' | 'tool' | 'tool_result' | 'limit' | 'note';
  /** thinking 的累积文本，或 note 的一句话 */
  text: string;
  /** tool / tool_result 的工具名 */
  name?: string;
  /** tool 的参数摘要（真实参数，不再恒为 `{}`） */
  args?: string;
  /** tool_result 的摘要 */
  summary?: string;
  truncated?: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  /** 正文（用户消息为原话） */
  content: string;
  /** 思维链全文（供「工作过程」折叠区与回溯） */
  reasoning: string;
  items: TimelineItem[];
  conclusion: Conclusion | null;
  conclusionRaw: string | null;
  score: ScorePayload | null;
  status: 'streaming' | 'done' | 'error' | 'aborted';
  error: string | null;
  createdAt: number;
}

/** 已绑定的日志上下文 */
export interface LogContext {
  /** LogShare 日志 ID（只读引用；请求里传 logId 时服务端自行取回正文） */
  logId: string | null;
  /** 日志正文（粘贴/上传/取回后驻留内存，供直接随请求发送） */
  content: string;
  /** 展示用元信息 */
  label: string;
  bytes: number;
  lines: number;
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}`;
}

function countLines(s: string): number {
  if (s === '') return 0;
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

export function useChat() {
  const settings = useSettings();

  const messages = ref<ChatMessage[]>([]);
  const sessionId = ref<string | null>(null);
  const log = ref<LogContext | null>(null);
  const sending = ref(false);
  const phase = ref('');
  const remaining = ref<number | null>(null);
  const nearLimit = ref(false);
  const uploadNotes = ref<string[]>([]);

  let abort: AbortController | null = null;

  const lastAssistant = computed(() =>
    [...messages.value].reverse().find((m) => m.role === 'assistant'),
  );

  /**
   * 有没有可分析的内容。
   *
   * 注意这里必须写 `(log.value?.logId ?? null) !== null`：若直接写
   * `log.value?.logId !== null`，在 `log` 为 null 时得到 `undefined !== null` → **true**，
   * 于是「一份日志都没有」会被判定成「有日志」。这是上一版就存在的缺陷，
   * 当时不显形是因为入口路径（上传/粘贴/填 ID）就长在那个组件里，误判成 true
   * 反而把入口渲染了出来；重做把入口独立成 `EntryPlate` 之后，它立刻表现为
   * 「首屏挂着一个空的日志栏、却看不到任何入口」。
   */
  const hasLog = computed(() => (log.value?.content ?? '') !== '' || (log.value?.logId ?? null) !== null);

  function push(message: ChatMessage): void {
    messages.value.push(message);
  }

  /** 重置为「新会话」（保留日志上下文，允许对同一份日志开新会话） */
  function newSession(): void {
    stop();
    messages.value = [];
    sessionId.value = null;
    phase.value = '';
    nearLimit.value = false;
  }

  function setLog(next: LogContext | null): void {
    log.value = next;
    uploadNotes.value = [];
  }

  function stop(): void {
    abort?.abort();
    abort = null;
    const last = lastAssistant.value;
    if (last !== undefined && last.status === 'streaming') {
      last.status = 'aborted';
      last.error = '已停止。已产出的内容保留在上方，可继续追问。';
    }
    sending.value = false;
    phase.value = '';
  }

  /**
   * 发一轮对话。
   *
   * `overrideLog` 用于「贴了日志直接问」的场景：一次性日志不写进上下文。
   */
  async function send(text: string, overrideLog?: string): Promise<void> {
    const message = text.trim();
    if (message === '' || sending.value) return;

    sending.value = true;
    phase.value = '正在准备…';

    push({
      id: nextId('u'),
      role: 'user',
      content: message,
      reasoning: '',
      items: [],
      conclusion: null,
      conclusionRaw: null,
      score: null,
      status: 'done',
      error: null,
      createdAt: Date.now(),
    });

    const assistant: ChatMessage = {
      id: nextId('a'),
      role: 'assistant',
      content: '',
      reasoning: '',
      items: [],
      conclusion: null,
      conclusionRaw: null,
      score: null,
      status: 'streaming',
      error: null,
      createdAt: Date.now(),
    };
    push(assistant);

    const logContent = overrideLog ?? log.value?.content ?? '';
    const logId = overrideLog === undefined ? (log.value?.logId ?? undefined) : undefined;

    const body = {
      message,
      ...(logContent !== '' ? { logContent } : {}),
      ...(logId !== undefined ? { logId } : {}),
      ...(sessionId.value !== null ? { sessionId: sessionId.value } : {}),
      ...(settings.providerReady.value
        ? {
            provider: {
              baseUrl: settings.provider.value.baseUrl.trim(),
              apiKey: settings.provider.value.apiKey.trim(),
              model: settings.provider.value.model.trim(),
            },
          }
        : {}),
      fingerprint: deviceFingerprint(),
    };

    abort = new AbortController();
    const controller = abort;

    /** 追加「工作过程」条目 */
    const onStatus = (payload: StatusPayload): void => {
      const type = payload.type;

      if (type === 'thinking') {
        const delta = (payload as { delta?: string }).delta ?? '';
        assistant.reasoning += delta;
        const tail = assistant.items[assistant.items.length - 1];
        if (tail !== undefined && tail.kind === 'thinking') tail.text += delta;
        else assistant.items.push({ kind: 'thinking', text: delta });
        phase.value = '正在思考…';
        return;
      }

      if (type === 'tool') {
        const name = (payload as { name?: string }).name ?? '未知工具';
        const args = (payload as { arguments?: unknown }).arguments;
        let argsText = '';
        try {
          argsText = typeof args === 'string' ? args : JSON.stringify(args ?? {});
        } catch {
          argsText = String(args);
        }
        assistant.items.push({ kind: 'tool', text: '', name, args: argsText });
        phase.value = `正在调用 ${name}…`;
        return;
      }

      if (type === 'tool_result') {
        const p = payload as { name?: string; summary?: string; truncated?: boolean };
        assistant.items.push({
          kind: 'tool_result',
          text: '',
          ...(p.name !== undefined ? { name: p.name } : {}),
          summary: p.summary ?? '',
          ...(p.truncated !== undefined ? { truncated: p.truncated } : {}),
        });
        return;
      }

      if (type === 'limit') {
        const rounds = (payload as { rounds?: number }).rounds ?? 0;
        assistant.items.push({
          kind: 'limit',
          text: `已达到 ${rounds} 轮工具调用上限，接下来只做结论汇总。`,
        });
        phase.value = '正在汇总结论…';
        return;
      }

      if (type === 'queued') {
        const p = payload as { message?: string; position?: number };
        phase.value = p.message ?? '排队中…';
        return;
      }

      if (type === 'reflection') {
        assistant.items.push({
          kind: 'note',
          text: (payload as { message?: string }).message ?? '',
        });
        return;
      }

      // 未知帧类型不报错、不显示——服务端将来加帧不应把界面搞坏
    };

    const onDone = (payload: DonePayload): void => {
      if (typeof payload.sessionId === 'string' && payload.sessionId !== '') {
        sessionId.value = payload.sessionId;
      }
      if (typeof payload.remaining === 'number') remaining.value = payload.remaining;
      nearLimit.value = payload.nearLimit === true;
      if (payload.score !== undefined) assistant.score = payload.score;

      if (payload.status !== 'completed') {
        assistant.status = 'error';
        assistant.error = `分析未完成（${payload.status}）。`;
      } else {
        assistant.status = 'done';
      }
    };

    try {
      await streamChat(
        body,
        {
          onStatus,
          onContent: (delta) => {
            assistant.content += delta;
            phase.value = '正在输出结论…';
          },
          onDone,
          onError: (message) => {
            assistant.status = 'error';
            assistant.error = message;
          },
        },
        controller.signal,
      );
    } catch (e) {
      if (controller.signal.aborted) {
        assistant.status = 'aborted';
        assistant.error = '已停止。';
      } else {
        assistant.status = 'error';
        assistant.error =
          e instanceof ApiError
            ? e.status === 429
              ? `${e.message}（今日额度已用完，可直接把日志粘贴进对话继续用。）`
              : e.message
            : e instanceof Error
              ? `连接失败：${e.message}`
              : '连接失败';
      }
    } finally {
      if (assistant.status === 'streaming') {
        // 流结束了但没收到 done 帧：多为连接被中途掐断
        assistant.status = assistant.content.trim() === '' ? 'error' : 'done';
        if (assistant.status === 'error') assistant.error = '连接中断，未收到完整结果。';
      }
      // 正文末尾的结构化块拆出来单独呈现（正文里不再留裸 JSON）
      if (assistant.content !== '') {
        const split = splitConclusion(assistant.content);
        assistant.conclusion = split.conclusion;
        assistant.conclusionRaw = split.raw;
        assistant.content = split.body;
      }
      sending.value = false;
      phase.value = '';
      abort = null;
    }
  }

  /** 上传日志（走 LogShare 的完整流水线：脱敏 + 去重 + 异步反混淆） */
  async function uploadFiles(files: File[]): Promise<string | null> {
    if (files.length === 0) return null;

    const textFiles = files.filter((f) => /\.(log|txt|md|json|yml|yaml|toml|ini|cfg|properties)$/i.test(f.name));
    if (textFiles.length === 0) {
      return '只支持文本类日志（.log/.txt/.json/.yml/.toml 等）。压缩包请先在启动器里解开，或直接把内容粘贴进对话框。';
    }

    const [main, ...rest] = textFiles;
    const content = main === undefined ? '' : await main.text();
    const attachments = await Promise.all(
      rest.slice(0, 20).map(async (f) => ({ name: f.name, data: await f.text() })),
    );

    try {
      const res = await uploadApi({
        content,
        ...(attachments.length > 0 ? { files: attachments } : {}),
        fingerprint: deviceFingerprint(),
      });
      if (!res.ok || typeof res.id !== 'string') {
        return res.error ?? '上传失败';
      }
      uploadNotes.value = res.notes ?? [];
      setLog({
        logId: res.id,
        content: '',
        label: '上传的日志',
        bytes: new Blob([content]).size,
        lines: countLines(content),
      });
      if (typeof res.remaining === 'number') remaining.value = res.remaining;
      return null;
    } catch (e) {
      return e instanceof ApiError ? e.message : e instanceof Error ? `上传失败：${e.message}` : '上传失败';
    }
  }

  /** 直接以粘贴内容作为日志上下文（不入库，随请求一次性带上） */
  function useTextAsLog(content: string): void {
    setLog({
      logId: null,
      content,
      label: '粘贴的日志',
      bytes: new Blob([content]).size,
      lines: countLines(content),
    });
  }

  /** 以 LogShare 日志 ID 作为上下文（正文由服务端取回） */
  function useLogId(logId: string): void {
    setLog({ logId: logId.trim(), content: '', label: `日志 ${logId.trim()}`, bytes: 0, lines: 0 });
  }

  /** 回放历史会话（48h 内 / 跟随日志 TTL） */
  async function replaySession(id: string): Promise<string | null> {
    try {
      const res = await replay(id);
      messages.value = res.messages.map((m) => ({
        id: nextId(m.role === 'user' ? 'u' : 'a'),
        role: m.role,
        content: m.content,
        reasoning: m.reasoning ?? '',
        items: [],
        conclusion: null,
        conclusionRaw: null,
        score: null,
        status: 'done' as const,
        error: null,
        createdAt: m.createdAt,
      }));
      // 历史里的结论块如果还在正文里，同样拆出来（旧记录可能未拆）
      for (const m of messages.value) {
        if (m.role !== 'assistant' || m.content === '') continue;
        const split = splitConclusion(m.content);
        m.conclusion = split.conclusion;
        m.conclusionRaw = split.raw;
        m.content = split.body;
      }
      sessionId.value = res.session.id;
      if (res.session.logId !== null) {
        setLog({
          logId: res.session.logId,
          content: '',
          label: `日志 ${res.session.logId}`,
          bytes: 0,
          lines: 0,
        });
      }
      if (typeof res.rounds.remaining === 'number') remaining.value = res.rounds.remaining;
      return null;
    } catch (e) {
      return e instanceof ApiError ? e.message : '会话读取失败';
    }
  }

  return {
    messages,
    sessionId,
    log,
    sending,
    phase,
    remaining,
    nearLimit,
    hasLog,
    uploadNotes,
    send,
    stop,
    newSession,
    setLog,
    uploadFiles,
    useTextAsLog,
    useLogId,
    replaySession,
  };
}
