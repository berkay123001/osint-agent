import type OpenAI from 'openai';

export type ToolExecutor = (name: string, args: Record<string, string>) => Promise<string>;

export interface AgentConfig {
  name: string;
  systemPrompt: string;
  tools: OpenAI.Chat.ChatCompletionTool[];
  executeTool: ToolExecutor;
  model?: string;
  maxToolCalls?: number; // default 30; derin araştırma yapan ajanlar için artırılabilir
}

export type Message = OpenAI.Chat.ChatCompletionMessageParam;

export interface AgentResult {
  finalResponse: string;
  toolCallCount: number;
  toolsUsed: Record<string, number>; // tool_name -> kaç kez çağrıldı
}
