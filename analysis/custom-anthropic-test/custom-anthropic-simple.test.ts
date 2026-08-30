/**
 * 自定义 Anthropic 兼容 API 测试（简化版）
 *
 * 使用方法：
 * 1. 设置环境变量：
 *    $env:CUSTOM_ANTHROPIC_BASE_URL="https://你的 API 地址"
 *    $env:CUSTOM_ANTHROPIC_API_KEY="你的 API key"
 *
 * 2. 运行测试：
 *    npx vitest --run test/custom-anthropic-simple.test.ts
 */

import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { complete, stream } from "../src/stream.js";
import type { Context, Model, Tool } from "../src/types.js";
import { StringEnum } from "../src/utils/typebox-helpers.js";
import { CUSTOM_API_KEY, CUSTOM_BASE_URL, MODEL_ID } from "./custom-anthropic-config.js";

// ============================================================================
// 工具定义
// ============================================================================

// 计算器工具的 Schema
const calculatorSchema = Type.Object({
	a: Type.Number({ description: "第一个数字" }),
	b: Type.Number({ description: "第二个数字" }),
	operation: StringEnum(["add", "subtract", "multiply", "divide"], {
		description: "要执行的操作：'add'（加）, 'subtract'（减）, 'multiply'（乘）, 'divide'（除）",
	}),
});

const calculatorTool: Tool<typeof calculatorSchema> = {
	name: "math_operation",
	description: "执行基本的算术运算",
	parameters: calculatorSchema,
};

// ============================================================================
// 测试用例
// ============================================================================

describe("自定义 Anthropic API 测试（简化版）", () => {
	it("应该能够生成基础文本", async () => {
		const model: Model<"anthropic-messages"> = {
			id: MODEL_ID,
			name: MODEL_ID, // 添加名称字段
			provider: "anthropic",
			api: "anthropic-messages",
			contextWindow: 200000,
			maxTokens: 4096,
			reasoning: false,
			baseUrl: CUSTOM_BASE_URL,
			input: ["text"], // 添加输入类型字段
			// 添加成本配置（必需！）
			cost: {
				input: 0, // 每百万 token 输入成本（美元）
				output: 0, // 每百万 token 输出成本（美元）
				cacheRead: 0, // 每百万 token 缓存读取成本
				cacheWrite: 0, // 每百万 token 缓存写入成本
			},
		};

		const context: Context = {
			messages: [
				{
					role: "user",
					content: "用一句话回答：你好吗？",
					timestamp: Date.now(),
				},
			],
		};

		const response = await complete(model, context, {
			apiKey: CUSTOM_API_KEY,
		});

		console.log("完整响应:", JSON.stringify(response, null, 2));

		// 首先检查是否有错误
		if (response.errorMessage) {
			console.error("❌ API 返回错误:", response.errorMessage);
			console.error("   stopReason:", response.stopReason);
			console.error("   content:", response.content);

			// 如果是 SDK 内部错误，这可能是 API 格式不兼容导致的
			if (response.errorMessage.includes("Cannot read properties")) {
				console.error("\n⚠  这可能是因为自定义 API 的响应格式与标准 Anthropic API 不完全兼容");
				console.error("   请检查你的 API 是否正确实现了 Anthropic Messages API 规范");
			}

			throw new Error(`API 错误：${response.errorMessage}`);
		}

		expect(response.role).toBe("assistant");

		// 检查响应内容
		expect(response.content).toBeTruthy();
		expect(response.content.length).toBeGreaterThan(0);

		const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");

		console.log("✓ 响应文本:", text);
		expect(text.length).toBeGreaterThan(0);

		// 输出 usage 信息（如果存在）
		if (response.usage) {
			console.log("✓ Token 使用:", {
				input: response.usage.input,
				output: response.usage.output,
				total: response.usage.totalTokens,
			});
		}

		console.log("✓ 测试通过");
	}, 60000);

	it("应该能够处理多轮对话", async () => {
		const model: Model<"anthropic-messages"> = {
			id: MODEL_ID,
			name: MODEL_ID,
			provider: "anthropic",
			api: "anthropic-messages",
			contextWindow: 200000,
			maxTokens: 4096,
			reasoning: false,
			baseUrl: CUSTOM_BASE_URL,
			input: ["text"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
		};

		const context: Context = {
			systemPrompt: "你是一个有帮助的助手。保持简洁。",
			messages: [
				{
					role: "user",
					content: "回复：'Hello test successful'",
					timestamp: Date.now(),
				},
			],
		};

		const response = await complete(model, context, {
			apiKey: CUSTOM_API_KEY,
		});

		expect(response.role).toBe("assistant");
		expect(response.content).toBeTruthy();
		expect(response.usage.input + response.usage.cacheRead).toBeGreaterThan(0);
		expect(response.usage.output).toBeGreaterThan(0);
		expect(response.errorMessage).toBeFalsy();

		const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
		expect(text).toContain("Hello test successful");

		// 第二轮对话
		context.messages.push(response);
		context.messages.push({
			role: "user",
			content: "现在说：'Goodbye test successful'",
			timestamp: Date.now(),
		});

		const secondResponse = await complete(model, context, {
			apiKey: CUSTOM_API_KEY,
		});

		expect(secondResponse.role).toBe("assistant");
		expect(secondResponse.content).toBeTruthy();
		expect(secondResponse.usage.input + secondResponse.usage.cacheRead).toBeGreaterThan(0);
		expect(secondResponse.usage.output).toBeGreaterThan(0);
		expect(secondResponse.errorMessage).toBeFalsy();

		const secondText = secondResponse.content.map((b) => (b.type === "text" ? b.text : "")).join("");
		expect(secondText).toContain("Goodbye test successful");

		console.log("✓ 多轮对话测试通过");
	}, 60000);

	it("应该能够处理工具调用", async () => {
		const model: Model<"anthropic-messages"> = {
			id: MODEL_ID,
			name: MODEL_ID,
			provider: "anthropic",
			api: "anthropic-messages",
			contextWindow: 200000,
			maxTokens: 4096,
			reasoning: false,
			baseUrl: CUSTOM_BASE_URL,
			input: ["text"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
		};

		const context: Context = {
			systemPrompt: "你是一个有帮助的助手，在需要时使用工具。",
			messages: [
				{
					role: "user",
					content: "使用 math_operation 工具计算 15 + 27。",
					timestamp: Date.now(),
				},
			],
			tools: [calculatorTool],
		};

		const s = stream(model, context, {
			apiKey: CUSTOM_API_KEY,
		});

		let hasToolStart = false;
		let hasToolDelta = false;
		let hasToolEnd = false;
		let accumulatedToolArgs = "";
		let index = 0;

		for await (const event of s) {
			if (event.type === "toolcall_start") {
				hasToolStart = true;
				const toolCall = event.partial.content[event.contentIndex];
				index = event.contentIndex;
				expect(toolCall.type).toBe("toolCall");
				if (toolCall.type === "toolCall") {
					expect(toolCall.name).toBe("math_operation");
					expect(toolCall.id).toBeTruthy();
				}
			}
			if (event.type === "toolcall_delta") {
				hasToolDelta = true;
				const toolCall = event.partial.content[event.contentIndex];
				expect(event.contentIndex).toBe(index);
				expect(toolCall.type).toBe("toolCall");
				if (toolCall.type === "toolCall") {
					expect(toolCall.name).toBe("math_operation");
					accumulatedToolArgs += event.delta;
					expect(toolCall.arguments).toBeDefined();
					expect(typeof toolCall.arguments).toBe("object");
				}
			}
			if (event.type === "toolcall_end") {
				hasToolEnd = true;
				const toolCall = event.partial.content[event.contentIndex];
				expect(event.contentIndex).toBe(index);
				expect(toolCall.type).toBe("toolCall");
				if (toolCall.type === "toolCall") {
					expect(toolCall.name).toBe("math_operation");
					JSON.parse(accumulatedToolArgs);
					expect(toolCall.arguments).not.toBeUndefined();
					expect((toolCall.arguments as any).a).toBe(15);
					expect((toolCall.arguments as any).b).toBe(27);
					expect((toolCall.arguments as any).operation).oneOf(["add", "subtract", "multiply", "divide"]);
				}
			}
		}

		expect(hasToolStart).toBe(true);
		expect(hasToolDelta).toBe(true);
		expect(hasToolEnd).toBe(true);

		const response = await s.result();
		expect(response.stopReason).toBe("toolUse");
		expect(response.content.some((b) => b.type === "toolCall")).toBeTruthy();

		const toolCall = response.content.find((b) => b.type === "toolCall");
		if (toolCall && toolCall.type === "toolCall") {
			expect(toolCall.name).toBe("math_operation");
			expect(toolCall.id).toBeTruthy();
		} else {
			throw new Error("响应中没有找到工具调用");
		}

		console.log("✓ 工具调用测试通过");
	}, 60000);

	it("应该能够处理流式输出", async () => {
		const model: Model<"anthropic-messages"> = {
			id: MODEL_ID,
			name: MODEL_ID,
			provider: "anthropic",
			api: "anthropic-messages",
			contextWindow: 200000,
			maxTokens: 4096,
			reasoning: false,
			baseUrl: CUSTOM_BASE_URL,
			input: ["text"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
		};

		const context: Context = {
			messages: [
				{
					role: "user",
					content: "从 1 数到 3",
					timestamp: Date.now(),
				},
			],
			systemPrompt: "你是一个有帮助的助手。",
		};

		const s = stream(model, context, {
			apiKey: CUSTOM_API_KEY,
		});

		let textStarted = false;
		let textChunks = "";
		let textCompleted = false;

		for await (const event of s) {
			if (event.type === "text_start") {
				textStarted = true;
			} else if (event.type === "text_delta") {
				textChunks += event.delta;
			} else if (event.type === "text_end") {
				textCompleted = true;
			}
		}

		const response = await s.result();

		expect(textStarted).toBe(true);
		expect(textChunks.length).toBeGreaterThan(0);
		expect(textCompleted).toBe(true);
		expect(response.content.some((b) => b.type === "text")).toBeTruthy();

		console.log("✓ 流式输出测试通过");
		console.log("  文本内容:", textChunks);
	}, 60000);
});
