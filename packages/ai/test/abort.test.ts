import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { complete, stream } from "../src/stream.js";
import type { Api, Context, Model, StreamOptions } from "../src/types.js";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

import { hasAzureOpenAICredentials, resolveAzureDeploymentName } from "./azure-utils.js";
import { hasBedrockCredentials } from "./bedrock-utils.js";
import { CUSTOM_API_KEY, CUSTOM_BASE_URL, MODEL_ID } from "./custom-anthropic-config.js";
import { resolveApiKey } from "./oauth.js";

// Resolve OAuth tokens at module level (async, runs before tests)
// 在模块级别解析 OAuth 令牌（异步，在测试前运行）
const [geminiCliToken, openaiCodexToken] = await Promise.all([
	resolveApiKey("google-gemini-cli"),
	resolveApiKey("openai-codex"),
]);

/**
 * 创建自定义 Anthropic 模型配置
 * 用于在没有标准 API 密钥时使用自定义 API 端点进行测试
 */
function createCustomAnthropicModel(): Model<"anthropic-messages"> {
	return {
		id: MODEL_ID,
		name: MODEL_ID,
		provider: "anthropic",
		api: "anthropic-messages",
		contextWindow: 200000,
		maxTokens: 4096,
		reasoning: false,
		input: ["text"],
		baseUrl: CUSTOM_BASE_URL,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
	};
}

/**
 * 测试流式输出中的中止信号
 *
 * 验证在流式输出过程中触发 abort 信号时，模型能否正确响应并停止生成
 *
 * @param llm - 要测试的模型
 * @param options - 额外的流式选项
 */
async function testAbortSignal<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const context: Context = {
		messages: [
			{
				role: "user",
				content: "What is 15 + 27? Think step by step. Then list 50 first names.",
				timestamp: Date.now(),
			},
		],
		systemPrompt: "You are a helpful assistant.",
	};

	let abortFired = false;
	let text = "";
	const controller = new AbortController();
	const response = await stream(llm, context, { ...options, signal: controller.signal });
	for await (const event of response) {
		if (abortFired) return;
		if (event.type === "text_delta" || event.type === "thinking_delta") {
			text += event.delta;
		}
		// 当累积文本达到 50 个字符时，触发 abort 信号
		if (text.length >= 50) {
			controller.abort();
			abortFired = true;
		}
	}
	const msg = await response.result();

	// 如果没有抛出异常，说明 abort 成功执行
	expect(msg.stopReason).toBe("aborted");
	expect(msg.content.length).toBeGreaterThan(0);

	context.messages.push(msg);
	context.messages.push({
		role: "user",
		content: "Please continue, but only generate 5 names.",
		timestamp: Date.now(),
	});

	// 验证中止后可以继续发送新请求
	const followUp = await complete(llm, context, options);
	expect(followUp.stopReason).toBe("stop");
	expect(followUp.content.length).toBeGreaterThan(0);
}

/**
 * 测试立即中止
 *
 * 验证在请求开始前就触发 abort 信号时，模型能否正确处理
 *
 * @param llm - 要测试的模型
 * @param options - 额外的流式选项
 */
async function testImmediateAbort<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const controller = new AbortController();

	// 立即触发 abort
	controller.abort();

	const context: Context = {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};

	const response = await complete(llm, context, { ...options, signal: controller.signal });
	expect(response.stopReason).toBe("aborted");
}

/**
 * 测试中止后发送新消息
 *
 * 验证在请求被中止后，仍然可以发送新的请求并正常响应
 * 这是为了模拟实际 coding agent 中的场景：用户可能中止一个请求后继续对话
 *
 * @param llm - 要测试的模型
 * @param options - 额外的流式选项
 */
async function testAbortThenNewMessage<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	// 第一个请求：在任何响应内容到达之前立即中止
	const controller = new AbortController();
	controller.abort();

	const context: Context = {
		messages: [{ role: "user", content: "Hello, how are you?", timestamp: Date.now() }],
	};

	const abortedResponse = await complete(llm, context, { ...options, signal: controller.signal });
	expect(abortedResponse.stopReason).toBe("aborted");
	// 由于在内容到达前就中止了，响应内容为空
	expect(abortedResponse.content.length).toBe(0);

	// 将被中止的助手消息添加到上下文中（这是实际 coding agent 中的处理方式）
	context.messages.push(abortedResponse);

	// 第二个请求：发送新消息 - 即使上下文中有被中止的消息，这个请求也应该正常工作
	context.messages.push({
		role: "user",
		content: "What is 2 + 2?",
		timestamp: Date.now(),
	});

	const followUp = await complete(llm, context, options);
	expect(followUp.stopReason).toBe("stop");
	expect(followUp.content.length).toBeGreaterThan(0);
}

describe("AI Providers Abort Tests", () => {
	// Google Provider 测试组
	// 测试 Google Gemini 模型的中止功能
	describe.skipIf(!process.env.GEMINI_API_KEY)("Google Provider Abort", () => {
		const llm = getModel("google", "gemini-2.5-flash");

		it("should abort mid-stream", { retry: 3 }, async () => {
			await testAbortSignal(llm, { thinking: { enabled: true } });
		});

		it("should handle immediate abort", { retry: 3 }, async () => {
			await testImmediateAbort(llm, { thinking: { enabled: true } });
		});
	});

	// OpenAI Completions Provider 测试组
	// 测试 OpenAI 标准补全 API 的中止功能
	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Completions Provider Abort", () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		void _compat;
		const llm: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
		};

		it("should abort mid-stream", { retry: 3 }, async () => {
			await testAbortSignal(llm);
		});

		it("should handle immediate abort", { retry: 3 }, async () => {
			await testImmediateAbort(llm);
		});
	});

	// OpenAI Responses Provider 测试组
	// 测试 OpenAI Responses API（新 API）的中止功能
	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Responses Provider Abort", () => {
		const llm = getModel("openai", "gpt-5-mini");

		it("should abort mid-stream", { retry: 3 }, async () => {
			await testAbortSignal(llm);
		});

		it("should handle immediate abort", { retry: 3 }, async () => {
			await testImmediateAbort(llm);
		});
	});

	// Azure OpenAI Responses Provider 测试组
	// 测试 Azure 部署的 OpenAI Responses API 的中止功能
	describe.skipIf(!hasAzureOpenAICredentials())("Azure OpenAI Responses Provider Abort", () => {
		const llm = getModel("azure-openai-responses", "gpt-4o-mini");
		const azureDeploymentName = resolveAzureDeploymentName(llm.id);
		const azureOptions = azureDeploymentName ? { azureDeploymentName } : {};

		it("should abort mid-stream", { retry: 3 }, async () => {
			await testAbortSignal(llm, azureOptions);
		});

		it("should handle immediate abort", { retry: 3 }, async () => {
			await testImmediateAbort(llm, azureOptions);
		});
	});

	// Anthropic Provider 测试组
	// 测试 Anthropic Claude 模型的中止功能（带思考模式）
	describe.skipIf(!process.env.ANTHROPIC_OAUTH_TOKEN)("Anthropic Provider Abort", () => {
		const llm = getModel("anthropic", "claude-opus-4-1-20250805");

		it("should abort mid-stream", { retry: 3 }, async () => {
			await testAbortSignal(llm, { thinkingEnabled: true, thinkingBudgetTokens: 2048 });
		});

		it("should handle immediate abort", { retry: 3 }, async () => {
			await testImmediateAbort(llm, { thinkingEnabled: true, thinkingBudgetTokens: 2048 });
		});
	});

	// Mistral Provider 测试组
	// 测试 Mistral 模型的中止功能
	describe.skipIf(!process.env.MISTRAL_API_KEY)("Mistral Provider Abort", () => {
		const llm = getModel("mistral", "devstral-medium-latest");

		it("should abort mid-stream", { retry: 3 }, async () => {
			await testAbortSignal(llm);
		});

		it("should handle immediate abort", { retry: 3 }, async () => {
			await testImmediateAbort(llm);
		});
	});

	// MiniMax Provider 测试组
	// 测试 MiniMax 模型的中止功能
	describe.skipIf(!process.env.MINIMAX_API_KEY)("MiniMax Provider Abort", () => {
		const llm = getModel("minimax", "MiniMax-M2.1");

		it("should abort mid-stream", { retry: 3 }, async () => {
			await testAbortSignal(llm);
		});

		it("should handle immediate abort", { retry: 3 }, async () => {
			await testImmediateAbort(llm);
		});
	});

	// Kimi For Coding Provider 测试组
	// 测试 Kimi 代码模型的中止功能
	describe.skipIf(!process.env.KIMI_API_KEY)("Kimi For Coding Provider Abort", () => {
		const llm = getModel("kimi-coding", "kimi-k2-thinking");

		it("should abort mid-stream", { retry: 3 }, async () => {
			await testAbortSignal(llm);
		});

		it("should handle immediate abort", { retry: 3 }, async () => {
			await testImmediateAbort(llm);
		});
	});

	// Vercel AI Gateway Provider 测试组
	// 测试 Vercel AI Gateway 的中止功能
	describe.skipIf(!process.env.AI_GATEWAY_API_KEY)("Vercel AI Gateway Provider Abort", () => {
		const llm = getModel("vercel-ai-gateway", "google/gemini-2.5-flash");

		it("should abort mid-stream", { retry: 3 }, async () => {
			await testAbortSignal(llm);
		});

		it("should handle immediate abort", { retry: 3 }, async () => {
			await testImmediateAbort(llm);
		});
	});

	// Google Gemini CLI Provider 测试组
	// 使用 OAuth 认证的 Gemini CLI 测试
	// Google Gemini CLI / Antigravity 共享同一个 provider，一个测试覆盖两者
	describe("Google Gemini CLI Provider Abort", () => {
		it.skipIf(!geminiCliToken)("should abort mid-stream", { retry: 3 }, async () => {
			const llm = getModel("google-gemini-cli", "gemini-2.5-flash");
			await testAbortSignal(llm, { apiKey: geminiCliToken });
		});

		it.skipIf(!geminiCliToken)("should handle immediate abort", { retry: 3 }, async () => {
			const llm = getModel("google-gemini-cli", "gemini-2.5-flash");
			await testImmediateAbort(llm, { apiKey: geminiCliToken });
		});
	});

	// OpenAI Codex Provider 测试组
	// 使用 OAuth 认证的 OpenAI Codex 测试
	describe("OpenAI Codex Provider Abort", () => {
		it.skipIf(!openaiCodexToken)("should abort mid-stream", { retry: 3 }, async () => {
			const llm = getModel("openai-codex", "gpt-5.2-codex");
			await testAbortSignal(llm, { apiKey: openaiCodexToken });
		});

		it.skipIf(!openaiCodexToken)("should handle immediate abort", { retry: 3 }, async () => {
			const llm = getModel("openai-codex", "gpt-5.2-codex");
			await testImmediateAbort(llm, { apiKey: openaiCodexToken });
		});
	});

	// Amazon Bedrock Provider 测试组
	// 测试 AWS Bedrock 上部署的模型的中止功能
	describe.skipIf(!hasBedrockCredentials())("Amazon Bedrock Provider Abort", () => {
		const llm = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0");

		it("should abort mid-stream", { retry: 3 }, async () => {
			await testAbortSignal(llm, { reasoning: "medium" });
		});

		it("should handle immediate abort", { retry: 3 }, async () => {
			await testImmediateAbort(llm);
		});

		it("should handle abort then new message", { retry: 3 }, async () => {
			await testAbortThenNewMessage(llm);
		});
	});

	// 自定义 Anthropic API 测试组
	// 使用自定义配置的 Anthropic 兼容 API 进行中止测试
	// 这个测试组不依赖任何标准环境变量，始终运行
	describe("Custom Anthropic API Abort (自定义配置)", () => {
		const customLlm = createCustomAnthropicModel();

		it("should abort mid-stream", { retry: 3 }, async () => {
			await testAbortSignal(customLlm, { apiKey: CUSTOM_API_KEY });
		});

		it("should handle immediate abort", { retry: 3 }, async () => {
			await testImmediateAbort(customLlm, { apiKey: CUSTOM_API_KEY });
		});

		it("should handle abort then new message", { retry: 3 }, async () => {
			await testAbortThenNewMessage(customLlm, { apiKey: CUSTOM_API_KEY });
		});
	});
});
