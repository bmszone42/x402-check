---
name: x402-check
description: >
  Check any public x402 seller origin or door URL. Quotes the full per-run
  total (OCP doors plus the target's cheapest working listed door, named),
  then with --yes pays that cheapest door once from the user's own x402
  wallet, captures settle/tx, real content, and paid-call latency, and
  computes the public leaderboard grade. Unread parts stay unread, not
  zeroed. Streak stays unread unless history exists. Use when the user
  pastes an https x402 URL and asks if it is real, if it settles, how
  slow it is, what the cheapest door costs, or what the live grade is.
  Never ask for or log a private key. Never invent listed=true. No trading.
license: MIT
---

# /x402-check

Free open-source skill. One Node script. No extra npm packages.

## When to use

A user gives a public `https://` seller origin or paid door. They want a short report:

1. On-demand grade using the public leaderboard formula, computed **client-side** after one paid GET of the cheapest working listed door. Unmeasurable parts stay **unread**, never zeroed. Streak stays unread unless leaderboard/ping-ledger history exists.
2. Whether that paid call settled (wrapper tx hash / settle_failed). Never invent a tx.
3. Whether the paid response was real content (non-empty, valid type/schema, not error/placeholder).
4. Seller paid-response latency (2000ms cap). Not client wrapper wall-clock.
5. Cheapest working listed door from live unpaid 402 quotes (then that door is the only target pay).

## How to run

```bash
node check.mjs --dry-run https://SELLER-ORIGIN
```

Prints the **full** per-run total (OCP + named cheapest target door), `--max-usdc` cap, formula parts that would fill, unpaid 402 quotes, and free `/sample` shapes. **No USDC.**

```bash
node check.mjs --yes --max-usdc 0.05 https://seller.example
```

Prints the same quote, then pays only if you pass `--yes` and `X402_FETCH_COMMAND` is already your x402 fetch wrapper. The wrapper holds the wallet. This skill never prompts for a key. **At most one target call.** The target URL includes documented sample query params (402 bazaar `info.input.queryParams`, the leaderboard ping URL, or OpenAPI). An unpaid probe of that exact request must be HTTP 402 or the skill aborts **before paying anything**, including OCP doors. Invalid target 4xx is **not graded**. If the cheapest target door is over `--max-usdc` (default `$0.05`), the target is not paid.

Until Live Grade is overlay-deployed, aim that unpublished OCP door at a local server with `--desk` pointing at your local desk origin.

## Price per run

Quoted up front:

**total = livegrade $0.04 + pipecheck $0.02 + settleproof $0.02 + target cheapest working door (named)**

`--max-usdc` (default `$0.05`) caps the **target door only**, not the OCP `$0.08`. If cheapest > cap, the target is omitted from the total and is not paid.

Free `GET /api/v1/leaderboard` and unpaid seller-door GETs are not in the total.

## Grade

Same public formula as `GET /api/v1/leaderboard`:

`grade = round(30*paid_ok + 30*settled + 25*content + 10*latency + 5*min(streak,5)/5)`

This skill computes it client-side from the one paid target call. Unread components are omitted from the sum (not zeroed).

## Latency fields for `X402_FETCH_COMMAND`

The grade's latency term is the **seller paid HTTP round-trip**, not node startup, wallet load, the unsigned 402, or signing. Clients should emit JSON (stdout) with one of these fields, milliseconds, paid request only:

| Field | Meaning |
| --- | --- |
| `paid_request_ms` | **Preferred.** Duration of the paid request alone. |
| `paid_elapsed_ms` | Same as `paid_request_ms`. |
| `request_ms` / `response_ms` / `ttfb_ms` | Paid HTTP timing. |
| `elapsed_ms` / `latency_ms` | Accepted if they measure the paid request, not the whole process. Nested `timing` / `metrics` / `stats` / `_meta` objects are also read. |

If none of those fields are present, the skill grades latency from the **timed unpaid 402 probe of the same URL** (`latency_source=unpaid_402_probe`). Wrapper wall-clock is logged as `wrapper_wall_ms` and is **never graded**.

## Honesty

- `listed=true` is never invented. Missing grade parts are unread, not zero.
- `--dry-run` never pays. `--yes` is required to pay.
- Never more than one target call per run.
- Localhost and tunnels are rejected.
- Facilitator on OCP doors is OpenX402. No Coinbase CDP in this skill.
- No telemetry.

Sellers who want a verified seat: https://openclawproductions.com/claim
