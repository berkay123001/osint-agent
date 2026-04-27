import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildStrategySystemPrompt,
  getStrategyModelsToTry,
  parseStrategyReviewResult,
  StrategySession,
  type StrategyReviewResult,
} from './strategyAgent.js';
import { executeStrategyFlow } from './strategyOrchestrator.js';
import type { Message } from './types.js';

function makeBaseHistory(): Message[] {
  return [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'original task' },
  ];
}

function makeDetailedReport(title: string): string {
  return [
    `## ${title}`,
    '- Finding 1 with tool-backed evidence and explicit caveats.',
    '- Finding 2 with tool-backed evidence and explicit caveats.',
    '- Finding 3 with tool-backed evidence and explicit caveats.',
    '- Finding 4 with tool-backed evidence and explicit caveats.',
    '- Finding 5 with tool-backed evidence and explicit caveats.',
    '- Finding 6 with tool-backed evidence and explicit caveats.',
    '',
    '### Evidence',
    'https://example.com/source-1',
    'https://example.com/source-2',
    'The report states limitations rather than promising future searches.',
    'This section is intentionally long enough to cross the synthesis threshold and exercise the post-review synthesis path.',
    'It keeps the assertions behavioral: one correction pass, same history, then synthesis over the corrected report.',
  ].join('\n');
}

test('buildStrategySystemPrompt includes only the selected agent review rubric', () => {
  const identityPrompt = buildStrategySystemPrompt('identity');
  assert.match(identityPrompt, /Identity Agent Review/);
  assert.doesNotMatch(identityPrompt, /Academic Agent Review/);
  assert.doesNotMatch(identityPrompt, /Media Agent Review/);

  const academicPrompt = buildStrategySystemPrompt('academic');
  assert.match(academicPrompt, /Academic Agent Review/);
  assert.doesNotMatch(academicPrompt, /Identity Agent Review/);
  assert.doesNotMatch(academicPrompt, /Media Agent Review/);
});

test('getStrategyModelsToTry keeps a deduplicated fallback chain', () => {
  assert.deepEqual(getStrategyModelsToTry(), [
    'qwen/qwen3.6-plus',
    'deepseek/deepseek-v3.2',
  ]);
});

test('parseStrategyReviewResult fails closed for plain-language cautionary reviews', () => {
  const limitationReview = parseStrategyReviewResult(
    'Evidence is too thin to trust. Finalize the report with explicit limitations.',
  );
  assert.equal(limitationReview.decision, 'finalize_with_limitations');

  const malformedMajorReview = parseStrategyReviewResult(
    '[MAJOR] Evidence remains incomplete; keep limitations explicit.',
  );
  assert.equal(malformedMajorReview.decision, 'finalize_with_limitations');

  const correctionReview = parseStrategyReviewResult(
    'One unsupported linkage remains. Do one bounded same-history correction pass.',
  );
  assert.equal(correctionReview.decision, 'revise_same_history');
});

test('StrategySession review fallback returns warning feedback when the model is unavailable', async () => {
  const previousApiKey = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;

  try {
    const session = new StrategySession('identity', 'Investigate the target');
    const review = await session.review(makeDetailedReport('Fallback Review'));

    assert.equal(review.decision, 'accept_with_warnings');
    assert.match(review.feedback, /ACCEPT_WITH_WARNINGS/);
    assert.match(review.summary, /Review failed/);
  } finally {
    if (previousApiKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = previousApiKey;
    }
  }
});

test('executeStrategyFlow performs one same-history correction pass when review requests revision', async () => {
  const initialReport = makeDetailedReport('Initial Report');
  const correctedReport = makeDetailedReport('Corrected Report');
  const calls: Array<{ depth?: string; history?: Message[]; context?: string }> = [];
  const synthesizeInputs: string[] = [];

  const agentFn = async (
    _query: string,
    context?: string,
    depth?: string,
    existingHistory?: Message[],
  ) => {
    calls.push({
      depth,
      history: existingHistory ? [...existingHistory] : undefined,
      context,
    });

    if (calls.length === 1) {
      return {
        response: initialReport,
        history: [...makeBaseHistory(), { role: 'assistant' as const, content: initialReport }],
      };
    }

    const history = [...(existingHistory ?? makeBaseHistory())];
    return {
      response: correctedReport,
      history: [...history, { role: 'assistant' as const, content: correctedReport }],
    };
  };

  const strategy = {
    plan: async () => '1. Use GitHub-backed evidence first.\n2. Correct unsupported claims only.',
    review: async () => ({
      approved: false,
      feedback: [
        '[REVIEW_DECISION]',
        'decision: REVISE_SAME_HISTORY',
        'summary: The report contains unsupported identity linkage that needs one targeted correction pass.',
        'issue: severity=MAJOR | code=unsupported_identity_link | fix_mode=same_history_revision | note=Re-run only the missing verification step and rewrite the report.',
      ].join('\n'),
      decision: 'revise_same_history',
      summary: 'The report contains unsupported identity linkage that needs one targeted correction pass.',
      issues: [
        {
          severity: 'major',
          code: 'unsupported_identity_link',
          fixMode: 'same_history_revision',
          note: 'Re-run only the missing verification step and rewrite the report.',
        },
      ],
    } satisfies StrategyReviewResult),
    synthesize: async (result: string) => {
      synthesizeInputs.push(result);
      return `SYNTHESIZED\n\n${result}`;
    },
    flushLog: async () => {},
    getHistorySize: () => 4,
  };

  const result = await executeStrategyFlow({
    agentType: 'identity',
    args: {
      query: 'Investigate whether johndoe on GitHub and Twitter are the same person',
      context: 'Known identifier set available',
      depth: 'normal',
    },
    agentFn,
    strategy,
    agentLabel: 'IdentityAgent',
  });

  assert.equal(calls.length, 2);
  assert.match(String(calls[1].history?.at(-1)?.content), /STRATEGY REVIEW — Correction Required/);
  assert.equal(result.usedCorrectionPass, true);
  assert.equal(result.reviewDecision, 'revise_same_history');
  assert.equal(synthesizeInputs[0], correctedReport);
  assert.match(result.finalReport, /SYNTHESIZED/);
  assert.match(result.finalReport, /Corrected Report/);
});

test('executeStrategyFlow does not re-run the sub-agent when review accepts with warnings', async () => {
  const initialReport = makeDetailedReport('Accepted With Warnings');
  let callCount = 0;

  const agentFn = async () => {
    callCount++;
    return {
      response: initialReport,
      history: [...makeBaseHistory(), { role: 'assistant' as const, content: initialReport }],
    };
  };

  const strategy = {
    plan: async () => '',
    review: async () => ({
      approved: true,
      feedback: [
        '[REVIEW_DECISION]',
        'decision: ACCEPT_WITH_WARNINGS',
        'summary: The report is usable as-is, but minor caution text should remain in the synthesis.',
      ].join('\n'),
      decision: 'accept_with_warnings',
      summary: 'The report is usable as-is, but minor caution text should remain in the synthesis.',
      issues: [],
    } satisfies StrategyReviewResult),
    synthesize: async (result: string) => result,
    flushLog: async () => {},
    getHistorySize: () => 3,
  };

  const result = await executeStrategyFlow({
    agentType: 'academic',
    args: {
      query: 'Find peer-reviewed work on multi-agent orchestration',
      depth: 'normal',
    },
    agentFn,
    strategy,
    agentLabel: 'AcademicAgent',
  });

  assert.equal(callCount, 1);
  assert.equal(result.usedCorrectionPass, false);
  assert.equal(result.reviewDecision, 'accept_with_warnings');
  assert.equal(result.finalReport, initialReport);
});

test('executeStrategyFlow synthesizes medium-length reports when review says finalize with limitations', async () => {
  const mediumReport = [
    'Short but reviewed result.',
    'It contains some evidence, but not enough to be safely trusted without explicit limitations.',
    'https://example.com/one',
    'https://example.com/two',
    'The reviewer should force a final limitations-aware synthesis even though this is under the normal synthesis threshold.',
  ].join('\n');
  let synthesizeCallCount = 0;

  const agentFn = async () => ({
    response: mediumReport,
    history: [...makeBaseHistory(), { role: 'assistant' as const, content: mediumReport }],
  });

  const strategy = {
    plan: async () => '',
    review: async () => ({
      approved: false,
      feedback: [
        '[REVIEW_DECISION]',
        'decision: FINALIZE_WITH_LIMITATIONS',
        'summary: Evidence remains incomplete, so the result must be finalized with explicit limitations.',
      ].join('\n'),
      decision: 'finalize_with_limitations',
      summary: 'Evidence remains incomplete, so the result must be finalized with explicit limitations.',
      issues: [],
    } satisfies StrategyReviewResult),
    synthesize: async (result: string, feedback?: string) => {
      synthesizeCallCount++;
      return `${result}\n\n${feedback}`;
    },
    flushLog: async () => {},
    getHistorySize: () => 3,
  };

  const result = await executeStrategyFlow({
    agentType: 'media',
    args: {
      query: 'Check whether this claim is sufficiently supported',
      depth: 'normal',
    },
    agentFn,
    strategy,
    agentLabel: 'MediaAgent',
  });

  assert.equal(synthesizeCallCount, 1);
  assert.equal(result.usedCorrectionPass, false);
  assert.equal(result.reviewDecision, 'finalize_with_limitations');
  assert.match(result.finalReport, /FINALIZE_WITH_LIMITATIONS/);
  assert.match(result.finalReport, /Do not request more open-ended research/);
});

test('executeStrategyFlow keeps quick depth for the correction pass after a crash fallback', async () => {
  const recoveredReport = makeDetailedReport('Recovered After Crash');
  const correctedReport = makeDetailedReport('Corrected After Quick Retry');
  const observedDepths: Array<string | undefined> = [];
  let callCount = 0;

  const agentFn = async (
    _query: string,
    _context?: string,
    depth?: string,
    existingHistory?: Message[],
  ) => {
    callCount++;
    observedDepths.push(depth);

    if (callCount === 1) {
      throw new Error('primary run failed');
    }

    if (callCount === 2) {
      return {
        response: recoveredReport,
        history: [...makeBaseHistory(), { role: 'assistant' as const, content: recoveredReport }],
      };
    }

    const history = [...(existingHistory ?? makeBaseHistory())];
    return {
      response: correctedReport,
      history: [...history, { role: 'assistant' as const, content: correctedReport }],
    };
  };

  const strategy = {
    plan: async () => '',
    review: async () => ({
      approved: false,
      feedback: [
        '[REVIEW_DECISION]',
        'decision: REVISE_SAME_HISTORY',
        'summary: One bounded correction pass is required after the crash recovery.',
        'issue: severity=MAJOR | code=reverify_after_recovery | fix_mode=same_history_revision | note=Keep the same scope and same history.',
      ].join('\n'),
      decision: 'revise_same_history',
      summary: 'One bounded correction pass is required after the crash recovery.',
      issues: [
        {
          severity: 'major',
          code: 'reverify_after_recovery',
          fixMode: 'same_history_revision',
          note: 'Keep the same scope and same history.',
        },
      ],
    } satisfies StrategyReviewResult),
    synthesize: async (result: string) => result,
    flushLog: async () => {},
    getHistorySize: () => 4,
  };

  const result = await executeStrategyFlow({
    agentType: 'identity',
    args: {
      query: 'Investigate the target deeply',
      depth: 'deep',
    },
    agentFn,
    strategy,
    agentLabel: 'IdentityAgent',
  });

  assert.deepEqual(observedDepths, ['deep', 'quick', 'quick']);
  assert.equal(result.usedCorrectionPass, true);
  assert.equal(result.reviewDecision, 'revise_same_history');
  assert.match(result.finalReport, /Corrected After Quick Retry/);
});

test('executeStrategyFlow performs a bounded final-report retry when the first correction reply is only an acknowledgement', async () => {
  const initialReport = makeDetailedReport('Initial Review Target');
  const correctedReport = makeDetailedReport('Corrected After Acknowledgement');
  const observedCorrectionPrompts: string[] = [];
  let callCount = 0;

  const agentFn = async (
    _query: string,
    _context?: string,
    _depth?: string,
    existingHistory?: Message[],
  ) => {
    callCount++;

    if (callCount === 1) {
      return {
        response: initialReport,
        history: [...makeBaseHistory(), { role: 'assistant' as const, content: initialReport }],
      };
    }

    const latestPrompt = String(existingHistory?.at(-1)?.content ?? '');
    observedCorrectionPrompts.push(latestPrompt);

    if (callCount === 2) {
      const acknowledgement = "I'll fix the unsupported linkage using the tool results I already have.";
      return {
        response: acknowledgement,
        history: [...(existingHistory ?? makeBaseHistory()), { role: 'assistant' as const, content: acknowledgement }],
      };
    }

    return {
      response: correctedReport,
      history: [...(existingHistory ?? makeBaseHistory()), { role: 'assistant' as const, content: correctedReport }],
    };
  };

  const strategy = {
    plan: async () => '',
    review: async () => ({
      approved: false,
      feedback: [
        '[REVIEW_DECISION]',
        'decision: REVISE_SAME_HISTORY',
        'summary: One bounded correction cycle is required.',
        'issue: severity=MAJOR | code=unsupported_identity_link | fix_mode=same_history_revision | note=Rewrite the final report from the same history.',
      ].join('\n'),
      decision: 'revise_same_history',
      summary: 'One bounded correction cycle is required.',
      issues: [
        {
          severity: 'major',
          code: 'unsupported_identity_link',
          fixMode: 'same_history_revision',
          note: 'Rewrite the final report from the same history.',
        },
      ],
    } satisfies StrategyReviewResult),
    synthesize: async (result: string) => result,
    flushLog: async () => {},
    getHistorySize: () => 5,
  };

  const result = await executeStrategyFlow({
    agentType: 'identity',
    args: {
      query: 'Verify whether two profiles belong to the same target',
      depth: 'normal',
    },
    agentFn,
    strategy,
    agentLabel: 'IdentityAgent',
  });

  assert.equal(callCount, 3);
  assert.equal(result.usedCorrectionPass, true);
  assert.match(observedCorrectionPrompts[0], /STRATEGY REVIEW — Correction Required/);
  assert.match(observedCorrectionPrompts[1], /STRATEGY REVIEW — Final Report Required/);
  assert.match(result.finalReport, /Corrected After Acknowledgement/);
});