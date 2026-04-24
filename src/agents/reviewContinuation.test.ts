import assert from 'node:assert/strict';
import test from 'node:test';

import {
  continueSubAgentAfterStrategyReview,
  isAcceptableReviewedSubAgentResponse,
  looksLikeStrategyRevisionAcknowledgement,
} from './reviewContinuation.js';
import type { Message } from './types.js';

function makeHistory(): Message[] {
  return [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'original research task' },
  ];
}

function makeLongReport(title: string): string {
  return [
    `## ${title}`,
    '- Paper 1: detailed venue-backed citation and short synthesis.',
    '- Paper 2: detailed venue-backed citation and short synthesis.',
    '- Paper 3: detailed venue-backed citation and short synthesis.',
    '',
    '### Notes',
    'This corrected report uses only tool-backed findings, states missing details explicitly, and does not promise future searches.',
    'Every item is written as a final result rather than an execution update.',
  ].join('\n');
}

test('looksLikeStrategyRevisionAcknowledgement detects non-final status updates', () => {
  const acknowledgement = "I'll fix the issues using information from the tool results I already have. Let me search for additional details on the survey paper to complete the citation.";
  const structuredStatusUpdate = [
    'Understood. I am correcting the report now.',
    '1. Re-check the incomplete survey citation.',
    '2. Verify the venue details.',
    '3. Update the final answer after I finish the search.',
  ].join('\n');
  const changelogStyleUpdate = [
    'Updated the report and fixed the citation gaps.',
    '- Corrected the survey entry.',
    '- Revised the MetaGPT citation.',
    '- Addressed the missing venue details.',
  ].join('\n');
  const plainProseFinal = [
    'The corrected result contains exactly three peer-reviewed papers on multi-agent LLM orchestration frameworks.',
    'AutoGen, MetaGPT, and ChatDev are each cited with venue-backed publication details, and the previously incomplete survey entry has been removed rather than guessed.',
    'Where venue metadata remained absent from the tool output, the report marks it explicitly as missing instead of promising more searches.',
  ].join(' ');
  const hybridFinal = [
    'Understood. I fixed the citation gaps and rewrote the report below.',
    '',
    makeLongReport('Corrected Final Report'),
  ].join('\n');
  const longChangelogOnly = `${'Updated the report and fixed the citation gaps. '.repeat(45)}\n${'Corrections made to the summary. '.repeat(20)}`;

  assert.equal(looksLikeStrategyRevisionAcknowledgement(acknowledgement), true);
  assert.equal(looksLikeStrategyRevisionAcknowledgement(structuredStatusUpdate), true);
  assert.equal(looksLikeStrategyRevisionAcknowledgement(changelogStyleUpdate), true);
  assert.equal(looksLikeStrategyRevisionAcknowledgement(longChangelogOnly), true);
  assert.equal(looksLikeStrategyRevisionAcknowledgement(makeLongReport('Corrected Final Report')), false);
  assert.equal(looksLikeStrategyRevisionAcknowledgement(hybridFinal), false);
  assert.equal(isAcceptableReviewedSubAgentResponse(structuredStatusUpdate), false);
  assert.equal(isAcceptableReviewedSubAgentResponse(changelogStyleUpdate), false);
  assert.equal(isAcceptableReviewedSubAgentResponse(longChangelogOnly), false);
  assert.equal(isAcceptableReviewedSubAgentResponse(plainProseFinal), true);
  assert.equal(isAcceptableReviewedSubAgentResponse(hybridFinal), true);
});

test('continueSubAgentAfterStrategyReview retries when the first corrected pass is only an acknowledgement', async () => {
  const callHistories: Message[][] = [];
  const acknowledgement = "I'll fix the issues using information from the tool results I already have. Let me search for additional details on the survey paper to complete the citation.";
  const correctedReport = makeLongReport('Corrected Final Report');

  const agentFn = async (_query: string, _context?: string, _depth?: string, existingHistory?: Message[]) => {
    const history = [...(existingHistory ?? [])];
    callHistories.push(history);

    if (callHistories.length === 1) {
      return {
        response: acknowledgement,
        history: [...history, { role: 'assistant' as const, content: acknowledgement }],
      };
    }

    return {
      response: correctedReport,
      history: [...history, { role: 'assistant' as const, content: correctedReport }],
    };
  };

  const result = await continueSubAgentAfterStrategyReview(
    'find exactly 3 peer-reviewed papers',
    'normal',
    '[ISSUE_DESCRIPTION]\n- Citation incomplete',
    agentFn,
    makeHistory(),
  );

  assert.equal(result.acceptedCorrection, true);
  assert.equal(result.usedFinalizationRetry, true);
  assert.equal(result.correctedResult, correctedReport);
  assert.equal(callHistories.length, 2);
  assert.match(String(callHistories[0].at(-1)?.content), /STRATEGY REVIEW — Correction Required/);
  assert.match(String(callHistories[1].at(-1)?.content), /STRATEGY REVIEW — Final Report Required/);
});

test('continueSubAgentAfterStrategyReview accepts a substantive corrected report immediately', async () => {
  const callHistories: Message[][] = [];
  const correctedReport = makeLongReport('Immediate Corrected Report');

  const agentFn = async (_query: string, _context?: string, _depth?: string, existingHistory?: Message[]) => {
    const history = [...(existingHistory ?? [])];
    callHistories.push(history);

    return {
      response: correctedReport,
      history: [...history, { role: 'assistant' as const, content: correctedReport }],
    };
  };

  const result = await continueSubAgentAfterStrategyReview(
    'find exactly 3 peer-reviewed papers',
    'normal',
    '[ISSUE_DESCRIPTION]\n- Citation incomplete',
    agentFn,
    makeHistory(),
  );

  assert.equal(result.acceptedCorrection, true);
  assert.equal(result.usedFinalizationRetry, false);
  assert.equal(result.correctedResult, correctedReport);
  assert.equal(callHistories.length, 1);
});