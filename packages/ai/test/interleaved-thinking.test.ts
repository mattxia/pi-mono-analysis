/**
 * 交错思考（Interleaved Thinking）测试文件
 *
 * 此测试文件用于验证 LLM 的交错思考功能。
 *
 * 交错思考（Interleaved Thinking）是指 LLM 在进行工具调用之前
 * 或之后进行推理的能力，而不仅仅是在第一次交互时思考。
 *
 * 测试内容：
 * - 验证 LLM 在每次工具调用之前都会进行思考
 * - 验证 LLM 在收到工具结果后会再次思考
 * - 使用计算器工具进行算术运算测试
 */

import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { getEnvApiKey } from "../src/env-api-keys.js";
import { getModel } from "../src/models.js";
import { completeSimple } from "../src/stream.js";
import type {
	Api,
	Context,
	Model,
	StopReason,
	StreamOptions,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../src/types.js";
import { StringEnum } from "../src/utils/typebox-helpers.js";
import { hasBedrockCredentials } from "./bedrock-utils.js";
import { CUSTOM_API_KEY, CUSTOM_BASE_URL, MODEL_ID } from "./custom-anthropic-config.js";

/**
 * 扩展的流式选项类型
 * 支持添加额外的自定义参数
 */
type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

/**
 * 计算器工具的参数模式定义
 *
 * 使用 TypeBox 定义工具的参数结构，包括：
 * - a: 第一个数字
 * - b: 第二个数字
 * - operation: 运算符（add/subtract/multiply/divide）
 */
const calculatorSchema = Type.Object({
	a: Type.Number({ description: "First number" }),
	b: Type.Number({ description: "Second number" }),
	operation: StringEnum(["add", "subtract", "multiply", "divide"], {
		description: "The operation to perform.",
	}),
});

/**
 * 计算器工具定义
 *
 * 提供基本的算术运算功能，用于测试 LLM 的工具调用和交错思考能力
 */
const calculatorTool: Tool<typeof calculatorSchema> = {
	name: "calculator",
	description: "Perform basic arithmetic operations",
	parameters: calculatorSchema,
};

/**
 * 计算器运算符类型
 *
 * 定义支持的四种算术运算
 */
type CalculatorOperation = "add" | "subtract" | "multiply" | "divide";

/**
 * 计算器参数类型
 *
 * 定义计算器工具调用所需的参数结构
 */
type CalculatorArguments = {
	a: number;
	b: number;
	operation: CalculatorOperation;
};

/**
 * 将通用的工具调用参数转换为计算器专用参数
 *
 * 对工具调用参数进行类型检查和转换，确保参数符合计算器的要求
 *
 * @param args - 通用的工具调用参数
 * @returns 类型安全的计算器参数
 * @throws 如果参数无效则抛出错误
 */
function asCalculatorArguments(args: ToolCall["arguments"]): CalculatorArguments {
	// 检查参数是否为对象
	if (typeof args !== "object" || args === null) {
		throw new Error("Tool arguments must be an object");
	}

	const value = args as Record<string, unknown>;
	const operation = value.operation;

	// 验证所有参数的类型和取值
	if (
		typeof value.a !== "number" ||
		typeof value.b !== "number" ||
		(operation !== "add" && operation !== "subtract" && operation !== "multiply" && operation !== "divide")
	) {
		throw new Error("Invalid calculator arguments");
	}

	return { a: value.a, b: value.b, operation };
}

/**
 * 执行计算器工具调用并返回结果
 *
 * 根据运算符和操作数计算算术结果
 *
 * @param toolCall - 计算器工具调用对象
 * @returns 算术运算结果
 */
function evaluateCalculatorCall(toolCall: ToolCall): number {
	const { a, b, operation } = asCalculatorArguments(toolCall.arguments);

	// 根据运算符执行相应的计算
	switch (operation) {
		case "add":
			return a + b;
		case "subtract":
			return a - b;
		case "multiply":
			return a * b;
		case "divide":
			return a / b;
	}
}

/**
 * 断言第二次工具调用时存在交错思考
 *
 * 这是核心测试函数，验证 LLM 在多轮对话中都能进行思考：
 * 1. 第一次请求：LLM 应该思考并调用计算器工具
 * 2. 第二次请求：LLM 收到工具结果后应该再次思考并给出答案
 *
 * 测试验证点：
 * - 第一次响应包含 thinking 块和 toolCall 块
 * - 第二次响应包含 thinking 块和 text 块
 *
 * @param llm - 要测试的 LLM 模型
 * @param reasoning - 思考级别（"high" 或 "xhigh"
 * @param options - 可选的流式配置（如 apiKey）
 */
async function assertSecondToolCallWithInterleavedThinking<TApi extends Api>(
	llm: Model<TApi>,
	reasoning: "high" | "xhigh",
	options?: StreamOptionsWithExtras,
) {
	// 构建对话上下文
	const context: Context = {
		systemPrompt: [
			"You are a helpful assistant that must use tools for arithmetic.",
			"Always think before every tool call, not just the first one.",
			"Do not answer with plain text when a tool call is required.",
		].join(" "),
		messages: [
			{
				role: "user",
				content: [
					"Use calculator to calculate 328 * 29.",
					"You must call the calculator tool exactly once.",
					"Provide the final answer based on the best guess given the tool result, even if it seems unreliable.",
					"Start by thinking about the steps you will take to solve the problem.",
				].join(" "),
				timestamp: Date.now(),
			},
		],
		tools: [calculatorTool],
	};

	// 第一次请求：LLM 应该调用工具
	const firstResponse = await completeSimple(llm, context, { reasoning, ...options });

	// 验证第一次响应：应该以 toolUse 停止，并且包含 thinking 和 toolCall
	expect(firstResponse.stopReason, `Error: ${firstResponse.errorMessage}`).toBe("toolUse" satisfies StopReason);
	expect(firstResponse.content.some((block) => block.type === "thinking")).toBe(true);
	expect(firstResponse.content.some((block) => block.type === "toolCall")).toBe(true);

	// 查找工具调用
	const firstToolCall = firstResponse.content.find((block) => block.type === "toolCall");
	expect(firstToolCall?.type).toBe("toolCall");
	if (!firstToolCall || firstToolCall.type !== "toolCall") {
		throw new Error("Expected first response to include a tool call");
	}

	// 将工具调用添加到上下文中
	context.messages.push(firstResponse);

	// 计算正确答案，然后创建一个故意模糊的工具结果
	// 这样可以测试 LLM 在收到工具结果后是否会再次思考
	const correctAnswer = evaluateCalculatorCall(firstToolCall);
	const firstToolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: firstToolCall.id,
		toolName: firstToolCall.name,
		content: [{ type: "text", text: `The answer is ${correctAnswer} or ${correctAnswer * 2}.` }],
		isError: false,
		timestamp: Date.now(),
	};
	context.messages.push(firstToolResult);

	// 第二次请求：LLM 收到工具结果后应该思考并给出答案
	const secondResponse = await completeSimple(llm, context, { reasoning, ...options });

	// 验证第二次响应：应该以 stop 停止，并且包含 thinking 和 text
	expect(secondResponse.stopReason, `Error: ${secondResponse.errorMessage}`).toBe("stop" satisfies StopReason);
	expect(secondResponse.content.some((block) => block.type === "thinking")).toBe(true);
	expect(secondResponse.content.some((block) => block.type === "text")).toBe(true);
}

/**
 * 检查是否有 Anthropic 凭证
 */
const hasAnthropicCredentials = !!getEnvApiKey("anthropic");

/**
 * Amazon Bedrock 交错思考测试组
 *
 * 测试通过 Amazon Bedrock 访问的 Claude Opus 模型
 */
describe.skipIf(!hasBedrockCredentials())("Amazon Bedrock interleaved thinking", () => {
	/**
	 * 测试 Claude Opus 4.5 的交错思考功能
	 */
	it("should do interleaved thinking on Claude Opus 4.5", { retry: 3 }, async () => {
		const llm = getModel("amazon-bedrock", "global.anthropic.claude-opus-4-5-20251101-v1:0");
		await assertSecondToolCallWithInterleavedThinking(llm, "high");
	});

	/**
	 * 测试 Claude Opus 4.6 的交错思考功能
	 */
	it("should do interleaved thinking on Claude Opus 4.6", { retry: 3 }, async () => {
		const llm = getModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1");
		await assertSecondToolCallWithInterleavedThinking(llm, "high");
	});
});

/**
 * Anthropic 交错思考测试组
 *
 * 测试通过官方 Anthropic API 访问的 Claude Opus 模型
 */
describe.skipIf(!hasAnthropicCredentials)("Anthropic interleaved thinking", () => {
	/**
	 * 测试 Claude Opus 4.5 的交错思考功能
	 */
	it("should do interleaved thinking on Claude Opus 4.5", { retry: 3 }, async () => {
		const llm = getModel("anthropic", "claude-opus-4-5");
		await assertSecondToolCallWithInterleavedThinking(llm, "high");
	});

	/**
	 * 测试 Claude Opus 4.6 的交错思考功能
	 */
	it("should do interleaved thinking on Claude Opus 4.6", { retry: 3 }, async () => {
		const llm = getModel("anthropic", "claude-opus-4-6");
		await assertSecondToolCallWithInterleavedThinking(llm, "high");
	});
});

/**
 * 自定义 Anthropic API 交错思考测试组
 *
 * 使用自定义配置的 Anthropic API 端点进行测试
 * 适用于非官方 Anthropic API 的兼容实现
 *
 * 环境变量：
 * - CUSTOM_ANTHROPIC_BASE_URL: 自定义 API 基础 URL
 * - CUSTOM_ANTHROPIC_API_KEY: 自定义 API 密钥
 * - CUSTOM_ANTHROPIC_MODEL: 自定义模型 ID
 */
describe("Custom Anthropic API interleaved thinking (自定义配置)", () => {
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
			contextWindow: 200000,
			maxTokens: 4096,
			reasoning: true,
			input: ["text"] as const,
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
	 * 测试自定义 Anthropic 模型的交错思考功能
	 *
	 * 注意：
	 * - 某些自定义 API 可能不完全支持交错思考
	 * - 某些自定义 API 可能不支持工具调用
	 * - 如果测试失败，请检查 API 端点是否支持这些功能
	 */
	it("should do interleaved thinking", { retry: 3 }, async () => {
		try {
			await assertSecondToolCallWithInterleavedThinking(llm, "high", { apiKey: CUSTOM_API_KEY });
		} catch (error) {
			console.log("  Note: Custom Anthropic API may not support interleaved thinking or tool calls");
			console.log("  Error:", error);
			throw error;
		}
	});
});
