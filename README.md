# dsh-auto-review-model-router

Route DSH's experimental **auto-review** safety gate to a model you choose, so a
premium agent model does not pay for its own safety reviews.

```yaml
# <profile>/cordis.patch.yml
- insert:
    - id: auto-review-model-router
      name: dsh-auto-review-model-router
      config:
        reviewModel: deepseek-official/deepseek-flash
```

With that entry every review runs on `deepseek-official/deepseek-flash` while the
agent keeps `claude-opus-4`, `gpt-6-astra`, or whatever else the session selected.

## The problem it solves

`@deepseek-ai/dsh-experimental-auto-review` reviews each gated tool call by
calling `ctx.llm.stream()` on **the session's own route**: it copies `provider`
and `model` out of the session request header
(`snapshotAutoReview()` in `packages/experimental/auto-review/src/index.ts`).
There is no `reviewModel` field in the shipped plugin, so an expensive agent
model is charged for one extra full review request per gated call.

## How it works

The plugin wraps two service methods at activation: `llm.stream` always, and
`llm.prepareCall` unless `wrapPrepareCall` is off.

1. A request is recognized as an auto-review call when it is **hand-built**
   (it does not carry the agent loop's own-request mark) **and** its `system`
   prompt starts with auto-review's fixed `REVIEW_POLICY` opening. Only such a
   request is ever rewritten.
2. It is copied onto `reviewModel`, and the source route's `reasoningEffort` and
   `maxTokens` are dropped. Both are properties of the *agent's* model: a
   reasoning effort the target does not declare makes the harness throw
   `UNSUPPORTED_REASONING_EFFORT`, and an inherited output cap can exceed the
   target's limit. Either would fail every review closed.
3. Everything else — the review prompt, its policy system prompt, `temperature`,
   and the `{"risk":…,"decision":…}` JSON protocol the gate parses — is
   unchanged. Only the model that produces the verdict changes.
4. A review that fails transiently is retried on the same route
   (`retryAttempts`, default 4). The gate calls `llm.stream` directly, outside
   the agent loop, so the harness retry plugin (an `agent/request-error`
   listener) never sees a review: without this, one dropped connection denies
   the tool call.

### Why retries need their own classification

Only the codes the harness itself treats as transient are retried:
`EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TRANSPORT`. `TIMEOUT` is deliberately
excluded — the DeepSeek adapter raises it from an **idle watchdog**, so retrying
it multiplies a silent wait by the attempt count while the auto-review deadline
drains. `ABORTED` (the deadline, or the caller cancelling) and configuration
errors such as `AUTH` are not fixed by trying again.

A failed attempt's terminal `finish` chunk is held back: the gate's reader ends
the review on any terminal `finish`, so yielding it would end the review on the
first transport blip. Reasoning chunks stay live (the reader ignores reasoning
content), so a retried review exposes more than one attempt's reasoning while the
verdict is still parsed from the final text block alone.

### Why the wrappers, and not an `llm/stream` listener

Two seams were tried first and both are dead ends on a real runtime:

- Mutating the request inside an `llm/stream` listener throws: auto-review
  freezes it (`deepFreeze`) before streaming.
- Returning `next(replacement)` from a listener never reaches the adapter:
  Cordis's `EventsService.waterfall` invokes the innermost callback with the
  argument list it closed over.
- Writing `ctx.llm.stream = wrapper` is also ineffective: `ctx.llm` is a
  per-read traceable proxy, and its property overlay shadows what you write.

The wrappers are therefore installed on the object that owns each method in the
service's prototype chain (`LlmRuntime.prototype` in practice), which is the one
seam every consumer actually calls. Both are removed when the plugin's fiber
disposes.

### Why `prepareCall` needs its own wrapper

A prepared handle resolves its route during `prepareCall` and then rejects a
dispatch whose config differs from the resolved one
(`INVALID_PREPARED_CALL`). The retarget must therefore happen *before* the call
is prepared; swapping the route in the returned handle cannot work. With
`wrapPrepareCall: true` (the default) a review prepared that way runs on the
review route, and turning it off restores the session route for that path.

## Install

Published on npm as `dsh-auto-review-model-router`:

```sh
# in the profile directory
pnpm add dsh-auto-review-model-router
```

From a local checkout instead, link it:

```jsonc
// <profile>/package.json
"dependencies": { "dsh-auto-review-model-router": "link:D:/path/to/dsh-auto-review-model-router" }
```

Then insert it in the profile patch layer, after the auto-review bundle:

```yaml
# <profile>/cordis.patch.yml
- insert:
    - id: auto-review-model-router
      name: dsh-auto-review-model-router
      config:
        reviewModel: deepseek-official/deepseek-flash
```

Restart the app: patch-layer changes apply at profile startup.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `reviewModel` | `deepseek-official/deepseek-flash` | `<provider>/<model>` every review runs on. An empty string disables routing. |
| `systemPromptPatterns` | the shipped `REVIEW_POLICY` opening | Substrings, or `/regex/u` literals, matched against a request's `system` prompt. Widen this only if a harness release rewrites that prompt. |
| `retryAttempts` | `4` | Retries after the first attempt of one review call, so up to 5 attempts. `0` disables retrying. Maximum 10. |
| `retryDelayMs` | `500` | Pause before each retry. |
| `wrapPrepareCall` | `true` | Also route review requests issued through `llm.prepareCall`. |
| `dropReasoningEffort` | `true` | Drop the source route's reasoning effort on the review request. |
| `dropMaxTokens` | `true` | Drop the source route's output cap on the review request. |
| `logRetargets` | `true` | Log each retargeted review. Retries log a warning regardless. |

## Verify

The test suite has two files. `test/router.test.js` covers the decision surface
with no harness at all; `test/live.test.js` runs the wrappers over the real
`LlmRuntime` and skips those checks when neither this package nor
`DSH_PROFILE_DIR` resolves `@deepseek-ai/dsh-llm`.

```sh
node test/router.test.js
DSH_PROFILE_DIR=<profile dir> node test/live.test.js
```

Two commands rather than `node --test`: each file runs its `node:test` suite
in-process, while `node --test` spawns a child process per file.

> The plugin patches `LlmRuntime.prototype`, so each live test disposes its own
> mount. Skipping that teardown leaks a wrapper into the next test's dispatches.

At runtime each retarget logs one line, and each retry logs a warning:

```
auto-review-model-router: review request re-routed anthropic/claude-opus-4 -> deepseek-official/deepseek-flash (stream)
auto-review-model-router: review attempt 1/5 failed with TRANSPORT; retrying in 500 ms
```

## Scope and limits

- Only requests recognized as auto-review calls change route. A false negative
  costs nothing (the review runs exactly as before); a false positive is bounded
  to one extra object and one changed route for one hand-built request.
- The standalone `dsh-auto-review` plugin needs none of this: its `reviewerModel`
  config field already sets the reviewer's model directly.
- DSH public APIs are pre-stable. A release that changes the `REVIEW_POLICY`
  opening, `LlmRuntime.prototype`'s method names, or the prepared-handle contract
  needs a matching update here. Detection is configurable
  (`systemPromptPatterns`) precisely for the first case, and the plugin logs a
  warning instead of failing the profile boot when a method it needs is missing.

## License

MIT
