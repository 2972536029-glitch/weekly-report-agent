// 共享类型:config、LLM 消息契约、工具契约。

export interface RepoDef {
  name: string;
  path: string;
  desc: string;
}

export interface AppConfig {
  repos: RepoDef[];
  rubric: string;
}

// ---- LLM 消息契约(OpenAI 兼容,GLM 遵循同一契约) -------------------------

export interface ToolCallRequest {
  id: string;
  function: { name: string; arguments: string };
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** 仅 assistant:模型发起的工具调用请求。GLM 严格校验 type 必须是 "function"。 */
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  /** 仅 tool:对应的调用 id */
  tool_call_id?: string;
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCallRequest[];
}

// ---- 工具契约 ---------------------------------------------------------------

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}

export interface ToolResult {
  ok: boolean;
  /** 成功时给模型看的结果文本 */
  data?: string;
  /** 失败时给模型看的错误说明(错误回给模型让它自己决定跳过还是换路) */
  error?: string;
  /** 失败时的补救建议 */
  hint?: string;
  /** save_draft 成功时的内部通道:agent 用来记录草稿路径,不回传给模型 */
  draftPath?: string;
}
