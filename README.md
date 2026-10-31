# /x402-check

Free skill: quote the **full** per-run total, then optionally pay Open Claw Productions doors **and one** target cheapest working door from **your** x402 wallet. Computes the public leaderboard grade client-side from that paid call.

**Install (one line):**

```bash
npx degit bmszone42/x402-check x402-check
```

Then run with Node 20+ (no extra packages):

```bash
node x402-check/check.mjs --dry-run https://YOUR-ORIGIN
```

Or fetch just the script:

```bash
curl -fsSL https://raw.githubusercontent.com/bmszone42/x402-check/main/check.mjs -o check.mjs
node check.mjs --dry-run https://YOUR-ORIGIN
```

Copy this folder into a Claude Code / Cursor / Grok skills directory (`SKILL.md` frontmatter is the loader contract).

**Price per run:** **$0.08 to Open Claw** (Live Grade $0.04 + Pipe Check $0.02 + Settle Proof $0.02) **plus the target seller's cheapest working listed door (named)**. Example: seo.forgemesh.io cheapest `GET /v1/query-correct` at **$0.005** → **$0.085** (85000 atomic) when under `--max-usdc`.

**Guards:** `--yes` is required to pay. `--max-usdc` (default **$0.05**) applies to the **target door only**. If cheapest > cap, the skill refuses to pay the target (OCP quote still printed). `--dry-run` is free and never pays. Never more than one target call.

**Sample inputs:** the paid target URL is not the bare listed path. Query params come from, in order, the unpaid leaderboard ping URL (same path), the 402 `PAYMENT-REQUIRED` bazaar `info.input.queryParams`, then OpenAPI examples. Required params without a documented sample skip that door. An unpaid probe of the exact request must be HTTP 402 or the run aborts before any pay. HTTP 400/422-style invalid responses are reported as `not graded`, never as a 0–100 score.

**Grade:** `round(30*paid_ok + 30*settled + 25*content + 10*latency + 5*min(streak,5)/5)`. Unread omitted, not zeroed. Streak unread unless leaderboard/ping-ledger history exists. Computed client-side after the paid target call (not by inventing livegrade fields).

Requires Node 20+. No extra packages. `--dry-run` never pays. `--yes` required to pay, only through `X402_FETCH_COMMAND` (your existing x402 client). This repo never asks for a private key.

## Plug in an x402 fetch client (`X402_FETCH_COMMAND`)

Paid runs spawn your existing wrapper. It must already hold the wallet. Example:

```bash
export X402_FETCH_COMMAND="your-x402-fetch"
node check.mjs --yes --max-usdc 0.05 https://seller.example
```

The grade's latency term is the **seller paid HTTP round-trip**, not node startup, wallet load, the unsigned 402, or signing. The wrapper should print JSON on stdout with one of these fields (milliseconds, paid request only):

| Field | Meaning |
| --- | --- |
| `paid_request_ms` | **Preferred.** Duration of the paid request alone. |
| `paid_elapsed_ms` | Same as `paid_request_ms`. |
| `request_ms` / `response_ms` / `ttfb_ms` | Paid HTTP timing. |
| `elapsed_ms` / `latency_ms` | Accepted if they measure the paid request, not the whole process. Nested `timing` / `metrics` / `stats` / `_meta` objects are also read. |

If none of those fields are present, the skill grades latency from the timed unpaid 402 probe of the same URL (`latency_source=unpaid_402_probe`). Wrapper wall-clock is logged as `wrapper_wall_ms` and is **never graded**.

No trading content.

Sellers who want a pinned seat after a ping-verify pass: https://openclawproductions.com/claim

## Example: live `--dry-run` (unpaid)

Against **https://seo.forgemesh.io**. Unpaid 402s and free `/sample` only. **No USDC.** Production Live Grade may still be 404 until overlay deploy.

```bash
node check.mjs --dry-run https://seo.forgemesh.io
```

## Honesty / gaps

- `--dry-run` does not pay the seller or OCP. paid_ok, settled, real_content, and paid-call latency stay unread until `--yes`.
- Latency grades `paid_request_ms` (or `elapsed_ms` / `latency_ms` / `paid_elapsed_ms`) from wrapper JSON, else the unpaid 402 probe of the same URL. Wrapper wall-clock is never graded.
- Streak stays unread unless history exists; it is not invented.
- Cheapest working door is an unpaid 402 quote until `--yes` pays it once.
- Production Live Grade may be unpublished until overlay deploy. `--desk` aims that unpaid 402 at a local server.
- Seller 402 bodies may be x402 v1 (`maxAmountRequired`). The skill also reads the v2 `PAYMENT-REQUIRED` header when present.
- Listed-door unpaid fan-out is capped at 8. Target pay is still one call.
- Wrapper shape varies; settle is true only when a 32-byte tx hash is present (or explicit settle_failed → false).

## License

MIT
