/**
 * 代理流式函数，用于通过服务器路由 LLM 调用的应用。
 * 服务器管理认证并代理请求到 LLM 提供商。
 */

// 内部导入用于 JSON 解析工具
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	EventStream,
	type Model,
	parseStreamingJson,
	type SimpleStreamOptions,
	type StopReason,
	type ToolCall,
} from "@mariozechner/pi-ai";

/**
 * 代理消息事件流类
 *
 * 继承自 EventStream，专门用于处理代理服务器返回的消息事件
 */
class ProxyMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			// 终止条件：当事件类型为 "done" 或 "error" 时结束流
			(event) => event.type === "done" || event.type === "error",
			// 结果提取：从事件中提取最终的 AssistantMessage
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

/**
 * 代理事件类型 - 服务器发送这些事件时会剥离 partial 字段以减少带宽
 */
export type ProxyAssistantMessageEvent =
	| { type: "start" }
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; contentSignature?: string }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "thinking_end"; contentIndex: number; contentSignature?: string }
	| { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_end"; contentIndex: number }
	| {
			type: "done";
			reason: Extract<StopReason, "stop" | "length" | "toolUse">;
			usage: AssistantMessage["usage"];
	  }
	| {
			type: "error";
			reason: Extract<StopReason, "aborted" | "error">;
			errorMessage?: string;
			usage: AssistantMessage["usage"];
	  };

/**
 * 代理流式选项接口
 *
 * 扩展自 SimpleStreamOptions，添加了代理服务器特定的配置
 */
export interface ProxyStreamOptions extends SimpleStreamOptions {
	/** 代理服务器的认证令牌 */
	authToken: string;
	/** 代理服务器 URL（例如 "https://genai.example.com"） */
	proxyUrl: string;
}

/**
 * 代理流式函数，通过服务器代理而不是直接调用 LLM 提供商
 *
 * 服务器从增量事件中剥离 partial 字段以减少带宽。
 * 我们在客户端重建 partial 消息。
 *
 * 将此用作创建需要通过代理的 Agent 时的 `streamFn` 选项。
 *
 * @example
 * ```typescript
 * const agent = new Agent({
 *   streamFn: (model, context, options) =>
 *     streamProxy(model, context, {
 *       ...options,
 *       authToken: await getAuthToken(),
 *       proxyUrl: "https://genai.example.com",
 *     }),
 * });
 * ```
 */
export function streamProxy(model: Model<any>, context: Context, options: ProxyStreamOptions): ProxyMessageEventStream {
	const stream = new ProxyMessageEventStream();

	// 使用异步 IIFE 启动流式处理
	(async () => {
		// 初始化我们将从事件中构建的 partial 消息
		const partial: AssistantMessage = {
			role: "assistant",
			stopReason: "stop",
			content: [],
			api: model.api,
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
			timestamp: Date.now(),
		};

		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

		// 中止处理函数
		const abortHandler = () => {
			if (reader) {
				reader.cancel("Request aborted by user").catch(() => {});
			}
		};

		// 注册中止信号监听器
		if (options.signal) {
			options.signal.addEventListener("abort", abortHandler);
		}

		try {
			// 发送请求到代理服务器
			const response = await fetch(`${options.proxyUrl}/api/stream`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${options.authToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model,
					context,
					options: {
						temperature: options.temperature,
						maxTokens: options.maxTokens,
						reasoning: options.reasoning,
					},
				}),
				signal: options.signal,
			});

			// 检查响应状态
			if (!response.ok) {
				let errorMessage = `Proxy error: ${response.status} ${response.statusText}`;
				try {
					const errorData = (await response.json()) as { error?: string };
					if (errorData.error) {
						errorMessage = `Proxy error: ${errorData.error}`;
					}
				} catch {
					// 无法解析错误响应
				}
				throw new Error(errorMessage);
			}

			// 获取响应流读取器
			reader = response.body!.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			// 处理流式数据
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				// 检查是否已被中止
				if (options.signal?.aborted) {
					throw new Error("Request aborted by user");
				}

				// 解码数据并添加到缓冲区
				buffer += decoder.decode(value, { stream: true });
				// 按行分割
				const lines = buffer.split("\n");
				// 保存不完整的最后一行到缓冲区
				buffer = lines.pop() || "";

				// 处理每一行
				for (const line of lines) {
					// 只处理 Server-Sent Events (SSE) 格式的 data: 行
					if (line.startsWith("data: ")) {
						const data = line.slice(6).trim();
						if (data) {
							// 解析代理事件并处理
							const proxyEvent = JSON.parse(data) as ProxyAssistantMessageEvent;
							const event = processProxyEvent(proxyEvent, partial);
							if (event) {
								stream.push(event);
							}
						}
					}
				}
			}

			// 再次检查是否已被中止
			if (options.signal?.aborted) {
				throw new Error("Request aborted by user");
			}

			// 正常结束流
			stream.end();
		} catch (error) {
			// 处理错误
			const errorMessage = error instanceof Error ? error.message : String(error);
			const reason = options.signal?.aborted ? "aborted" : "error";
			partial.stopReason = reason;
			partial.errorMessage = errorMessage;
			// 推送错误事件
			stream.push({
				type: "error",
				reason,
				error: partial,
			});
			stream.end();
		} finally {
			// 清理：移除中止信号监听器
			if (options.signal) {
				options.signal.removeEventListener("abort", abortHandler);
			}
		}
	})();

	return stream;
}

/**
 * 处理代理事件并更新 partial 消息
 *
 * 将代理服务器发送的简化事件转换为完整的 AssistantMessageEvent，
 * 并在客户端重建 partial 消息对象。
 *
 * @param proxyEvent - 代理服务器发送的事件
 * @param partial - 正在构建的 partial 消息对象
 * @returns 转换后的 AssistantMessageEvent，如果不需要推送则返回 undefined
 */
function processProxyEvent(
	proxyEvent: ProxyAssistantMessageEvent,
	partial: AssistantMessage,
): AssistantMessageEvent | undefined {
	switch (proxyEvent.type) {
		case "start":
			// 流式开始事件
			return { type: "start", partial };

		case "text_start":
			// 文本内容块开始
			partial.content[proxyEvent.contentIndex] = { type: "text", text: "" };
			return { type: "text_start", contentIndex: proxyEvent.contentIndex, partial };

		case "text_delta": {
			// 文本增量
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "text") {
				content.text += proxyEvent.delta;
				return {
					type: "text_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received text_delta for non-text content");
		}

		case "text_end": {
			// 文本内容块结束
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "text") {
				content.textSignature = proxyEvent.contentSignature;
				return {
					type: "text_end",
					contentIndex: proxyEvent.contentIndex,
					content: content.text,
					partial,
				};
			}
			throw new Error("Received text_end for non-text content");
		}

		case "thinking_start":
			// 思考内容块开始
			partial.content[proxyEvent.contentIndex] = { type: "thinking", thinking: "" };
			return { type: "thinking_start", contentIndex: proxyEvent.contentIndex, partial };

		case "thinking_delta": {
			// 思考增量
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "thinking") {
				content.thinking += proxyEvent.delta;
				return {
					type: "thinking_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received thinking_delta for non-thinking content");
		}

		case "thinking_end": {
			// 思考内容块结束
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "thinking") {
				content.thinkingSignature = proxyEvent.contentSignature;
				return {
					type: "thinking_end",
					contentIndex: proxyEvent.contentIndex,
					content: content.thinking,
					partial,
				};
			}
			throw new Error("Received thinking_end for non-thinking content");
		}

		case "toolcall_start":
			// 工具调用内容块开始
			partial.content[proxyEvent.contentIndex] = {
				type: "toolCall",
				id: proxyEvent.id,
				name: proxyEvent.toolName,
				arguments: {},
				partialJson: "",
			} satisfies ToolCall & { partialJson: string } as ToolCall;
			return { type: "toolcall_start", contentIndex: proxyEvent.contentIndex, partial };

		case "toolcall_delta": {
			// 工具调用增量（JSON 参数）
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "toolCall") {
				// 累积 partial JSON 字符串
				(content as any).partialJson += proxyEvent.delta;
				// 尝试解析 JSON 并更新 arguments
				content.arguments = parseStreamingJson((content as any).partialJson) || {};
				// 触发响应式更新
				partial.content[proxyEvent.contentIndex] = { ...content };
				return {
					type: "toolcall_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received toolcall_delta for non-toolCall content");
		}

		case "toolcall_end": {
			// 工具调用内容块结束
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "toolCall") {
				// 清理临时字段
				delete (content as any).partialJson;
				return {
					type: "toolcall_end",
					contentIndex: proxyEvent.contentIndex,
					toolCall: content,
					partial,
				};
			}
			return undefined;
		}

		case "done":
			// 流式完成
			partial.stopReason = proxyEvent.reason;
			partial.usage = proxyEvent.usage;
			return { type: "done", reason: proxyEvent.reason, message: partial };

		case "error":
			// 流式错误
			partial.stopReason = proxyEvent.reason;
			partial.errorMessage = proxyEvent.errorMessage;
			partial.usage = proxyEvent.usage;
			return { type: "error", reason: proxyEvent.reason, error: partial };

		default: {
			// 未处理的事件类型（类型安全检查）
			const _exhaustiveCheck: never = proxyEvent;
			console.warn(`Unhandled proxy event type: ${(proxyEvent as any).type}`);
			return undefined;
		}
	}
}
