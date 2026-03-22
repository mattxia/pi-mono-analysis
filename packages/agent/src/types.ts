/**
 * Agent 类型定义文件
 *
 * 此文件定义了 Agent 系统的所有核心类型，包括：
 * - 流式函数类型
 * - 工具执行模式
 * - 工具钩子接口
 * - Agent 循环配置
 * - Agent 消息和状态
 * - Agent 工具类型
 * - Agent 事件类型
 */

import type {
	AssistantMessage,
	AssistantMessageEvent,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	streamSimple,
	TextContent,
	Tool,
	ToolResultMessage,
} from "@mariozechner/pi-ai";
import type { Static, TSchema } from "@sinclair/typebox";

/**
 * Agent 循环使用的流式函数类型
 *
 * 契约：
 * - 对于请求/模型/运行时失败，不得抛出或返回拒绝的 Promise
 * - 必须返回 AssistantMessageEventStream
 * - 失败必须通过协议事件编码到返回的流中，
 *   并在最终的 AssistantMessage 中设置 stopReason 为 "error" 或 "aborted"，
 *   同时设置 errorMessage
 */
export type StreamFn = (
	...args: Parameters<typeof streamSimple>
) => ReturnType<typeof streamSimple> | Promise<ReturnType<typeof streamSimple>>;

/**
 * 单个助手消息中的工具调用执行配置
 *
 * - "sequential": 每个工具调用在准备、执行和最终化完成后，才开始下一个
 * - "parallel": 工具调用按顺序准备，然后允许的工具并发执行。
 *   最终的工具结果仍然按照助手源顺序发出
 */
export type ToolExecutionMode = "sequential" | "parallel";

/** 助手消息发出的单个工具调用内容块 */
export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

/**
 * `beforeToolCall` 返回的结果
 *
 * 返回 `{ block: true }` 可以防止工具执行。循环会发出一个错误的工具结果。
 * `reason` 成为该错误结果中显示的文本。如果省略，则使用默认的阻止消息
 */
export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
}

/**
 * `afterToolCall` 返回的部分覆盖
 *
 * 合并语义是按字段进行的：
 * - `content`: 如果提供，完全替换工具结果内容数组
 * - `details`: 如果提供，完全替换工具结果详情值
 * - `isError`: 如果提供，替换工具结果错误标志
 *
 * 省略的字段保持原始执行的工具结果值。
 * `content` 或 `details` 不会进行深度合并
 */
export interface AfterToolCallResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
}

/** 传递给 `beforeToolCall` 的上下文 */
export interface BeforeToolCallContext {
	/** 请求工具调用的助手消息 */
	assistantMessage: AssistantMessage;
	/** 来自 `assistantMessage.content` 的原始工具调用块 */
	toolCall: AgentToolCall;
	/** 目标工具模式的验证工具参数 */
	args: unknown;
	/** 工具调用准备时的当前 Agent 上下文 */
	context: AgentContext;
}

/** 传递给 `afterToolCall` 的上下文 */
export interface AfterToolCallContext {
	/** 请求工具调用的助手消息 */
	assistantMessage: AssistantMessage;
	/** 来自 `assistantMessage.content` 的原始工具调用块 */
	toolCall: AgentToolCall;
	/** 目标工具模式的验证工具参数 */
	args: unknown;
	/** 应用任何 `afterToolCall` 覆盖之前的执行工具结果 */
	result: AgentToolResult<any>;
	/** 执行的工具结果当前是否被视为错误 */
	isError: boolean;
	/** 工具调用最终化时的当前 Agent 上下文 */
	context: AgentContext;
}

/**
 * Agent 循环配置接口
 *
 * 扩展自 SimpleStreamOptions，添加了 Agent 特定的配置
 */
export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model<any>;

	/**
	 * 在每次 LLM 调用之前，将 AgentMessage[] 转换为 LLM 兼容的 Message[]
	 *
	 * 每个 AgentMessage 必须转换为 LLM 可以理解的 UserMessage、AssistantMessage 或 ToolResultMessage。
	 * 无法转换的 AgentMessage（例如仅限 UI 的通知、状态消息）应该被过滤掉。
	 *
	 * 契约：不得抛出或拒绝。改为返回安全的回退值。
	 * 抛出会中断底层 Agent 循环，而不会产生正常的事件序列
	 *
	 * @example
	 * ```typescript
	 * convertToLlm: (messages) => messages.flatMap(m => {
	 *   if (m.role === "custom") {
	 *     // 将自定义消息转换为用户消息
	 *     return [{ role: "user", content: m.content, timestamp: m.timestamp }];
	 *   }
	 *   if (m.role === "notification") {
	 *     // 过滤掉仅限 UI 的消息
	 *     return [];
	 *   }
	 *   // 传递标准 LLM 消息
	 *   return [m];
	 * })
	 * ```
	 */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	/**
	 * 在 `convertToLlm` 之前应用于上下文的可选转换
	 *
	 * 用于在 AgentMessage 级别工作的操作：
	 * - 上下文窗口管理（修剪旧消息）
	 * - 从外部源注入上下文
	 *
	 * 契约：不得抛出或拒绝。改为返回原始消息或另一个安全的回退值
	 *
	 * @example
	 * ```typescript
	 * transformContext: async (messages) => {
	 *   if (estimateTokens(messages) > MAX_TOKENS) {
	 *     return pruneOldMessages(messages);
	 *   }
	 *   return messages;
	 * }
	 * ```
	 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	/**
	 * 为每次 LLM 调用动态解析 API 密钥
	 *
	 * 适用于可能在长时间运行的工具执行阶段过期的短期 OAuth 令牌（例如 GitHub Copilot）
	 *
	 * 契约：不得抛出或拒绝。当没有可用密钥时返回 undefined
	 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	/**
	 * 返回要在运行中途注入对话的引导消息
	 *
	 * 在每次工具执行后调用，以检查用户中断。
	 * 如果返回消息，剩余的工具调用会被跳过，
	 * 这些消息会在下一次 LLM 调用之前添加到上下文中
	 *
	 * 用于在 Agent 工作时"引导"它
	 *
	 * 契约：不得抛出或拒绝。当没有引导消息时返回 []
	 */
	getSteeringMessages?: () => Promise<AgentMessage[]>;

	/**
	 * 返回在 Agent 本应停止后处理的跟进消息
	 *
	 * 在 Agent 没有更多工具调用且没有引导消息时调用。
	 * 如果返回消息，它们会被添加到上下文中，Agent 会继续另一轮
	 *
	 * 用于应该等待 Agent 完成的跟进消息
	 *
	 * 契约：不得抛出或拒绝。当没有跟进消息时返回 []
	 */
	getFollowUpMessages?: () => Promise<AgentMessage[]>;

	/**
	 * 工具执行模式
	 * - "sequential": 逐个执行工具调用
	 * - "parallel": 按顺序预检查工具调用，然后并发执行允许的工具
	 *
	 * 默认值："parallel"
	 */
	toolExecution?: ToolExecutionMode;

	/**
	 * 在工具执行之前、参数验证之后调用
	 *
	 * 返回 `{ block: true }` 以阻止执行。循环会发出一个错误的工具结果
	 * 钩子接收 Agent 中止信号并负责遵守它
	 */
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;

	/**
	 * 在工具完成执行之后、最终工具事件发出之前调用
	 *
	 * 返回 `AfterToolCallResult` 以覆盖执行的工具结果的部分：
	 * - `content` 替换完整的内容数组
	 * - `details` 替换完整的详情有效载荷
	 * - `isError` 替换错误标志
	 *
	 * 任何省略的字段保持其原始值。不执行深度合并
	 * 钩子接收 Agent 中止信号并负责遵守它
	 */
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
}

/**
 * 支持它的模型的思考/推理级别
 * 注意："xhigh" 仅受 OpenAI gpt-5.1-codex-max、gpt-5.2、gpt-5.2-codex、gpt-5.3 和 gpt-5.3-codex 模型支持
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * 自定义应用消息的可扩展接口
 * 应用可以通过声明合并扩展：
 *
 * @example
 * ```typescript
 * declare module "@mariozechner/agent" {
 *   interface CustomAgentMessages {
 *     artifact: ArtifactMessage;
 *     notification: NotificationMessage;
 *   }
 * }
 * ```
 */
export interface CustomAgentMessages {
	// 默认为空 - 应用通过声明合并扩展
}

/**
 * AgentMessage：LLM 消息 + 自定义消息的联合类型
 * 此抽象允许应用添加自定义消息类型，同时保持类型安全和与基础 LLM 消息的兼容性
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

/**
 * 包含所有配置和对话数据的 Agent 状态
 */
export interface AgentState {
	systemPrompt: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	tools: AgentTool<any>[];
	messages: AgentMessage[]; // 可以包含附件 + 自定义消息类型
	isStreaming: boolean;
	streamMessage: AgentMessage | null;
	pendingToolCalls: Set<string>;
	error?: string;
}

/**
 * Agent 工具结果接口
 *
 * 支持文本和图像的内容块，以及用于 UI 显示或日志记录的详情
 */
export interface AgentToolResult<T> {
	// 支持文本和图像的内容块
	content: (TextContent | ImageContent)[];
	// 要在 UI 中显示或记录的详情
	details: T;
}

// 流式工具执行更新的回调
export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;

// AgentTool 扩展 Tool 但添加了 execute 函数
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
	// 要在 UI 中显示的工具的人类可读标签
	label: string;
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
}

// AgentContext 类似于 Context 但使用 AgentTool
export interface AgentContext {
	systemPrompt: string;
	messages: AgentMessage[];
	tools?: AgentTool<any>[];
}

/**
 * Agent 为 UI 更新发出的事件
 * 这些事件提供消息、轮次和工具执行的细粒度生命周期信息
 */
export type AgentEvent =
	// Agent 生命周期
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	// 轮次生命周期 - 一个轮次是一个助手响应 + 任何工具调用/结果
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	// 消息生命周期 - 为用户、助手和 toolResult 消息发出
	| { type: "message_start"; message: AgentMessage }
	// 仅在流式传输期间为助手消息发出
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	// 工具执行生命周期
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
