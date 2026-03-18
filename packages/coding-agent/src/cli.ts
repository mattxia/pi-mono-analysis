#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli.ts [args...]
 */

// 设置进程标题，方便系统任务管理器识别
process.title = "pi";

// 导入AWS Bedrock提供商动态注册工具
import { setBedrockProviderModule } from "@mariozechner/pi-ai";
// 导入Bedrock提供商模块实现
import { bedrockProviderModule } from "@mariozechner/pi-ai/bedrock-provider";
// 导入系统代理支持工具，自动适配HTTP_PROXY/HTTPS_PROXY环境变量
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
// 导入CLI主逻辑入口
import { main } from "./main.js";

// 配置全局HTTP请求代理，自动遵循系统代理设置
// 支持HTTP_PROXY、HTTPS_PROXY、NO_PROXY等标准环境变量
setGlobalDispatcher(new EnvHttpProxyAgent());

// 动态注册Bedrock提供商模块
// 采用动态注册模式，减小核心包体积，未使用Bedrock的用户可以按需加载
setBedrockProviderModule(bedrockProviderModule);

// 启动CLI主逻辑，传入用户输入的命令行参数
// 去掉前两个参数（node执行路径和当前脚本路径）
main(process.argv.slice(2));
