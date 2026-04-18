import type OpenAI from 'openai';

export type ToolExecutor = (name: string, args: Record<string, string>) => Promise<string>;

export interface AgentConfig {
  name: string;
  systemPrompt: string;
  tools: OpenAI.Chat.ChatCompletionTool[];
  executeTool: ToolExecutor;
  model?: string;
  maxToolCalls?: number;       // default 30; increase for agents doing deep research
  maxTokens?: number;          // default 32768; increase for agents with large context like Supervisor
  maxEmptyRetries?: number;    // default 1; increase for long tool chains like MediaAgent
  toolLimits?: Record<string, number>;  // per-tool hard limits, merged with defaults
}

export type Message = OpenAI.Chat.ChatCompletionMessageParam;

export interface AgentResult {
  finalResponse: string;
  toolCallCount: number;
  toolsUsed: Record<string, number>; // tool_name -> how many times called
  history?: Message[];               // sub-agent conversation history (for AutoGen-style continuation)
}
