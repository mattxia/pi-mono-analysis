# Pi 项目提升任务执行成功率的设计分析

本文基于对源码的通读（packages/ai、packages/agent、packages/coding-agent），梳理 Pi 中所有以"提升 agent 任务执行成功率"为目标的设计机制。

## 总体思路

Pi 把"任务失败"拆解为六类失败源，每一类都有对应的工程机制：

| 失败源 | 对应机制层 |
| --- | --- |
| LLM API 调用失败（网络/限流/过载/流截断） | AI 层重试与流解析韧性 |
| 上下文窗口耗尽（输入溢出、输出截断） | 溢出检测 + Compaction |
| 模型输出畸形（JSON 坏、参数违例、幻觉工具） | JSON 修复 + 参数自愈 + 提示词强一致 |
| 消息序列非法（孤儿 tool call、跨模型重放） | 配对不变量 + transform-messages |
| 工具执行失败（路径错、编码、并发竞争） | 工具层静默纠错 + 教学式错误 |
| 中断/崩溃、认证过期、模型误配 | 持久化恢复 + 认证预刷新 + 模型解析 |

核心哲学：**一切失败都降级为数据（结构化错误/事件），再分类修复；模型可见的错误自带修复路径；修复机制本身有界（防失控）**。

---

## 一、AI 层：让 LLM 调用可靠

### 1.1 两层重试体系

**应用层重试**：`packages/ai/src/utils/retry.ts` 的 `retryAssistantCall`：

- 指数退避：`baseDelayMs * 2^(attempt-1)`；
- `isRetryableAssistantError` 用正则区分两类错误：
  - 可重试：429/5xx、网络与代理错误、流提前结束（"ended without"、"stream ended before message_stop"）、WebSocket 关闭、服务端提示 "you can retry your request"；
  - 不可重试：配额/计费耗尽（`insufficient_quota`、Monthly usage limit reached）——确定性失败快速失败，不浪费等待；
- abort 永不重试；退避 sleep 可被 AbortSignal 中断，中断归一化为 `stopReason: "aborted"` 的消息。

**传输层重试**：`packages/ai/src/utils/provider-retry.ts` 的 `retryProviderRequest`：

- SDK 内置重试的退避计时器忽略 AbortSignal，因此调用 SDK 一律传 `maxRetries: 0`，由外层接管重试；
- 优先尊重服务端 `retry-after-ms`/`retry-after` 响应头；
- 否则指数退避 `min(0.5 * 2^retryIndex, 8)s` 并乘 `(1 - random * 0.25)`——最多 25% 随机抖动，防止并发客户端同步重试造成雷群效应；
- 服务端要求的重试延迟超过 `maxRetryDelayMs`（默认 60 秒）时直接抛错而非无限挂起。

### 1.2 上下文溢出检测

`packages/ai/src/utils/overflow.ts`：

- 约 26 条厂商定制正则识别"上下文超限"错误（Anthropic "prompt is too long"、OpenAI 两种措辞、Gemini、Groq、Ollama、DashScope 等）+ 3 条通用兜底；
- 两条反直觉检测：
  - z.ai 静默接受超限请求并正常返回——用 `usage.input + cacheRead > contextWindow` 判定；
  - Xiaomi MiMo 截断输入后返回 length + 零输出——用 `output === 0 && input+cacheRead >= contextWindow * 0.99` 判定；
- `NON_OVERFLOW_PATTERNS` 反向排除：Bedrock 把限流格式化为 "ThrottlingException: Too many tokens"，无此排除会被误判为溢出。

区分溢出与普通错误后，上层才能"压缩上下文后重试"而非盲目重试。

### 1.3 请求前预防

`packages/ai/src/api/simple-options.ts`：

- `clampMaxTokensToContext`：`max_tokens = 窗口 - 输入估算 - 4096`（安全边际），防止"输入 + max_tokens > 窗口"类请求被直接拒绝；
- 思考预算保护：`MIN_ANSWER_TOKENS = 1024`，保证思考预算永不吃掉整个响应上限。openai-completions.ts 的注释点明动机："不设上限的思考阶段会耗尽整个响应，既没有答案也没有工具调用"。

### 1.4 发送前消息清洗

`packages/ai/src/api/transform-messages.ts`：

- 非视觉模型：image 块替换为文本占位符，连续图片合并为单条占位——避免 400；
- 工具调用 ID 跨 API 归一：OpenAI Responses API 生成 450+ 字符含 `|` 的 ID，Anthropic 要求 `^[a-zA-Z0-9_-]{1,64}$`；映射时同步 toolResult 侧；
- thinking 块处理：`redacted` 思考仅同模型保留；空 thinking 删除；跨模型 thinking 降级为普通 text；toolCall 的 `thoughtSignature` 跨模型剥离；
- **孤儿工具调用修复**：第二遍扫描为没有 toolResult 的 toolCall 插入合成结果 `{ text: "No result provided", isError: true }`——满足"每个 tool_use 必须有 tool_result"的 API 硬性要求；
- 错误/中止的 assistant 消息整体跳过：不完整回合重放会触发 OpenAI "reasoning without following item" 错误。

`packages/ai/src/utils/sanitize-unicode.ts`：删除未配对代理对（会导致多数 API 的 JSON 序列化失败），合法 emoji 不受影响。

### 1.5 流解析韧性

`packages/ai/src/api/anthropic-messages.ts` 手写 SSE 状态机：

- 完整处理 `\r\n`/`\r`/`\n` 三种换行、注释行、多行 data、流结束 flush 残余 buffer；
- 未知事件类型跳过（前向兼容新事件）；
- 追踪 `sawMessageStart/sawMessageEnd`，流在 `message_stop` 前结束则抛 "Anthropic stream ended before message_stop"——**该错误文本恰好命中 retry.ts 的可重试模式，截断的流自动进入重试**；
- 工具调用块按事件 index 对齐，`input_json_delta` 每个增量用 `parseStreamingJson` 重解析（部分 JSON 恒为有效对象）。

`packages/ai/src/utils/json-parse.ts` 的 `parseStreamingJson` 四级兜底：`parse → repair+parse → partial-json → repair+partial-json → {}`——模型输出畸形 JSON（控制字符、错误转义）时工具调用仍可恢复。

### 1.6 厂商兼容层

`packages/ai/src/api/openai-completions.ts` 的 `detectCompat` 把 20+ 项厂商差异收敛为数据开关而非散落的 if：max_tokens 字段名、developer role、usage 位置（Moonshot 放在 `choice.usage`）、推理字段多种拼写（`reasoning_content`/`reasoning`/`reasoning_text`）、DeepSeek 要求空 `reasoning_content: ""`、部分厂商要求 tool result 带 `name` 等。

### 1.7 认证韧性

`packages/ai/src/auth/resolve.ts`：OAuth 凭据在过期前 5 分钟窗口内双检锁预刷新——锁内**再查一次**（另一进程可能已刷新），刷新挂 15 秒超时，轮换后的凭据在释放锁前持久化。长工具执行期间 token 过期不会导致整轮失败。

### 1.8 Prompt cache 优化（间接提升）

- Anthropic 三处稳定 cache 断点：system prompt、最后一个工具定义、最后一条消息——恰好对应会话中增长最慢的前缀，最大化缓存命中；
- OpenAI 侧 `prompt_cache_key` 按 codepoint 截断 64 字符防请求被拒；
- 会话亲和头（`x-session-affinity`）减少跨实例缓存未命中。

---

## 二、Agent Loop 层：失败是数据，不是异常

这是最核心的架构决策。`packages/agent/src/types.ts` 的契约：StreamFn **必须不抛异常**，失败必须编码为返回流中 `stopReason: "error"/"aborted"` + `errorMessage` 的消息；convertToLlm 同样"必须不抛，返回安全兜底值"。

### 2.1 错误消息照常进入转录

`packages/agent/src/agent-loop.ts`：失败的 assistant 消息照常 push 进 `context.messages` 并 emit 完整事件序列——失败成为转录的一部分（后续轮次模型可见，可自我纠正），事件流完整，UI/会话状态机不失步。

循环本体崩溃时（`packages/agent/src/agent.ts` `handleRunFailure`）：合成错误消息并补发 `message_start/message_end/turn_end/agent_end`，`finally` 中 `finishRun()` 保证状态复位，Agent 不会卡死。

### 2.2 工具调用/结果配对不变量

**每个 toolCall 必有 toolResult**。任何失败都合成错误结果文本回传模型：

- 工具不存在 → `Tool X not found`；
- 参数校验失败 → 带点分路径与原始参数的错误（模型可自行纠正）；
- 被扩展 `beforeToolCall` 拦截 → 错误结果含 reason；
- 执行抛异常 → catch 转为错误结果；
- 中止 → `Operation aborted`；
- **输出 token 溢出（stopReason=length）→ 已产生的工具调用全部判失败**：流式参数经 best-effort JSON salvage，"可能解析通过但静默不完整"；错误消息明确指示 "Re-issue the tool call with complete arguments"。

同时 provider 消息序列永远合法。

### 2.3 Steering / Follow-up 双队列

`packages/agent/src/agent.ts`：

- steering：用户中途纠偏不必 abort——消息在下一轮 assistant 响应前注入；
- follow-up：agent 本应停止时查队列，有则继续外层循环——agent "不停机"；
- 中止时队列可取回重放，不丢消息（`AbortResult` 返回 `{ steer, followUp }`）；
- 长耗时 `prepareNextTurn`（压缩）运行期间入队的 steering 会被补捞。

### 2.4 prepareNextTurn 钩子

每轮开始前可整体替换 `context`、`model`、`thinkingLevel`——压缩与模型降级共用此入口，对循环透明，无需外部重启循环。

### 2.5 熔断设计（防修复机制自身失控）

- 溢出恢复压缩只做一次（`overflowRecoveryUsed` 守卫），防"溢出→压缩→仍溢出→再压缩"死循环；
- 持久层校验 attempt 连续递增、消息配对、队列事件合法等 12 类不可能状态（`RecordLogCorruption`）快速失败，而不是带着损坏状态继续跑。

---

## 三、上下文管理：长任务不撞墙

`packages/coding-agent/src/core/compaction/compaction.ts`（1012 行，工程化最重的成功率机制）：

### 3.1 预压缩

`contextTokens > contextWindow - reserveTokens`（默认 reserve 16k、keepRecent 20k）时触发，token 估算优先用最近 assistant 的真实 provider usage（跳过 aborted/error 与零用量消息），其后消息按 chars/4 估算，图片按 4800 chars。在下一轮 assistant 响应前检查，防止请求因超出窗口直接失败。

### 3.2 切点安全

- **toolResult 永不作为切点**——否则重建的上下文含孤儿 tool_result 被 API 拒绝；
- 从尾部累计 keepRecentTokens 找切点；单 turn 超预算时 split-turn，轮前缀单独生成 "Turn Context" 摘要，保留轮内语境。

### 3.3 迭代压缩（信息不丢失）

不是从头重摘，而是把新消息合并进旧摘要：`UPDATE_SUMMARIZATION_PROMPT` 要求 "PRESERVE all existing information... UPDATE Progress: move In Progress → Done"。防止多轮压缩后早期信息（最初需求、早期决策）被反复有损重写。

### 3.4 文件操作跨压缩累积

从 read/write/edit 工具调用提取路径，摘要尾部附 `<read-files>`/`<modified-files>` XML 标签，跨多次压缩/分支摘要**累积**。压缩后模型仍知道改过哪些文件——这对"继续未完成任务"类续接至关重要。

### 3.5 坏摘要门禁

stopReason 为 error/length 的摘要拒绝入库——"坏的压缩比不压缩更危险"。截断的半截摘要绝不作为 checkpoint 写入会话。

### 3.6 防模型入戏

对话序列化为 `[User]:` / `[Assistant]:` / `[Tool result]:` 文本流，并加双重禁令 "Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary."——解决摘要调用最常见的失败模式：模型入戏去回答对话里的问题而不是输出摘要。

### 3.7 分支摘要

会话树导航离开分支时，丢弃的探索路径被摘要保留，前言显式告知 "The user explored a different conversation branch before returning here."——避免模型把旧分支的工作当成当前事实。

---

## 四、工具层：静默纠错 + 教学式错误

### 4.1 截断策略（上下文有界但不失真）

`packages/coding-agent/src/core/tools/truncate.ts`：

- 双限制：2000 行 / 50KB 先到者为准；
- **read/grep/find 保头**（truncateHead）：文件开头是 imports、类型定义、结构信息；
- **bash 保尾**（truncateTail）：注释明说 "errors, final results" 几乎总在末尾；
- 永不返回半行；单行截到 500 字符加 `... [truncated]` 后缀，模型明确知道该行不完整；
- bash 截断时全量输出落盘临时文件，脚注 `[Showing lines X-Y of Z. Full output: /tmp/pi-bash-....log]`——被截掉的内容零丢失，路径回传给模型；
- 流式 UTF-8 解码避免跨 chunk 多字节字符截断；截断元数据精确（"Showing lines 1734-2000 of 2500"）。

### 4.2 edit 工具安全

`packages/coding-agent/src/core/tools/edit-diff.ts`：

- **唯一匹配强制**：多处出现时报错并给出次数与修复方法（"Please provide more context to make it unique"）；计数在 fuzzy 归一化空间里做，防漏判；
- **精确→模糊两级匹配**：先 indexOf，失败后在归一化空间找（NFKC、智能引号→ASCII、NBSP/全角空格→普通空格、CRLF→LF）——解决模型从网页/PDF 复制的 oldText 带不可见字符的经典失败；
- **参数形状自修复**（edit.ts L116-147）：Opus 4.6/GLM-5.1 把 edits 发成 JSON 字符串或单对象，直接修复为合法结构而非报错；
- **BOM 与行尾保真**：剥 U+FEFF（注释："The model will not include an invisible BOM in oldText"），匹配在 LF 空间进行，写回还原 BOM 与 CRLF；
- **零变更检测**：`No changes made to X. The replacement produced identical content.`——防"假成功"；
- **重叠检测**：`edits[i] and edits[j] overlap... Merge them into one edit or target disjoint regions.`

**per-file 变更队列**（`file-mutation-queue.ts`）：edit 是"读-改-写"三步，两个并发 edit 若都基于同一原始内容，后写者会静默覆盖前者的修改。按 canonical path（realpath）串行化，不同文件仍并行。

### 4.3 read 工具

- 描述即教程："Use offset/limit for large files. When you need the full file, continue with offset until complete."；
- 越界即教：`Offset N is beyond end of file (M lines total)`——告诉模型总行数；
- 续读脚注：`Use offset=N to continue.`——给出可直接复制的下一个参数值；区分"系统截断"与"你自己的 limit 截断"，模型不会误以为文件读完了；
- 超大单行（minified js、长 JSON）直接给替代命令：`Use bash: sed -n 'Np' file | head -c 50000`；
- 图片：魔数检测 MIME、自动缩放 2000×2000、格式转换带 hints；非视觉模型提示 `[Current model does not support images...]`——不会反复重读同一张图。

### 4.4 bash 工具

- 超时杀整棵进程树（Windows taskkill /F /T，Unix 进程组 SIGKILL）——防孤儿进程继续写文件、占端口导致后续工具调用结果全部失真；
- **失败时 stdout/stderr 全量附在错误里**（`Command exited with code N` + 输出）——许多实现失败即丢输出，模型只能盲试；
- 已收集的输出附在超时错误里，模型能看到卡住前发生了什么；
- 编码修复：PowerShell 注入 UTF-8 OutputEncoding（修 Windows GBK 乱码）、ANSI 剥离、`\r` 删除；
- exit 后等管道空闲再收尾（issue #5303：孙进程握着 stdout 管道，直接收会截尾；100ms 宽限计时器每收到 chunk 就重置）；
- env 隔离：默认删除 `PI_SESSION_ID` 等（防嵌套 pi 会话递归自引用）；
- bash 未安装时报错列出已搜索路径 + 三种安装方案 + 下载 URL。

### 4.5 路径变体链（静默纠错）

`packages/coding-agent/src/core/tools/path-utils.ts`：

- 路径不存在时依次尝试：macOS 截图名 AM/PM 前的窄不换行空格（U+202F）、NFD 分解形式、弯引号 U+2019、NFD+弯引号组合；
- 静默归一：Unicode 空格变体→普通空格（常来自 PDF/网页复制）、剥 `@` 前缀、`~` 展开、`file://` URL→本地路径；
- **Windows shell 路径转换**：`/c/foo`、`/mnt/c/foo`、`/cygdrive/c/foo` → `C:\foo`——模型在 Windows 上高频输出 Unix 风格路径。

### 4.6 find/grep 的模式自动修正

- find：模式含 `/` 时自动切 `--full-path` 并补 `**/` 前缀（缺前缀会匹配 0 结果）；Windows 上把 `/` 替换为 `[/\\]` 字符类——"看起来对"的 glob 被静默修正为能命中的形式；
- grep：达到 limit 立即 kill rg（结果有界响应快）；截断提示跨工具引导 "Use read tool to see full lines"。

### 4.7 教学式错误消息汇总

| 位置 | 消息 | 教了什么 |
| --- | --- | --- |
| edit-diff.ts | `The old text must match exactly including all whitespace and newlines.` | 精确空白 |
| edit-diff.ts | `Found N occurrences... Please provide more context to make it unique.` | 唯一性 + 扩上下文 |
| edit-diff.ts | `edits[i] and edits[j] overlap... Merge them into one edit.` | 合并编辑 |
| read.ts | `Offset N is beyond end of file (M lines total)` | 文件实际行数 |
| read.ts | `Use bash: sed -n 'Np' file \| head -c 50000` | 超大行的替代命令 |
| read.ts | `Use offset=N to continue.` | 下一次调用的确切参数 |
| grep.ts | `N matches limit reached. Use limit=N*2 for more, or refine pattern` | 提 limit 或缩模式 |
| grep.ts | `Some lines truncated... Use read tool to see full lines` | 跨工具引导 |
| bash.ts | `Command exited with code N` + 全量输出 | 看报错自纠 |
| shell.ts | bash 未找到：3 种安装方案 + 已搜索路径 | 环境修复 |
| ls.ts | `(empty directory)` | 空 result 显式化（空文本易被误读为失败） |

**有意反向设计**：read 没有**跨轮次读缓存**——文件可能在轮间被改，陈旧缓存会导致 edit 的 oldText 失配，fresh-read 是正确性优先。

---

## 五、引导层：提示词与真实状态强一致

### 5.1 工具列表由注册表驱动

`packages/coding-agent/src/core/system-prompt.ts`：

- 工具只有提供了一行摘要（toolSnippet）才出现在 "Available tools" 列表——提示词永远不宣传注册表中不存在的工具，避免"幻影工具"浪费轮次；
- 每轮刷新（agent-session.ts `_installAgentNextTurnRefresh`）：扩展中途注册/注销工具、或每轮覆盖系统提示词时，下一轮立即生效，无脱节窗口；
- `promptGuideline` 自动注入：每个工具定义携带使用最佳实践（如 edit 的 "Keep oldText as small as possible while still being unique"），注册即入系统提示词，无需改框架代码。

### 5.2 Skills 渐进披露

`packages/coding-agent/src/core/skills.ts`：

- description 常驻上下文、正文按需 read 加载——基础开销极小；
- docs/skills.md 诚实承认 "models don't always do this"，因此保留 `/skill:name` 强制通道**双保险**；
- 提示词写明 "resolve it against the skill directory"——技能内相对路径（`references/api.md`）解析错误的常见失败被前置消除；
- 缺 description 不加载（宁可少加载，不加载语义不明的技能）。

### 5.3 项目上下文自动加载

`packages/coding-agent/src/core/resource-loader.ts`：

- AGENTS.md 从 cwd 沿祖先目录逐级上溯收集，根目录优先——项目约定自动进入提示词，模型无需被口头提醒；
- 处理 git worktree 遮蔽（`findShadowedContextFile`），避免同一逻辑仓库的上下文被应用两次（重复规则可能互相矛盾）；
- **信任门控**：不受信任项目的 SYSTEM.md 不能劫持提示词。

### 5.4 模型解析：宁报错不误配

`packages/coding-agent/src/core/model-resolver.ts`：

- 跨 provider 歧义时报错列出全部候选 + auth 提示，绝不静默选错模型；
- 会话恢复的模型必须"仍存在"且"auth 仍配置"，否则降级并写明原因（"model no longer exists" / "no auth configured"）——过期凭证不会导致恢复后第一轮就崩；
- 自定义模型构造 fallback 元数据（克隆该 provider 默认模型）——否则上下文窗口按默认值误判会触发错误的压缩时机；
- alias 优先（`-latest`）、curated 默认表保证初选模型质量。

### 5.5 auth 失败消息自带修复路径

`packages/coding-agent/src/core/auth-guidance.ts`：统一"问题 + 下一步动作"模式——具体 provider 名 + `/login <provider>` 命令 + 文档路径（docs/providers.md）。从启动、选模型、恢复会话到每次请求前的全链路 auth 检查；摘要调用有独立 auth 校验，避免"主对话正常但压缩悄悄失败"的隐性上下文丢失。

---

## 六、持久化：崩溃可无损续跑

- **逐消息落盘**（agent-session.ts 每个 message_end 即持久化）：崩溃后恢复到最后一条消息而非回合边界；
- **reducer 纯函数状态重建**（packages/agent/src/harness/reducer.ts）：从持久化记录推导——未落盘结果的 step 可重试、孤儿工具调用合成结果（`unresolved` 列表）、pending 队列重放；
- **持久化防腐**：`assertJsonSerializable` 写盘前拦截会损坏后续 provider 请求的数据（循环引用、非有限数、稀疏数组）；
- 统计聚合所有条目（含已压缩掉的），计费数字不会被压缩抹掉；`getContextUsage` 只信任压缩之后的 assistant usage——宁可显示未知，不显示错误数字诱导误判剩余空间。

---

## 七、设计哲学总结

四条不变量贯穿全部机制：

1. **失败是数据不是异常**——错误消息进转录、模型可见，配对不变量永不破坏；
2. **结构合法性优先**——消息序列、压缩切点、队列顺序的合法性高于一切（宁可延迟投递、拒绝坏摘要）；
3. **修复有界**——重试封顶、溢出恢复只一次、attempt 连续性校验，防止修复机制自身失控；
4. **静默纠正高频笔误，显式教学低频错误**——路径变体、BOM/CRLF、参数形状这类高频错误直接修掉；低频错误则给出带数值、参数、替代命令的可执行修复路径。

一句话概括：**把"这一轮失败"转化为"下一轮可成功"的结构化信号，而不是裸抛异常**。
