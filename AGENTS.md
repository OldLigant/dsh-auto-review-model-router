# AGENTS.md

Standalone DeepSeek Harness plugin repository (`dsh-auto-review-model-router`).
Plain ESM JavaScript, no build step, no runtime dependencies.

## Layout

- `index.js` — the whole plugin: the function-plugin contract
  (`name`/`inject`/`Config`/`apply`, no default export), request recognition,
  request re-targeting, and the two method wrappers.
- `cordis.patch.yml` — the bundle patch a profile composes (`dsh.bundle.patch`).
- `test/router.test.js` — the decision surface; runs anywhere with plain Node.
- `test/live.test.js` — the wrappers over the real `@deepseek-ai/dsh-llm`
  `LlmRuntime`; skips itself when that peer is unresolvable.
- `README.md` / `README.zh.md` — keep both in sync when behavior changes.

## Hard rules applied here

- **Never touch a request that is not an auto-review call.** Recognition requires
  both the hand-built mark check and a configured `system` prompt pattern. A
  request carrying the agent loop's own-request mark is a pure function of the
  session log and must stay byte-identical; it is refused even when the prompt
  matches.
- **Never keep a source-route control on a re-targeted request.**
  `reasoningEffort` and `maxTokens` belong to the source model;
  `UNSUPPORTED_REASONING_EFFORT` would fail every review closed.
- **Retry only the harness-transient codes.** `TIMEOUT` is the adapter's idle
  watchdog, so retrying it multiplies a silent wait. Hold back a failed attempt's
  terminal `finish` chunk: the gate's reader ends the review on any terminal
  `finish`. A request signal already inside a retry loop is dispatched once, so
  stacked wrappers cannot multiply the attempt count.
- **Wrap the owner, not the proxy.** `ctx.llm` is a per-read traceable proxy in
  which a property write is shadowed. `methodOwner()` walks the prototype chain to
  the object that actually holds the method.
- **Restore on disposal, and only your own wrapper.** The disposer restores the
  original only while its wrapper is still the installed method.
- **Prepared handles are retargeted before preparation.** The runtime rejects a
  dispatch config that differs from the resolved one (`INVALID_PREPARED_CALL`), so
  swapping the route on the returned handle cannot work.
- **Warn, never fail the boot.** A missing or non-writable method leaves reviews
  on the session route with one warning line.
- **Model-visible ⟺ logged.** This plugin adds no model-visible content: it only
  changes which model answers an existing request. The retarget log line is
  host-side diagnostics, not model input.

## Checks

```sh
node test/router.test.js
DSH_PROFILE_DIR=<profile dir> node test/live.test.js   # integration cases skip without the harness
```

Each file runs its `node:test` suite in-process; do not switch to `node --test`,
which spawns a child process per file (blocked by confined shells on Windows).

## Test isolation

The plugin patches `LlmRuntime.prototype`, which is shared by every runtime in one
process. Every live test must dispose its mount (`harness()` registers the
disposal through `t.after`) or its wrapper leaks into the following test's
dispatches and the expectations become order-dependent. `mount()` asserts that the
plugin registered a disposal effect, so a test cannot silence that leak by
registering an `undefined` teardown.

A leaked wrapper made the retry cases fail only inside the full suite, which is
how the leak was found: a test that mounts with defaults leaves `retryAttempts: 4`
in the chain, so a later case configured with `retryAttempts: 0` still retried.
`RETRYING_SIGNALS` keeps the plugin itself correct in that situation regardless.

## Publishing

`npm publish` only; `prepublishOnly` is intentionally absent because the package
needs no build. Bump `package.json#version` and add a `CHANGELOG.md` entry in the
same commit.
