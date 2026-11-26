import { describe, expect, it } from "vitest"
import { VersionedCell } from "../src/engine/versioned-cell"

describe("VersionedCell CAS invariants", () => {
	it("increments version on valid CAS write and rejects stale writers (write-skew prevention)", () => {
		const cell = new VersionedCell({ status: "OPEN", amountCents: 31000 })

		const snapA = cell.read()
		const snapB = cell.read()
		expect(snapA.version).toBe(1)
		expect(snapB.version).toBe(1)

		const winA = cell.casWrite(snapA.version, (cur) => ({ ...cur, status: "HOLD_RISK" }))
		expect(winA.ok).toBe(true)
		if (winA.ok) {
			expect(winA.version).toBe(2)
			expect(winA.value.status).toBe("HOLD_RISK")
		}

		const loseB = cell.casWrite(snapB.version, (cur) => ({ ...cur, status: "REFUNDED" }))
		expect(loseB.ok).toBe(false)
		if (!loseB.ok) {
			expect(loseB.reason).toBe("cas.rejected")
			expect(loseB.currentVersion).toBe(2)
			expect(loseB.currentValue.status).toBe("HOLD_RISK")
		}
	})

	it("returns defensive clones so external mutations do not corrupt stored cell state", () => {
		const cell = new VersionedCell({ tags: ["initial"] })
		const snap = cell.read()
		snap.value.tags.push("tampered")
		expect(cell.read().value.tags).toEqual(["initial"])
	})
})
