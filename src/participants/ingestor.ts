import { createHuman } from "@mozaik-ai/core"

export function createIngestorParticipant() {
	return createHuman({
		name: "BlackFridayIngestor",
		capabilities: ["stream-ingestion", "late-event-injection"],
		handlers: [],
	})
}
