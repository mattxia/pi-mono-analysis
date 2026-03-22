/**
 * Anthropic API Provider
 *
 * 实现与 Anthropic Claude API 的流式交互，支持以下功能：
 * - 文本生成与流式输出
 * - 图像输入（多模态）
 * - 工具调用（Tool Use）
 * - 扩展思考（Thinking/Reasoning）
 * - 缓存控制（Cache Control）
 * - GitHub Copilot 集成
 * - OAuth 认证（Claude Code）
 *
 * 支持的模型：
 * - Claude 3.x 系列（Haiku, Sonnet, Opus）
 * - Claude 4.x 系列（支持自适应思考）
 *
 * 认证方式：
 * - API Key（标准认证）
 * - OAuth Token（Claude Code，以 sk-ant-oat 开头）
 * - GitHub Copilot（Bearer Token）
 */
import Anthropic from "@anthropic-ai/sdk";
import type {
	ContentBlockParam,
	MessageCreateParamsStreaming,
	MessageParam,
} from "@anthropic-ai/sdk/resources/messages.js";
import { getEnvApiKey } from "../env-api-keys.js";
import { calculateCost } from "../models.js";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { parseStreamingJson } from "../utils/json-parse.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";

import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.js";
import { adjustMaxTokensForThinking, buildBaseOptions } from "./simple-options.js";
import { transformMessages } from "./transform-messages.js";

/**
 * 解析缓存保留偏好设置
 *
 * 确定消息缓存的保留策略，用于优化 API 调用成本和响应速度。
 * 缓存可以让 Anthropic API 重用之前处理过的内容，减少重复计算的 token 费用。
 *
 * @param cacheRetention - 可选的缓存保留级别参数
 * @returns 缓存保留级别
 *
 * 缓存保留级别说明：
 * - "none": 不使用缓存，每次都重新处理
 * - "short"/"ephemeral": 使用临时缓存，无 TTL 限制
 * - "long": 使用长期缓存，设置 1 小时 TTL（仅当使用官方 api.anthropic.com 端点时）
 *
 * 环境变量：
 * - PI_CACHE_RETENTION=long: 设置默认缓存行为为长期缓存
 */
function resolveCacheRetention(cacheRetention?: CacheRetention): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (typeof process !== "undefined" && process.env.PI_CACHE_RETENTION === "long") {
		return "long";
	}
	return "short";
}

/**
 * 获取缓存控制配置
 *
 * 根据 baseUrl 和缓存保留级别生成 Anthropic API 所需的 cache_control 对象。
 * 只有官方 Anthropic API 端点才支持 TTL（生存时间）设置。
 *
 * @param baseUrl - API 基础 URL
 * @param cacheRetention - 可选的缓存保留级别
 * @returns 包含保留级别和可选缓存控制对象的配置
 *
 * 注意：
 * - 自定义端点（如阿里云、z.ai 等）不支持 TTL，只能使用 ephemeral 缓存
 * - TTL 设置为 "1h" 表示缓存 1 小时后过期
 */
function getCacheControl(
	baseUrl: string,
	cacheRetention?: CacheRetention,
): { retention: CacheRetention; cacheControl?: { type: "ephemeral"; ttl?: "1h" } } {
	const retention = resolveCacheRetention(cacheRetention);
	if (retention === "none") {
		return { retention };
	}
	const ttl = retention === "long" && baseUrl.includes("api.anthropic.com") ? "1h" : undefined;
	return {
		retention,
		cacheControl: { type: "ephemeral", ...(ttl && { ttl }) },
	};
}

// ============================================================================
// Claude Code 兼容性配置
// ============================================================================

/**
 * Claude Code 版本号
 * 用于在 OAuth 认证时模拟 Claude Code 客户端的身份
 * 来源：https://github.com/badlogic/cchistory
 */
const claudeCodeVersion = "2.1.75";

/**
 * Claude Code 2.x 工具名称列表（标准命名）
 *
 * 这些是 Claude Code CLI 使用的标准工具名称。
 * 当使用 OAuth Token 时，需要将工具名称映射到这些标准名称，
 * 以便 Anthropic API 识别为 Claude Code 客户端。
 *
 * 来源：https://cchistory.mariozechner.at/data/prompts-2.1.11.md
 */
const claudeCodeTools = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Grep",
	"Glob",
	"AskUserQuestion",
	"EnterPlanMode",
	"ExitPlanMode",
	"KillShell",
	"NotebookEdit",
	"Skill",
	"Task",
	"TaskOutput",
	"TodoWrite",
	"WebFetch",
	"WebSearch",
];

/**
 * Claude Code 工具名称查找表
 * 键：小写名称，值：标准名称（首字母大写）
 */
const ccToolLookup = new Map(claudeCodeTools.map((t) => [t.toLowerCase(), t]));

/**
 * 将工具名称转换为 Claude Code 标准命名
 *
 * 当使用 OAuth Token 时，将本地工具名称映射到 Claude Code 的标准工具名称。
 * 例如："read" -> "Read", "bash" -> "Bash"
 *
 * @param name - 原始工具名称
 * @returns 标准化后的工具名称（如果匹配），否则返回原名称
 */
const toClaudeCodeName = (name: string) => ccToolLookup.get(name.toLowerCase()) ?? name;

/**
 * 从 Claude Code 标准名称还原为本地工具名称
 *
 * 当从 API 接收工具调用响应时，将标准名称还原为本地定义的工具名称。
 *
 * @param name - Claude Code 标准名称
 * @param tools - 本地工具列表（用于查找匹配的工具）
 * @returns 还原后的工具名称
 */
const fromClaudeCodeName = (name: string, tools?: Tool[]) => {
	if (tools && tools.length > 0) {
		const lowerName = name.toLowerCase();
		const matchedTool = tools.find((tool) => tool.name.toLowerCase() === lowerName);
		if (matchedTool) return matchedTool.name;
	}
	return name;
};

/**
 * 将内容块转换为 Anthropic API 格式
 *
 * 处理文本和图像内容，将其转换为 Anthropic API 可识别的格式。
 * 支持纯文本、纯图像或混合内容。
 *
 * @param content - 内容块数组（文本或图像）
 * @returns 字符串（纯文本时）或内容块数组（包含图像时）
 *
 * 处理逻辑：
 * 1. 如果只有文本：合并为单个字符串
 * 2. 如果有图像：转换为 base64 编码的图像块
 * 3. 如果只有图像没有文本：添加占位符文本 "(see attached image)"
 *
 * 注意：
 * - 所有文本都会通过 sanitizeSurrogates 处理，确保 Unicode 编码正确
 * - 图像支持 JPEG、PNG、GIF、WebP 格式
 */
function convertContentBlocks(content: (TextContent | ImageContent)[]):
	| string
	| Array<
			| { type: "text"; text: string }
			| {
					type: "image";
					source: {
						type: "base64";
						media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
						data: string;
					};
			  }
	  > {
	// If only text blocks, return as concatenated string for simplicity
	const hasImages = content.some((c) => c.type === "image");
	if (!hasImages) {
		return sanitizeSurrogates(content.map((c) => (c as TextContent).text).join("\n"));
	}

	// If we have images, convert to content block array
	const blocks = content.map((block) => {
		if (block.type === "text") {
			return {
				type: "text" as const,
				text: sanitizeSurrogates(block.text),
			};
		}
		return {
			type: "image" as const,
			source: {
				type: "base64" as const,
				media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
				data: block.data,
			},
		};
	});

	// If only images (no text), add placeholder text block
	const hasText = blocks.some((b) => b.type === "text");
	if (!hasText) {
		blocks.unshift({
			type: "text" as const,
			text: "(see attached image)",
		});
	}

	return blocks;
}

export type AnthropicEffort = "low" | "medium" | "high" | "max";

export interface AnthropicOptions extends StreamOptions {
	/**
	 * Enable extended thinking.
	 * For Opus 4.6 and Sonnet 4.6: uses adaptive thinking (model decides when/how much to think).
	 * For older models: uses budget-based thinking with thinkingBudgetTokens.
	 */
	thinkingEnabled?: boolean;
	/**
	 * Token budget for extended thinking (older models only).
	 * Ignored for Opus 4.6 and Sonnet 4.6, which use adaptive thinking.
	 */
	thinkingBudgetTokens?: number;
	/**
	 * Effort level for adaptive thinking (Opus 4.6 and Sonnet 4.6).
	 * Controls how much thinking Claude allocates:
	 * - "max": Always thinks with no constraints (Opus 4.6 only)
	 * - "high": Always thinks, deep reasoning (default)
	 * - "medium": Moderate thinking, may skip for simple queries
	 * - "low": Minimal thinking, skips for simple tasks
	 * Ignored for older models.
	 */
	effort?: AnthropicEffort;
	interleavedThinking?: boolean;
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
}

/**
 * 合并多个 HTTP 头对象
 *
 * 将多个头对象合并为一个，后面的头会覆盖前面的同名键。
 * 用于合并模型默认头、动态头和选项头。
 *
 * @param headerSources - 头对象数组（可能为 undefined）
 * @returns 合并后的头对象
 */
function mergeHeaders(...headerSources: (Record<string, string> | undefined)[]): Record<string, string> {
	const merged: Record<string, string> = {};
	for (const headers of headerSources) {
		if (headers) {
			Object.assign(merged, headers);
		}
	}
	return merged;
}

/**
 * Anthropic 流式主函数
 *
 * 与 Anthropic API 建立流式连接，处理响应事件并生成 AssistantMessage。
 * 这是 Anthropic provider 的核心函数，负责：
 *
 * 1. 客户端创建：根据认证方式（API Key/OAuth/Copilot）创建不同的客户端
 * 2. 参数构建：构建 API 请求参数，包括消息、工具、缓存控制等
 * 3. 流式处理：监听并处理各种流式事件
 *    - message_start: 消息开始，初始化 token 使用统计
 *    - content_block_start: 内容块开始（文本/思考/工具调用）
 *    - content_block_delta: 内容增量（文本片段/思考片段/JSON 参数）
 *    - content_block_stop: 内容块结束
 *    - message_delta: 消息元数据更新（停止原因、最终 token 数）
 * 4. 错误处理：捕获异常并生成错误消息
 *
 * @param model - 模型配置
 * @param context - 对话上下文（系统提示、消息历史、工具定义）
 * @param options - 可选配置（API 密钥、思考模式、缓存策略等）
 * @returns AssistantMessageEventStream - 助理消息事件流
 *
 * 事件流类型：
 * - start: 流式开始
 * - text_start/text_delta/text_end: 文本内容
 * - thinking_start/thinking_delta/thinking_end: 思考内容
 * - toolcall_start/toolcall_delta/toolcall_end: 工具调用
 * - done: 完成
 * - error: 错误
 */
export const streamAnthropic: StreamFunction<"anthropic-messages", AnthropicOptions> = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: AnthropicOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			const apiKey = options?.apiKey ?? getEnvApiKey(model.provider) ?? "";

			let copilotDynamicHeaders: Record<string, string> | undefined;
			if (model.provider === "github-copilot") {
				const hasImages = hasCopilotVisionInput(context.messages);
				copilotDynamicHeaders = buildCopilotDynamicHeaders({
					messages: context.messages,
					hasImages,
				});
			}

			const { client, isOAuthToken } = createClient(
				model,
				apiKey,
				options?.interleavedThinking ?? true,
				options?.headers,
				copilotDynamicHeaders,
			);
			let params = buildParams(model, context, isOAuthToken, options);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as MessageCreateParamsStreaming;
			}
			const anthropicStream = client.messages.stream({ ...params, stream: true }, { signal: options?.signal });
			stream.push({ type: "start", partial: output });

			type Block = (ThinkingContent | TextContent | (ToolCall & { partialJson: string })) & { index: number };
			const blocks = output.content as Block[];

			for await (const event of anthropicStream) {
				if (event.type === "message_start") {
					// Capture initial token usage from message_start event
					// This ensures we have input token counts even if the stream is aborted early
					output.usage.input = event.message.usage.input_tokens || 0;
					output.usage.output = event.message.usage.output_tokens || 0;
					output.usage.cacheRead = event.message.usage.cache_read_input_tokens || 0;
					output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens || 0;
					// Anthropic doesn't provide total_tokens, compute from components
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					calculateCost(model, output.usage);
				} else if (event.type === "content_block_start") {
					if (event.content_block.type === "text") {
						const block: Block = {
							type: "text",
							text: "",
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "thinking") {
						const block: Block = {
							type: "thinking",
							thinking: "",
							thinkingSignature: "",
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "redacted_thinking") {
						const block: Block = {
							type: "thinking",
							thinking: "[Reasoning redacted]",
							thinkingSignature: event.content_block.data,
							redacted: true,
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "tool_use") {
						const block: Block = {
							type: "toolCall",
							id: event.content_block.id,
							name: isOAuthToken
								? fromClaudeCodeName(event.content_block.name, context.tools)
								: event.content_block.name,
							arguments: (event.content_block.input as Record<string, any>) ?? {},
							partialJson: "",
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
					}
				} else if (event.type === "content_block_delta") {
					if (event.delta.type === "text_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "text") {
							block.text += event.delta.text;
							stream.push({
								type: "text_delta",
								contentIndex: index,
								delta: event.delta.text,
								partial: output,
							});
						}
					} else if (event.delta.type === "thinking_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "thinking") {
							block.thinking += event.delta.thinking;
							stream.push({
								type: "thinking_delta",
								contentIndex: index,
								delta: event.delta.thinking,
								partial: output,
							});
						}
					} else if (event.delta.type === "input_json_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "toolCall") {
							block.partialJson += event.delta.partial_json;
							block.arguments = parseStreamingJson(block.partialJson);
							stream.push({
								type: "toolcall_delta",
								contentIndex: index,
								delta: event.delta.partial_json,
								partial: output,
							});
						}
					} else if (event.delta.type === "signature_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "thinking") {
							block.thinkingSignature = block.thinkingSignature || "";
							block.thinkingSignature += event.delta.signature;
						}
					}
				} else if (event.type === "content_block_stop") {
					const index = blocks.findIndex((b) => b.index === event.index);
					const block = blocks[index];
					if (block) {
						delete (block as any).index;
						if (block.type === "text") {
							stream.push({
								type: "text_end",
								contentIndex: index,
								content: block.text,
								partial: output,
							});
						} else if (block.type === "thinking") {
							stream.push({
								type: "thinking_end",
								contentIndex: index,
								content: block.thinking,
								partial: output,
							});
						} else if (block.type === "toolCall") {
							block.arguments = parseStreamingJson(block.partialJson);
							delete (block as any).partialJson;
							stream.push({
								type: "toolcall_end",
								contentIndex: index,
								toolCall: block,
								partial: output,
							});
						}
					}
				} else if (event.type === "message_delta") {
					if (event.delta.stop_reason) {
						output.stopReason = mapStopReason(event.delta.stop_reason);
					}
					// Only update usage fields if present (not null).
					// Preserves input_tokens from message_start when proxies omit it in message_delta.
					if (event.usage.input_tokens != null) {
						output.usage.input = event.usage.input_tokens;
					}
					if (event.usage.output_tokens != null) {
						output.usage.output = event.usage.output_tokens;
					}
					if (event.usage.cache_read_input_tokens != null) {
						output.usage.cacheRead = event.usage.cache_read_input_tokens;
					}
					if (event.usage.cache_creation_input_tokens != null) {
						output.usage.cacheWrite = event.usage.cache_creation_input_tokens;
					}
					// Anthropic doesn't provide total_tokens, compute from components
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					calculateCost(model, output.usage);
				}
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error("An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) delete (block as any).index;
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

/**
 * 检查模型是否支持自适应思考（Opus 4.6 和 Sonnet 4.6）
 *
 * 自适应思考（Adaptive Thinking）是 Claude 4.6 系列模型的新特性，
 * 模型会自动决定何时思考以及思考多长时间，而不需要预先设定 token 预算。
 *
 * @param modelId - 模型 ID
 * @returns 是否支持自适应思考
 *
 * 支持的模型：
 * - Opus 4.6（包括带日期后缀的变体）
 * - Sonnet 4.6（包括带日期后缀的变体）
 */
function supportsAdaptiveThinking(modelId: string): boolean {
	// Opus 4.6 and Sonnet 4.6 model IDs (with or without date suffix)
	return (
		modelId.includes("opus-4-6") ||
		modelId.includes("opus-4.6") ||
		modelId.includes("sonnet-4-6") ||
		modelId.includes("sonnet-4.6")
	);
}

/**
 * 将思考级别映射到 Anthropic 的努力程度（effort）
 *
 * 仅适用于支持自适应思考的模型（Opus 4.6 和 Sonnet 4.6）。
 * 努力程度控制 Claude 分配多少思考资源：
 *
 * @param level - 思考级别（minimal/low/medium/high/xhigh）
 * @param modelId - 模型 ID（用于判断是否可以使用 "max" 努力程度）
 * @returns AnthropicEffort - 努力程度（low/medium/high/max）
 *
 * 映射规则：
 * - minimal/low -> low: 最小思考，简单任务直接回答
 * - medium -> medium: 适度思考，简单查询可能跳过
 * - high -> high: 深度推理（默认）
 * - xhigh -> max: 无限制思考（仅 Opus 4.6 支持），否则降级为 high
 *
 * 注意：
 * - "max" 努力程度仅对 Opus 4.6 有效
 * - Sonnet 4.6 不支持 "max"，会自动降级为 "high"
 * - 旧模型不使用此映射，使用基于预算的思考
 */
function mapThinkingLevelToEffort(level: SimpleStreamOptions["reasoning"], modelId: string): AnthropicEffort {
	switch (level) {
		case "minimal":
			return "low";
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		case "xhigh":
			return modelId.includes("opus-4-6") || modelId.includes("opus-4.6") ? "max" : "high";
		default:
			return "high";
	}
}

/**
 * 简化的 Anthropic 流式函数（兼容 SimpleStreamOptions）
 *
 * 这是 streamAnthropic 的包装函数，使用 SimpleStreamOptions 接口，
 * 提供更简洁的配置选项，自动处理思考模式的配置。
 *
 * @param model - 模型配置
 * @param context - 对话上下文
 * @param options - 简化选项（包括 reasoning 思考级别）
 * @returns AssistantMessageEventStream
 *
 * 思考模式处理：
 * 1. 无思考（!options.reasoning）：直接调用 streamAnthropic，禁用思考
 * 2. 自适应思考模型（Opus 4.6/Sonnet 4.6）：
 *    - 使用 adaptive thinking 模式
 *    - 根据 reasoning 级别设置 effort
 * 3. 旧模型：
 *    - 使用 budget-based thinking 模式
 *    - 调整 maxTokens 为思考预留空间
 *    - 设置 thinkingBudgetTokens
 */
export const streamSimpleAnthropic: StreamFunction<"anthropic-messages", SimpleStreamOptions> = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = buildBaseOptions(model, options, apiKey);
	if (!options?.reasoning) {
		return streamAnthropic(model, context, { ...base, thinkingEnabled: false } satisfies AnthropicOptions);
	}

	// For Opus 4.6 and Sonnet 4.6: use adaptive thinking with effort level
	// For older models: use budget-based thinking
	if (supportsAdaptiveThinking(model.id)) {
		const effort = mapThinkingLevelToEffort(options.reasoning, model.id);
		return streamAnthropic(model, context, {
			...base,
			thinkingEnabled: true,
			effort,
		} satisfies AnthropicOptions);
	}

	const adjusted = adjustMaxTokensForThinking(
		base.maxTokens || 0,
		model.maxTokens,
		options.reasoning,
		options.thinkingBudgets,
	);

	return streamAnthropic(model, context, {
		...base,
		maxTokens: adjusted.maxTokens,
		thinkingEnabled: true,
		thinkingBudgetTokens: adjusted.thinkingBudget,
	} satisfies AnthropicOptions);
};

/**
 * 判断 API 密钥是否为 OAuth Token
 *
 * OAuth Token 用于 Claude Code 官方客户端的身份验证。
 * OAuth Token 的格式：sk-ant-oat-xxxxx
 *
 * @param apiKey - API 密钥
 * @returns 是否为 OAuth Token
 */
function isOAuthToken(apiKey: string): boolean {
	return apiKey.includes("sk-ant-oat");
}

/**
 * 创建 Anthropic SDK 客户端
 *
 * 根据不同的认证方式和 provider 创建合适的 Anthropic 客户端实例。
 * 支持三种认证方式：
 *
 * @param model - 模型配置
 * @param apiKey - API 密钥
 * @param interleavedThinking - 是否启用交错思考（interleaved thinking）
 * @param optionsHeaders - 可选的自定义头
 * @param dynamicHeaders - 可选的动态头（如 Copilot 的动态头）
 * @returns 包含客户端和 OAuth 标记的对象
 *
 * 1. GitHub Copilot（Bearer 认证）：
 *    - 使用 authToken 而非 apiKey
 *    - 仅启用必要的 beta 功能（interleaved-thinking）
 *    - 不启用 fine-grained-tool-streaming
 *
 * 2. OAuth Token（Claude Code）：
 *    - 使用 authToken 而非 apiKey
 *    - 添加 Claude Code 身份标识头（user-agent, x-app）
 *    - 启用完整的 beta 功能集：
 *      - claude-code-20250219: Claude Code 特性
 *      - oauth-2025-04-20: OAuth 认证
 *      - fine-grained-tool-streaming-2025-05-14: 细粒度工具流
 *      - interleaved-thinking-2025-05-14: 交错思考（旧模型）
 *
 * 3. API Key（标准认证）：
 *    - 使用 apiKey 认证
 *    - 启用标准 beta 功能
 *
 * 注意：
 * - 自适应思考模型（Opus 4.6/Sonnet 4.6）不需要 interleaved-thinking beta
 * - dangerouslyAllowBrowser: true 允许在浏览器环境中使用（非 Node.js）
 */
function createClient(
	model: Model<"anthropic-messages">,
	apiKey: string,
	interleavedThinking: boolean,
	optionsHeaders?: Record<string, string>,
	dynamicHeaders?: Record<string, string>,
): { client: Anthropic; isOAuthToken: boolean } {
	// Adaptive thinking models (Opus 4.6, Sonnet 4.6) have interleaved thinking built-in.
	// The beta header is deprecated on Opus 4.6 and redundant on Sonnet 4.6, so skip it.
	const needsInterleavedBeta = interleavedThinking && !supportsAdaptiveThinking(model.id);

	// Copilot: Bearer auth, selective betas (no fine-grained-tool-streaming)
	if (model.provider === "github-copilot") {
		const betaFeatures: string[] = [];
		if (needsInterleavedBeta) {
			betaFeatures.push("interleaved-thinking-2025-05-14");
		}

		const client = new Anthropic({
			apiKey: null,
			authToken: apiKey,
			baseURL: model.baseUrl,
			dangerouslyAllowBrowser: true,
			defaultHeaders: mergeHeaders(
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
				},
				model.headers,
				dynamicHeaders,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: false };
	}

	const betaFeatures = ["fine-grained-tool-streaming-2025-05-14"];
	if (needsInterleavedBeta) {
		betaFeatures.push("interleaved-thinking-2025-05-14");
	}

	// OAuth: Bearer auth, Claude Code identity headers
	if (isOAuthToken(apiKey)) {
		const client = new Anthropic({
			apiKey: null,
			authToken: apiKey,
			baseURL: model.baseUrl,
			dangerouslyAllowBrowser: true,
			defaultHeaders: mergeHeaders(
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					"anthropic-beta": `claude-code-20250219,oauth-2025-04-20,${betaFeatures.join(",")}`,
					"user-agent": `claude-cli/${claudeCodeVersion}`,
					"x-app": "cli",
				},
				model.headers,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: true };
	}

	// API key auth
	const client = new Anthropic({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		defaultHeaders: mergeHeaders(
			{
				accept: "application/json",
				"anthropic-dangerous-direct-browser-access": "true",
				"anthropic-beta": betaFeatures.join(","),
			},
			model.headers,
			optionsHeaders,
		),
	});

	return { client, isOAuthToken: false };
}

/**
 * 构建 API 请求参数
 *
 * 根据模型、上下文和选项构建 Anthropic API 的请求参数。
 * 处理系统提示、工具、思考模式、缓存控制等配置。
 *
 * @param model - 模型配置
 * @param context - 对话上下文
 * @param isOAuthToken - 是否为 OAuth Token
 * @param options - 可选的 Anthropic 配置
 * @returns 流式消息创建参数
 *
 * 参数配置：
 * 1. 系统提示：
 *    - OAuth Token：必须包含 Claude Code 身份标识
 *    - 非 OAuth Token：使用自定义系统提示
 *    - 两者都应用缓存控制
 *
 * 2. 温度（temperature）：
 *    - 与思考模式互斥
 *    - 仅在未启用思考时使用
 *
 * 3. 工具（tools）：
 *    - 如果上下文定义了工具，转换为 Anthropic 格式
 *    - OAuth Token 时使用标准命名
 *
 * 4. 思考模式（thinking）：
 *    - 自适应思考模型：使用 adaptive 类型 + effort 配置
 *    - 旧模型：使用 enabled 类型 + budget_tokens
 *
 * 5. 元数据（metadata）：
 *    - 可选的用户 ID
 *
 * 6. 工具选择（tool_choice）：
 *    - auto: 自动决定是否使用工具
 *    - any: 必须使用至少一个工具
 *    - none: 不使用工具
 *    - { type: "tool", name: "xxx" }: 强制使用特定工具
 */
function buildParams(
	model: Model<"anthropic-messages">,
	context: Context,
	isOAuthToken: boolean,
	options?: AnthropicOptions,
): MessageCreateParamsStreaming {
	const { cacheControl } = getCacheControl(model.baseUrl, options?.cacheRetention);
	const params: MessageCreateParamsStreaming = {
		model: model.id,
		messages: convertMessages(context.messages, model, isOAuthToken, cacheControl),
		max_tokens: options?.maxTokens || (model.maxTokens / 3) | 0,
		stream: true,
	};

	// For OAuth tokens, we MUST include Claude Code identity
	if (isOAuthToken) {
		params.system = [
			{
				type: "text",
				text: "You are Claude Code, Anthropic's official CLI for Claude.",
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
		if (context.systemPrompt) {
			params.system.push({
				type: "text",
				text: sanitizeSurrogates(context.systemPrompt),
				...(cacheControl ? { cache_control: cacheControl } : {}),
			});
		}
	} else if (context.systemPrompt) {
		// Add cache control to system prompt for non-OAuth tokens
		params.system = [
			{
				type: "text",
				text: sanitizeSurrogates(context.systemPrompt),
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
	}

	// Temperature is incompatible with extended thinking (adaptive or budget-based).
	if (options?.temperature !== undefined && !options?.thinkingEnabled) {
		params.temperature = options.temperature;
	}

	if (context.tools) {
		params.tools = convertTools(context.tools, isOAuthToken);
	}

	// Configure thinking mode: adaptive (Opus 4.6 and Sonnet 4.6) or budget-based (older models)
	if (options?.thinkingEnabled && model.reasoning) {
		if (supportsAdaptiveThinking(model.id)) {
			// Adaptive thinking: Claude decides when and how much to think
			params.thinking = { type: "adaptive" };
			if (options.effort) {
				params.output_config = { effort: options.effort };
			}
		} else {
			// Budget-based thinking for older models
			params.thinking = {
				type: "enabled",
				budget_tokens: options.thinkingBudgetTokens || 1024,
			};
		}
	}

	if (options?.metadata) {
		const userId = options.metadata.user_id;
		if (typeof userId === "string") {
			params.metadata = { user_id: userId };
		}
	}

	if (options?.toolChoice) {
		if (typeof options.toolChoice === "string") {
			params.tool_choice = { type: options.toolChoice };
		} else {
			params.tool_choice = options.toolChoice;
		}
	}

	return params;
}

/**
 * 标准化工具调用 ID
 *
 * Anthropic API 要求工具调用 ID 必须符合特定格式：
 * - 只能包含字母、数字、下划线和连字符
 * - 最大长度 64 个字符
 *
 * @param id - 原始工具调用 ID
 * @returns 标准化后的 ID
 */
function normalizeToolCallId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

/**
 * 转换消息为 Anthropic API 格式
 *
 * 将内部消息格式转换为 Anthropic API 可识别的 MessageParam 数组。
 * 处理用户消息、助理消息和工具结果消息。
 *
 * @param messages - 内部消息数组
 * @param model - 模型配置
 * @param isOAuthToken - 是否为 OAuth Token
 * @param cacheControl - 可选的缓存控制配置
 * @returns Anthropic API 消息参数数组
 *
 * 消息类型处理：
 * 1. 用户消息（user）：
 *    - 字符串内容：直接转换
 *    - 多模态内容：转换为文本块 + 图像块
 *    - 过滤空文本和不支持的图像
 *
 * 2. 助理消息（assistant）：
 *    - 文本块：转换为 text 类型
 *    - 思考块：
 *      - Redacted thinking: 转换为 redacted_thinking 类型
 *      - 普通 thinking: 转换为 thinking 类型（带 signature）
 *      - 无 signature: 降级为 text 类型
 *    - 工具调用：转换为 tool_use 类型
 *
 * 3. 工具结果（toolResult）：
 *    - 合并连续的工具结果消息
 *    - 转换为单个 user 消息包含所有 tool_result 块
 *    - 这对于某些 Anthropic 端点（如 z.ai）是必需的
 *
 * 缓存控制：
 * - 应用到最后一个 user 消息的最后一个内容块
 * - 用于缓存对话历史，减少重复处理的 token 费用
 */
function convertMessages(
	messages: Message[],
	model: Model<"anthropic-messages">,
	isOAuthToken: boolean,
	cacheControl?: { type: "ephemeral"; ttl?: "1h" },
): MessageParam[] {
	const params: MessageParam[] = [];

	// Transform messages for cross-provider compatibility
	const transformedMessages = transformMessages(messages, model, normalizeToolCallId);

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];

		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				if (msg.content.trim().length > 0) {
					params.push({
						role: "user",
						content: sanitizeSurrogates(msg.content),
					});
				}
			} else {
				const blocks: ContentBlockParam[] = msg.content.map((item) => {
					if (item.type === "text") {
						return {
							type: "text",
							text: sanitizeSurrogates(item.text),
						};
					} else {
						return {
							type: "image",
							source: {
								type: "base64",
								media_type: item.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
								data: item.data,
							},
						};
					}
				});
				let filteredBlocks = !model?.input.includes("image") ? blocks.filter((b) => b.type !== "image") : blocks;
				filteredBlocks = filteredBlocks.filter((b) => {
					if (b.type === "text") {
						return b.text.trim().length > 0;
					}
					return true;
				});
				if (filteredBlocks.length === 0) continue;
				params.push({
					role: "user",
					content: filteredBlocks,
				});
			}
		} else if (msg.role === "assistant") {
			const blocks: ContentBlockParam[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					if (block.text.trim().length === 0) continue;
					blocks.push({
						type: "text",
						text: sanitizeSurrogates(block.text),
					});
				} else if (block.type === "thinking") {
					// Redacted thinking: pass the opaque payload back as redacted_thinking
					if (block.redacted) {
						blocks.push({
							type: "redacted_thinking",
							data: block.thinkingSignature!,
						});
						continue;
					}
					if (block.thinking.trim().length === 0) continue;
					// If thinking signature is missing/empty (e.g., from aborted stream),
					// convert to plain text block without <thinking> tags to avoid API rejection
					// and prevent Claude from mimicking the tags in responses
					if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
						blocks.push({
							type: "text",
							text: sanitizeSurrogates(block.thinking),
						});
					} else {
						blocks.push({
							type: "thinking",
							thinking: sanitizeSurrogates(block.thinking),
							signature: block.thinkingSignature,
						});
					}
				} else if (block.type === "toolCall") {
					blocks.push({
						type: "tool_use",
						id: block.id,
						name: isOAuthToken ? toClaudeCodeName(block.name) : block.name,
						input: block.arguments ?? {},
					});
				}
			}
			if (blocks.length === 0) continue;
			params.push({
				role: "assistant",
				content: blocks,
			});
		} else if (msg.role === "toolResult") {
			// Collect all consecutive toolResult messages, needed for z.ai Anthropic endpoint
			const toolResults: ContentBlockParam[] = [];

			// Add the current tool result
			toolResults.push({
				type: "tool_result",
				tool_use_id: msg.toolCallId,
				content: convertContentBlocks(msg.content),
				is_error: msg.isError,
			});

			// Look ahead for consecutive toolResult messages
			let j = i + 1;
			while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
				const nextMsg = transformedMessages[j] as ToolResultMessage; // We know it's a toolResult
				toolResults.push({
					type: "tool_result",
					tool_use_id: nextMsg.toolCallId,
					content: convertContentBlocks(nextMsg.content),
					is_error: nextMsg.isError,
				});
				j++;
			}

			// Skip the messages we've already processed
			i = j - 1;

			// Add a single user message with all tool results
			params.push({
				role: "user",
				content: toolResults,
			});
		}
	}

	// Add cache_control to the last user message to cache conversation history
	if (cacheControl && params.length > 0) {
		const lastMessage = params[params.length - 1];
		if (lastMessage.role === "user") {
			if (Array.isArray(lastMessage.content)) {
				const lastBlock = lastMessage.content[lastMessage.content.length - 1];
				if (
					lastBlock &&
					(lastBlock.type === "text" || lastBlock.type === "image" || lastBlock.type === "tool_result")
				) {
					(lastBlock as any).cache_control = cacheControl;
				}
			} else if (typeof lastMessage.content === "string") {
				lastMessage.content = [
					{
						type: "text",
						text: lastMessage.content,
						cache_control: cacheControl,
					},
				] as any;
			}
		}
	}

	return params;
}

/**
 * 转换工具定义为 Anthropic API 格式
 *
 * 将内部工具定义转换为 Anthropic API 可识别的 Tool 对象。
 * 使用 TypeBox 生成的 JSON Schema 作为工具参数规范。
 *
 * @param tools - 内部工具定义数组
 * @param isOAuthToken - 是否为 OAuth Token
 * @returns Anthropic API 工具数组
 *
 * 工具转换：
 * - name: 工具名称（OAuth Token 时使用标准命名）
 * - description: 工具描述
 * - input_schema: JSON Schema 格式的参数定义
 *   - type: "object"
 *   - properties: 参数属性列表
 *   - required: 必需参数列表
 */
function convertTools(tools: Tool[], isOAuthToken: boolean): Anthropic.Messages.Tool[] {
	if (!tools) return [];

	return tools.map((tool) => {
		const jsonSchema = tool.parameters as any; // TypeBox already generates JSON Schema

		return {
			name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name,
			description: tool.description,
			input_schema: {
				type: "object" as const,
				properties: jsonSchema.properties || {},
				required: jsonSchema.required || [],
			},
		};
	});
}

/**
 * 映射 Anthropic 停止原因为标准停止原因
 *
 * 将 Anthropic API 返回的停止原因映射为内部统一的 StopReason 类型。
 *
 * @param reason - Anthropic API 停止原因
 * @returns 标准化的停止原因
 *
 * 映射关系：
 * - end_turn -> stop: 正常完成
 * - max_tokens -> length: 达到 token 限制
 * - tool_use -> toolUse: 需要调用工具
 * - refusal -> error: 内容被拒绝
 * - pause_turn -> stop: 暂停回合（可重新提交）
 * - stop_sequence -> stop: 遇到停止序列
 * - sensitive -> error: 内容被安全过滤器标记
 * - 其他 -> 抛出错误（未知停止原因）
 */
function mapStopReason(reason: Anthropic.Messages.StopReason | string): StopReason {
	switch (reason) {
		case "end_turn":
			return "stop";
		case "max_tokens":
			return "length";
		case "tool_use":
			return "toolUse";
		case "refusal":
			return "error";
		case "pause_turn": // Stop is good enough -> resubmit
			return "stop";
		case "stop_sequence":
			return "stop"; // We don't supply stop sequences, so this should never happen
		case "sensitive": // Content flagged by safety filters (not yet in SDK types)
			return "error";
		default:
			// Handle unknown stop reasons gracefully (API may add new values)
			throw new Error(`Unhandled stop reason: ${reason}`);
	}
}
