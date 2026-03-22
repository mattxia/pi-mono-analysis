/**
 * 自定义 Anthropic API 测试配置文件
 *
 * 此文件集中管理测试配置，便于多个测试文件引用
 *
 * 使用方法：
 * 1. 设置环境变量：
 *    $env:CUSTOM_ANTHROPIC_BASE_URL="https://你的 API 地址"
 *    $env:CUSTOM_ANTHROPIC_API_KEY="你的 API key"
 *    $env:CUSTOM_ANTHROPIC_MODEL="你的模型 ID"
 *
 * 2. 在测试文件中导入：
 *    import { CUSTOM_CONFIG } from "./custom-anthropic-config.js";
 */

/** 自定义 Anthropic API 配置接口 */
export interface CustomAnthropicConfig {
	/** API 基础 URL */
	baseUrl: string;
	/** API 密钥 */
	apiKey: string;
	/** 模型 ID */
	modelId: string;
}

/** 默认配置 */
export const CUSTOM_CONFIG: CustomAnthropicConfig = {
	baseUrl: process.env.CUSTOM_ANTHROPIC_BASE_URL || "https://coding.dashscope.aliyuncs.com/apps/anthropic",
	apiKey: process.env.CUSTOM_ANTHROPIC_API_KEY || "",
	modelId: process.env.CUSTOM_ANTHROPIC_MODEL || "kimi-k2.5",
};

/** 快速访问常量 */
export const CUSTOM_BASE_URL = CUSTOM_CONFIG.baseUrl;
export const CUSTOM_API_KEY = CUSTOM_CONFIG.apiKey;
export const MODEL_ID = CUSTOM_CONFIG.modelId;
