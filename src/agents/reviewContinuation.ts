import type { Message } from './types.js';

export interface StrategyReviewSubAgentResult {
  response: string;
  history: Message[];
}

export type StrategyReviewSubAgentFn = (
  query: string,
  context?: string,
  depth?: string,
  existingHistory?: Message[],
) => Promise<StrategyReviewSubAgentResult>;

export interface StrategyReviewContinuationResult {
  correctedResult: string;
  correctedHistory: Message[];
  acceptedCorrection: boolean;
  usedFinalizationRetry: boolean;
}

export const STRATEGY_REVIEW_CORRECTION_HEADER = '[STRATEGY REVIEW — Correction Required]';
export const STRATEGY_REVIEW_FINAL_REPORT_HEADER = '[STRATEGY REVIEW — Final Report Required]';
export const STRATEGY_REVIEW_INTERNAL_PREFIXES = [
  STRATEGY_REVIEW_CORRECTION_HEADER,
  STRATEGY_REVIEW_FINAL_REPORT_HEADER,
] as const;

const MIN_SUBSTANTIVE_RESPONSE_CHARS = 200;

export function buildStrategyCorrectionPrompt(feedback: string): string {
  return (
    `${STRATEGY_REVIEW_CORRECTION_HEADER}\n\n` +
    `Review result:\n${feedback.slice(0, 4000)}\n\n` +
    `Fix the issues above. Run missing tools only if they are truly needed, correct incorrect information, ` +
    `and then write the corrected final Markdown report. ` +
    `Do not reply with a status update like "I'll fix it" or "let me search". ` +
    `Remember the results of tools you already called — do not call them again unless the review shows a concrete missing gap.`
  );
}

export function buildStrategyFinalReportPrompt(): string {
  return (
    `${STRATEGY_REVIEW_FINAL_REPORT_HEADER}\n\n` +
    `Your previous response was only a status update, not the corrected report. ` +
    `Do not explain what you will do next. Using the tool results already in history, write the corrected final Markdown report now. ` +
    `If a citation or venue detail is still missing, mark it explicitly as missing instead of promising another search.`
  );
}

export function looksLikeStrategyRevisionAcknowledgement(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return false;

  const opening = normalized.slice(0, 320).toLowerCase();
  const processIntentPatterns = [
    /(?:^|\b)(?:ok|okay|sure|certainly|understood|got it)\b.{0,160}\b(?:fix|correct|revise|update|search|look up|gather|verify|check|complete|refine|improve|rerun|re-run)\b/i,
    /(?:^|\b)(?:i(?:'|’)ll|i will|i can|let me|i need to|i(?:'|’)m going to|i’m going to|i am going to|i(?:'|’)m|i am)\b.{0,160}\b(?:fix|correct|revise|update|search|look up|gather|verify|check|complete|refine|improve|rerun|re-run|finish)\b/i,
    /\busing (?:the )?tool results\b.{0,160}\b(?:fix|correct|complete|search|verify|update)\b/i,
    /\b(?:next step|next,|first,|then,|after that|once i finish|when i finish|working on|currently)\b/i,
    /\b(?:updated|fixed|corrected|revised|addressed)\b.{0,160}\b(?:report|citation|issue|gap|feedback|problem|section|summary)\b/i,
    /\b(?:changes made|what i changed|i made the following changes|summary of changes|corrections made|revisions made)\b/i,
  ];
  const claimsFinalDelivery = /\b(?:final report|corrected report|revised report|here is the corrected|below is the corrected|report below|answer below|below is (?:the )?(?:report|corrected report|final answer)|the corrected report follows|full report below|rewrote the report below)\b/i.test(opening);
  const hasReportSectionHeading = /(^|\n)#{1,3}\s(?!changes\b|update\b|updates\b|corrections\b|what i changed\b|summary of changes\b|revisions\b)/im.test(text);
  const hasReportTable = /(^|\n)\|.+\|/m.test(text);
  const hasEvidenceSignals = /\bdoi\b|\barxiv:\b|\[source:|https?:\/\//i.test(text);
  const hasStrongReportBody = hasReportSectionHeading || hasReportTable || hasEvidenceSignals;

  return !claimsFinalDelivery && !hasStrongReportBody && processIntentPatterns.some((pattern) => pattern.test(opening));
}

export function isAcceptableReviewedSubAgentResponse(text: string): boolean {
  const normalized = text.trim();
  return normalized.length > MIN_SUBSTANTIVE_RESPONSE_CHARS && !looksLikeStrategyRevisionAcknowledgement(normalized);
}

export async function continueSubAgentAfterStrategyReview(
  query: string,
  depth: string | undefined,
  reviewFeedback: string,
  agentFn: StrategyReviewSubAgentFn,
  agentHistory: Message[],
): Promise<StrategyReviewContinuationResult> {
  const firstPassHistory = [
    ...agentHistory,
    {
      role: 'user' as const,
      content: buildStrategyCorrectionPrompt(reviewFeedback),
    },
  ];

  const firstPass = await agentFn(query, undefined, depth, firstPassHistory);
  if (isAcceptableReviewedSubAgentResponse(firstPass.response)) {
    return {
      correctedResult: firstPass.response,
      correctedHistory: firstPass.history,
      acceptedCorrection: true,
      usedFinalizationRetry: false,
    };
  }

  if (!looksLikeStrategyRevisionAcknowledgement(firstPass.response)) {
    return {
      correctedResult: firstPass.response,
      correctedHistory: firstPass.history,
      acceptedCorrection: false,
      usedFinalizationRetry: false,
    };
  }

  const secondPassHistory = [
    ...firstPass.history,
    {
      role: 'user' as const,
      content: buildStrategyFinalReportPrompt(),
    },
  ];

  const secondPass = await agentFn(query, undefined, depth, secondPassHistory);
  return {
    correctedResult: secondPass.response,
    correctedHistory: secondPass.history,
    acceptedCorrection: isAcceptableReviewedSubAgentResponse(secondPass.response),
    usedFinalizationRetry: true,
  };
}