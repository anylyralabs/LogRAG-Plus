/**
 * 本地模型服务的 SSE 兼容适配。
 *
 * ## 背景
 * 实测发现：本地端点（127.0.0.1:8765）**忽略 `stream: false`，始终返回
 * `text/event-stream`**。而 LangChain 的 `ChatOpenAI` 在非流式模式下期望 JSON，
 * 会解析失败（`Cannot read properties of undefined (reading 'message')`）。
 *
 * ## 方案
 * 强制 LangChain 走流式路径（`streaming: true`），由 `ChatOpenAI` 内部的 SSE
 * 解析器消费——这条路径对 SSE 是原生支持的。
 *
 * 这是**环境适配**，不是业务逻辑：生产环境若使用标准 OpenAI 兼容端点，
 * 此适配不会造成任何影响（流式也是合法模式）。
 */

import { ChatOpenAI } from '@langchain/openai';

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** 自定义请求头（部分网关需要 Referer / X-Title 等） */
  headers?: Record<string, string>;
}

/**
 * 构造模型实例。
 *
 * 关键配置：
 *  - `streaming: true`：强制走 SSE 路径（兼容始终返回 SSE 的端点）
 *  - `streamUsage: false`：部分端点不支持 `stream_options.include_usage`，开启会导致 400
 *  - `configuration.baseURL`：自定义供应商
 */
export function createModel(cfg: ProviderConfig): ChatOpenAI {
  return new ChatOpenAI({
    model: cfg.model,
    apiKey: cfg.apiKey,
    temperature: cfg.temperature ?? 0,
    ...(cfg.maxTokens !== undefined ? { maxTokens: cfg.maxTokens } : {}),
    configuration: {
      baseURL: cfg.baseUrl,
      ...(cfg.headers !== undefined ? { defaultHeaders: cfg.headers } : {}),
    },
    // 强制流式：本地/自建端点常常忽略 stream:false 而始终返回 SSE
    streaming: true,
    // 多数自建端点不支持 stream_options.include_usage
    streamUsage: false,
  });
}
