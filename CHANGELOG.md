# Changelog

## 0.2.1

- Declare `Config` as a Standard Schema. Cordis 4.0.5 (dsh 0.2.1) validates a
  function plugin's `Config` through `Config['~standard'].validate(raw)` before
  `apply`; the previous bare JSON Schema object carried no `~standard`, so the
  loader threw `Cannot read properties of undefined (reading 'validate')` and
  the row never mounted (`auto-review-model-router did not activate`). The JSON
  Schema stays available as `Config.jsonSchema` for tooling, and `validate`
  delegates to `resolveConfig` while returning the RAW config, which `apply`
  resolves again — returning the resolved form would replace every configured
  field with its default.

## 0.2.0

- Retry transient review failures (`retryAttempts`, default 4, so up to 5
  attempts; `retryDelayMs`, default 500). The built-in gate calls `llm.stream`
  directly, outside the agent loop, so the harness retry plugin — an
  `agent/request-error` listener — never sees a failed review: one dropped
  connection used to deny the tool call outright.
- Retry only the codes the harness itself treats as transient
  (`EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TRANSPORT`). `TIMEOUT` is excluded
  because the DeepSeek adapter raises it from an idle watchdog, so retrying it
  multiplies a silent wait while the auto-review deadline drains.
- Hold back a failed attempt's terminal `finish` chunk. The gate's reader ends
  the review on any terminal `finish`, so yielding it would end the review on the
  first transport blip. Reasoning chunks stay live; the verdict is still parsed
  from the final text block alone.
- Stop retrying when the request signal aborts, and never retry more than the
  configured count even when `llm.stream` is wrapped more than once: a request
  signal already inside a retry loop is dispatched once by the outer wrapper.

## 0.1.0

Initial release.

- Route the built-in experimental auto-review gate to a configured
  `<provider>/<model>` (`reviewModel`, default `deepseek-official/deepseek-flash`).
- Recognize review requests by auto-review's fixed `REVIEW_POLICY` system prompt
  plus the absence of the agent loop's own-request mark; every other request,
  including loop-built ones that happen to match a pattern, is passed through
  byte-identical.
- Drop the source route's `reasoningEffort` and `maxTokens` on the review
  request: both are properties of the agent's model, and keeping them makes the
  review fail closed on the target model
  (`UNSUPPORTED_REASONING_EFFORT`).
- Wrap `llm.stream`, and `llm.prepareCall` unless `wrapPrepareCall` is off. A
  prepared handle resolves its route before dispatch and rejects a dispatch
  config that differs from it (`INVALID_PREPARED_CALL`), so that path is
  retargeted at prepare time.
- Install each wrapper on the object that owns the method in the service's
  prototype chain, because `ctx.llm` is a per-read traceable proxy whose
  property overlay shadows a write. Restore it on fiber disposal.
- Warn, rather than fail the profile boot, when a method the plugin needs is
  missing or not writable.
