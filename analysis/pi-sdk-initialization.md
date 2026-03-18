# Pi SDK 初始化过程深度分析

### 初始化核心流程图
```mermaid
flowchart TD
    A[调用createAgentSession] --> B[参数初始化与默认值填充]
    B --> C[创建/加载基础依赖]
    C --> D[资源加载器初始化]
    D --> E[会话上下文恢复]
    E --> F[模型与思考等级解析]
    F --> G[Agent 核心实例创建]
    G --> H[AgentSession 实例组装]
    H --> I[返回初始化结果]

    subgraph 参数初始化
        B --> B1[cwd: 默认为process.cwd()]
        B --> B2[agentDir: 默认为~/.pi/agent]
    end

    subgraph 基础依赖创建
        C --> C1[AuthStorage: 认证信息存储]
        C --> C2[ModelRegistry: 模型注册与管理]
        C --> C3[SettingsManager: 全局/项目设置管理]
        C --> C4[SessionManager: 会话持久化管理]
    end

    subgraph 资源加载
        D --> D1[加载Extensions扩展]
        D --> D2[加载Skills技能包]
        D --> D3[加载Prompt Templates提示词模板]
        D --> D4[加载Themes主题]
        D --> D5[加载AGENTS.md等上下文文件]
    end

    subgraph 会话恢复
        E --> E1[检查是否有已存在的会话数据]
        E --> E2[恢复历史消息上下文]
        E --> E3[恢复之前的模型配置]
    end

    subgraph 模型解析
        F --> F1[优先使用用户传入的model参数]
        F --> F2[其次尝试从会话历史中恢复模型]
        F --> F3[最后通过findInitialModel自动选择可用模型]
        F --> F4[思考等级匹配模型能力,不支持推理则设为off]
    end

    subgraph Agent实例化
        G --> G1[配置convertToLlm消息转换层]
        G --> G2[配置getApiKey动态密钥获取]
        G --> G3[配置transformContext上下文转换钩子]
        G --> G4[配置工具执行、重试等策略]
    end
```

---

### 初始化步骤详细解析

#### 1. 阶段一：参数标准化与基础依赖创建
```typescript
// 核心参数默认值填充
const cwd = options.cwd ?? process.cwd();
const agentDir = options.agentDir ?? getDefaultAgentDir(); // ~/.pi/agent

// 基础依赖实例化
const authStorage = options.authStorage ?? AuthStorage.create(join(agentDir, "auth.json"));
const modelRegistry = options.modelRegistry ?? new ModelRegistry(authStorage, join(agentDir, "models.json"));
const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
const sessionManager = options.sessionManager ?? SessionManager.create(cwd);
```
**职责**：
- `AuthStorage`：管理所有 LLM 提供商的 API Key 和 OAuth 凭证，支持持久化到本地文件
- `ModelRegistry`：维护所有可用模型列表，处理模型查询、API Key 获取、OAuth 认证流程
- `SettingsManager`：合并全局配置（~/.pi/agent/settings.json）和项目级配置（./.pi/settings.json）
- `SessionManager`：负责会话的持久化存储、分支管理、历史消息加载

---

#### 2. 阶段二：资源加载器初始化
```typescript
if (!resourceLoader) {
    resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
    await resourceLoader.reload();
}
```
**DefaultResourceLoader 会自动发现并加载以下资源**：
| 资源类型 | 加载路径 | 作用 |
|---------|---------|------|
| Extensions | ~/.pi/agent/extensions/、./.pi/extensions/ | TypeScript 扩展，可新增工具、命令、UI、钩子 |
| Skills | ~/.pi/agent/skills/、./.pi/skills/ | 声明式技能包，模型可自动调用 |
| Prompt Templates | ~/.pi/agent/prompts/、./.pi/prompts/ | 可复用提示词模板，通过 `/name` 调用 |
| Themes | ~/.pi/agent/themes/、./.pi/themes/ | 终端界面主题 |
| Context Files | 各级目录下的 AGENTS.md/SYSTEM.md | 项目规则、系统提示词自动注入 |

---

#### 3. 阶段三：会话上下文恢复
```typescript
const existingSession = sessionManager.buildSessionContext();
const hasExistingSession = existingSession.messages.length > 0;

// 如果是已有会话，恢复历史消息
if (hasExistingSession) {
    agent.replaceMessages(existingSession.messages);
}
```
**会话支持能力**：
- 支持从 JSONL 文件恢复完整会话历史，包括消息、工具调用结果、分支结构
- 支持恢复之前使用的模型、思考等级等设置
- 会话文件采用树形结构（每条消息有 id/parentId），支持多分支回溯

---

#### 4. 阶段四：模型与思考等级解析
```typescript
// 模型优先级：用户传入 > 会话恢复 > 自动发现
if (!model && hasExistingSession && existingSession.model) {
    model = modelRegistry.find(existingSession.model.provider, existingSession.model.modelId);
}
if (!model) {
    const result = await findInitialModel({ /* 从设置中查找默认模型 */ });
    model = result.model;
}

// 思考等级自动适配模型能力
if (!model || !model.reasoning) {
    thinkingLevel = "off";
}
```
**自动模型选择逻辑**：
1. 优先使用用户显式传入的 model 参数
2. 如果是恢复已有会话，尝试使用会话中保存的模型
3. 最后从设置中读取默认模型，或查找第一个有可用 API Key 的模型
4. 如果模型不支持推理（thinking）能力，自动将思考等级设为 off

---

#### 5. 阶段五：Agent 核心实例创建
```typescript
agent = new Agent({
    initialState: {
        systemPrompt: "",
        model,
        thinkingLevel,
        tools: [],
    },
    convertToLlm: convertToLlmWithBlockImages, // 消息格式转换，支持禁用图片
    getApiKey: async (provider) => { /* 动态从 modelRegistry 获取密钥 */ },
    transformContext: async (messages) => { /* 支持扩展修改上下文 */ },
    steeringMode: settingsManager.getSteeringMode(), // 中断消息处理模式
    followUpMode: settingsManager.getFollowUpMode(), // 后续消息处理模式
    transport: settingsManager.getTransport(), // API 传输协议（sse/websocket）
});
```
**核心配置说明**：
- `convertToLlm`：将 AgentMessage 转换为 LLM 可识别的标准格式，支持动态禁用图片输入
- `getApiKey`：动态获取对应提供商的 API Key，支持 OAuth 令牌自动刷新
- `transformContext`：上下文钩子，支持扩展在发送给 LLM 前修改上下文
- 所有运行时配置从 SettingsManager 读取，支持运行中动态修改生效

---

#### 6. 阶段六：AgentSession 组装与返回
```typescript
const session = new AgentSession({
    agent,
    sessionManager,
    settingsManager,
    cwd,
    resourceLoader,
    modelRegistry,
    /* 其他配置 */
});

return { session, extensionsResult, modelFallbackMessage };
```
**AgentSession 是上层交互的核心对象**，封装了所有能力：
- 会话管理：消息发送、中断、分支切换、历史回溯
- 工具管理：内置工具、扩展工具的注册与执行
- 事件订阅：所有生命周期事件（消息更新、工具执行、错误等）
- 能力扩展：模型切换、思考等级调整、动态加载扩展
- 持久化：自动保存会话变更到本地文件

---

### 不同集成场景的初始化方案

#### 1. 最简集成（默认配置）
```typescript
// 自动发现所有资源，使用默认配置
const { session } = await createAgentSession();
await session.prompt("Hello Pi!");
```

#### 2. 嵌入式集成（无持久化）
```typescript
const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(), // 内存会话，不保存到磁盘
    tools: [readTool, writeTool], // 仅启用指定工具，不使用默认工具集
    cwd: "/your/project/path", // 指定工作目录
});
```

#### 3. 完全自定义集成
```typescript
// 自定义所有依赖
const authStorage = AuthStorage.inMemory();
authStorage.setRuntimeApiKey("anthropic", "sk-ant-xxx");

const modelRegistry = new ModelRegistry(authStorage);
const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");

const { session } = await createAgentSession({
    model,
    thinkingLevel: "high",
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
    customTools: [yourCustomTool], // 注册自定义工具
});
```

---

### 关键初始化注意事项
1. **资源加载开销**：默认的 DefaultResourceLoader 会扫描多个目录，首次初始化可能需要几十到几百毫秒，如果不需要扩展能力，可以手动创建最小 ResourceLoader 提升性能
2. **会话持久化**：默认 SessionManager 会自动保存所有会话到 ~/.pi/agent/sessions/，不需要持久化请显式使用 SessionManager.inMemory()
3. **模型可用性**：初始化时会自动检查模型的 API Key 是否存在，如果没有可用模型会返回 modelFallbackMessage 提示，需要处理这种情况引导用户认证
4. **扩展隔离**：每个 AgentSession 实例有独立的扩展运行环境，多个实例之间不会互相影响

初始化完成后，就可以通过 `session.prompt()` 发送用户消息，通过 `session.subscribe()` 订阅事件流，实现完整的 Agent 交互。
