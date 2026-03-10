/**
 * Test Fixtures Export
 * 
 * Kullanim:
 * import { SAFE_TEST_TARGETS, GITHUB_TEST_CASES } from './test/index.js'
 * 
 * veya
 * 
 * import { getEasyTarget, getAllUsernames } from './test/index.js'
 */

export {
  SAFE_TEST_TARGETS,
  FICTIONAL_SCENARIOS,
  GITHUB_TEST_CASES,
  NEO4J_TEST_GRAPH,
  AGENT_TEST_SCENARIOS,
  type TestTarget
} from './fixtures/testTargets.js'

import {
  SAFE_TEST_TARGETS,
  FICTIONAL_SCENARIOS,
  GITHUB_TEST_CASES,
  NEO4J_TEST_GRAPH,
  AGENT_TEST_SCENARIOS,
} from './fixtures/testTargets.js'

// Helper fonksiyonlar
export function getEasyTarget() {
  return SAFE_TEST_TARGETS.find(t => t.difficulty === 'easy' && t.ethical)
}

export function getMediumTarget() {
  return SAFE_TEST_TARGETS.find(t => t.difficulty === 'medium' && t.ethical)
}

export function getAllUsernames(): string[] {
  return [
    ...SAFE_TEST_TARGETS.map(t => t.data.username).filter(Boolean),
    ...GITHUB_TEST_CASES.existing
  ] as string[]
}

export function getTestScenario(name: string) {
  return AGENT_TEST_SCENARIOS.find(s => s.name === name)
}

// Default export
export default {
  SAFE_TEST_TARGETS,
  FICTIONAL_SCENARIOS,
  GITHUB_TEST_CASES,
  NEO4J_TEST_GRAPH,
  AGENT_TEST_SCENARIOS,
  getEasyTarget,
  getMediumTarget,
  getAllUsernames,
  getTestScenario
}
