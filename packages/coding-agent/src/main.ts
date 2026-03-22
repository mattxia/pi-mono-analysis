/**
 * coding-agent CLI 的主入口文件
 *
 * 本文件负责处理 CLI 参数解析，并将参数转换为 createAgentSession() 的选项
 * 实际的重量级工作由 SDK（core/sdk.ts）完成
 */

// 导入 AI 提供商相关的类型和工具函数
import { type ImageContent, modelsAreEqual, supportsXhigh } from "@mariozechner/pi-ai";
// 终端彩色输出库
import chalk from "chalk";
// 命令行交互接口（用于确认提示）
import { createInterface } from "readline";
// CLI 参数解析和帮助信息打印
import { type Args, parseArgs, printHelp } from "./cli/args.js";
// 配置选择器（用于 config 命令）
import { selectConfig } from "./cli/config-selector.js";
// 文件参数处理（解析 @file 语法，提取文本和图片）
import { processFileArguments } from "./cli/file-processor.js";
// 模型列表查询（--list-models）
import { listModels } from "./cli/list-models.js";
// 会话选择器（--resume 时显示会话列表）
import { selectSession } from "./cli/session-picker.js";
// 应用配置常量（名称、版本、目录路径等）
import { APP_NAME, getAgentDir, getModelsPath, VERSION } from "./config.js";
// 认证信息存储（API Key、OAuth 令牌等）
import { AuthStorage } from "./core/auth-storage.js";
// 会话导出为 HTML
import { exportFromFile } from "./core/export-html/index.js";
// 扩展加载结果类型
import type { LoadExtensionsResult } from "./core/extensions/index.js";
// 快捷键管理器
import { KeybindingsManager } from "./core/keybindings.js";
// 模型注册表（管理所有可用的 LLM 提供商和模型）
import { ModelRegistry } from "./core/model-registry.js";
// 模型解析（将 CLI 的 --model 参数解析为具体模型配置）
import { resolveCliModel, resolveModelScope, type ScopedModel } from "./core/model-resolver.js";
// 包管理器（install/remove/update/list 命令）
import { DefaultPackageManager } from "./core/package-manager.js";
// 资源加载器（加载扩展、技能、提示模板、主题等）
import { DefaultResourceLoader } from "./core/resource-loader.js";
// AgentSession 创建选项和工厂函数（核心 SDK 入口）
import { type CreateAgentSessionOptions, createAgentSession } from "./core/sdk.js";
// 会话管理器（创建/打开/继续/分支会话）
import { SessionManager } from "./core/session-manager.js";
// 配置管理器（读取/写入用户和项目级 settings.json）
import { SettingsManager } from "./core/settings-manager.js";
// 性能计时工具
import { printTimings, time } from "./core/timings.js";
// 所有内置工具（bash、read、write、edit 等）
import { allTools } from "./core/tools/index.js";
// 数据迁移和弃用警告处理
import { runMigrations, showDeprecationWarnings } from "./migrations.js";
// 三种运行模式：交互式 TUI、打印模式、RPC 模式
import { InteractiveMode, runPrintMode, runRpcMode } from "./modes/index.js";
// 主题初始化和监听器停止
import { initTheme, stopThemeWatcher } from "./modes/interactive/theme/theme.js";

/**
 * 从管道 stdin 读取所有内容
 * 如果 stdin 是 TTY（交互式终端），则返回 undefined
 */
async function readPipedStdin(): Promise<string | undefined> {
	// 如果 stdin 是 TTY，说明是交互式运行，不读取 stdin
	if (process.stdin.isTTY) {
		return undefined;
	}

	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => {
			resolve(data.trim() || undefined);
		});
		process.stdin.resume();
	});
}

/**
 * 报告配置管理器中的错误
 * @param settingsManager 配置管理器实例
 * @param context 错误上下文（用于定位错误来源）
 */
function reportSettingsErrors(settingsManager: SettingsManager, context: string): void {
	const errors = settingsManager.drainErrors();
	for (const { scope, error } of errors) {
		console.error(chalk.yellow(`Warning (${context}, ${scope} settings): ${error.message}`));
		if (error.stack) {
			console.error(chalk.dim(error.stack));
		}
	}
}

/**
 * 判断环境变量是否为真值标志
 * @param value 环境变量值
 * @returns 如果是 "1"、"true" 或 "yes" 则返回 true
 */
function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

// 包管理命令类型（安装、移除、更新、列表）
type PackageCommand = "install" | "remove" | "update" | "list";

// 包管理命令选项接口
interface PackageCommandOptions {
	command: PackageCommand; // 命令类型
	source?: string; // 包来源（如 npm:package-name）
	local: boolean; // 是否仅作用于项目本地配置
	help: boolean; // 是否显示帮助
	invalidOption?: string; // 无效选项（用于错误提示）
}

/**
 * 获取包管理命令的使用说明字符串
 * @param command 命令类型
 * @returns 使用说明字符串
 */
function getPackageCommandUsage(command: PackageCommand): string {
	switch (command) {
		case "install":
			return `${APP_NAME} install <source> [-l]`;
		case "remove":
			return `${APP_NAME} remove <source> [-l]`;
		case "update":
			return `${APP_NAME} update [source]`;
		case "list":
			return `${APP_NAME} list`;
	}
}

/**
 * 打印包管理命令的帮助信息
 * @param command 命令类型
 */
function printPackageCommandHelp(command: PackageCommand): void {
	switch (command) {
		case "install":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("install")}

Install a package and add it to settings.

Options:
  -l, --local    Install project-locally (.pi/settings.json)

Examples:
  ${APP_NAME} install npm:@foo/bar
  ${APP_NAME} install git:github.com/user/repo
  ${APP_NAME} install git:git@github.com:user/repo
  ${APP_NAME} install https://github.com/user/repo
  ${APP_NAME} install ssh://git@github.com/user/repo
  ${APP_NAME} install ./local/path
`);
			return;

		case "remove":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("remove")}

Remove a package and its source from settings.
Alias: ${APP_NAME} uninstall <source> [-l]

Options:
  -l, --local    Remove from project settings (.pi/settings.json)

Examples:
  ${APP_NAME} remove npm:@foo/bar
  ${APP_NAME} uninstall npm:@foo/bar
`);
			return;

		case "update":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("update")}

Update installed packages.
If <source> is provided, only that package is updated.
`);
			return;

		case "list":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("list")}

List installed packages from user and project settings.
`);
			return;
	}
}

/**
 * 解析包管理命令的参数
 * @param args 命令行参数数组
 * @returns 解析后的命令选项，如果无法解析则返回 undefined
 */
function parsePackageCommand(args: string[]): PackageCommandOptions | undefined {
	const [rawCommand, ...rest] = args;
	let command: PackageCommand | undefined;
	// 处理 uninstall 别名
	if (rawCommand === "uninstall") {
		command = "remove";
	} else if (rawCommand === "install" || rawCommand === "remove" || rawCommand === "update" || rawCommand === "list") {
		command = rawCommand;
	}
	if (!command) {
		return undefined;
	}

	let local = false;
	let help = false;
	let invalidOption: string | undefined;
	let source: string | undefined;

	// 解析剩余参数
	for (const arg of rest) {
		if (arg === "-h" || arg === "--help") {
			help = true;
			continue;
		}

		if (arg === "-l" || arg === "--local") {
			// -l 仅对 install/remove 有效
			if (command === "install" || command === "remove") {
				local = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		// 其他以 - 开头的选项视为无效
		if (arg.startsWith("-")) {
			invalidOption = invalidOption ?? arg;
			continue;
		}

		// 第一个非选项参数作为 source
		if (!source) {
			source = arg;
		}
	}

	return { command, source, local, help, invalidOption };
}

/**
 * 处理包管理命令（install/remove/update/list）
 * @param args 命令行参数
 * @returns 是否已处理该命令（true 表示是包管理命令，应退出）
 */
async function handlePackageCommand(args: string[]): Promise<boolean> {
	const options = parsePackageCommand(args);
	if (!options) {
		return false;
	}

	// 显示帮助信息
	if (options.help) {
		printPackageCommandHelp(options.command);
		return true;
	}

	// 报告无效选项
	if (options.invalidOption) {
		console.error(chalk.red(`Unknown option ${options.invalidOption} for "${options.command}".`));
		console.error(chalk.dim(`Use "${APP_NAME} --help" or "${getPackageCommandUsage(options.command)}".`));
		process.exitCode = 1;
		return true;
	}

	// 验证必需参数
	const source = options.source;
	if ((options.command === "install" || options.command === "remove") && !source) {
		console.error(chalk.red(`Missing ${options.command} source.`));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	// 初始化配置管理器和包管理器
	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	reportSettingsErrors(settingsManager, "package command");
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });

	// 设置进度回调
	packageManager.setProgressCallback((event) => {
		if (event.type === "start") {
			process.stdout.write(chalk.dim(`${event.message}\n`));
		}
	});

	try {
		switch (options.command) {
			case "install":
				// 安装包并添加到配置
				await packageManager.install(source!, { local: options.local });
				packageManager.addSourceToSettings(source!, { local: options.local });
				console.log(chalk.green(`Installed ${source}`));
				return true;

			case "remove": {
				// 移除包并从配置中删除
				await packageManager.remove(source!, { local: options.local });
				const removed = packageManager.removeSourceFromSettings(source!, { local: options.local });
				if (!removed) {
					console.error(chalk.red(`No matching package found for ${source}`));
					process.exitCode = 1;
					return true;
				}
				console.log(chalk.green(`Removed ${source}`));
				return true;
			}

			case "list": {
				// 列出所有已安装的包
				const globalSettings = settingsManager.getGlobalSettings();
				const projectSettings = settingsManager.getProjectSettings();
				const globalPackages = globalSettings.packages ?? [];
				const projectPackages = projectSettings.packages ?? [];

				if (globalPackages.length === 0 && projectPackages.length === 0) {
					console.log(chalk.dim("No packages installed."));
					return true;
				}

				// 格式化输出单个包信息
				const formatPackage = (pkg: (typeof globalPackages)[number], scope: "user" | "project") => {
					const source = typeof pkg === "string" ? pkg : pkg.source;
					const filtered = typeof pkg === "object";
					const display = filtered ? `${source} (filtered)` : source;
					console.log(`  ${display}`);
					const path = packageManager.getInstalledPath(source, scope);
					if (path) {
						console.log(chalk.dim(`    ${path}`));
					}
				};

				// 输出用户级包
				if (globalPackages.length > 0) {
					console.log(chalk.bold("User packages:"));
					for (const pkg of globalPackages) {
						formatPackage(pkg, "user");
					}
				}

				// 输出项目级包
				if (projectPackages.length > 0) {
					if (globalPackages.length > 0) console.log();
					console.log(chalk.bold("Project packages:"));
					for (const pkg of projectPackages) {
						formatPackage(pkg, "project");
					}
				}

				return true;
			}

			case "update":
				// 更新包
				await packageManager.update(source);
				if (source) {
					console.log(chalk.green(`Updated ${source}`));
				} else {
					console.log(chalk.green("Updated packages"));
				}
				return true;
		}
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "Unknown package command error";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
}

/**
 * 处理文件参数，准备初始消息
 * 解析 @file 参数，提取文本内容和图片，合并到初始消息中
 * @param parsed 解析后的 CLI 参数
 * @param autoResizeImages 是否自动调整图片大小以适配模型上下文窗口
 * @returns 包含初始消息和图片的对象
 */
async function prepareInitialMessage(
	parsed: Args,
	autoResizeImages: boolean,
): Promise<{
	initialMessage?: string;
	initialImages?: ImageContent[];
}> {
	if (parsed.fileArgs.length === 0) {
		return {};
	}

	// 处理所有 @file 参数，提取文本和图片
	const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages });

	let initialMessage: string;
	// 如果有额外的消息参数，合并到初始消息
	if (parsed.messages.length > 0) {
		initialMessage = text + parsed.messages[0];
		parsed.messages.shift();
	} else {
		initialMessage = text;
	}

	return {
		initialMessage,
		initialImages: images.length > 0 ? images : undefined,
	};
}

/** 会话参数解析结果类型 */
type ResolvedSession =
	| { type: "path"; path: string } // 直接文件路径
	| { type: "local"; path: string } // 在当前项目中找到
	| { type: "global"; path: string; cwd: string } // 在其他项目中找到
	| { type: "not_found"; arg: string }; // 未找到

/**
 * 将会话参数解析为文件路径
 * 如果看起来像路径则直接使用，否则尝试匹配会话 ID 前缀
 * @param sessionArg 会话参数（可以是路径或会话 ID 前缀）
 * @param cwd 当前工作目录
 * @param sessionDir 自定义会话目录
 * @returns 解析结果
 */
async function resolveSessionPath(sessionArg: string, cwd: string, sessionDir?: string): Promise<ResolvedSession> {
	// 如果看起来像文件路径，直接使用
	if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
		return { type: "path", path: sessionArg };
	}

	// 首先在当前项目中尝试匹配会话 ID
	const localSessions = await SessionManager.list(cwd, sessionDir);
	const localMatches = localSessions.filter((s) => s.id.startsWith(sessionArg));

	if (localMatches.length >= 1) {
		return { type: "local", path: localMatches[0].path };
	}

	// 如果本地未找到，尝试在所有项目中全局搜索
	const allSessions = await SessionManager.listAll();
	const globalMatches = allSessions.filter((s) => s.id.startsWith(sessionArg));

	if (globalMatches.length >= 1) {
		const match = globalMatches[0];
		return { type: "global", path: match.path, cwd: match.cwd };
	}

	// 未找到匹配
	return { type: "not_found", arg: sessionArg };
}

/**
 * 提示用户进行是/否确认
 * @param message 提示信息
 * @returns 用户是否确认
 */
async function promptConfirm(message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
		});
	});
}

/**
 * 调用扩展的 session_directory 钩子
 * 在创建会话管理器之前，允许扩展自定义会话目录
 * @param extensions 已加载的扩展列表
 * @param cwd 当前工作目录
 * @returns 自定义会话目录路径，如果没有扩展提供则返回 undefined
 */
async function callSessionDirectoryHook(extensions: LoadExtensionsResult, cwd: string): Promise<string | undefined> {
	let customSessionDir: string | undefined;

	for (const ext of extensions.extensions) {
		const handlers = ext.handlers.get("session_directory");
		if (!handlers || handlers.length === 0) continue;

		for (const handler of handlers) {
			try {
				const event = { type: "session_directory" as const, cwd };
				const result = (await handler(event)) as { sessionDir?: string } | undefined;

				if (result?.sessionDir) {
					customSessionDir = result.sessionDir;
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				console.error(chalk.red(`Extension "${ext.path}" session_directory handler failed: ${message}`));
			}
		}
	}

	return customSessionDir;
}

/**
 * 创建会话管理器
 * 根据 CLI 参数决定创建、打开、继续或分支会话
 * @param parsed 解析后的 CLI 参数
 * @param cwd 当前工作目录
 * @param extensions 已加载的扩展列表
 * @returns 会话管理器实例，如果不需要持久化则返回 undefined
 */
async function createSessionManager(
	parsed: Args,
	cwd: string,
	extensions: LoadExtensionsResult,
): Promise<SessionManager | undefined> {
	if (parsed.noSession) {
		// --no-session：使用内存会话（不持久化）
		return SessionManager.inMemory();
	}

	// CLI 标志优先，否则询问扩展是否有自定义会话目录
	let effectiveSessionDir = parsed.sessionDir;
	if (!effectiveSessionDir) {
		effectiveSessionDir = await callSessionDirectoryHook(extensions, cwd);
	}

	if (parsed.session) {
		// --session：打开指定会话
		const resolved = await resolveSessionPath(parsed.session, cwd, effectiveSessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
				return SessionManager.open(resolved.path, effectiveSessionDir);

			case "global": {
				// 会话在不同项目中找到 - 询问用户是否要分支
				console.log(chalk.yellow(`Session found in different project: ${resolved.cwd}`));
				const shouldFork = await promptConfirm("Fork this session into current directory?");
				if (!shouldFork) {
					console.log(chalk.dim("Aborted."));
					process.exit(0);
				}
				return SessionManager.forkFrom(resolved.path, cwd, effectiveSessionDir);
			}

			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}
	if (parsed.continue) {
		// --continue：继续最近的会话
		return SessionManager.continueRecent(cwd, effectiveSessionDir);
	}
	// --resume 单独处理（需要选择器 UI）
	// 如果设置了有效的会话目录，在那里创建新会话
	if (effectiveSessionDir) {
		return SessionManager.create(cwd, effectiveSessionDir);
	}
	// 默认情况（新会话）返回 undefined，由 SDK 创建
	return undefined;
}

/**
 * 构建 AgentSession 的创建选项
 * 将 CLI 参数转换为 createAgentSession() 所需的配置
 * @param parsed 解析后的 CLI 参数
 * @param scopedModels 作用域内的模型列表（用于 Ctrl+P 切换）
 * @param sessionManager 会话管理器
 * @param modelRegistry 模型注册表
 * @param settingsManager 配置管理器
 * @returns 会话选项和 CLI thinking 标志
 */
function buildSessionOptions(
	parsed: Args,
	scopedModels: ScopedModel[],
	sessionManager: SessionManager | undefined,
	modelRegistry: ModelRegistry,
	settingsManager: SettingsManager,
): { options: CreateAgentSessionOptions; cliThinkingFromModel: boolean } {
	const options: CreateAgentSessionOptions = {};
	let cliThinkingFromModel = false;

	// 设置会话管理器
	if (sessionManager) {
		options.sessionManager = sessionManager;
	}

	// 从 CLI 参数解析模型
	// - 支持 --provider <name> --model <pattern>
	// - 支持 --model <provider>/<pattern>
	if (parsed.model) {
		const resolved = resolveCliModel({
			cliProvider: parsed.provider,
			cliModel: parsed.model,
			modelRegistry,
		});
		if (resolved.warning) {
			console.warn(chalk.yellow(`Warning: ${resolved.warning}`));
		}
		if (resolved.error) {
			console.error(chalk.red(resolved.error));
			process.exit(1);
		}
		if (resolved.model) {
			options.model = resolved.model;
			// 允许 "--model <pattern>:<thinking>" 简写形式
			// 显式的 --thinking 优先级更高（稍后应用）
			if (!parsed.thinking && resolved.thinkingLevel) {
				options.thinkingLevel = resolved.thinkingLevel;
				cliThinkingFromModel = true;
			}
		}
	}

	// 如果没有指定模型但有作用域模型，使用保存的默认值或第一个作用域模型
	if (!options.model && scopedModels.length > 0 && !parsed.continue && !parsed.resume) {
		// 检查保存的默认模型是否在作用域内
		const savedProvider = settingsManager.getDefaultProvider();
		const savedModelId = settingsManager.getDefaultModel();
		const savedModel = savedProvider && savedModelId ? modelRegistry.find(savedProvider, savedModelId) : undefined;
		const savedInScope = savedModel ? scopedModels.find((sm) => modelsAreEqual(sm.model, savedModel)) : undefined;

		if (savedInScope) {
			options.model = savedInScope.model;
			// 使用作用域模型配置的 thinking 级别（如果显式设置）
			if (!parsed.thinking && savedInScope.thinkingLevel) {
				options.thinkingLevel = savedInScope.thinkingLevel;
			}
		} else {
			options.model = scopedModels[0].model;
			// 使用第一个作用域模型的 thinking 级别（如果显式设置）
			if (!parsed.thinking && scopedModels[0].thinkingLevel) {
				options.thinkingLevel = scopedModels[0].thinkingLevel;
			}
		}
	}

	// CLI 的 thinking 级别优先级最高（覆盖作用域模型的设置）
	if (parsed.thinking) {
		options.thinkingLevel = parsed.thinking;
	}

	// 设置作用域模型列表（用于 Ctrl+P 切换）
	// 如果模型模式中没有显式设置 thinking 级别，保持 undefined
	// undefined 表示"继承当前会话的 thinking 级别"
	if (scopedModels.length > 0) {
		options.scopedModels = scopedModels.map((sm) => ({
			model: sm.model,
			thinkingLevel: sm.thinkingLevel,
		}));
	}

	// API Key 从 CLI 传入 - 在 authStorage 中设置
	// （由调用者在 createAgentSession 之前处理）

	// 工具配置
	if (parsed.noTools) {
		// --no-tools：不使用任何内置工具
		// --tools 仍可以添加特定工具回来
		if (parsed.tools && parsed.tools.length > 0) {
			options.tools = parsed.tools.map((name) => allTools[name]);
		} else {
			options.tools = [];
		}
	} else if (parsed.tools) {
		// 仅使用 --tools 指定的工具
		options.tools = parsed.tools.map((name) => allTools[name]);
	}

	return { options, cliThinkingFromModel };
}

/**
 * 处理 config 命令
 * 启动交互式配置编辑器
 * @param args 命令行参数
 * @returns 是否已处理该命令
 */
async function handleConfigCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "config") {
		return false;
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	reportSettingsErrors(settingsManager, "config command");
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });

	const resolvedPaths = await packageManager.resolve();

	await selectConfig({
		resolvedPaths,
		settingsManager,
		cwd,
		agentDir,
	});

	process.exit(0);
}

/**
 * CLI 主入口函数
 * 处理所有命令行参数，初始化环境，并启动相应的运行模式
 * @param args 命令行参数数组（不包含 node 和脚本路径）
 */
export async function main(args: string[]) {
	// 检查离线模式（--offline 或 PI_OFFLINE 环境变量）
	const offlineMode = args.includes("--offline") || isTruthyEnvFlag(process.env.PI_OFFLINE);
	if (offlineMode) {
		process.env.PI_OFFLINE = "1";
		process.env.PI_SKIP_VERSION_CHECK = "1";
	}

	// 优先处理包管理命令（install/remove/update/list）
	if (await handlePackageCommand(args)) {
		return;
	}

	// 处理 config 命令
	if (await handleConfigCommand(args)) {
		return;
	}

	// 运行数据迁移（传递 cwd 用于项目本地的迁移）
	const { migratedAuthProviders: migratedProviders, deprecationWarnings } = runMigrations(process.cwd());

	// 第一遍解析：获取 --extension 路径，用于早期加载扩展
	const firstPass = parseArgs(args);

	// 早期加载扩展以发现它们的 CLI 标志
	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	reportSettingsErrors(settingsManager, "startup");
	const authStorage = AuthStorage.create();
	const modelRegistry = new ModelRegistry(authStorage, getModelsPath());

	// 创建资源加载器（加载扩展、技能、提示模板、主题等）
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		additionalExtensionPaths: firstPass.extensions,
		additionalSkillPaths: firstPass.skills,
		additionalPromptTemplatePaths: firstPass.promptTemplates,
		additionalThemePaths: firstPass.themes,
		noExtensions: firstPass.noExtensions,
		noSkills: firstPass.noSkills,
		noPromptTemplates: firstPass.noPromptTemplates,
		noThemes: firstPass.noThemes,
		systemPrompt: firstPass.systemPrompt,
		appendSystemPrompt: firstPass.appendSystemPrompt,
	});
	await resourceLoader.reload();
	time("resourceLoader.reload");

	// 获取扩展加载结果
	const extensionsResult: LoadExtensionsResult = resourceLoader.getExtensions();
	for (const { path, error } of extensionsResult.errors) {
		console.error(chalk.red(`Failed to load extension "${path}": ${error}`));
	}

	// 立即应用扩展中的待处理提供商注册
	// 这样它们在 AgentSession 创建之前就可用于模型解析
	for (const { name, config } of extensionsResult.runtime.pendingProviderRegistrations) {
		modelRegistry.registerProvider(name, config);
	}
	extensionsResult.runtime.pendingProviderRegistrations = [];

	// 收集扩展的 CLI 标志定义
	const extensionFlags = new Map<string, { type: "boolean" | "string" }>();
	for (const ext of extensionsResult.extensions) {
		for (const [name, flag] of ext.flags) {
			extensionFlags.set(name, { type: flag.type });
		}
	}

	// 第二遍解析：使用扩展标志定义解析完整参数
	const parsed = parseArgs(args, extensionFlags);

	// 将标志值传递给扩展运行时
	for (const [name, value] of parsed.unknownFlags) {
		extensionsResult.runtime.flagValues.set(name, value);
	}

	// 处理版本标志
	if (parsed.version) {
		console.log(VERSION);
		process.exit(0);
	}

	// 处理帮助标志
	if (parsed.help) {
		printHelp();
		process.exit(0);
	}

	// 处理模型列表查询
	if (parsed.listModels !== undefined) {
		const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
		await listModels(modelRegistry, searchPattern);
		process.exit(0);
	}

	// 读取管道 stdin 内容（如果有）- RPC 模式跳过（stdin 用于 JSON-RPC）
	if (parsed.mode !== "rpc") {
		const stdinContent = await readPipedStdin();
		if (stdinContent !== undefined) {
			// 强制使用打印模式（交互式模式需要 TTY 进行键盘输入）
			parsed.print = true;
			// 将 stdin 内容前置到消息列表
			parsed.messages.unshift(stdinContent);
		}
	}

	// 处理会话导出
	if (parsed.export) {
		let result: string;
		try {
			const outputPath = parsed.messages.length > 0 ? parsed.messages[0] : undefined;
			result = await exportFromFile(parsed.export, outputPath);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Failed to export session";
			console.error(chalk.red(`Error: ${message}`));
			process.exit(1);
		}
		console.log(`Exported to: ${result}`);
		process.exit(0);
	}

	// RPC 模式不支持 @file 参数
	if (parsed.mode === "rpc" && parsed.fileArgs.length > 0) {
		console.error(chalk.red("Error: @file arguments are not supported in RPC mode"));
		process.exit(1);
	}

	// 准备初始消息（处理 @file 参数）
	const { initialMessage, initialImages } = await prepareInitialMessage(parsed, settingsManager.getImageAutoResize());
	// 判断是否为交互式模式（非打印模式且未指定 mode）
	const isInteractive = !parsed.print && parsed.mode === undefined;
	const mode = parsed.mode || "text";
	initTheme(settingsManager.getTheme(), isInteractive);

	// 在交互式模式下显示弃用警告
	if (isInteractive && deprecationWarnings.length > 0) {
		await showDeprecationWarnings(deprecationWarnings);
	}

	// 解析作用域模型（用于 Ctrl+P 切换）
	let scopedModels: ScopedModel[] = [];
	const modelPatterns = parsed.models ?? settingsManager.getEnabledModels();
	if (modelPatterns && modelPatterns.length > 0) {
		scopedModels = await resolveModelScope(modelPatterns, modelRegistry);
	}

	// 根据 CLI 标志创建会话管理器
	let sessionManager = await createSessionManager(parsed, cwd, extensionsResult);

	// 处理 --resume：显示会话选择器
	if (parsed.resume) {
		// 初始化快捷键管理器，使会话选择器遵循用户配置
		KeybindingsManager.create();

		// 计算有效的会话目录（与 createSessionManager 相同的逻辑）
		const effectiveSessionDir = parsed.sessionDir || (await callSessionDirectoryHook(extensionsResult, cwd));

		// 显示会话选择器
		const selectedPath = await selectSession(
			(onProgress) => SessionManager.list(cwd, effectiveSessionDir, onProgress),
			SessionManager.listAll,
		);
		if (!selectedPath) {
			console.log(chalk.dim("No session selected"));
			stopThemeWatcher();
			process.exit(0);
		}
		sessionManager = SessionManager.open(selectedPath, effectiveSessionDir);
	}

	// 构建会话选项
	const { options: sessionOptions, cliThinkingFromModel } = buildSessionOptions(
		parsed,
		scopedModels,
		sessionManager,
		modelRegistry,
		settingsManager,
	);
	sessionOptions.authStorage = authStorage;
	sessionOptions.modelRegistry = modelRegistry;
	sessionOptions.resourceLoader = resourceLoader;

	// 处理 CLI --api-key（运行时覆盖，不持久化）
	if (parsed.apiKey) {
		if (!sessionOptions.model) {
			console.error(
				chalk.red("--api-key requires a model to be specified via --model, --provider/--model, or --models"),
			);
			process.exit(1);
		}
		authStorage.setRuntimeApiKey(sessionOptions.model.provider, parsed.apiKey);
	}

	// 创建 AgentSession 实例
	const { session, modelFallbackMessage } = await createAgentSession(sessionOptions);

	// 检查是否有可用模型
	if (!isInteractive && !session.model) {
		console.error(chalk.red("No models available."));
		console.error(chalk.yellow("\nSet an API key environment variable:"));
		console.error("  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, etc.");
		console.error(chalk.yellow(`\nOr create ${getModelsPath()}`));
		process.exit(1);
	}

	// 根据模型能力调整 thinking 级别
	// 适用于 --thinking <level> 和 --model <pattern>:<thinking>
	const cliThinkingOverride = parsed.thinking !== undefined || cliThinkingFromModel;
	if (session.model && cliThinkingOverride) {
		let effectiveThinking = session.thinkingLevel;
		if (!session.model.reasoning) {
			// 模型不支持推理，关闭 thinking
			effectiveThinking = "off";
		} else if (effectiveThinking === "xhigh" && !supportsXhigh(session.model)) {
			// 模型不支持 xhigh，降级为 high
			effectiveThinking = "high";
		}
		if (effectiveThinking !== session.thinkingLevel) {
			session.setThinkingLevel(effectiveThinking);
		}
	}

	// 根据模式启动相应的运行逻辑
	if (mode === "rpc") {
		// RPC 模式：JSON-RPC 服务
		await runRpcMode(session);
	} else if (isInteractive) {
		// 交互式 TUI 模式
		// 如果有作用域模型且开启了详细模式或非安静启动，显示模型列表
		if (scopedModels.length > 0 && (parsed.verbose || !settingsManager.getQuietStartup())) {
			const modelList = scopedModels
				.map((sm) => {
					const thinkingStr = sm.thinkingLevel ? `:${sm.thinkingLevel}` : "";
					return `${sm.model.id}${thinkingStr}`;
				})
				.join(", ");
			console.log(chalk.dim(`Model scope: ${modelList} ${chalk.gray("(Ctrl+P to cycle)")}`));
		}

		// 打印性能计时信息
		printTimings();
		// 创建并运行交互式模式
		const mode = new InteractiveMode(session, {
			migratedProviders,
			modelFallbackMessage,
			initialMessage,
			initialImages,
			initialMessages: parsed.messages,
			verbose: parsed.verbose,
		});
		await mode.run();
	} else {
		// 打印模式：发送请求后直接输出响应并退出
		await runPrintMode(session, {
			mode,
			messages: parsed.messages,
			initialMessage,
			initialImages,
		});
		stopThemeWatcher();
		// 等待 stdout 缓冲区排空
		if (process.stdout.writableLength > 0) {
			await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
		}
		process.exit(0);
	}
}
