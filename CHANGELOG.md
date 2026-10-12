# Changelog

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
