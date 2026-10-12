/**
 * Unit coverage for the decision surface: route parsing, pattern compilation,
 * request recognition, and request re-targeting. The end-to-end wrap over the
 * real harness runtime lives in live.test.js.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  AUTO_REVIEW_SYSTEM_PREFIX,
  RETRYABLE_FAILURE_CODES,
  TEST_UNMARKED_LOOP_MARK,
  compilePattern,
  isAutoReviewRequest,
  isLoopRequest,
  isRetryableFailure,
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
  assert.equal(resolved.retryAttempts, 4)
  assert.equal(resolved.retryDelayMs, 500)
  assert.equal(resolved.wrapPrepareCall, true)
  assert.equal(resolved.dropReasoningEffort, true)
  assert.equal(resolved.dropMaxTokens, true)
  assert.equal(resolved.logRetargets, true)
})

test('resolveConfig validates the retry controls', () => {
  assert.equal(resolveConfig({ retryAttempts: 0 }).retryAttempts, 0)
  assert.equal(resolveConfig({ retryAttempts: 10 }).retryAttempts, 10)
  assert.equal(resolveConfig({ retryDelayMs: 0 }).retryDelayMs, 0)
  assert.throws(() => resolveConfig({ retryAttempts: 11 }), /between 0 and 10/u)
  assert.throws(() => resolveConfig({ retryAttempts: -1 }), /between 0 and 10/u)
  assert.throws(() => resolveConfig({ retryAttempts: 1.5 }), /between 0 and 10/u)
  assert.throws(() => resolveConfig({ retryAttempts: '4' }), /between 0 and 10/u)
  assert.throws(() => resolveConfig({ retryDelayMs: -1 }), /non-negative/u)
  assert.throws(() => resolveConfig({ retryDelayMs: 1.5 }), /non-negative/u)
})

test('isRetryableFailure retries only the harness-transient codes', () => {
  assert.deepEqual([...RETRYABLE_FAILURE_CODES], ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TRANSPORT'])
  for (const code of RETRYABLE_FAILURE_CODES) {
    assert.equal(isRetryableFailure({ code, message: code }), true, code)
  }
  // `TIMEOUT` is the adapter's idle watchdog: retrying multiplies a silent wait.
  for (const code of ['TIMEOUT', 'ABORTED', 'AUTH', 'INVALID_CREDENTIAL', 'NO_ADAPTER', 'UNSUPPORTED_REASONING_EFFORT']) {
    assert.equal(isRetryableFailure({ code, message: code }), false, code)
  }
  assert.equal(isRetryableFailure({ code: 'TRANSPORT', message: 'x' }, new AbortController().signal), true)
  assert.equal(isRetryableFailure({ code: 'TRANSPORT', message: 'x' }, AbortSignal.abort()), false)
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
