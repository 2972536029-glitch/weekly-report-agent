// GLM chat 客户端(非流式,带 tool calling)+ 可注入的模型接口。
//
// 为什么非流式:命令行 Agent 的产物是一篇草稿,不是打字机体验;一次拿到
// 完整的 tool_calls 比拼装 SSE 分片简单一个量级(流式拼装逻辑见宝可梦项目)。
//
// ChatModel 是 agent 循环唯一依赖的接口——E2E 注入 fake 模型走完整循环,
// 一分钱不烧;真模型只在最后验收跑。这和宝可梦项目 "mock 与生产行为同构"
// 的教训一致:测试路径必须是同一套循环代码,而不是旁路。

import { requireEnv } from './env.js';
import type { ChatResponse, LlmMessage, ToolDef } from './types.js';

const MAX_ATTEMPTS = 4;

export interface ChatModel {
  /** 模型标识,写入审计日志首行(如 "glm-4-flash" / "fake-scripted") */
  name: string;
  chat(messages: LlmMessage[], tools: ToolDef[]): Promise<ChatResponse>;
}

class RetryableError extends Error {}

function isTransient(err: unknown): boolean {
  if (err instanceof RetryableError) return true;
  if (err instanceof TypeError) return true; // fetch 网络失败抛 TypeError
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return true;
  return false;
}

interface ChatCompletionJson {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
    };
    finish_reason?: string;
  }>;
}

export function createGlmModel(): ChatModel {
  const model = process.env.GLM_MODEL ?? 'glm-4-flash';
  return {
    name: model,
    async chat(messages: LlmMessage[], tools: ToolDef[]): Promise<ChatResponse> {
      const key = requireEnv('GLM_API_KEY');
      const body = {
        model,
        messages,
        temperature: 0.3,
        // 周报草稿以中文长文为主;被 max_tokens 掐断会存进半篇草稿,给足余量
        max_tokens: 3000,
        tools: tools.map(t => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
      };
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          const res = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(60_000),
          });
          if (!res.ok) {
            const detail = (await res.text()).slice(0, 300);
            // 429/5xx 是暂时性故障,退避重试;4xx(如 key 无效)重试无意义,直接抛
            if (res.status === 429 || res.status >= 500) throw new RetryableError(`GLM API ${res.status}: ${detail}`);
            throw new Error(`GLM API ${res.status}: ${detail}`);
          }
          const json = (await res.json()) as ChatCompletionJson;
          const choice = json.choices?.[0];
          const msg = choice?.message;
          return {
            text: typeof msg?.content === 'string' ? msg.content : '',
            toolCalls: (msg?.tool_calls ?? []).map(c => ({
              id: c.id,
              function: { name: c.function.name, arguments: c.function.arguments },
            })),
          };
        } catch (err) {
          if (!isTransient(err) || attempt === MAX_ATTEMPTS - 1) throw err;
          const delay = 500 * 2 ** attempt + Math.random() * 400;
          process.stderr.write(`GLM 调用失败(第 ${attempt + 1} 次),${delay.toFixed(0)}ms 后重试: ${err instanceof Error ? err.message : err}\n`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
      throw new Error('chat: 不可达');
    },
  };
}
