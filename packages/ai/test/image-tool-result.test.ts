/**
 * 工具结果图像测试文件
 *
 * 此测试文件用于验证跨多个 LLM Provider 的工具结果图像功能。
 *
 * 测试内容包括：
 * 1. 工具结果只包含图像（无文本）
 * 2. 工具结果同时包含文本和图像
 *
 * 验证目标：
 * - 工具结果可以包含图像内容块
 * - Provider 能够正确地将图像从工具结果传递给 LLM
 * - LLM 能够看到并描述工具返回的图像
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import type { Api, Context, Model, Tool, ToolResultMessage } from "../src/index.js";
import { complete, getModel } from "../src/index.js";
import type { StreamOptions } from "../src/types.js";

/**
 * 扩展的流式选项类型
 * 支持添加额外的自定义参数
 */
type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

import { hasAzureOpenAICredentials, resolveAzureDeploymentName } from "./azure-utils.js";
import { hasBedrockCredentials } from "./bedrock-utils.js";
import { CUSTOM_API_KEY, CUSTOM_BASE_URL, MODEL_ID } from "./custom-anthropic-config.js";
import { resolveApiKey } from "./oauth.js";

/**
 * 在模块级别解析 OAuth 令牌（异步，在测试前运行）
 *
 * 解析以下 Provider 的认证令牌：
 * - Anthropic OAuth
 * - GitHub Copilot
 * - Google Gemini CLI
 * - Google Antigravity
 * - OpenAI Codex
 */
const oauthTokens = await Promise.all([
	resolveApiKey("anthropic"),
	resolveApiKey("github-copilot"),
	resolveApiKey("google-gemini-cli"),
	resolveApiKey("google-antigravity"),
	resolveApiKey("openai-codex"),
]);
const [anthropicOAuthToken, githubCopilotToken, geminiCliToken, antigravityToken, openaiCodexToken] = oauthTokens;

/**
 * 测试工具结果只包含图像的功能（跨所有 Provider）
 *
 * 此函数验证：
 * 1. 工具结果可以包含图像内容块
 * 2. Provider 能够正确地将图像从工具结果传递给 LLM
 * 3. LLM 能够看到并描述工具返回的图像
 *
 * 测试流程：
 * 1. 检查模型是否支持图像输入
 * 2. 读取测试图像文件（红色圆形）
 * 3. 定义一个只返回图像的工具
 * 4. 第一次请求：LLM 调用工具
 * 5. 第二次请求：LLM 描述工具返回的图像
 *
 * @param model - 要测试的模型
 * @param options - 可选的流式配置（如 API Key、Azure 部署名称等）
 */
async function handleToolWithImageResult<TApi extends Api>(model: Model<TApi>, options?: StreamOptionsWithExtras) {
	// 检查模型是否支持图像
	if (!model.input.includes("image")) {
		console.log(`Skipping tool image result test - model ${model.id} doesn't support images`);
		return;
	}

	// 读取测试图像（红色圆形 PNG）
	const imagePath = join(__dirname, "data", "red-circle.png");
	const imageBuffer = readFileSync(imagePath);
	const base64Image = imageBuffer.toString("base64");

	// 定义一个只返回图像（无文本）的工具
	const getImageSchema = Type.Object({});
	const getImageTool: Tool<typeof getImageSchema> = {
		name: "get_circle",
		description: "Returns a circle image for visualization",
		parameters: getImageSchema,
	};

	// 构建对话上下文
	const context: Context = {
		systemPrompt: "You are a helpful assistant that uses tools when asked.",
		messages: [
			{
				role: "user",
				content: "Call the get_circle tool to get an image, and describe what you see, shapes, colors, etc.",
				timestamp: Date.now(),
			},
		],
		tools: [getImageTool],
	};

	// 第一次请求：LLM 应该调用工具
	const firstResponse = await complete(model, context, options);
	expect(firstResponse.stopReason).toBe("toolUse");

	// 查找工具调用
	const toolCall = firstResponse.content.find((b) => b.type === "toolCall");
	expect(toolCall).toBeTruthy();
	if (!toolCall || toolCall.type !== "toolCall") {
		throw new Error("Expected tool call");
	}
	expect(toolCall.name).toBe("get_circle");

	// 将工具调用添加到上下文
	context.messages.push(firstResponse);

	// 创建只包含图像（无文本）的工具结果
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [
			{
				type: "image",
				data: base64Image,
				mimeType: "image/png",
			},
		],
		isError: false,
		timestamp: Date.now(),
	};

	context.messages.push(toolResult);

	// 第二次请求：LLM 应该描述工具结果中的图像
	const secondResponse = await complete(model, context, options);
	expect(secondResponse.stopReason).toBe("stop");
	expect(secondResponse.errorMessage).toBeFalsy();

	// 验证 LLM 能够看到并描述图像
	const textContent = secondResponse.content.find((b) => b.type === "text");
	expect(textContent).toBeTruthy();
	if (textContent && textContent.type === "text") {
		const lowerContent = textContent.text.toLowerCase();
		// 应该提到 "red"（红色）和 "circle"（圆形），因为这就是图像显示的内容
		expect(lowerContent).toContain("red");
		expect(lowerContent).toContain("circle");
	}
}

/**
 * 测试工具结果同时包含文本和图像的功能（跨所有 Provider）
 *
 * 此函数验证：
 * 1. 工具结果可以包含混合内容块（文本 + 图像）
 * 2. Provider 能够正确地将文本和图像从工具结果传递给 LLM
 * 3. LLM 能够看到工具结果中的文本和图像
 *
 * 测试流程：
 * 1. 检查模型是否支持图像输入
 * 2. 读取测试图像文件（红色圆形）
 * 3. 定义一个返回文本和图像的工具
 * 4. 第一次请求：LLM 调用工具
 * 5. 第二次请求：LLM 描述工具返回的文本和图像
 *
 * @param model - 要测试的模型
 * @param options - 可选的流式配置（如 API Key、Azure 部署名称等）
 */
async function handleToolWithTextAndImageResult<TApi extends Api>(
	model: Model<TApi>,
	options?: StreamOptionsWithExtras,
) {
	// 检查模型是否支持图像
	if (!model.input.includes("image")) {
		console.log(`Skipping tool text+image result test - model ${model.id} doesn't support images`);
		return;
	}

	// 读取测试图像（红色圆形 PNG）
	const imagePath = join(__dirname, "data", "red-circle.png");
	const imageBuffer = readFileSync(imagePath);
	const base64Image = imageBuffer.toString("base64");

	// 定义一个同时返回文本和图像的工具
	const getImageSchema = Type.Object({});
	const getImageTool: Tool<typeof getImageSchema> = {
		name: "get_circle_with_description",
		description: "Returns a circle image with a text description",
		parameters: getImageSchema,
	};

	// 构建对话上下文
	const context: Context = {
		systemPrompt: "You are a helpful assistant that uses tools when asked.",
		messages: [
			{
				role: "user",
				content:
					"Use the get_circle_with_description tool and tell me what you learned. Also say what color the shape is.",
				timestamp: Date.now(),
			},
		],
		tools: [getImageTool],
	};

	// 第一次请求：LLM 应该调用工具
	const firstResponse = await complete(model, context, options);
	expect(firstResponse.stopReason).toBe("toolUse");

	// 查找工具调用
	const toolCall = firstResponse.content.find((b) => b.type === "toolCall");
	expect(toolCall).toBeTruthy();
	if (!toolCall || toolCall.type !== "toolCall") {
		throw new Error("Expected tool call");
	}
	expect(toolCall.name).toBe("get_circle_with_description");

	// 将工具调用添加到上下文
	context.messages.push(firstResponse);

	// 创建同时包含文本和图像的工具结果
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [
			{
				type: "text",
				text: "This is a geometric shape with specific properties: it has a diameter of 100 pixels.",
			},
			{
				type: "image",
				data: base64Image,
				mimeType: "image/png",
			},
		],
		isError: false,
		timestamp: Date.now(),
	};

	context.messages.push(toolResult);

	// 第二次请求：LLM 应该描述工具结果中的文本和图像
	const secondResponse = await complete(model, context, options);
	expect(secondResponse.stopReason).toBe("stop");
	expect(secondResponse.errorMessage).toBeFalsy();

	// 验证 LLM 能够看到文本和图像
	const textContent = secondResponse.content.find((b) => b.type === "text");
	expect(textContent).toBeTruthy();
	if (textContent && textContent.type === "text") {
		const lowerContent = textContent.text.toLowerCase();
		// 应该提到文本中的细节（diameter/100/pixel）
		expect(lowerContent.match(/diameter|100|pixel/)).toBeTruthy();
		// 也应该提到视觉属性（red 和 circle）
		expect(lowerContent).toContain("red");
		expect(lowerContent).toContain("circle");
	}
}

/**
 * 工具结果图像测试套件
 *
 * 包含多个 Provider 的测试，验证工具结果中的图像功能
 */
describe("Tool Results with Images", () => {
	/**
	 * Google Provider 测试（gemini-2.5-flash）
	 *
	 * 测试 Google Gemini 2.5 Flash 模型的工具结果图像功能
	 * 需要 GEMINI_API_KEY 环境变量
	 */
	describe.skipIf(!process.env.GEMINI_API_KEY)("Google Provider (gemini-2.5-flash)", () => {
		const llm = getModel("google", "gemini-2.5-flash");

		// 测试只包含图像的工具结果
		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm);
		});

		// 测试同时包含文本和图像的工具结果
		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm);
		});
	});

	/**
	 * OpenAI Completions Provider 测试（gpt-4o-mini）
	 *
	 * 测试 OpenAI Completions API 的工具结果图像功能
	 * 需要 OPENAI_API_KEY 环境变量
	 */
	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Completions Provider (gpt-4o-mini)", () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
		void _compat;
		const llm: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
		};

		// 测试只包含图像的工具结果
		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm);
		});

		// 测试同时包含文本和图像的工具结果
		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm);
		});
	});

	/**
	 * OpenAI Responses Provider 测试（gpt-5-mini）
	 *
	 * 测试 OpenAI Responses API 的工具结果图像功能
	 * 需要 OPENAI_API_KEY 环境变量
	 */
	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Responses Provider (gpt-5-mini)", () => {
		const llm = getModel("openai", "gpt-5-mini");

		// 测试只包含图像的工具结果
		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm);
		});

		// 测试同时包含文本和图像的工具结果
		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm);
		});
	});

	/**
	 * Azure OpenAI Responses Provider 测试（gpt-4o-mini）
	 *
	 * 测试 Azure OpenAI Responses API 的工具结果图像功能
	 * 需要 Azure 凭证（AZURE_OPENAI_API_KEY 等）
	 */
	describe.skipIf(!hasAzureOpenAICredentials())("Azure OpenAI Responses Provider (gpt-4o-mini)", () => {
		const llm = getModel("azure-openai-responses", "gpt-4o-mini");
		const azureDeploymentName = resolveAzureDeploymentName(llm.id);
		const azureOptions = azureDeploymentName ? { azureDeploymentName } : {};

		// 测试只包含图像的工具结果
		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm, azureOptions);
		});

		// 测试同时包含文本和图像的工具结果
		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm, azureOptions);
		});
	});

	/**
	 * Anthropic Provider 测试（claude-haiku-4-5）
	 *
	 * 测试 Anthropic Claude Haiku 4.5 模型的工具结果图像功能
	 * 需要 ANTHROPIC_API_KEY 环境变量
	 */
	describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic Provider (claude-haiku-4-5)", () => {
		const model = getModel("anthropic", "claude-haiku-4-5");

		// 测试只包含图像的工具结果
		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(model);
		});

		// 测试同时包含文本和图像的工具结果
		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(model);
		});
	});

	/**
	 * OpenRouter Provider 测试（glm-4.5v）
	 *
	 * 测试 OpenRouter 上的 glm-4.5v 模型的工具结果图像功能
	 * 需要 OPENROUTER_API_KEY 环境变量
	 */
	describe.skipIf(!process.env.OPENROUTER_API_KEY)("OpenRouter Provider (glm-4.5v)", () => {
		const llm = getModel("openrouter", "z-ai/glm-4.5v");

		// 测试只包含图像的工具结果
		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm);
		});

		// 测试同时包含文本和图像的工具结果
		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm);
		});
	});

	/**
	 * Mistral Provider 测试（pixtral-12b）
	 *
	 * 测试 Mistral Pixtral 12B 模型的工具结果图像功能
	 * 需要 MISTRAL_API_KEY 环境变量
	 */
	describe.skipIf(!process.env.MISTRAL_API_KEY)("Mistral Provider (pixtral-12b)", () => {
		const llm = getModel("mistral", "pixtral-12b");

		// 测试只包含图像的工具结果（重试 5 次，因为 Mistral 有时不稳定）
		it("should handle tool result with only image", { retry: 5, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm);
		});

		// 测试同时包含文本和图像的工具结果（重试 5 次）
		it("should handle tool result with text and image", { retry: 5, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm);
		});
	});

	/**
	 * Kimi For Coding Provider 测试（k2p5）
	 *
	 * 测试 Kimi For Coding k2p5 模型的工具结果图像功能
	 * 需要 KIMI_API_KEY 环境变量
	 */
	describe.skipIf(!process.env.KIMI_API_KEY)("Kimi For Coding Provider (k2p5)", () => {
		const llm = getModel("kimi-coding", "k2p5");

		// 测试只包含图像的工具结果
		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm);
		});

		// 测试同时包含文本和图像的工具结果
		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm);
		});
	});

	/**
	 * Vercel AI Gateway Provider 测试（google/gemini-2.5-flash）
	 *
	 * 测试通过 Vercel AI Gateway 访问的 Gemini 2.5 Flash 模型
	 * 需要 AI_GATEWAY_API_KEY 环境变量
	 */
	describe.skipIf(!process.env.AI_GATEWAY_API_KEY)("Vercel AI Gateway Provider (google/gemini-2.5-flash)", () => {
		const llm = getModel("vercel-ai-gateway", "google/gemini-2.5-flash");

		// 测试只包含图像的工具结果
		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm);
		});

		// 测试同时包含文本和图像的工具结果
		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm);
		});
	});

	/**
	 * Amazon Bedrock Provider 测试（claude-sonnet-4-5）
	 *
	 * 测试通过 Amazon Bedrock 访问的 Claude Sonnet 4.5 模型
	 * 需要 AWS Bedrock 凭证
	 */
	describe.skipIf(!hasBedrockCredentials())("Amazon Bedrock Provider (claude-sonnet-4-5)", () => {
		const llm = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0");

		// 测试只包含图像的工具结果
		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm);
		});

		// 测试同时包含文本和图像的工具结果
		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm);
		});
	});

	// =========================================================================
	// Custom Anthropic API (自定义配置)
	// 使用自定义 API 端点测试（如阿里云、z.ai 等）
	// =========================================================================

	/**
	 * 自定义 Anthropic API Provider 测试
	 *
	 * 使用自定义配置的 Anthropic API 端点进行测试
	 * 适用于非官方 Anthropic API 的兼容实现
	 *
	 * 环境变量：
	 * - CUSTOM_ANTHROPIC_BASE_URL: 自定义 API 基础 URL
	 * - CUSTOM_ANTHROPIC_API_KEY: 自定义 API 密钥
	 * - CUSTOM_ANTHROPIC_MODEL: 自定义模型 ID
	 */
	describe("Custom Anthropic API (自定义配置)", () => {
		/**
		 * 创建自定义 Anthropic 模型配置
		 *
		 * 使用自定义 API 端点和模型 ID 构建模型对象
		 *
		 * @returns 自定义 Anthropic 模型配置
		 */
		function createCustomAnthropicModel(): Model<"anthropic-messages"> {
			return {
				id: MODEL_ID,
				name: MODEL_ID,
				provider: "anthropic" as const,
				api: "anthropic-messages" as const,
				contextWindow: 200000, // 默认 200k，可根据实际模型调整
				maxTokens: 4096,
				reasoning: false,
				input: ["text", "image"] as const, // 确保支持图像输入
				baseUrl: CUSTOM_BASE_URL,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
				},
			};
		}

		const llm = createCustomAnthropicModel();

		/**
		 * 测试自定义 Anthropic 模型的只包含图像的工具结果
		 *
		 * 注意：
		 * - 某些自定义 API 可能不完全支持工具调用
		 * - 某些自定义 API 可能不支持图像输入
		 * - 如果测试失败，请检查 API 端点是否支持这些功能
		 */
		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			try {
				await handleToolWithImageResult(llm, { apiKey: CUSTOM_API_KEY });
			} catch (error) {
				console.log("  Note: Custom Anthropic API may not support tool calls with images");
				console.log("  Error:", error);
				// 如果 API 不支持，不强制失败
				throw error;
			}
		});

		/**
		 * 测试自定义 Anthropic 模型的同时包含文本和图像的工具结果
		 */
		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			try {
				await handleToolWithTextAndImageResult(llm, { apiKey: CUSTOM_API_KEY });
			} catch (error) {
				console.log("  Note: Custom Anthropic API may not support tool calls with images");
				console.log("  Error:", error);
				// 如果 API 不支持，不强制失败
				throw error;
			}
		});
	});

	// =========================================================================
	// OAuth 认证的 Provider（凭证来自 ~/.pi/agent/oauth.json）
	// =========================================================================

	/**
	 * Anthropic OAuth Provider 测试（claude-sonnet-4-5）
	 *
	 * 使用 OAuth 令牌测试 Anthropic Claude Sonnet 4.5 模型
	 */
	describe("Anthropic OAuth Provider (claude-sonnet-4-5)", () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");

		// 测试只包含图像的工具结果
		it.skipIf(!anthropicOAuthToken)(
			"should handle tool result with only image",
			{ retry: 3, timeout: 30000 },
			async () => {
				await handleToolWithImageResult(model, { apiKey: anthropicOAuthToken });
			},
		);

		// 测试同时包含文本和图像的工具结果
		it.skipIf(!anthropicOAuthToken)(
			"should handle tool result with text and image",
			{ retry: 3, timeout: 30000 },
			async () => {
				await handleToolWithTextAndImageResult(model, { apiKey: anthropicOAuthToken });
			},
		);
	});

	/**
	 * GitHub Copilot Provider 测试
	 *
	 * 测试通过 GitHub Copilot 访问的模型（GPT-4o 和 Claude Sonnet 4）
	 */
	describe("GitHub Copilot Provider", () => {
		// 测试 GPT-4o 的只包含图像的工具结果
		it.skipIf(!githubCopilotToken)(
			"gpt-4o - should handle tool result with only image",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "gpt-4o");
				await handleToolWithImageResult(llm, { apiKey: githubCopilotToken });
			},
		);

		// 测试 GPT-4o 的同时包含文本和图像的工具结果
		it.skipIf(!githubCopilotToken)(
			"gpt-4o - should handle tool result with text and image",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "gpt-4o");
				await handleToolWithTextAndImageResult(llm, { apiKey: githubCopilotToken });
			},
		);

		// 测试 Claude Sonnet 4 的只包含图像的工具结果
		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should handle tool result with only image",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-sonnet-4");
				await handleToolWithImageResult(llm, { apiKey: githubCopilotToken });
			},
		);

		// 测试 Claude Sonnet 4 的同时包含文本和图像的工具结果
		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should handle tool result with text and image",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-sonnet-4");
				await handleToolWithTextAndImageResult(llm, { apiKey: githubCopilotToken });
			},
		);
	});

	/**
	 * Google Gemini CLI Provider 测试
	 *
	 * 测试通过 OAuth 认证的 Gemini CLI 接口
	 */
	describe("Google Gemini CLI Provider", () => {
		// 测试只包含图像的工具结果
		it.skipIf(!geminiCliToken)(
			"gemini-2.5-flash - should handle tool result with only image",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("google-gemini-cli", "gemini-2.5-flash");
				await handleToolWithImageResult(llm, { apiKey: geminiCliToken });
			},
		);

		// 测试同时包含文本和图像的工具结果
		it.skipIf(!geminiCliToken)(
			"gemini-2.5-flash - should handle tool result with text and image",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("google-gemini-cli", "gemini-2.5-flash");
				await handleToolWithTextAndImageResult(llm, { apiKey: geminiCliToken });
			},
		);
	});

	/**
	 * Google Antigravity Provider 测试
	 *
	 * 测试通过 Antigravity 访问的模型（Gemini 和 Anthropic）
	 */
	describe("Google Antigravity Provider", () => {
		// 测试 Gemini 3 Flash 的只包含图像的工具结果
		it.skipIf(!antigravityToken)(
			"gemini-3-flash - should handle tool result with only image",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("google-antigravity", "gemini-3-flash");
				await handleToolWithImageResult(llm, { apiKey: antigravityToken });
			},
		);

		// 测试 Gemini 3 Flash 的同时包含文本和图像的工具结果
		it.skipIf(!antigravityToken)(
			"gemini-3-flash - should handle tool result with text and image",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("google-antigravity", "gemini-3-flash");
				await handleToolWithTextAndImageResult(llm, { apiKey: antigravityToken });
			},
		);

		/** 这两个测试不能正常工作，模型根本不会调用工具，但在 pi 中可以工作
		it.skipIf(!antigravityToken)(
			"claude-sonnet-4-5 - should handle tool result with only image",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("google-antigravity", "claude-sonnet-4-5");
				await handleToolWithImageResult(llm, { apiKey: antigravityToken });
			},
		);

		it.skipIf(!antigravityToken)(
			"claude-sonnet-4-5 - should handle tool result with text and image",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("google-antigravity", "claude-sonnet-4-5");
				await handleToolWithTextAndImageResult(llm, { apiKey: antigravityToken });
			},
		);**/

		// 注意：gpt-oss-120b-medium 不支持图像，因此这里不测试
	});

	/**
	 * OpenAI Codex Provider 测试
	 *
	 * 测试通过 OAuth 认证的 OpenAI Codex 接口（ChatGPT Plus/Pro 订阅）
	 */
	describe("OpenAI Codex Provider", () => {
		// 测试 GPT 5.2 Codex 的只包含图像的工具结果
		it.skipIf(!openaiCodexToken)(
			"gpt-5.2-codex - should handle tool result with only image",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("openai-codex", "gpt-5.2-codex");
				await handleToolWithImageResult(llm, { apiKey: openaiCodexToken });
			},
		);

		// 测试 GPT 5.2 Codex 的同时包含文本和图像的工具结果
		it.skipIf(!openaiCodexToken)(
			"gpt-5.2-codex - should handle tool result with text and image",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("openai-codex", "gpt-5.2-codex");
				await handleToolWithTextAndImageResult(llm, { apiKey: openaiCodexToken });
			},
		);
	});
});
