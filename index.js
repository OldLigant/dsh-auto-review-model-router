/**
 * dsh-auto-review-model-router — route DSH's experimental auto-review gate to
 * a cheaper model.
 *
 * The built-in `@deepseek-ai/dsh-experimental-auto-review` package reviews every
 * gated tool call by calling `ctx.llm.stream()` on the session's OWN route: it
 * copies `provider` and `model` out of the session's request header. A
 * state-of-the-art agent model therefore pays for every safety review as well.
 *
 * Why this wraps the service methods instead of listening on `llm/stream`:
 *
 * - The review request arrives deep-frozen (`deepFreeze` in the auto-review
 *   source), so a listener cannot mutate it.
 * - The `llm/stream` waterfall hands `next()`'s innermost callback the ORIGINAL
 *   argument list it closed over (Cordis `EventsService.waterfall`), so
 *   `next(replacement)` never reaches the adapter.
 *
 * The wrappers intercept the call BEFORE the request is frozen, so the
 * reviewer's request is re-built on the configured route. Nothing else about it
 * changes: the review prompt, its fixed policy system prompt, and the
 * risk/decision JSON protocol the gate parses are all preserved, so verdict
 * semantics are unchanged — only the model that produces the verdict.
 *
 * @module dsh-auto-review-model-router
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'auto-review-model-router'

/**
 * Required service. `llm` is the service whose `stream` and `prepareCall`
 * methods this plugin wraps.
 */
export const inject = ['llm']

/**
 * The opening of the `system` prompt of every auto-review request, copied
 * verbatim from the shipped `REVIEW_POLICY` constant of
 * `@deepseek-ai/dsh-experimental-auto-review`
 * (`packages/experimental/auto-review/src/index.ts`). Detection is anchored on
 * this full opening, so no other hand-built request can collide with it by
 * coincidence — the session-title and compaction prompts differ from it at the
 * first character.
 */
export const AUTO_REVIEW_SYSTEM_PREFIX = 'REVIEW_POLICY\nYou are the final authorization reviewer'

/**
 * The process-local mark the agent loop puts on its own requests
 * (`markAgentLoopRequest`). Loop requests are a pure function of the session
 * log and must never be rewritten. The symbol is read by description so this
 * plugin keeps working when the harness module identity differs.
 */
const LOOP_MARK = Symbol.for('dsh.llm.agent-loop-request')

/**
 * Test-only escape hatch: a de-registered loop mark. `Symbol.for` keys live in
 * the global registry, where `delete` has no effect, so a mark cannot be
 * removed once `markAgentLoopRequest` has run in this process. Tests substitute
 * this key to exercise the "loop request" branch.
 */
export const TEST_UNMARKED_LOOP_MARK = Symbol.for('dsh-auto-review-model-router/test-unmarked-loop-mark')

/** The default review route: the cheapest full-capability DeepSeek route. */
const DEFAULT_REVIEW_MODEL = 'deepseek-official/deepseek-flash'

/** Shipped defaults for the request controls a retarget rewrites. */
const DEFAULT_DROP_REASONING_EFFORT = true
const DEFAULT_DROP_MAX_TOKENS = true
const DEFAULT_LOG_RETARGETS = true

/**
 * Retries after the first attempt of one review call. The built-in auto-review
 * calls `llm.stream` directly, outside the agent loop, so the harness retry
 * plugin (`llm-retry`, an `agent/request-error` listener) never sees it: a
 * transient transport failure denies the tool call instead of being retried.
 */
const DEFAULT_RETRY_ATTEMPTS = 4

/** Pause before each retry, in milliseconds. */
const DEFAULT_RETRY_DELAY_MS = 500

/** Upper bound on {@link Config} `retryAttempts`, so a typo cannot spin forever. */
const MAX_RETRY_ATTEMPTS = 10

/**
 * Request signals with a retry loop already running. Auto-review reuses one
 * signal for its whole review, so an outer `llm.stream` wrapper can recognize a
 * request the inner wrapper is already retrying and dispatch it once instead of
 * multiplying the attempt count.
 */
const RETRYING_SIGNALS = new WeakSet()

/**
 * Failure codes worth retrying, matching the harness's own
 * `DEFAULT_RETRYABLE_CODES` (`dsh-llm` `retry-policy.ts`).
 *
 * `TIMEOUT` is deliberately absent: the DeepSeek adapter raises it from an IDLE
 * WATCHDOG, so retrying it multiplies the silent wait by the attempt count while
 * the auto-review deadline silently drains. `ABORTED` is the deadline or the
 * caller cancelling, and `AUTH`/`INVALID_*` cannot be fixed by trying again.
 */
export const RETRYABLE_FAILURE_CODES = Object.freeze(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TRANSPORT'])

/**
 * JSON Schema of the accepted config fields. It stays beside the Standard
 * Schema below so documentation and tooling still describe the knobs the
 * loader accepts; Cordis itself reads only `~standard`.
 */
const CONFIG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reviewModel: {
      type: 'string',
      description: 'Review route as "<provider>/<model>". Empty disables routing.',
      default: DEFAULT_REVIEW_MODEL,
    },
    systemPromptPatterns: {
      type: 'array',
      items: { type: 'string' },
      description: 'Substrings or /regex/u literals matched against the request system prompt.',
      default: [AUTO_REVIEW_SYSTEM_PREFIX],
    },
    retryAttempts: {
      type: 'integer',
      minimum: 0,
      maximum: MAX_RETRY_ATTEMPTS,
      description: 'Retries after the first attempt of one review call. 0 disables retrying.',
      default: DEFAULT_RETRY_ATTEMPTS,
    },
    retryDelayMs: {
      type: 'integer',
      minimum: 0,
      description: 'Pause before each review retry, in milliseconds.',
      default: DEFAULT_RETRY_DELAY_MS,
    },
    wrapPrepareCall: {
      type: 'boolean',
      description: 'Also route review requests issued through llm.prepareCall.',
      default: true,
    },
    dropReasoningEffort: {
      type: 'boolean',
      description: "Drop the source route's reasoning effort from the review request.",
      default: DEFAULT_DROP_REASONING_EFFORT,
    },
    dropMaxTokens: {
      type: 'boolean',
      description: "Drop the source route's output cap from the review request.",
      default: DEFAULT_DROP_MAX_TOKENS,
    },
    logRetargets: {
      type: 'boolean',
      description: 'Log every retargeted review request.',
      default: DEFAULT_LOG_RETARGETS,
    },
  },
}

/**
 * Loader config schema. Cordis 4.0.5 (dsh 0.2.1) validates a function plugin's
 * `Config` through Standard Schema — it reads `Config['~standard'].validate(raw)`
 * and hands the returned value to `apply`. A bare JSON Schema object carries no
 * `~standard`, so the loader threw before `apply` ever ran.
 *
 * `validate` delegates to this plugin's own {@link resolveConfig} and returns the
 * RAW config: `apply` resolves it again, so returning the resolved form here
 * would silently replace every configured field with its default.
 */
export const Config = {
  /** Field documentation for tooling that reports a plugin's accepted keys. */
  jsonSchema: CONFIG_SCHEMA,
  '~standard': {
    version: 1,
    vendor: 'dsh-auto-review-model-router',
    validate(value) {
      try {
        resolveConfig(value ?? {})
      } catch (error) {
        return {
          issues: [{
            message: error instanceof Error ? error.message : String(error),
            path: [],
          }],
        }
      }
      return { value: value ?? {} }
    },
  },
}

/**
 * Parse one `"<provider>/<model>"` route.
 * @param value - the configured route text.
 * @returns the provider and model, or undefined when either half is empty.
 */
export function parseRoute(value) {
  if (typeof value !== 'string') return undefined
  const separator = value.indexOf('/')
  if (separator <= 0) return undefined
  const provider = value.slice(0, separator).trim()
  const model = value.slice(separator + 1).trim()
  if (provider === '' || model === '') return undefined
  return { provider, model }
}

/**
 * Compile one configured pattern: a `/…/flags` literal becomes a RegExp, any
 * other non-empty text is a literal substring test.
 * @param pattern - one configured pattern.
 * @returns the matcher, or undefined when the text is empty.
 * @throws {TypeError} when a regex literal or its flags are invalid.
 */
export function compilePattern(pattern) {
  if (typeof pattern !== 'string' || pattern === '') return undefined
  if (pattern.startsWith('/')) {
    const lastSlash = pattern.lastIndexOf('/')
    if (lastSlash > 0) {
      const source = pattern.slice(1, lastSlash)
      const flags = pattern.slice(lastSlash + 1)
      try {
        return { kind: 'regex', value: new RegExp(source, `${flags}u`) }
      } catch (error) {
        throw new TypeError(`systemPromptPatterns entry ${JSON.stringify(pattern)} is not a valid regular expression: ${String(error)}`)
      }
    }
  }
  return { kind: 'literal', value: pattern }
}

/**
 * Fill defaults and compile the configured detection patterns. Defaults are
 * applied here — the explicit resolution step — so a partially specified config
 * from the loader or a direct `ctx.plugin` mount behaves identically.
 * @param raw - raw (possibly partial) plugin config.
 * @returns the resolved config with compiled matchers.
 * @throws {TypeError} on a malformed route or an invalid pattern.
 */
export function resolveConfig(raw = {}) {
  const reviewModel = raw.reviewModel ?? DEFAULT_REVIEW_MODEL
  if (typeof reviewModel !== 'string') {
    throw new TypeError(`reviewModel must be a string, got ${typeof reviewModel}`)
  }
  const trimmed = reviewModel.trim()
  const route = trimmed === '' ? undefined : parseRoute(trimmed)
  if (trimmed !== '' && route === undefined) {
    throw new TypeError(`reviewModel must be "<provider>/<model>", got ${JSON.stringify(reviewModel)}`)
  }
  const patterns = raw.systemPromptPatterns ?? [AUTO_REVIEW_SYSTEM_PREFIX]
  if (!Array.isArray(patterns)) {
    throw new TypeError(`systemPromptPatterns must be an array, got ${typeof patterns}`)
  }
  const compiled = patterns.map(compilePattern).filter(matcher => matcher !== undefined)
  if (route !== undefined && compiled.length === 0) {
    throw new TypeError('systemPromptPatterns must name at least one pattern while reviewModel is set: nothing could be recognized as an auto-review request')
  }
  const booleans = {
    wrapPrepareCall: raw.wrapPrepareCall ?? true,
    dropReasoningEffort: raw.dropReasoningEffort ?? DEFAULT_DROP_REASONING_EFFORT,
    dropMaxTokens: raw.dropMaxTokens ?? DEFAULT_DROP_MAX_TOKENS,
    logRetargets: raw.logRetargets ?? DEFAULT_LOG_RETARGETS,
  }
  for (const [key, value] of Object.entries(booleans)) {
    if (typeof value !== 'boolean') throw new TypeError(`${key} must be a boolean, got ${typeof value}`)
  }
  const retryAttempts = raw.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS
  if (!Number.isSafeInteger(retryAttempts) || retryAttempts < 0 || retryAttempts > MAX_RETRY_ATTEMPTS) {
    throw new TypeError(`retryAttempts must be a safe integer between 0 and ${MAX_RETRY_ATTEMPTS}, got ${String(raw.retryAttempts)}`)
  }
  const retryDelayMs = raw.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) {
    throw new TypeError(`retryDelayMs must be a non-negative safe integer, got ${String(raw.retryDelayMs)}`)
  }
  return {
    route,
    patterns: compiled,
    retryAttempts,
    retryDelayMs,
    wrapPrepareCall: booleans.wrapPrepareCall,
    dropReasoningEffort: booleans.dropReasoningEffort,
    dropMaxTokens: booleans.dropMaxTokens,
    logRetargets: booleans.logRetargets,
  }
}

/**
 * Whether one stream failure is worth trying again.
 * @param failure - the terminal failure of an attempt.
 * @param signal - the request's cancellation signal.
 * @returns true when the caller should retry.
 */
export function isRetryableFailure(failure, signal) {
  if (signal?.aborted === true) return false
  return RETRYABLE_FAILURE_CODES.includes(failure.code)
}

/** Wait `delayMs`, or resolve early when the signal aborts. */
function cancellableDelay(delayMs, signal) {
  if (delayMs <= 0) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(done, delayMs)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

/**
 * Stream one review call with bounded retries.
 *
 * The built-in gate reaches `llm.stream` directly, outside the agent loop, so the
 * harness's retry plugin (which is an `agent/request-error` listener) never sees
 * a failed review: without this, one dropped connection denies the tool call.
 *
 * A failed attempt's terminal `finish` chunk is NOT yielded, because the gate's
 * reader treats any terminal `finish` as the end of the review — emitting it
 * would end the review on the first transport blip. Retryable failure codes are
 * exactly the ones the harness itself treats as transient.
 *
 * Reasoning chunks of a failed attempt stay on the wire (the reader ignores
 * reasoning content), so a retried review exposes more than one attempt's
 * reasoning; the verdict is still parsed from the final text block alone.
 *
 * `start` MUST build a fresh attempt stream per call: an attempt stream is
 * single-use, and a retry needs a new dispatch.
 * @param start - builds one attempt from the request to dispatch.
 * @param options - the request being dispatched; its signal bounds the retries.
 * @param resolved - the resolved plugin config.
 * @param warn - reports each retry.
 * @returns the chunk stream of the first successful attempt, or of the last one.
 */
export async function* streamReviewWithRetry(start, options, resolved, warn) {
  const attempts = resolved.retryAttempts + 1
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let failure
    // The finish chunk of THIS attempt is held back until the attempt is known
    // to be the last one, so a retried attempt cannot terminate the review. It
    // is cleared per attempt, so a failure is never reported twice.
    let lastFinish
    for await (const chunk of start()) {
      if (chunk.type !== 'finish') {
        yield chunk
        continue
      }
      if (chunk.reason.kind === 'stop' || chunk.reason.kind === 'tool-calls' || chunk.reason.kind === 'max-tokens') {
        yield chunk
        return
      }
      failure = chunk.reason.failure
      lastFinish = chunk
    }
    if (failure === undefined || attempt === attempts || !isRetryableFailure(failure, options.signal)) {
      if (lastFinish !== undefined) yield lastFinish
      return
    }
    warn(`review attempt ${attempt}/${attempts} failed with ${failure.code}; retrying in ${resolved.retryDelayMs} ms`)
    await cancellableDelay(resolved.retryDelayMs, options.signal)
    if (options.signal?.aborted === true) {
      yield lastFinish
      return
    }
  }
}

/**
 * Stream a rewritten review request, retrying transient failures when enabled.
 * The route rewrite is owned by the innermost wrapper, so the retry loop lives
 * here rather than around a chain of calls: if `llm.stream` is wrapped more than
 * once (another plugin, or a re-mount whose predecessor has not disposed yet),
 * the outer wrapper must not re-dispatch a stream the inner one already retried.
 * {@link RETRYING_SIGNALS} carries that fact across the layers.
 * @param dispatch - performs ONE dispatch of the rewritten request.
 * @param options - the rewritten request; its `signal` bounds the retries.
 * @param resolved - the resolved plugin config.
 * @param warn - reports each retry.
 * @returns the chunk stream the gate consumes.
 */
function reviewStream(dispatch, options, resolved, warn) {
  const signal = options?.signal
  const guarded = signal instanceof AbortSignal && RETRYING_SIGNALS.has(signal)
  if (resolved.retryAttempts === 0 || guarded) return dispatch()
  if (!(signal instanceof AbortSignal)) return streamReviewWithRetry(dispatch, options, resolved, warn)
  RETRYING_SIGNALS.add(signal)
  return (async function* retriedReview() {
    try {
      yield* streamReviewWithRetry(dispatch, options, resolved, warn)
    } finally {
      RETRYING_SIGNALS.delete(signal)
    }
  })()
}

/**
 * Whether one request carries the agent loop's own-request mark. Loop requests
 * are a pure function of the session log; they are left byte-identical.
 * @param options - the request under inspection.
 * @returns true when the loop built this request.
 */
export function isLoopRequest(options) {
  if (options === null || typeof options !== 'object') return false
  return options[LOOP_MARK] !== undefined || options[TEST_UNMARKED_LOOP_MARK] !== undefined
}

/**
 * Whether one request is an auto-review call: hand-built (no loop mark) and
 * carrying a configured system-prompt pattern.
 * @param options - the request under inspection.
 * @param patterns - compiled matchers from {@link resolveConfig}.
 * @returns true when the request is the reviewer's call.
 */
export function isAutoReviewRequest(options, patterns) {
  if (options === null || typeof options !== 'object') return false
  if (isLoopRequest(options)) return false
  const system = options.system
  if (typeof system !== 'string') return false
  return patterns.some(matcher => matcher.kind === 'regex' ? matcher.value.test(system) : system.includes(matcher.value))
}

/**
 * The review route to apply to one request, or undefined when the request must
 * keep its own route.
 * @param options - the request under inspection.
 * @param resolved - the resolved plugin config.
 * @returns the route, or undefined for a pass-through request.
 */
function reviewRoute(options, resolved) {
  if (resolved.route === undefined || !isAutoReviewRequest(options, resolved.patterns)) return undefined
  return resolved.route
}

/**
 * Build the reviewer's request on the configured route. The returned object is
 * a copy: the caller keeps its own request, so a mistaken match degrades to one
 * extra object allocation rather than a corrupted request.
 * @param options - the original auto-review request.
 * @param route - the configured review route.
 * @param resolved - the resolved plugin config.
 * @returns the re-targeted request.
 */
export function retargetReviewOptions(options, route, resolved) {
  if (route === undefined) return options
  return {
    ...options,
    provider: route.provider,
    model: route.model,
    // Both controls belong to the SOURCE route. A reasoning effort the target
    // model does not declare makes the harness throw
    // UNSUPPORTED_REASONING_EFFORT, and an inherited output cap can exceed the
    // target's limit; either would fail the review closed.
    ...resolved.dropReasoningEffort ? { reasoningEffort: undefined } : {},
    ...resolved.dropMaxTokens ? { maxTokens: undefined } : {},
  }
}

/**
 * Object that actually owns `method` in this service's prototype chain.
 * `ctx.llm` is a per-read traceable proxy over the service instance, so a write
 * through it never reaches the method other consumers call; the owning object —
 * normally `LlmRuntime.prototype` — is the only seam that does.
 * @param service - the injected `llm` service.
 * @param method - the method name to locate.
 * @returns the owning object, or undefined when the method is unreachable.
 */
export function methodOwner(service, method) {
  for (let node = service; node !== null && node !== undefined; node = Object.getPrototypeOf(node)) {
    if (typeof node === 'object' || typeof node === 'function') {
      if (Object.hasOwn(node, method)) return node
    }
  }
  return undefined
}

/**
 * Install one pass-through wrapper on the object that owns a service method.
 * @param ctx - the Cordis context providing the logger and the effect lifetime.
 * @param owner - the object owning the method.
 * @param method - the method name to wrap.
 * @param wrapper - receives the original method and returns the replacement.
 * @returns true when the wrapper was installed (and its restoration registered).
 */
function installWrapper(ctx, owner, method, wrapper) {
  const original = owner[method]
  const wrapped = wrapper(original)
  try {
    owner[method] = wrapped
  } catch (error) {
    // A non-writable method would leave every review on the agent's own route;
    // report it instead of failing the whole profile boot.
    ctx.logger?.warn?.(`${name}: cannot wrap llm.${method}, those reviews keep the session route: ${String(error)}`)
    return false
  }
  ctx.effect(() => () => {
    // Restore only while this plugin's wrapper is still the installed method: a
    // plugin that wrapped the same method after this one keeps its own wrapper.
    if (owner[method] === wrapped) owner[method] = original
  })
  return true
}

/**
 * Wrap `llm.stream` and, optionally, `llm.prepareCall` so every recognized
 * review request runs on the configured route. Both wrappers are pass-throughs
 * for every other request, so the agent's own calls — and every other
 * hand-built call — are untouched.
 * @param ctx - the Cordis context, with the `llm` service injected.
 * @param rawConfig - raw plugin config; defaults resolve here.
 * @returns nothing.
 */
export function apply(ctx, rawConfig = {}) {
  const resolved = resolveConfig(rawConfig)

  /**
   * Report one retarget. Formatted here rather than with printf placeholders: a
   * log record is only rendered by the exporter that consumes it, so an eager
   * string is what actually shows the routing fact.
   */
  const report = (options, route, via) => {
    if (!resolved.logRetargets) return
    ctx.logger?.info?.(
      `${name}: review request re-routed ${options.provider}/${options.model} -> ${route.provider}/${route.model} (${via})`,
    )
  }

  const streamOwner = methodOwner(ctx.llm, 'stream')
  if (streamOwner === undefined) {
    ctx.logger?.warn?.(`${name}: llm.stream was not found, reviews keep the session route`)
    return
  }
  installWrapper(ctx, streamOwner, 'stream', original => function stream(options) {
    const route = reviewRoute(options, resolved)
    if (route === undefined) return original.call(this, options)
    report(options, route, 'stream')
    const retargeted = retargetReviewOptions(options, route, resolved)
    const warn = message => ctx.logger?.warn?.(`${name}: ${message}`)
    return reviewStream(() => original.call(this, retargeted), retargeted, resolved, warn)
  })

  if (!resolved.wrapPrepareCall) return
  const prepareOwner = methodOwner(ctx.llm, 'prepareCall')
  if (prepareOwner === undefined) {
    ctx.logger?.warn?.(`${name}: llm.prepareCall was not found, prepareCall reviews keep the session route`)
    return
  }
  installWrapper(ctx, prepareOwner, 'prepareCall', original => async function prepareCall(config, signal, configure) {
    const route = reviewRoute(config, resolved)
    if (route === undefined) return original.call(this, config, signal, configure)
    report(config, route, 'prepareCall')
    // The retargeted config must be prepared by the runtime itself: a prepared
    // handle refuses a dispatch config that differs from the one it resolved
    // (`INVALID_PREPARED_CALL`), so the route cannot be swapped afterwards.
    const retargetedConfig = retargetReviewOptions(config, route, resolved)
    const prepared = await original.call(this, retargetedConfig, signal, configure)
    const warn = message => ctx.logger?.warn?.(`${name}: ${message}`)
    // A handle of this kind may be dispatched once, so the retry starts a fresh
    // dispatch per attempt. A dispatch that still carries the review prompt — a
    // caller that reused the config, or one that never passed it through
    // prepareCall — is retargeted here too, where the runtime re-resolves the
    // route from `options`.
    const retargetedFor = options => isAutoReviewRequest(options, resolved.patterns)
      ? retargetReviewOptions(options, route, resolved)
      : options
    return {
      ...prepared,
      stream: options => reviewStream(() => prepared.stream(retargetedFor(options)), options, resolved, warn),
    }
  })
}
