/**
 * Unit coverage for the decision surface: route parsing, pattern compilation,
 * request recognition, and request re-targeting. The end-to-end wrap over the
 * real harness runtime lives in live.test.js.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  AUTO_REVIEW_SYSTEM_PREFIX,
  TEST_UNMARKED_LOOP_MARK,
  compilePattern,
  isAutoReviewRequest,
  isLoopRequest,
  methodOwner,
  parseRoute,
  resolveConfig,
  retargetReviewOptions,
} from '../index.js'

/** The exact `system` prompt opening the shipped auto-review gate sends. */
const reviewSystem = `${AUTO_REVIEW_SYSTEM_PREFIX} for exactly one pending tool call.`

/** Build one request object with the fields the detection reads. */
function request(overrides = {}) {
  return { provider: 'anthropic', model: 'claude-opus-4', messages: [], ...overrides }
}

/** The configured route, for the two-argument retarget calls below. */
const route = { provider: 'deepseek-official', model: 'deepseek-flash' }

test('parseRoute splits provider and model, and rejects malformed routes', () => {
  assert.deepEqual(parseRoute('deepseek-official/deepseek-flash'), route)
  assert.deepEqual(parseRoute(' provider / model '), { provider: 'provider', model: 'model' })
  assert.deepEqual(parseRoute('openrouter/vendor/model-1'), { provider: 'openrouter', model: 'vendor/model-1' })
  assert.equal(parseRoute('/model'), undefined)
  assert.equal(parseRoute('provider/'), undefined)
  assert.equal(parseRoute('/'), undefined)
  assert.equal(parseRoute('no-separator'), undefined)
  assert.equal(parseRoute(undefined), undefined)
})

test('compilePattern accepts literal substrings and /regex/u literals', () => {
  assert.deepEqual(compilePattern('REVIEW_POLICY'), { kind: 'literal', value: 'REVIEW_POLICY' })
  const regex = compilePattern('/^REVIEW_\\w+/')
  assert.equal(regex.kind, 'regex')
  assert.equal(regex.value.test('REVIEW_POLICY'), true)
  assert.equal(compilePattern(''), undefined)
  assert.throws(() => compilePattern('/[unterminated/'), TypeError)
})

test('resolveConfig defaults to the DeepSeek flash review route', () => {
  const resolved = resolveConfig()
  assert.deepEqual(resolved.route, route)
  assert.deepEqual(resolved.patterns, [{ kind: 'literal', value: AUTO_REVIEW_SYSTEM_PREFIX }])
  assert.equal(resolved.wrapPrepareCall, true)
  assert.equal(resolved.dropReasoningEffort, true)
  assert.equal(resolved.dropMaxTokens, true)
  assert.equal(resolved.logRetargets, true)
})

test('resolveConfig treats an empty reviewModel as routing disabled', () => {
  assert.equal(resolveConfig({ reviewModel: '   ' }).route, undefined)
  assert.deepEqual(resolveConfig({ reviewModel: '', systemPromptPatterns: [] }).patterns, [])
})

test('resolveConfig fails loud on a malformed route or an unusable pattern set', () => {
  assert.throws(() => resolveConfig({ reviewModel: 'deepseek-flash' }), /provider.*model/u)
  assert.throws(() => resolveConfig({ systemPromptPatterns: 'REVIEW_POLICY' }), TypeError)
  assert.throws(() => resolveConfig({ systemPromptPatterns: [] }), /at least one pattern/u)
  assert.throws(() => resolveConfig({ logRetargets: 'yes' }), TypeError)
  assert.throws(() => resolveConfig({ wrapPrepareCall: 1 }), TypeError)
})

test('isAutoReviewRequest recognizes the review prompt and nothing else', () => {
  const { patterns } = resolveConfig()
  assert.equal(isAutoReviewRequest(request({ system: reviewSystem }), patterns), true)
  assert.equal(isAutoReviewRequest(request({ system: 'You are a coding agent.' }), patterns), false)
  assert.equal(isAutoReviewRequest(request({ system: 'Create a concise title for an AI coding-assistant session.' }), patterns), false)
  assert.equal(isAutoReviewRequest(request(), patterns), false)
  assert.equal(isAutoReviewRequest(null, patterns), false)
})

test('isAutoReviewRequest refuses loop-built requests even when the prompt matches', () => {
  const { patterns } = resolveConfig()
  // `Symbol.for` keys cannot be deleted from the global registry, so the
  // loop-request branch is exercised through the test substitute mark.
  const loopRequest = request({ system: reviewSystem, [Symbol.for('dsh.llm.agent-loop-request')]: true })
  assert.equal(isLoopRequest(loopRequest), true)
  assert.equal(isAutoReviewRequest(loopRequest, patterns), false)

  const substituted = request({ system: reviewSystem, [TEST_UNMARKED_LOOP_MARK]: true })
  assert.equal(isLoopRequest(substituted), true)
  assert.equal(isAutoReviewRequest(substituted, patterns), false)

  assert.equal(isLoopRequest(null), false)
  assert.equal(isLoopRequest('text'), false)
})

test('retargetReviewOptions rewrites only the route and the source-model controls', () => {
  const resolved = resolveConfig()
  const original = request({
    system: reviewSystem,
    temperature: 0,
    reasoningEffort: 'medium',
    maxTokens: 256_000,
    tools: [{ name: 'read', description: 'read', parameters: {} }],
  })
  const retargeted = retargetReviewOptions(original, route, resolved)
  assert.equal(retargeted.provider, 'deepseek-official')
  assert.equal(retargeted.model, 'deepseek-flash')
  assert.equal(retargeted.reasoningEffort, undefined)
  assert.equal(retargeted.maxTokens, undefined)
  // Everything the review prompt and its protocol need survives.
  assert.equal(retargeted.system, original.system)
  assert.equal(retargeted.temperature, 0)
  assert.equal(retargeted.tools, original.tools)
  // The caller's own request object is never modified.
  assert.equal(original.provider, 'anthropic')
  assert.equal(original.model, 'claude-opus-4')
  assert.equal(original.reasoningEffort, 'medium')
  assert.equal(original.maxTokens, 256_000)
})

test('retargetReviewOptions can preserve the source controls on request', () => {
  const resolved = resolveConfig({ dropReasoningEffort: false, dropMaxTokens: false })
  const retargeted = retargetReviewOptions(request({ reasoningEffort: 'medium', maxTokens: 1024 }), route, resolved)
  assert.equal(retargeted.reasoningEffort, 'medium')
  assert.equal(retargeted.maxTokens, 1024)
})

test('retargetReviewOptions is a pass-through without a route', () => {
  const resolved = resolveConfig({ reviewModel: '' })
  const original = request()
  assert.equal(retargetReviewOptions(original, undefined, resolved), original)
})

test('methodOwner finds the object owning a method up the prototype chain', () => {
  const prototype = { stream() {} }
  const service = Object.create(prototype)
  assert.equal(methodOwner(service, 'stream'), prototype)
  assert.equal(methodOwner(service, 'prepareCall'), undefined)
  // An own method belongs to the object itself, not to its prototype.
  const own = { stream() {} }
  assert.equal(methodOwner(own, 'stream'), own)
})
