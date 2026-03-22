# 自定义 Anthropic API 测试问题说明

## 最新诊断结果（curl 测试）

✅ **API 可以正常工作！**

通过 curl 测试发现 API 返回的格式**基本符合** Anthropic 规范：

```
event:message_start
data:{"message":{
  "model":"kimi-k2.5",
  "id":"msg_xxx",
  "role":"assistant",
  "type":"message",
  "content":[],
  "usage":{
    "input_tokens":1,
    "output_tokens":0
  }
}}

event:ping  ← 这是额外的

event:content_block_start
event:content_block_delta
event:content_block_stop

event:message_delta
data:{"delta":{"stop_reason":"end_turn"},"usage":{
  "output_tokens":33,
  "cache_creation_input_tokens":0,
  "input_tokens":10,
  "cache_read_input_tokens":0
}}

event:message_stop
```

### 🔍 发现的问题

**`message_start` 事件中的 `usage` 字段不完整：**

```json
// 实际返回（缺少 cache 字段）
"usage": {
  "input_tokens": 1,
  "output_tokens": 0
}

// 标准 Anthropic API 应该返回
"usage": {
  "input_tokens": 1,
  "output_tokens": 0,
  "cache_read_input_tokens": 0,  // ❌ 缺少
  "cache_creation_input_tokens": 0  // ❌ 缺少
}
```

这就是 SDK 报错的原因！Anthropic SDK 在 `message_start` 事件中期望访问这些字段，但 API 没有返回。

## 解决方案

### ✅ 方案 1：修复 SDK 代码（推荐）

修改 `packages/ai/src/providers/anthropic.ts`，使其能够处理缺失的字段：

找到这段代码（约 250-260 行）：

```typescript
if (event.type === "message_start") {
  output.usage.input = event.message.usage.input_tokens || 0;
  output.usage.output = event.message.usage.output_tokens || 0;
  output.usage.cacheRead = event.message.usage.cache_read_input_tokens || 0;
  output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens || 0;
  // ...
}
```

**问题**：SDK 可能在其他地方直接访问 `event.message.usage` 而没有检查是否存在。

需要检查 SDK 中是否有其他地方假设这些字段一定存在。

### 方案 2：联系 API 提供方

告知阿里云 DashScope 团队，他们的 API 响应缺少标准字段：
- `cache_read_input_tokens`
- `cache_creation_input_tokens`

建议他们在 `message_start` 和 `message_delta` 事件中都包含完整的 usage 字段。

### 方案 3：使用非流式模式

尝试不使用流式模式（`stream: false`），看是否能正常工作。

## ⚠️ 重要：模型配置必需字段

创建自定义模型时，必须包含以下字段：

```typescript
const model: Model<"anthropic-messages"> = {
  id: MODEL_ID,
  name: MODEL_ID,              // ← 必需！
  provider: "anthropic",
  api: "anthropic-messages",
  contextWindow: 200000,
  maxTokens: 4096,
  reasoning: false,
  vision: false,
  toolUse: false,
  baseUrl: CUSTOM_BASE_URL,
  input: ["text"],             // ← 必需！支持 "text" | "image"
  cost: {                      // ← 必需！
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
};
```

缺少任何字段都会导致 TypeScript 编译错误。

## 解决方案

### 方案 1：检查 API 兼容性

确认你的 API 是否正确实现了 Anthropic Messages API 规范：

1. **端点格式**：`POST /v1/messages`
2. **请求体格式**：
   ```json
   {
     "model": "your-model-id",
     "messages": [{"role": "user", "content": "Hello"}],
     "max_tokens": 1024,
     "stream": true
   }
   ```
3. **流式响应事件**：
   - `message_start` - 包含 usage 信息
   - `content_block_start` - 内容块开始
   - `content_block_delta` - 内容增量
   - `content_block_stop` - 内容块结束
   - `message_delta` - 消息完成
   - `message_stop` - 流结束

### 方案 2：使用 OpenAI 兼容模式

如果你的 API 支持 OpenAI 兼容模式，可以改用 OpenAI provider：

```typescript
const model: Model<"openai-completions"> = {
  id: MODEL_ID,
  provider: "openai",
  api: "openai-completions",
  contextWindow: 200000,
  maxTokens: 4096,
  reasoning: false,
  vision: false,
  toolUse: true,
  baseUrl: CUSTOM_BASE_URL,
};
```

### 方案 3：直接使用 HTTP 请求测试

绕过 SDK，直接用 HTTP 请求测试 API：

```bash
curl -X POST "https://coding.dashscope.aliyuncs.com/apps/anthropic/v1/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-sp-da75b0c0eb384e2985b9c68bb6a1bbe2" \
  -d '{
    "model": "kimi-k2.5",
    "messages": [{"role": "user", "content": "你好"}],
    "max_tokens": 100,
    "stream": true
  }'
```

观察返回的事件格式。

### 方案 4：联系 API 提供方

如果 API 确实不兼容，联系提供方（阿里云 DashScope）询问：
- 是否支持标准 Anthropic API 格式
- 是否有特定的 SDK 或客户端库
- 正确的使用方式

## 当前测试文件说明

已创建的测试文件：
- `test/custom-anthropic-simple.test.ts` - 简化版基础测试

运行测试：
```powershell
# 设置环境变量（可选，文件中已有默认值）
$env:CUSTOM_ANTHROPIC_BASE_URL="https://coding.dashscope.aliyuncs.com/apps/anthropic"
$env:CUSTOM_ANTHROPIC_API_KEY="sk-sp-da75b0c0eb384e2985b9c68bb6a1bbe2"
$env:CUSTOM_ANTHROPIC_MODEL="kimi-k2.5"

# 运行测试
cd packages/ai
npx vitest --run test/custom-anthropic-simple.test.ts
```

## 下一步建议

1. **先用 curl 测试** - 直接用 HTTP 请求验证 API 响应格式
2. **查看 API 文档** - 确认是否支持 Anthropic 兼容模式
3. **尝试 OpenAI 模式** - 如果支持 OpenAI 兼容，改用 OpenAI provider
4. **联系技术支持** - 如果是商业 API，寻求官方支持

## 参考资源

- Anthropic API 文档：https://docs.anthropic.com/claude/reference/messages-streamming
- OpenAI API 文档：https://platform.openai.com/docs/api-reference
- DashScope 文档：https://help.aliyun.com/zh/dashscope/
