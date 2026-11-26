export function formatMoney(amountCents: number, currency = "USD"): string {
	const formatted = (amountCents / 100).toFixed(2)
	if (currency === "EUR") return `€${formatted}`
	if (currency === "USD") return `$${formatted}`
	return `${currency} ${formatted}`
}
