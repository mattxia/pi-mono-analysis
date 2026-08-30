# Pi 项目在保障成功率前提下的 Token 节约机制分析

本文基于对源码的通读（packages/ai、packages/agent、packages/coding-agent），梳理 Pi 中所有以"节约 token / 降低成本"为目标的设计机制，及其与成功率的权衡关系。

核心观点：**Pi 的 token 节约与成功率不是对立关系——减少一轮失败重试（= 全量上下文重发）本身就是最大的 token 节约**，因此自纠错体系同时也是成本体系。

Token 消耗有五个来源，Pi 在每一层都有对应机制：

```
减少浪费的轮次（自纠错/重试分类/steering）
  > 压缩历史（compaction：真实 usage 触发 + 迭代更新 + 文件追踪）
    > 削减每请求固定开销（deferred tools / 空内容过滤 / 渐进披露）
      > 截断大输出（落盘可回取而非硬丢）
        > 缓存折扣（三断点 / cacheRetention / 会话亲和）
```

所有手段的共同前提：**不损失模型继续任务所需的信息完整性**——省下来的 token 如果换来一轮重新探索，就是负收益。

---

## 一、历史上下文的动态瘦身（最大头）

### 1.1 Compaction：O(全部历史) → O(摘要 + 20k)

- **触发时机精确**（`packages/coding-agent/src/core/compaction/compaction.ts` L247-250）：`contextTokens > contextWindow - reserveTokens` 才压缩，且 token 估算**优先用最近 assistant 的真实 provider usage**（L216-244，跳过 error/aborted 与零用量消息）而非纯 chars/4 猜测——既不过早压缩（丢信息 + 摘要请求本身花钱），也不撞墙失败。
- **迭代压缩而非全量重摘**（L616-687）：旧摘要作为 `previousSummary` 传入，UPDATE prompt 要求 "PRESERVE all existing information... move In Progress → Done"——每次压缩只增量更新，且信息不丢失（丢信息 → 模型重新探索 → 最大的 token 浪费）。
- **摘要内部再截断**（`packages/coding-agent/src/core/compaction/utils.ts` L89-99）：序列化对话时每个 toolResult 截到 2000 字符并标注截断数——摘要请求自身不撑爆窗口。
- **摘要输出预算挂钩**（L656）：`maxTokens = min(0.8 * reserveTokens, model.maxTokens)`——摘要是输出 token，有硬上限。
- **分支摘要**（`packages/coding-agent/src/core/compaction/branch-summarization.ts` L293）：`maxTokens: 2048`，预算内优先保留旧摘要条目（信息密度高，值得保留）。

### 1.2 工具输出截断：单条消息不撑爆上下文

`packages/coding-agent/src/core/tools/truncate.ts`：

- 2000 行 / 50KB 双限制；read/grep/find 保头（结构信息在前），bash 保尾（错误与最终结果在末尾）；
- **bash 超限部分全量落盘 temp file，路径回传**（`output-accumulator.ts` L205-221）——"不占上下文但可回取"，模型需要时用 `sed -n` 精准取片段，而不是把 50KB 全塞进历史；
- grep 单行截 500 字符、达到 limit 立即 kill rg（结果有界响应快）；
- read 用 offset/limit 分页 + `Use offset=N to continue` 脚注——分页而非整文件灌入。

### 1.3 渐进披露（Progressive Disclosure）

- **Skills**（`packages/coding-agent/src/core/skills.ts` L355-381）：只有 description（≤1024 字符）常驻系统提示词，正文按需 read 加载。N 个技能的常驻成本是 N×三行，而不是 N×全文——最典型的按需加载设计。
- **harness 文档**（`packages/coding-agent/src/core/system-prompt.ts` L138）："read only when the user asks about pi itself"——文档映射表只占几行，防模型在无关任务上把 pi 文档读进上下文。

### 1.4 图片瘦身

`packages/coding-agent/src/core/tools/read.ts` L66：自动缩放图片到 2000×2000（图片 token 与像素成正比）；非视觉模型直接降级为文本占位符（[transform-messages.ts](../ai/src/api/transform-messages.ts)），不占 token，只留一行说明。

---

## 二、每请求固定开销的削减

**每个请求都重发的内容**（系统提示词、工具定义、全部历史）是持续成本，Pi 在两处做了削减：

1. **Deferred tools / tool_reference**（`packages/ai/src/utils/deferred-tools.ts`）：支持 tool reference 的厂商（Anthropic）只发送立即工具的完整 schema，历史中已出现过的工具用 `tool_reference` 引用而非完整 schema 重发——几十个工具的 JSON schema 每请求都发，这个节约相当可观。无立即工具时全部升级为立即发送（保成功率优先）。
2. **空内容过滤**（`packages/ai/src/api/anthropic-messages.ts` convertMessages L1195-1212）：空文本块、空消息、中止产生的空回合全部过滤，不发垃圾内容。

---

## 三、输出 token 控制

1. **max_tokens 钳制**（`packages/ai/src/api/simple-options.ts` L12-19）：`窗口 - 输入估算 - 4096`——输出上限刚好够用，不多留。
2. **思考预算保护**（L55-95）：`MIN_ANSWER_TOKENS = 1024`，思考 token 是最贵的输出 token，注释直言"不设上限的思考阶段会耗尽整个响应，既没有答案也没有工具调用"——无答案的思考轮次是纯浪费。
3. **系统提示词 "Be concise in your responses"**（system-prompt.ts L122）。
4. **`!!` 前缀 excludeFromContext**（`packages/coding-agent/src/core/agent-session.ts` L2967-3075）：`!!ls` 命令可执行但输出不进上下文——用户手动决定哪些输出不值得占历史（如长 dir 列表）。
5. `bashExecution` 消息类型支持 `excludeFromContext`（`packages/agent/src/harness/messages.ts` L124-168）。

---

## 四、计费侧：Prompt cache 优化

这不是减少 token 数量，而是把同一 token 的计费降一个数量级（cache read 通常为输入价 1/10）：

1. **Anthropic 三处稳定 cache 断点**（anthropic-messages.ts L1011-1034、L1295-1317、L1360）：system prompt、最后一个工具定义、最后一条消息——恰好是会话中**增长最慢的前缀**，追加新消息后前缀不变，缓存稳定命中。
2. **cacheRetention 可调**（L50-74）：默认 short，`PI_CACHE_RETENTION=long` 升级 1 小时 TTL（长会话/间歇使用场景）。
3. **一次性请求不污染缓存**（compaction.ts L579）：摘要请求用 `cacheRetention: "none"` + 全新 `uuidv7` sessionId——缓存写入有溢价，写一个永远不会被复用的前缀纯属浪费；同时不挤占主会话的缓存前缀。
4. **会话亲和头**（`x-session-affinity`，L949-950）：减少跨实例缓存未命中。
5. **OpenAI 侧**（`packages/ai/src/api/openai-completions.ts` L805-810）：`prompt_cache_key` 按 codepoint 截 64 字符（超长 sessionId 会导致请求被拒），`prompt_cache_retention: "24h"`。

---

## 五、轮次侧：自纠错 = 减少全量重发

**每次失败重试 = 全量上下文重发一遍**（还可能 cache miss），所以自纠错设计在成本上同样是 token 节约：

| 机制 | 节约的轮次 |
| --- | --- |
| 路径变体链静默纠错（`path-utils.ts`） | 消掉一轮 ENOENT 重试 |
| edits 参数形状自修复（`edit.ts` L116-147） | 消掉一轮 400 |
| 教学式错误消息（给确切参数值/替代命令） | 一轮解决而非多轮试错 |
| 重试分类器（`packages/ai/src/utils/retry.ts` L7-24） | 配额耗尽快速失败，不做注定失败的重发 |
| steering 而非 abort（`packages/agent/src/agent.ts` L283-290） | abort 重来 = 已消耗输出 + 全部历史重发；steering 保留已有工作 |
| 坏摘要门禁（compaction.ts L545） | 坏压缩 → 模型重新探索 = 最大浪费 |
| `<read-files>`/`<modified-files>` 追踪（compaction/utils.ts L12-82） | 压缩后不重复读文件（重复读 = 重复输入 token + cache 全 miss） |

---

## 六、有意不做的事（性价比判断）

成本设计同样体现在**克制**上：

1. **read 不做跨轮缓存**——文件可能在轮间被改，陈旧缓存导致 edit oldText 失配的重试成本高于缓存节约，fresh-read 是正确性优先；
2. **压缩保留最近 20k token（keepRecentTokens）**——不是压得越狠越好，最近的工具结果对下一步决策信息密度最高；
3. **truncateHead 保头**——imports/类型定义是模型理解文件的骨架，砍掉它们省的 token 会被"理解错误导致的返工"加倍还回去。

---

## 七、总结：节约优先级与成功率的关系

Pi 的成本控制优先级链：

1. **减少浪费的轮次**——自纠错、重试分类、steering 保留已有工作；
2. **压缩历史**——真实 usage 触发、迭代更新、文件追踪防重复探索；
3. **削减每请求固定开销**——deferred tools、空内容过滤、渐进披露；
4. **截断大输出**——落盘可回取而非硬丢；
5. **缓存折扣**——三断点、cacheRetention、会话亲和。

与成功率的关系不是权衡取舍，而是**同一设计目标的两个收益面**：信息完整性保住了，模型不返工、不重新探索，token 自然省下来；反过来，为省 token 而硬截断（有损压缩、砍结构信息）会在返工中加倍还回去——Pi 在每处取舍上都选择了"保信息、省展示"而非"省信息"。
