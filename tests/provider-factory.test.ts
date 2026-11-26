import { describe, expect, it } from "vitest"
import { resolveLiveProviderFromEnv, resolveMockProvider } from "../src/engine/provider-factory"

describe("Provider factory resolution", () => {
	it("returns null when no live provider keys are present", () => {
		expect(resolveLiveProviderFromEnv({})).toBeNull()
	})

	it("prioritizes DeepSeek over OpenAI, Anthropic, and Gemini when multiple keys exist", () => {
		const res = resolveLiveProviderFromEnv({
			DEEPSEEK_API_KEY: "ds-test",
			OPENAI_API_KEY: "oa-test",
			ANTHROPIC_API_KEY: "an-test",
			GEMINI_API_KEY: "ge-test",
		})
		expect(res?.provider).toBe("deepseek")
		expect(res?.useNativeRunner).toBe(false)
		expect(res?.runner).toBeDefined()
	})

	it("supports OpenAI, Anthropic, and Gemini native Mozaik runners", () => {
		const openai = resolveLiveProviderFromEnv({ OPENAI_API_KEY: "oa-test" })
		expect(openai?.provider).toBe("openai")
		expect(openai?.useNativeRunner).toBe(true)

		const anthropic = resolveLiveProviderFromEnv({ ANTHROPIC_API_KEY: "an-test" })
		expect(anthropic?.provider).toBe("anthropic")
		expect(anthropic?.useNativeRunner).toBe(true)

		const gemini = resolveLiveProviderFromEnv({ GEMINI_API_KEY: "ge-test" })
		expect(gemini?.provider).toBe("gemini")
		expect(gemini?.useNativeRunner).toBe(true)
	})

	it("creates an offline mock provider without any API keys", () => {
		const mock = resolveMockProvider()
		expect(mock.mode).toBe("mock")
		expect(mock.runner).toBeDefined()
	})
})
