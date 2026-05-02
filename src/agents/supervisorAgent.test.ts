/**
 * Unit tests for isIdentityQuery pre-routing logic.
 *
 * Critical invariant: cross-domain queries (identity + academic / identity + media)
 * must NOT be pre-routed so they reach runAgentLoop and can delegate to multiple agents.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { isIdentityQuery } from './supervisorAgent.js';

// ── Should return true (pure identity, safe to pre-route) ─────────────────────

test('GitHub user query → true', () => {
  assert.equal(isIdentityQuery('torvalds GitHub kullanıcısının profilini bul'), true);
});

test('GitHub profile English → true', () => {
  assert.equal(isIdentityQuery('look up the github user account octocat'), true);
});

test('@username mention → true', () => {
  assert.equal(isIdentityQuery('@berkayhsrt kim bu'), true);
});

test('email investigation → true', () => {
  assert.equal(isIdentityQuery('bu email adresi kime ait araştır'), true);
});

test('kullanıcı adı araştır → true', () => {
  assert.equal(isIdentityQuery('kullanıcı adı "xhacker" profil araştır'), true);
});

test('profil çıkar → true', () => {
  assert.equal(isIdentityQuery('bu kişinin profil çıkar'), true);
});

// ── Should return false (cross-domain — must go through LLM loop) ─────────────

test('C-1: GitHub + akademik yayın → false (cross-domain)', () => {
  const c1 = 'torvalds GitHub kullanıcısının kimliğini doğrula ve aynı zamanda Linux çekirdeği üzerine yayınlarını akademik veri tabanlarında ara. Dijital kimlik ile akademik yayın profilini karşılaştır.';
  assert.equal(isIdentityQuery(c1), false);
});

test('C-2: GitHub + akademik + sosyal medya → false (cross-domain)', () => {
  const c2 = '"Ahmet Yılmaz" adındaki kişinin GitHub profilini, akademik yayınlarını ve sosyal medya hesaplarını araştır.';
  assert.equal(isIdentityQuery(c2), false);
});

test('identity + paper keyword → false', () => {
  assert.equal(isIdentityQuery('bu kişinin github hesabı ve paper yayınlarını bul'), false);
});

test('identity + publication keyword → false', () => {
  assert.equal(isIdentityQuery('octocat github profile and their publications'), false);
});

test('identity + image verification → false', () => {
  assert.equal(isIdentityQuery('@user kimdir ve bu fotoğraf gerçek mi doğrula'), false);
});

test('identity + news fact-check → false', () => {
  assert.equal(isIdentityQuery('torvalds github profili ve haberin doğruluğunu fact-check et'), false);
});

test('"hem...hem" conjunction → false', () => {
  assert.equal(isIdentityQuery('hem kimliğini hem de makalelerini araştır'), false);
});

test('"ve aynı zamanda" → false', () => {
  assert.equal(isIdentityQuery('@user kim ve aynı zamanda makaleleri var mı'), false);
});

// ── Pure academic or media (not identity) → false ────────────────────────────

test('pure academic query → false', () => {
  assert.equal(isIdentityQuery('reinforcement learning 2025 papers on arXiv'), false);
});

test('general question → false', () => {
  assert.equal(isIdentityQuery('Linux nedir?'), false);
});
