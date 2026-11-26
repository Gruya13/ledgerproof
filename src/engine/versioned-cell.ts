export type CasResult<T> =
	| { ok: true; version: number; value: T }
	| { ok: false; reason: "cas.rejected"; expectedVersion: number; currentVersion: number; currentValue: T }

export class VersionedCell<T> {
	private version = 1
	private value: T

	constructor(initialValue: T) {
		this.value = structuredClone(initialValue)
	}

	read(): { version: number; value: T } {
		return {
			version: this.version,
			value: structuredClone(this.value),
		}
	}

	casWrite(expectedVersion: number, mutator: (current: T) => T): CasResult<T> {
		if (expectedVersion !== this.version) {
			return {
				ok: false,
				reason: "cas.rejected",
				expectedVersion,
				currentVersion: this.version,
				currentValue: structuredClone(this.value),
			}
		}

		const next = mutator(structuredClone(this.value))
		this.version += 1
		this.value = structuredClone(next)

		return {
			ok: true,
			version: this.version,
			value: structuredClone(this.value),
		}
	}
}
