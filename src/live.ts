import "dotenv/config"
import { DeepSeekInferenceRunner } from "./engine/deepseek-runner"
import { runBlackFridayScenario } from "./runner-setup"

async function main(): Promise<void> {
	const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
	if (!apiKey) {
		console.log("DEEPSEEK_API_KEY is not set in .env.")
		console.log("To run live DeepSeek inference, copy .env.example to .env and set DEEPSEEK_API_KEY.")
		console.log("To run the zero-API-key deterministic demo right now, execute: npm run demo")
		return
	}

	const model = process.env.DEEPSEEK_MODEL?.trim() || "deepseek-chat"
	const baseURL = process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com/v1"

	console.log(`Starting LedgerProof live mode with DeepSeek (${model})...`)
	console.log("Disclaimer: 100% synthetic data only. Not financial advice.\n")

	const runner = new DeepSeekInferenceRunner({ apiKey, baseURL, model })
	const state = await runBlackFridayScenario({
		runner,
		modelName: model,
		log: (line) => console.log(line),
	})

	console.log(
		`\nCompleted live run. Peak concurrent loops: ${state.metrics.peakConcurrentLoops}, claims recorded: ${state.claims.length}`,
	)
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})
