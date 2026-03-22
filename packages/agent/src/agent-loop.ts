/**
 * Agent 循环核心文件
 *
 * 整个循环始终使用 AgentMessage，
 * 只在 LLM 调用边界处转换为 Message[]。
 */

import {
	type AssistantMessage,
	type Context,
	EventStream,
	streamSimple,
	type ToolResultMessage,
	validateToolArguments,
} from "@mariozechner/pi-ai";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	StreamFn,
} from "./types.js";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/**
 * 使用新的提示消息启动 Agent 循环
 *
 * 提示被添加到上下文中，并为其发出事件
 *
 * @param prompts - 要添加的提示消息数组
 * @param context - 当前 Agent 上下文
 * @param config - Agent 循环配置
 * @param signal - 可选的中止信号
 * @param streamFn - 可选的自定义流式函数
 * @returns Agent 事件流
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

/**
 * 从当前上下文继续 Agent 循环，不添加新消息
 *
 * 用于重试 - 上下文已经有用户消息或工具结果
 *
 * **重要：** 上下文中的最后一条消息必须通过 `convertToLlm` 转换为
 * `user` 或 `toolResult` 消息。如果没有，LLM 提供商将拒绝请求。
 * 这无法在这里验证，因为 `convertToLlm` 每轮只调用一次
 *
 * @param context - 当前 Agent 上下文
 * @param config - Agent 循环配置
 * @param signal - 可选的中止信号
 * @param streamFn - 可选的自定义流式函数
 * @returns Agent 事件流
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

/**
 * 运行 Agent 循环的异步函数
 *
 * 添加提示消息到上下文，发出事件，然后运行主循环
 *
 * @param prompts - 要添加的提示消息数组
 * @param context - 当前 Agent 上下文
 * @param config - Agent 循环配置
 * @param emit - 事件发送函数
 * @param signal - 可选的中止信号
 * @param streamFn - 可选的自定义流式函数
 * @returns 新添加的消息数组
 */
export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

/**
 * 继续运行 Agent 循环的异步函数
 *
 * 从当前上下文继续，不添加新消息
 *
 * @param context - 当前 Agent 上下文
 * @param config - Agent 循环配置
 * @param emit - 事件发送函数
 * @param signal - 可选的中止信号
 * @param streamFn - 可选的自定义流式函数
 * @returns 新添加的消息数组
 */
export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

/**
 * 创建 Agent 事件流
 *
 * @returns 配置好的 EventStream
 */
function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		// 终止条件：当事件类型为 "agent_end" 时结束流
		(event: AgentEvent) => event.type === "agent_end",
		// 结果提取：从事件中提取最终的消息数组
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * agentLoop 和 agentLoopContinue 共享的主循环逻辑
 *
 * 这是 Agent 循环的核心，包含外层循环和内层循环
 *
 * @param currentContext - 当前 Agent 上下文
 * @param newMessages - 新添加的消息数组
 * @param config - Agent 循环配置
 * @param signal - 可选的中止信号
 * @param emit - 事件发送函数
 * @param streamFn - 可选的自定义流式函数
 */
async function runLoop(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<void> {
	let firstTurn = true;
	// 开始时检查引导消息（用户可能在等待时输入了内容）
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// 外层循环：当 Agent 本应停止后，如果有跟进消息则继续
	while (true) {
		let hasMoreToolCalls = true;

		// 内层循环：处理工具调用和引导消息
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// 处理待处理消息（在下一个助手响应之前注入）
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// 流式获取助手响应
			const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFn);
			newMessages.push(message);

			// 检查是否出错或被中止
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// 检查是否有工具调用
			const toolCalls = message.content.filter((c) => c.type === "toolCall");
			hasMoreToolCalls = toolCalls.length > 0;

			const toolResults: ToolResultMessage[] = [];
			if (hasMoreToolCalls) {
				toolResults.push(...(await executeToolCalls(currentContext, message, config, signal, emit)));

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			await emit({ type: "turn_end", message, toolResults });

			pendingMessages = (await config.getSteeringMessages?.()) || [];
		}

		// Agent 本应在此处停止。检查是否有跟进消息
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// 设置为待处理，以便内层循环处理它们
			pendingMessages = followUpMessages;
			continue;
		}

		// 没有更多消息，退出
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

/**
 * 从 LLM 流式获取助手响应
 *
 * 这是 AgentMessage[] 被转换为 Message[] 以提供给 LLM 的地方
 *
 * @param context - 当前 Agent 上下文
 * @param config - Agent 循环配置
 * @param signal - 可选的中止信号
 * @param emit - 事件发送函数
 * @param streamFn - 可选的自定义流式函数
 * @returns 完整的 AssistantMessage
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	// 如果配置了上下文转换，则应用它（AgentMessage[] → AgentMessage[]）
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// 转换为 LLM 兼容的消息（AgentMessage[] → Message[]）
	const llmMessages = await config.convertToLlm(messages);

	// 构建 LLM 上下文
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};

	const streamFunction = streamFn || streamSimple;

	// 解析 API 密钥（对过期令牌很重要）
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		signal,
	});

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		switch (event.type) {
			case "start":
				// 流式开始，初始化 partial 消息
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				// 各种增量事件，更新 partial 消息
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			case "done":
			case "error": {
				// 流式完成或出错，获取最终消息
				const finalMessage = await response.result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	// 备用路径：如果循环没有捕获到 done/error 事件
	const finalMessage = await response.result();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}

/**
 * 执行助手消息中的工具调用
 *
 * 根据配置选择顺序或并行执行
 *
 * @param currentContext - 当前 Agent 上下文
 * @param assistantMessage - 包含工具调用的助手消息
 * @param config - Agent 循环配置
 * @param signal - 可选的中止信号
 * @param emit - 事件发送函数
 * @returns 工具结果消息数组
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ToolResultMessage[]> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	if (config.toolExecution === "sequential") {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

/**
 * 顺序执行工具调用
 *
 * 一个接一个地准备、执行和最终化工具调用
 *
 * @param currentContext - 当前 Agent 上下文
 * @param assistantMessage - 包含工具调用的助手消息
 * @param toolCalls - 工具调用数组
 * @param config - Agent 循环配置
 * @param signal - 可选的中止信号
 * @param emit - 事件发送函数
 * @returns 工具结果消息数组
 */
async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ToolResultMessage[]> {
	const results: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			// 立即返回结果（例如：工具未找到或被阻止）
			results.push(await emitToolCallOutcome(toolCall, preparation.result, preparation.isError, emit));
		} else {
			// 执行工具调用，然后最终化
			const executed = await executePreparedToolCall(preparation, signal, emit);
			results.push(
				await finalizeExecutedToolCall(
					currentContext,
					assistantMessage,
					preparation,
					executed,
					config,
					signal,
					emit,
				),
			);
		}
	}

	return results;
}

/**
 * 并行执行工具调用
 *
 * 顺序准备工具调用，然后允许的工具并发执行
 * 最终工具结果仍按助手源顺序发出
 *
 * @param currentContext - 当前 Agent 上下文
 * @param assistantMessage - 包含工具调用的助手消息
 * @param toolCalls - 工具调用数组
 * @param config - Agent 循环配置
 * @param signal - 可选的中止信号
 * @param emit - 事件发送函数
 * @returns 工具结果消息数组
 */
async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ToolResultMessage[]> {
	const results: ToolResultMessage[] = [];
	const runnableCalls: PreparedToolCall[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			// 立即返回结果（例如：工具未找到或被阻止）
			results.push(await emitToolCallOutcome(toolCall, preparation.result, preparation.isError, emit));
		} else {
			// 添加到可运行调用列表
			runnableCalls.push(preparation);
		}
	}

	// 并发启动所有可运行调用
	const runningCalls = runnableCalls.map((prepared) => ({
		prepared,
		execution: executePreparedToolCall(prepared, signal, emit),
	}));

	// 按顺序等待每个调用完成并最终化
	for (const running of runningCalls) {
		const executed = await running.execution;
		results.push(
			await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				running.prepared,
				executed,
				config,
				signal,
				emit,
			),
		);
	}

	return results;
}

/**
 * 已准备好的工具调用类型
 */
type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

/**
 * 立即工具调用结果类型（无需执行）
 */
type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

/**
 * 已执行的工具调用结果类型
 */
type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
};

/**
 * 准备工具调用
 *
 * 验证参数，调用 beforeToolCall 钩子
 *
 * @param currentContext - 当前 Agent 上下文
 * @param assistantMessage - 包含工具调用的助手消息
 * @param toolCall - 要准备的工具调用
 * @param config - Agent 循环配置
 * @param signal - 可选的中止信号
 * @returns 准备结果：要么立即返回结果，要么返回已准备好的调用
 */
async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	// 查找工具
	const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	try {
		// 验证工具参数
		const validatedArgs = validateToolArguments(tool, toolCall);

		// 调用 beforeToolCall 钩子
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			// 检查是否阻止工具执行
			if (beforeResult?.block) {
				return {
					kind: "immediate",
					result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
					isError: true,
				};
			}
		}
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
		};
	} catch (error) {
		// 验证失败或 beforeToolCall 钩子出错
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

/**
 * 执行已准备好的工具调用
 *
 * @param prepared - 已准备好的工具调用
 * @param signal - 可选的中止信号
 * @param emit - 事件发送函数
 * @returns 工具调用执行结果
 */
async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
	const updateEvents: Promise<void>[] = [];

	try {
		// 执行工具，捕获增量更新事件
		const result = await prepared.tool.execute(
			prepared.toolCall.id,
			prepared.args as never,
			signal,
			(partialResult) => {
				updateEvents.push(
					Promise.resolve(
						emit({
							type: "tool_execution_update",
							toolCallId: prepared.toolCall.id,
							toolName: prepared.toolCall.name,
							args: prepared.toolCall.arguments,
							partialResult,
						}),
					),
				);
			},
		);
		// 等待所有增量更新事件发送完成
		await Promise.all(updateEvents);
		return { result, isError: false };
	} catch (error) {
		// 工具执行出错
		await Promise.all(updateEvents);
		return {
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

/**
 * 最终化已执行的工具调用
 *
 * 调用 afterToolCall 钩子，发出最终事件
 *
 * @param currentContext - 当前 Agent 上下文
 * @param assistantMessage - 包含工具调用的助手消息
 * @param prepared - 已准备好的工具调用
 * @param executed - 已执行的工具调用结果
 * @param config - Agent 循环配置
 * @param signal - 可选的中止信号
 * @param emit - 事件发送函数
 * @returns 最终的工具结果消息
 */
async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ToolResultMessage> {
	let result = executed.result;
	let isError = executed.isError;

	// 调用 afterToolCall 钩子
	if (config.afterToolCall) {
		const afterResult = await config.afterToolCall(
			{
				assistantMessage,
				toolCall: prepared.toolCall,
				args: prepared.args,
				result,
				isError,
				context: currentContext,
			},
			signal,
		);
		// 应用覆盖
		if (afterResult) {
			result = {
				content: afterResult.content ?? result.content,
				details: afterResult.details ?? result.details,
			};
			isError = afterResult.isError ?? isError;
		}
	}

	return await emitToolCallOutcome(prepared.toolCall, result, isError, emit);
}

/**
 * 创建错误工具结果
 *
 * @param message - 错误消息
 * @returns 工具结果对象
 */
function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

/**
 * 发出工具调用结果
 *
 * @param toolCall - 工具调用对象
 * @param result - 工具结果对象
 * @param isError - 是否是错误结果
 * @param emit - 事件发送函数
 * @returns 工具结果消息
 */
async function emitToolCallOutcome(
	toolCall: AgentToolCall,
	result: AgentToolResult<any>,
	isError: boolean,
	emit: AgentEventSink,
): Promise<ToolResultMessage> {
	await emit({
		type: "tool_execution_end",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		result,
		isError,
	});

	const toolResultMessage: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: result.content,
		details: result.details,
		isError,
		timestamp: Date.now(),
	};

	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
	return toolResultMessage;
}
