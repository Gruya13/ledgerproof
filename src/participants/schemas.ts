export const CITATION_ARRAY_SCHEMA = {
	type: "array",
	description:
		"Machine-checked citations. Each item MUST reference an exact sourceId, field name, and exact expectedValue from the JSON input.",
	items: {
		type: "object",
		properties: {
			sourceId: { type: "string", description: "Exact sourceId, e.g. INV-1006, TX-2006, REQ-3002, VND-04" },
			field: { type: "string", description: "Exact field name on that source record, e.g. amountCents, targetIban, masterIban, poNumber" },
			expectedValue: {
				description: "Exact value of that field (integer for amountCents, string for IBAN/poNumber)",
			},
		},
		required: ["sourceId", "field", "expectedValue"],
	},
} as const
