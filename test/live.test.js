/**
 * End-to-end coverage over the REAL harness runtime: `@deepseek-ai/dsh-llm`'s
 * `LlmRuntime` plus a recording adapter, mounted beside this plugin's wrapper.
 * It proves the property the whole plugin exists for — a deep-frozen
 * auto-review request reaches the adapter on the configured review route while
 * the agent's own request keeps its route.
 *
 * The harness packages are optional at test time: when neither this repository
 * nor `DSH_PROFILE_DIR` resolves them, the checks are skipped instead of
 * failing.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { apply, AUTO_REVIEW_SYSTEM_PREFIX } from '../index.js'

/**
 * Resolve one harness package from this repository's install or from the
 * caller's `DSH_PROFILE_DIR`, whose `node_modules` holds the published harness.
 * @param name - the package name to resolve.
 * @returns its module URL, or undefined when nothing resolves it.
 */
function resolvePackage(name) {
  const bases = [import.meta.url]
  const profile = process.env.DSH_PROFILE_DIR
  if (profile !== undefined) bases.push(pathToFileURL(`${profile}/package.json`).href)
  for (const base of bases) {
    try {
      return pathToFileURL(createRequire(base).resolve(name)).href
    } catch {
      // Try the next base.
    }
  }
  return undefined
}

const cordisUrl = resolvePackage('@deepseek-ai/cordis')
const llmUrl = resolvePackage('@deepseek-ai/dsh-llm')

/**
 * Mount the plugin on a stand-in context that records logs and keeps the
 * disposal effect, so the wrappers' own teardown can be exercised without a
 * full Loader boot.
 * @param ctx - the object exposing the `llm` service under test.
 * @param config - plugin config; the review route is the deepseek default.
 * @returns the recorded log lines and a disposer.
 */
function mount(ctx, config = {}) {
  const logs = []
  const disposers = []
  const fake = {
    llm: ctx.llm,
    logger: {
      info: (...args) => logs.push(args.join(' ')),
      debug: () => {},
      warn: (...args) => logs.push(args.join(' ')),
    },
    effect: callback => {
      disposers.push(callback())
    },
  }
  apply(fake, { reviewModel: 'deepseek-official/deepseek-flash', ...config })
  return { logs, dispose: () => { for (const disposer of disposers) disposer() } }
}

/** One frozen request shaped like the auto-review gate's. */
function reviewRequest(overrides = {}) {
  return Object.freeze({
    provider: 'anthropic',
    model: 'claude-opus-4',
    system: `${AUTO_REVIEW_SYSTEM_PREFIX} for exactly one pending tool call.`,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'PENDING_ACTION' }] }],
    temperature: 0,
    ...overrides,
  })
}

/** One frozen request shaped like the agent loop's own hand-off. */
function agentRequest() {
  return Object.freeze({
    provider: 'anthropic',
    model: 'claude-opus-4',
    system: 'You are a coding agent.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })
}

/** Drain one stream to completion. */
async function drain(llm, options) {
  for await (const _chunk of llm.stream(options)) { /* drain */ }
}

/**
 * Build the runtime and one recording adapter that satisfies `LlmAdapter`.
 *
 * The plugin wraps `LlmRuntime.prototype.stream`, and that prototype is shared
 * by every runtime in this process, so each test MUST dispose its mount (see
 * `mount` + `t.after`) or its wrapper leaks into the next test's dispatches.
 * @returns the runtime and the recorded dispatches and controls.
 */
async function runtime() {
  const { Context } = await import(cordisUrl)
  const { LlmRuntime, LlmAdapter } = await import(llmUrl)
  const root = new Context()
  await root.plugin(LlmRuntime)
  const calls = []
  const seen = []
  class RecordingAdapter extends LlmAdapter {
    providerInfo(provider) {
      return { id: provider, name: provider }
    }

    async listModels() {
      return []
    }

    async resolveModel(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: 1_000_000 } }
    }

    async prepareCall(provider, model) {
      return { model: await this.resolveModel(provider, model), stream: options => this.stream(options) }
    }

    async * stream(options) {
      calls.push({ provider: options.provider, model: options.model })
      seen.push({ reasoningEffort: options.reasoningEffort, maxTokens: options.maxTokens })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"risk":"low","decision":"allow"}' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  root.llm.registerAdapter(['anthropic', 'deepseek-official'], new RecordingAdapter())
  return { root, calls, seen }
}

/**
 * Build a runtime with the plugin mounted, and register the wrapper's disposal
 * as a test teardown.
 * @param t - the running test, used to register the teardown.
 * @param config - plugin config; the review route is the deepseek default.
 * @returns the runtime, the recorded dispatches, and the recorded log lines.
 */
async function harness(t, config = {}) {
  const runtimeParts = await runtime()
  const { logs, dispose } = mount(runtimeParts.root, config)
  t.after(dispose)
  return { ...runtimeParts, logs, dispose }
}

test('a frozen review request is re-routed while the agent request is not', { skip: cordisUrl === undefined || llmUrl === undefined }, async (t) => {
  const { root, calls, logs, dispose } = await harness(t)
  assert.deepEqual(logs, [])

  const review = reviewRequest()
  await drain(root.llm, review)
  await drain(root.llm, agentRequest())

  assert.deepEqual(calls, [
    { provider: 'deepseek-official', model: 'deepseek-flash' },
    { provider: 'anthropic', model: 'claude-opus-4' },
  ])
  assert.equal(logs.length, 1)
  assert.match(logs[0], /anthropic\/claude-opus-4 -> deepseek-official\/deepseek-flash \(stream\)/u)
  // The caller's frozen request is untouched.
  assert.equal(review.provider, 'anthropic')
  assert.equal(review.model, 'claude-opus-4')

  dispose()
  await drain(root.llm, reviewRequest())
  assert.deepEqual(calls.at(-1), { provider: 'anthropic', model: 'claude-opus-4' })
})

test('a source reasoning effort and output cap never leak onto the review route', { skip: cordisUrl === undefined || llmUrl === undefined }, async (t) => {
  const { root, seen } = await harness(t)
  // `deepseek-flash` declares no reasoning efforts: keeping this control would
  // throw UNSUPPORTED_REASONING_EFFORT and fail the review closed.
  await drain(root.llm, reviewRequest({ reasoningEffort: 'medium', maxTokens: 256_000 }))
  assert.deepEqual(seen, [{ reasoningEffort: undefined, maxTokens: undefined }])
})

test('the wrapper passes unrelated hand-built requests straight through', { skip: cordisUrl === undefined || llmUrl === undefined }, async (t) => {
  const { root, calls } = await harness(t)
  await drain(root.llm, Object.freeze({
    provider: 'anthropic',
    model: 'claude-opus-4',
    system: 'Create a concise title for an AI coding-assistant session from the supplied human messages.',
    messages: [],
  }))
  assert.deepEqual(calls, [{ provider: 'anthropic', model: 'claude-opus-4' }])
})

test('a service without a reachable stream method warns instead of failing the boot', () => {
  const logs = []
  let effects = 0
  apply({
    llm: {},
    logger: { warn: message => logs.push(message), info: () => {} },
    effect: () => {
      effects += 1
    },
  })
  assert.equal(effects, 0)
  assert.equal(logs.length, 1)
  assert.match(logs[0], /llm\.stream was not found/u)
})

test('the default route applies when the plugin is mounted without config', { skip: cordisUrl === undefined || llmUrl === undefined }, async (t) => {
  const { root, calls } = await runtime()
  let disposed
  apply({
    llm: root.llm,
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    effect: callback => {
      disposed = callback()
    },
  })
  t.after(disposed)
  await drain(root.llm, reviewRequest())
  assert.deepEqual(calls, [{ provider: 'deepseek-official', model: 'deepseek-flash' }])
})

test('a review prepared through prepareCall dispatches on the review route', { skip: cordisUrl === undefined || llmUrl === undefined }, async (t) => {
  const { root, calls, seen, logs } = await harness(t)

  const review = reviewRequest({ reasoningEffort: 'medium', maxTokens: 256_000 })
  const prepared = await root.llm.prepareCall(review)
  for await (const _chunk of prepared.stream(review)) { /* drain */ }

  assert.deepEqual(calls, [{ provider: 'deepseek-official', model: 'deepseek-flash' }])
  assert.deepEqual(seen, [{ reasoningEffort: undefined, maxTokens: undefined }])
  assert.match(logs[0], /\(prepareCall\)$/u)
  // The prepared config is resolved before dispatch, and the handle rejects a
  // dispatch config that differs from it, so the retarget has to happen at
  // prepare time and the stream wrapper sees an already-retargeted request.
  assert.equal(logs.length, 1)
})

test('with wrapPrepareCall off, a prepared handle keeps the session route', { skip: cordisUrl === undefined || llmUrl === undefined }, async (t) => {
  const { root, calls, logs } = await harness(t, { wrapPrepareCall: false })

  const review = reviewRequest()
  const prepared = await root.llm.prepareCall(review)
  for await (const _chunk of prepared.stream(review)) { /* drain */ }

  assert.deepEqual(calls, [{ provider: 'anthropic', model: 'claude-opus-4' }])
  assert.deepEqual(logs, [])
})
