import { emitProgress } from '../lib/progressEmitter.js';
import { logger } from '../lib/logger.js';
import { continueSubAgentAfterStrategyReview } from './reviewContinuation.js';
import type { Message } from './types.js';
import type { StrategyAgentType, StrategyReviewDecision, StrategyReviewResult } from './strategyAgent.js';

export interface StrategyOrchestratorArgs {
  query: string;
  context?: string;
  depth?: string;
}

export interface StrategySessionAdapter {
  plan(context?: string): Promise<string>;
  review(result: string): Promise<StrategyReviewResult>;
  synthesize(result: string, reviewFeedback?: string): Promise<string>;
  flushLog(): Promise<void>;
  getHistorySize(): number;
}

export interface StrategySubAgentResult {
  response: string;
  history: Message[];
}

export type StrategySubAgentFn = (
  query: string,
  context?: string,
  depth?: string,
  existingHistory?: Message[],
) => Promise<StrategySubAgentResult>;

export interface ExecuteStrategyFlowInput {
  agentType: StrategyAgentType;
  args: StrategyOrchestratorArgs;
  agentFn: StrategySubAgentFn;
  strategy: StrategySessionAdapter;
  agentLabel: string;
}

export interface ExecuteStrategyFlowResult {
  finalReport: string;
  finalResult: string;
  reviewFeedback: string;
  reviewDecision: StrategyReviewDecision | 'skipped';
  usedCorrectionPass: boolean;
  strategyHistorySize: number;
  agentHistory: Message[];
}

export async function executeStrategyFlow({
  args,
  agentFn,
  strategy,
  agentLabel,
}: ExecuteStrategyFlowInput): Promise<ExecuteStrategyFlowResult> {
  const plan = await strategy.plan(args.context);
  const planContext = plan ? `\n\n[STRATEGY PLAN — Research according to this plan]:\n${plan}` : '';
  let effectiveDepth = args.depth;

  let result: string;
  let agentHistory: Message[];

  try {
    const agentResult = await agentFn(
      args.query,
      (args.context || '') + planContext,
      args.depth,
    );
    result = agentResult.response;
    agentHistory = agentResult.history;
  } catch (agentError) {
    const errMsg = agentError instanceof Error ? agentError.message : String(agentError);
    logger.error('AGENT', `[${agentLabel}] crashed: ${errMsg.slice(0, 200)}`);

    emitProgress(`⚠️ [${agentLabel}] crashed, retrying with quick depth...`);
    try {
      const retryResult = await agentFn(
        args.query,
        (args.context || '') + planContext,
        'quick',
      );
      effectiveDepth = 'quick';
      result = retryResult.response;
      agentHistory = retryResult.history;
    } catch {
      const failure = `❌ ${agentLabel} failed after retry: ${errMsg.slice(0, 300)}.\n\nThe sub-agent encountered an error during research. Try rephrasing the query or reducing scope.`;
      await strategy.flushLog();
      return {
        finalReport: failure,
        finalResult: failure,
        reviewFeedback: '',
        reviewDecision: 'skipped',
        usedCorrectionPass: false,
        strategyHistorySize: strategy.getHistorySize(),
        agentHistory: [],
      };
    }
  }

  let finalResult = result;
  let reviewFeedback = '';
  let reviewDecision: StrategyReviewDecision | 'skipped' = 'skipped';
  let usedCorrectionPass = false;

  if (result.length > 200) {
    const review = await strategy.review(result);
    reviewFeedback = review.feedback;
    reviewDecision = review.decision;

    if (review.decision === 'revise_same_history') {
      const correction = await continueSubAgentAfterStrategyReview(
        args.query,
        effectiveDepth,
        review.feedback,
        agentFn,
        agentHistory,
      );

      finalResult = correction.correctedResult;
      agentHistory = correction.correctedHistory;
      usedCorrectionPass = true;

      const correctionNote = correction.acceptedCorrection
        ? '[REVIEW_CORRECTION_STATUS]\nA bounded same-history correction pass completed successfully. Keep unresolved limitations explicit.'
        : '[REVIEW_CORRECTION_STATUS]\nA bounded same-history correction pass ran but did not fully resolve the review concerns. Finalize with explicit limitations.';
      reviewFeedback = reviewFeedback ? `${reviewFeedback}\n\n${correctionNote}` : correctionNote;
    } else if (review.decision === 'finalize_with_limitations') {
      const limitationNote = '[REVIEW_DECISION_NOTE]\nDo not request more open-ended research. Finalize the report with explicit limitations.';
      reviewFeedback = reviewFeedback ? `${reviewFeedback}\n\n${limitationNote}` : limitationNote;
    }
  }

  let finalReport = finalResult;
  const shouldSynthesize = finalResult.length > 500 || reviewFeedback.trim().length > 0;
  if (shouldSynthesize) {
    finalReport = await strategy.synthesize(finalResult, reviewFeedback);
  }

  await strategy.flushLog();
  return {
    finalReport,
    finalResult,
    reviewFeedback,
    reviewDecision,
    usedCorrectionPass,
    strategyHistorySize: strategy.getHistorySize(),
    agentHistory,
  };
}