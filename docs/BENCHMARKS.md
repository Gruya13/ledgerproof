# LedgerProof — Verified Benchmarks & Stress-Test Results

> **Compliance Notice:** LedgerProof uses **100% synthetic financial data** for demonstration only. Output is **not financial advice**.

- **Repository Commit Tested:** `0f1046d` (`@mozaik-ai/core@6.0.0`, Node `v26.13.1`)
- **Live LLM Provider:** DeepSeek (`deepseek-chat` via OpenAI-compatible adapter)
- **Deterministic Runner:** `MockInferenceRunner` (zero API keys required)

---

## 1. Automated CI & Local Suite (`MockInferenceRunner` + Security Suites)

Verified on commit `0f1046d` (and after adding documentation):

| Check | Outcome | Exact Coverage & Invariants Verified |
|---|---|---|
| `npm run typecheck` | Pass | Backend TypeScript (`tsc --noEmit`) + React UI (`tsc -p tsconfig.ui.json --noEmit`) |
| `npm run ui:build` | Pass | Production Vite bundle (`dist-ui/`) |
| `npm test` | **9 files / 26 tests passed** | Unit, E2E concurrency, HTTP/SSE API, Continuous Chaos Stream, L1 IBAN/vendor/kind/citation binding, ISO 13616 IBAN mod-97, immutable `SourceStore` enforcement, post-HITL staleness, refund balance checks, `<DbtrAgt>` XML |
| `npm run proof` | **`PROOF PASSED` (`12/12`)** | `18` peak concurrent loops, `22/22` finished, `10` deterministic `0`-token matches, `1` CAS conflict stopped, `1` L1 blocked, `1` `STALE` invalidation, `1` HITL routed, `0` invented numbers leaked |

---

## 2. 3× Consecutive Live Fixed-Pack Runs (`npm start` + `deepseek-chat`)

Three back-to-back live runs executed against the 12-invoice synthetic Black Friday pack (`INV-1001`..`INV-1012`) on commit `0f1046d` (`out/live-bench-run-{1,2,3}.log`):

| Run | GT Invoices Matched | Peak Concurrent Loops | Loops Completed | CAS Conflicts Stopped | Stale Invalidations | Human HITL Routed | L1 Blocked | Invented Numbers Leaked | Audit Entries |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **Run 1** | `12/12` | `21` | `22/22` | `1` (`INV-1011`) | `1` (`INV-1007`) | `1` (`REQ-3002`) | `0` | `0` | `36` |
| **Run 2** | `12/12` | `21` | `22/22` | `1` (`INV-1011`) | `1` (`INV-1007`) | `1` (`REQ-3002`) | `0` | `0` | `36` |
| **Run 3** | `12/12` | `20` | `22/22` | `1` (`INV-1011`) | `1` (`INV-1007`) | `1` (`REQ-3002`) | `0` | `0` | `36` |
| **Totals (`3×`)** | **`36/36` (`100%`)** | **`21` max** | **`66/66` (`100%`)** | **`3/3`** | **`3/3`** | **`3/3`** | `0` | **`0`** | `108` |

> **Honest Note on Live vs Mock `L1` Counts (`uncitedNumbersBlocked`):** `MockInferenceRunner` intentionally injects a planted `$319.99 / TX-9999` hallucination in `propose_refund` on `INV-1011` so `npm run proof` deterministically verifies ProofGate L1 rejection. On the small 12-invoice pack, `deepseek-chat` followed system instructions cleanly without inventing figures (`uncitedNumbersBlocked = 0`), while `ProofGate L2 CAS` (`INV-1011` race against `FRAUD_VELOCITY`) and `L3 HITL` (`REQ-3002` BEC IBAN mismatch) fired identically across all 3 runs (`3/3`). Live `ProofGate L1` interception is observed directly under high-volume randomized chaos in Section 3 below (`59` catches across `600` ticks).

---

## 3. 10×60-Tick Randomized Live Chaos Sweep (`600` Ticks Across `10` Seeds)

Ten isolated live worker processes running `ContinuousStreamGenerator` with `10` distinct prime seeds against `deepseek-chat` on commit `0f1046d` (`out/live-10x60-summary.json`):

- **Configuration:** `10` seeds × `60` ticks (`intervalMs = 650`, `trapCadence = 3`, `lateDelayMs = 7000`, `maxLlmCalls = 200`, worker concurrency `2`)
- **Execution Reliability:** **`10/10` runs succeeded** (`seedsFailed: 0`), **`0` LLM budget exhaustions**, total wall-clock time `233.2s`
- **Aggregate Totals:** `600` ticks, `200` injected scenarios, `614` invoices, `745/745` Mozaik loops finished (max `16` concurrent loops), `745` LLM calls, **`536` deterministic `0`-token matches**, **`135` verified ISO 20022 SEPA `pain.001` XML drafts**, **`59` L1 blocks**, **`3` L2 CAS write-skew stops**, **`71` L3 HITL routes**, **`14` Palimpsest `STALE` invalidations**, **`0` invented numbers leaked**

### 3.1 Per-Seed Breakdown (`60` Ticks Each)

| Seed | Invoices | Unfinished (`PARTIAL`) | Loops | Peak Concurrent | LLM Calls | 0-Token Matches | L1 Blocked | L2 CAS | STALE | HITL | SEPA `pain.001` XML | Leaked | Duration |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `104729` | 62 | 1 | 67/67 | 11 | 67 | 55 | 3 | 0 | 1 | 8 | 11 | 0 | 46.7s |
| `224737` | 61 | 0 | 79/79 | 16 | 79 | 53 | 7 | 1 | 1 | 7 | 16 | 0 | 46.0s |
| `350377` | 61 | 0 | 79/79 | 13 | 79 | 54 | 6 | 0 | 2 | 7 | 16 | 0 | 46.0s |
| `479909` | 62 | 1 | 80/80 | 10 | 80 | 54 | 5 | 1 | 1 | 6 | 16 | 0 | 45.9s |
| `611953` | 61 | 1 | 68/68 | 10 | 68 | 53 | 5 | 1 | 1 | 6 | 11 | 0 | 45.9s |
| `746773` | 61 | 0 | 81/81 | 11 | 81 | 53 | 8 | 0 | 2 | 7 | 16 | 0 | 45.9s |
| `882377` | 61 | 1 | 79/79 | 9 | 79 | 52 | 8 | 0 | 1 | 7 | 15 | 0 | 46.0s |
| `1020379` | 61 | 0 | 75/75 | 9 | 75 | 53 | 6 | 0 | 2 | 7 | 13 | 0 | 46.0s |
| `1159523` | 61 | 0 | 67/67 | 10 | 67 | 54 | 7 | 0 | 2 | 8 | 9 | 0 | 45.9s |
| `1299709` | 63 | 1 | 70/70 | 11 | 70 | 55 | 4 | 0 | 1 | 8 | 12 | 0 | 45.9s |
| **Total (`10×`)** | **614** | **5** | **745/745** | **16 max** | **745** | **536** | **59** | **3** | **14** | **71** | **135** | **0** | **233.2s wall** |

### 3.2 Ledger Status & Scenario Distribution (`614` Invoices / `200` Scenarios)

**Final Invoice Statuses:**
- `MATCHED`: `363`
- `SEPA_DRAFT_READY`: `135`
- `HOLD_RISK`: `73`
- `REFUNDED`: `20`
- `DUPLICATE`: `18`
- `PARTIAL`: `5` *(explained below)*

**Injected Scenarios (`200` total across all `11` chaos classes):**

| Scenario Class | Count |
|---|---:|
| `Overpayment` (`OVERPAYMENT_ANOMALY`) | 20 |
| `Legit High-Value Refund HITL` (0 risk flags) | 20 |
| `Orphan Wire` (`ORPHAN_TX`) | 19 |
| `Partial -> Late STALE` | 19 |
| `Legit High-Value SEPA HITL` (spaced IBAN / >limit) | 19 |
| `Currency Mismatch` (`CURRENCY_MISMATCH`) | 18 |
| `Duplicate Invoice` (`DUPLICATE_INVOICE`) | 18 |
| `CAS Write-Skew + L1` (`FRAUD_VELOCITY` race) | 18 |
| `Split + Typo` (`SPLIT_MATCH`) | 17 |
| `BEC IBAN HITL` (`BEC_IBAN_CHANGE`) | 17 |
| `Near-Duplicate False-Positive Test` (diff PO, benign) | 15 |

### 3.3 ProofGate `L1` / `L2` Catch Breakdown & Engineering Notes

- **`L1_SOURCE_OR_MATH: INVENTED_PROSE_AMOUNT` (`51`):** Blocked ungrounded prose figures and forced in-loop retries, including real raw-cents mislabeling slips (e.g., `45315 EUR`, `45740 EUR`, `80595 EUR`, `52575, USD`) as well as strict comma-adjacent date/PO boundaries (e.g., `06, USD`, `8011, USD`). Every single block was corrected on retry (**`0` leaked figures across all `600` ticks**).
- **`L1_SOURCE_OR_MATH: UNCITED_OR_FAKE_SOURCE` (`7`):** Blocked invalid `[src:PO-XXXX]` references (`SkepticAuditor` / `RiskSentinel`) when the LLM cited a PO number instead of an `INV-*` / `TX-*` entity ID.
- **`L1_SOURCE_OR_MATH: INVALID_CITATION` (`1`):** Seed `104729` (`REJ-7`) caught `PayoutAndRefund` normalizing a spaced IBAN inside a citation (`expected "NL91ABNA0417164300", actual "NL91 ABNA 0417 1643 00"`), enforcing verbatim raw-record citation fidelity.
- **`L2_CAS_WRITE_SKEW: WRITE_SKEW_PREVENTED` (`3`):** Stopped live concurrent refund races against `FRAUD_VELOCITY`-locked invoices on `INV-2037` (`seed 224737`), `INV-2034` (`seed 479909`), and `INV-2055` (`seed 611953`), each encountering `expected version 2, current version 3`. (In the other `15` `CAS Write-Skew + L1` injections, `L3 HITL` / fraud-hold rejection stopped `propose_refund` before a stale CAS mutation.)
- **Why `5` of `19` `Partial -> Late STALE` invoices ended in `PARTIAL`:** `INV-2056` (`seed 104729`), `INV-2053` (`479909`), `INV-2061` (`611953`), `INV-2052` (`882377`), and `INV-2059` (`1299709`) were all injected in the final ticks (`51–60`) before the runner called `stopContinuousStream()` at tick `60`, which calls `clearAllTimers()` and cancels delayed `lateDelayMs = 7000` settlement timers that had not yet fired (`14/19` earlier traps closed and flipped `STALE` cleanly).

---

## 4. Reproduce Locally

```bash
npm run typecheck && npm run ui:build && npm test && npm run proof   # Zero-key CI verification
npm start                                                           # Live fixed-pack run (requires key in .env)
npm start -- --stream --ticks 60                                    # Live 60-tick randomized chaos stream
```
