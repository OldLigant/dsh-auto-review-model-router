# dsh-auto-review-model-router

把 DSH 实验性 **auto-review** 安全审查固定路由到你指定的模型，让昂贵的 agent
模型不必再为自己的安全审查付费。

```yaml
# <profile>/cordis.patch.yml
- insert:
    - id: auto-review-model-router
      name: dsh-auto-review-model-router
      config:
        reviewModel: deepseek-official/deepseek-flash
```

加上这一条之后，每一次审查都跑在 `deepseek-official/deepseek-flash` 上，而 agent
仍然使用 `claude-opus-4`、`gpt-6-astra` 或当前会话选中的任何模型。

## 它解决什么问题

`@deepseek-ai/dsh-experimental-auto-review` 审查每个受控工具调用时，是**按会话
自身的路由**调用 `ctx.llm.stream()` 的：它从会话请求头里直接取出 `provider` 与
`model`（见 `packages/experimental/auto-review/src/index.ts` 的
`snapshotAutoReview()`）。已发布的插件里没有 `reviewModel` 配置项，因此每个受控
调用都会让昂贵的 agent 模型额外承担一次完整的审查请求。

## 工作原理

插件在激活时包装两个服务方法：始终包装 `llm.stream`，并在 `wrapPrepareCall` 未
关闭时一并包装 `llm.prepareCall`。

1. 只有**手工构造**（不携带 agent loop 自身请求标记）**且** `system` 提示词以
   auto-review 固定 `REVIEW_POLICY` 开头（固定的政策文本）的请求才会被识别为
   审查调用。只有这类请求会被改写。
2. 该请求被复制一份并改到 `reviewModel`，同时丢弃源路由的 `reasoningEffort` 与
   `maxTokens`。这两项是**agent 模型**的属性：目标模型未声明的 reasoning effort
   会让 harness 抛出 `UNSUPPORTED_REASONING_EFFORT`，而继承来的输出上限可能超出
   目标模型限制。两者都会让每次审查 fail closed。
3. 其余部分——审查提示词、政策 system prompt、`temperature`，以及网关解析的
   `{"risk":…,"decision":…}` JSON 协议——完全不变。改变的只有产出裁决的模型。

### 为什么是包装方法，而不是监听 `llm/stream`

以下三个切入点都在真实运行时上验证过，全部走不通：

- 在 `llm/stream` 监听器里改请求会抛异常：auto-review 在流式调用前已用
  `deepFreeze` 冻结该对象。
- 在监听器里 `next(replacement)` 永远到不了 adapter：Cordis 的
  `EventsService.waterfall` 会用自己闭包里保存的实参列表调用最内层回调。
- 写 `ctx.llm.stream = wrapper` 同样无效：`ctx.llm` 是每次读取都会新建的
  traceable 代理，其属性覆盖层会屏蔽你写入的值。

因此包装被装在服务原型链上真正拥有该方法的对象上（实际是
`LlmRuntime.prototype`）——那才是所有消费者实际调用的唯一切入点。插件 fiber 卸载
时两个包装都会被移除。

### 为什么 `prepareCall` 需要单独包装

prepared handle 在 `prepareCall` 阶段就解析好路由，随后会拒绝与已解析配置不一致
的分发（`INVALID_PREPARED_CALL`）。因此改写必须发生在**准备之前**，在返回的
handle 上换路由是行不通的。默认 `wrapPrepareCall: true` 时，这类审查会走审查路由；
关掉它则这条路径恢复会话路由。

## 安装

已发布到 npm：

```sh
# 在 profile 目录下执行
pnpm add dsh-auto-review-model-router
```

若从本地检出安装，则改用 link：

```jsonc
// <profile>/package.json
"dependencies": { "dsh-auto-review-model-router": "link:D:/path/to/dsh-auto-review-model-router" }
```

然后在 profile 的 patch 层插入，位置放在 auto-review bundle 之后：

```yaml
# <profile>/cordis.patch.yml
- insert:
    - id: auto-review-model-router
      name: dsh-auto-review-model-router
      config:
        reviewModel: deepseek-official/deepseek-flash
```

重启应用：patch 层变更在 profile 启动时生效。

## 配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `reviewModel` | `deepseek-official/deepseek-flash` | 审查统一使用的 `<provider>/<model>`。设为空字符串即关闭路由。 |
| `systemPromptPatterns` | 已发布的 `REVIEW_POLICY` 开头 | 与请求 `system` 提示词匹配的子串，或 `/regex/u` 字面量。仅当某个 harness 版本改写了该提示词时才需要放宽。 |
| `wrapPrepareCall` | `true` | 一并路由通过 `llm.prepareCall` 发出的审查请求。 |
| `dropReasoningEffort` | `true` | 在审查请求上丢弃源路由的 reasoning effort。 |
| `dropMaxTokens` | `true` | 在审查请求上丢弃源路由的输出上限。 |
| `logRetargets` | `true` | 记录每一次改写后的审查路由。 |

## 验证

测试分两个文件：`test/router.test.js` 完全不依赖 harness，覆盖判定逻辑；
`test/live.test.js` 在真实 `LlmRuntime` 上跑包装，当本包与 `DSH_PROFILE_DIR` 都
无法解析 `@deepseek-ai/dsh-llm` 时自动跳过这些用例。

```sh
node test/router.test.js
DSH_PROFILE_DIR=<profile 目录> node test/live.test.js
```

之所以分成两条命令而不是 `node --test`：每个文件都在同一进程内执行 `node:test`
套件，而 `node --test` 会为每个文件派生一个子进程。

> 插件会改写 `LlmRuntime.prototype`，因此每个 live 用例都会释放自己的挂载；漏掉这步
> 会让包装泄漏到下一个用例的分发里。

运行时每次改写都会打印一行日志：

```
auto-review-model-router: review request re-routed anthropic/claude-opus-4 -> deepseek-official/deepseek-flash (stream)
```

## 范围与限制

- 只有被识别为 auto-review 的请求会改路由。漏判没有代价（审查完全照旧）；误判的
  代价仅限于一次额外的对象分配，以及某个手工构造请求的一次路由变化。
- 独立的 `dsh-auto-review` 插件不需要这些：它的 `reviewerModel` 配置项已经能直接
  指定审查模型。
- DSH 公开 API 尚不稳定：若某个版本改动了 `REVIEW_POLICY` 开头、
  `LlmRuntime.prototype` 的方法名或 prepared handle 的约定，这里需要同步更新。检测
  方式之所以可配置（`systemPromptPatterns`），正是为了第一种情况；而缺少所需方法时
  插件只记录警告，不会让 profile 启动失败。

## 许可证

MIT
