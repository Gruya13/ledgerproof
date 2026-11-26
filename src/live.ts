import "dotenv/config"
import { resolveLiveProviderFromEnv } from "./engine/provider-factory"
import { runBlackFridayScenario } from "./runner-setup"

async function main(): Promise<void> {
	const resolved = resolveLiveProviderFromEnv()
	if (!resolved) {
		console.log("No live LLM API key is configured in .env.")
		console.log("Supported keys (checked in order): DEEPSEEK_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY.")
		console.log("Copy .env.example to .env and set one key, or run zero-key mode right now:")
		console.log("  npm run proof")
		console.log("  npm run demo -- --auto")
		console.log("  npm run ui")
		return
	}

	console.log(`Starting LedgerProof live mode with ${resolved.label}...`)
	console.log("Disclaimer: 100% synthetic data only. Not financial advice.\n")

	const state = await runBlackFridayScenario({
		runner: resolved.runner,
		useNativeRunner: resolved.useNativeRunner,
		modelName: resolved.modelName,
		log: (line) => console.log(line),
	})

	console.log(
		`\nCompleted live run (${resolved.label}). Peak concurrent loops: ${state.metrics.peakConcurrentLoops}, claims recorded: ${state.claims.length}`,
	)
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})
