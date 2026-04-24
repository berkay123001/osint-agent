import type { PromptBudgetPolicy } from '../agents/types.js'

const DEFAULT_POLICY: PromptBudgetPolicy = {
  maxPromptChars: 90_000,
  maxMemoryChars: 12_000,
  maxRecentChars: 65_000,
  maxEpisodePreviewChars: 220,
  maxRecentUnits: 18,
}

const MODEL_BUDGETS: Array<{ prefix: string; policy: PromptBudgetPolicy }> = [
  {
    prefix: 'minimax/minimax-m2.5',
    policy: {
      maxPromptChars: 180_000,
      maxMemoryChars: 18_000,
      maxRecentChars: 145_000,
      maxEpisodePreviewChars: 260,
      maxRecentUnits: 28,
    },
  },
  {
    prefix: 'minimax/minimax-m2.7',
    policy: {
      maxPromptChars: 180_000,
      maxMemoryChars: 18_000,
      maxRecentChars: 145_000,
      maxEpisodePreviewChars: 260,
      maxRecentUnits: 28,
    },
  },
  {
    prefix: 'minimax/minimax-m2.1',
    policy: {
      maxPromptChars: 160_000,
      maxMemoryChars: 16_000,
      maxRecentChars: 128_000,
      maxEpisodePreviewChars: 240,
      maxRecentUnits: 24,
    },
  },
  {
    prefix: 'qwen/qwen3.6-plus',
    policy: {
      maxPromptChars: 120_000,
      maxMemoryChars: 12_000,
      maxRecentChars: 96_000,
      maxEpisodePreviewChars: 220,
      maxRecentUnits: 22,
    },
  },
  {
    prefix: 'qwen/qwen3.5-plus',
    policy: {
      maxPromptChars: 120_000,
      maxMemoryChars: 12_000,
      maxRecentChars: 96_000,
      maxEpisodePreviewChars: 220,
      maxRecentUnits: 22,
    },
  },
]

export function resolvePromptBudget(modelName?: string): PromptBudgetPolicy {
  if (!modelName) return { ...DEFAULT_POLICY }

  const match = MODEL_BUDGETS.find(entry => modelName.startsWith(entry.prefix))
  return match ? { ...match.policy } : { ...DEFAULT_POLICY }
}