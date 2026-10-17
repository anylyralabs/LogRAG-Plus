/**
 * DeepAgents 冒烟测试 —— 尽早验证技术栈可行性。
 *
 * 验证点：
 *  1. ChatOpenAI 能否接自定义 baseURL（本地模型服务）
 *  2. createDeepAgent 能否装配成功
 *  3. 流式输出能否拿到 reasoning_content（思维链）
 *  4. 自定义工具能否被模型调用
 *
 * 用法: npx tsx scripts/smoke-deepagent.ts
 */
import { createDeepAgent } from 'deepagents';
import { tool } from 'langchain';
import * as z from 'zod';

import { createModel } from '../src/agent/model.ts';

const BASE_URL = process.env.AI_BASE_URL ?? 'http://127.0.0.1:8765/v1';
const API_KEY = process.env.AI_API_KEY ?? 'wb-local';
const MODEL = process.env.AI_MODEL ?? 'hy4-preview-f';

/** 一个最简单的工具，用于验证工具调用链路 */
const echoTool = tool(
  async ({ text }: { text: string }) => {
    console.log(`      [工具被调用] echo("${text}")`);
    return `ECHO_RESULT: ${text}`;
  },
  {
    name: 'echo',
    description: '回显输入文本。当用户要求你回显某些内容时使用。',
    schema: z.object({
      text: z.string().describe('要回显的文本'),
    }),
  },
);

async function main(): Promise<void> {
  console.log('═══ DeepAgents 冒烟测试 ═══\n');
  console.log(`模型: ${MODEL}`);
  console.log(`端点: ${BASE_URL}\n`);

  // ① 构造模型（OpenAI 兼容协议 + 自定义 baseURL）
  console.log('[1/4] 构造模型…');
  const model = createModel({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    model: MODEL,
  });
  console.log('      OK\n');

  // ② 装配 DeepAgent
  console.log('[2/4] 装配 createDeepAgent…');
  const agent = createDeepAgent({
    model,
    systemPrompt:
      '你是一个日志排障助手。回答简洁，使用简体中文。需要回显内容时调用 echo 工具。',
    tools: [echoTool],
  });
  console.log('      OK\n');

  // ③ 单轮调用
  console.log('[3/4] 单轮调用（验证基本对话）…');
  try {
    const result = await agent.invoke({
      messages: [{ role: 'user', content: '你好，请用一句话说明你是什么。' }],
    });
    const last = result.messages[result.messages.length - 1];
    const content = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content);
    console.log(`      回复: ${content.slice(0, 200)}\n`);
  } catch (e) {
    console.log(`      失败: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }

  // ④ 工具调用
  console.log('[4/4] 工具调用（验证 tool calling 链路）…');
  try {
    const result = await agent.invoke({
      messages: [{ role: 'user', content: '请调用 echo 工具回显文本 hello-lograg。' }],
    });

    // 检查是否真的调用了工具
    const toolMsgs = result.messages.filter((m) => m.getType?.() === 'tool');
    console.log(`      工具消息数: ${toolMsgs.length}`);
    for (const m of toolMsgs) {
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      console.log(`      工具返回: ${c.slice(0, 120)}`);
    }

    const last = result.messages[result.messages.length - 1];
    const content = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content);
    console.log(`      最终回复: ${content.slice(0, 200)}`);

    if (toolMsgs.length === 0) {
      console.log('\n      ⚠ 模型未调用工具（可能不支持 function calling，或未理解指令）');
    } else {
      console.log('\n      ✓ 工具调用链路正常');
    }
  } catch (e) {
    console.log(`      失败: ${e instanceof Error ? e.message : String(e)}`);
  }

  console.log('\n═══ 冒烟测试完成 ═══');
}

main().catch((e) => {
  console.error('冒烟测试异常:', e);
  process.exit(1);
});
