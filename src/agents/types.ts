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

export interface PromptBudgetPolicy {
  maxPromptChars: number;
  maxMemoryChars: number;
  maxRecentChars: number;
  maxEpisodePreviewChars: number;
  maxRecentUnits: number;
}

export interface ToolCallMemory {
  toolName: string;
  argsHash: string;
  argsPreview: string;
  resultPreview: string;
  yieldedNewUrls: number;
}

export interface ToolEpisodeMemory {
  id: string;
  startIndex: number;
  endIndex: number;
  headline: string;
  toolCalls: ToolCallMemory[];
}

export interface AgentWorkingMemory {
  objective: string | null;
  latestExternalUserMessage: string | null;
  latestAssistantSummary: string | null;
  phase: string | null;
  nextActions: string[];
}

export interface AgentRuntimeState {
  toolCallCount: number;
  toolsUsed: Record<string, number>;
  perToolCount: Record<string, number>;
  duplicateToolCache: Record<string, string>;
  seenUrls: string[];
  lowYieldStreak: number;
  toolsDisabled: boolean;
}

export interface AgentSessionSnapshot {
  schemaVersion: 1;
  agentName: string;
  workingMemory: AgentWorkingMemory;
  runtime: AgentRuntimeState;
  episodes: ToolEpisodeMemory[];
  processedMessageCount: number;
  updatedAt: string;
}

export interface AgentResult {
  finalResponse: string;
  toolCallCount: number;
  toolsUsed: Record<string, number>; // tool_name -> how many times called
  history?: Message[];               // sub-agent conversation history (for AutoGen-style continuation)
  session?: AgentSessionSnapshot;
}
