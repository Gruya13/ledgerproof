import OpenAI from "openai"
import {
	DeveloperMessageItem,
	FunctionCallItem,
	FunctionCallOutputItem,
	ModelMessageItem,
	SemanticEvent,
	SystemMessageItem,
	UserMessageItem,
	type InferenceInput,
	type InferenceOutput,
	type InferenceRunner,
} from "@mozaik-ai/core"

export interface DeepSeekConfig {
	apiKey: string
	baseURL?: string
	model?: string
}

/**
 * OpenAI-compatible InferenceRunner targeting DeepSeek Chat Completions API.
 * Ready for live execution when DEEPSEEK_API_KEY is supplied.
 */
export class DeepSeekInferenceRunner implements InferenceRunner {
	private readonly client: OpenAI
	private readonly defaultModel: string

	constructor(config: DeepSeekConfig) {
		this.client = new OpenAI({
			apiKey: config.apiKey,
			baseURL: config.baseURL ?? "https://api.deepseek.com/v1",
		})
		this.defaultModel = config.model ?? "deepseek-chat"
	}

	async run(input: InferenceInput): Promise<InferenceOutput> {
		const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = []

		for (const item of input.context.getItems()) {
			if (item instanceof SystemMessageItem) {
				messages.push({ role: "system", content: item.content.text })
			} else if (item instanceof DeveloperMessageItem) {
				messages.push({ role: "system", content: item.content.text })
			} else if (item instanceof UserMessageItem) {
				messages.push({ role: "user", content: item.content.text })
			} else if (item instanceof ModelMessageItem) {
				messages.push({ role: "assistant", content: item.content.text })
			} else if (item instanceof FunctionCallItem) {
				messages.push({
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: item.callId,
							type: "function",
							function: {
								name: item.name,
								arguments: item.args,
							},
						},
					],
				})
			} else if (item instanceof FunctionCallOutputItem) {
				messages.push({
					role: "tool",
					tool_call_id: item.callId,
					content: item.output.text,
				})
			}
		}

		const tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined = input.tools?.length
			? input.tools.map((t) => ({
					type: "function",
					function: {
						name: t.name,
						description: t.description,
						parameters: t.parameters,
					},
				}))
			: undefined

		const response = await this.client.chat.completions.create({
			model: input.model || this.defaultModel,
			messages,
			tools,
		})

		const choice = response.choices[0]
		const msg = choice?.message
		const items: InferenceOutput["items"] = []

		if (msg?.tool_calls && msg.tool_calls.length > 0) {
			for (const tc of msg.tool_calls) {
				if (tc.type === "function") {
					items.push(
						FunctionCallItem.rehydrate({
							callId: tc.id,
							name: tc.function.name,
							args: tc.function.arguments,
						}),
					)
				}
			}
		} else {
			items.push(
				ModelMessageItem.rehydrate({
					text: msg?.content ?? "",
				}),
			)
		}

		return {
			items,
			tokenUsage: undefined,
			rowResponse: response,
		}
	}

	async *stream(input: InferenceInput): AsyncGenerator<SemanticEvent> {
		yield SemanticEvent.create("inference.output", input.model, await this.run(input))
	}
}
