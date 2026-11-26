import type { InferenceRunner } from "@mozaik-ai/core"
import { DeepSeekInferenceRunner } from "./deepseek-runner"
import { MockInferenceRunner } from "./mock-runner"

export interface ResolvedProvider {
	mode: "mock" | "live"
	provider: "mock" | "deepseek" | "openai" | "anthropic" | "gemini"
	modelName: string
	runner?: InferenceRunner
	useNativeRunner: boolean
	label: string
}

export function resolveMockProvider(): ResolvedProvider {
	return {
		mode: "mock",
		provider: "mock",
		modelName: "deepseek-chat",
		runner: new MockInferenceRunner(),
		useNativeRunner: false,
		label: "Offline MockInferenceRunner (0 API keys)",
	}
}

export function resolveLiveProviderFromEnv(
	env: Record<string, string | undefined> = process.env,
): ResolvedProvider | null {
	const deepseekKey = env.DEEPSEEK_API_KEY?.trim()
	if (deepseekKey) {
		const model = env.DEEPSEEK_MODEL?.trim() || "deepseek-chat"
		const baseURL = env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com/v1"
		return {
			mode: "live",
			provider: "deepseek",
			modelName: model,
			runner: new DeepSeekInferenceRunner({ apiKey: deepseekKey, baseURL, model }),
			useNativeRunner: false,
			label: `DeepSeek (${model})`,
		}
	}

	const openaiKey = env.OPENAI_API_KEY?.trim()
	if (openaiKey) {
		const model = env.OPENAI_MODEL?.trim() || "gpt-5.4-mini"
		return {
			mode: "live",
			provider: "openai",
			modelName: model,
			runner: undefined,
			useNativeRunner: true,
			label: `OpenAI (${model})`,
		}
	}

	const anthropicKey = env.ANTHROPIC_API_KEY?.trim()
	if (anthropicKey) {
		const model = env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-6"
		return {
			mode: "live",
			provider: "anthropic",
			modelName: model,
			runner: undefined,
			useNativeRunner: true,
			label: `Anthropic (${model})`,
		}
	}

	const geminiKey = env.GEMINI_API_KEY?.trim()
	if (geminiKey) {
		const model = env.GEMINI_MODEL?.trim() || "gemini-3.5-flash"
		return {
			mode: "live",
			provider: "gemini",
			modelName: model,
			runner: undefined,
			useNativeRunner: true,
			label: `Gemini (${model})`,
		}
	}

	return null
}
