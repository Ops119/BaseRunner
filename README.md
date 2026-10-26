# BASE//AGENT

Trading agent for the top 8 Base tokens: own wallet, dashboard, risk limits. Paper mode needs no install (Node 18+).

    node agent.js            # PAPER mode. Creates wallet.json on first run. http://localhost:8402

## Going live (real money)

1. `npm install viem`
2. Run `node agent.js` once, copy the wallet address it prints. Send it a SMALL amount of **USDC on Base** and ~$2 of **ETH on Base** (gas). Only send what you can afford to lose.
3. Start live (no API keys needed):

       LIVE=1 LIVE_CONFIRM=I_UNDERSTAND_THIS_USES_REAL_MONEY node agent.js

Defaults: $100 total cap (`LIVE_MAX_USD`), $25 per swap (`LIVE_MAX_TRADE_USD`, memes get half). The agent refuses to start if anything is off.

### Swap routing: gasless first, then two gas-paying backups (all free, no keys)
1. **Velora Delta (gasless).** The agent signs an order off-chain and a solver settles it and pays the swap gas. Delta contract `0x0000000000bbf5c5fd284e657f01bd000933c96d` (Velora docs, Base supported).
2. **Velora Market** (backup 1), `api.velora.xyz`. Normal transaction, you pay gas. Free tier: 1 request/sec, 5,000/day.
3. **KyberSwap** (backup 2), legacy open endpoint. Rate limited; set `KYBER_API_KEY` if it stops working.

If one route fails before anything is sent (API down, no route, bad price, unexpected contract, dry-run revert, or a Delta order that expired unfilled) the agent moves to the next. Change order or drop one with `SWAP_ROUTERS=velora,kyber`.

**Gasless is not "no ETH ever."** Swaps via Delta cost you no gas, but the token approval for Delta is still an on-chain transaction (the Delta docs do not specify a gasless permit format, so I did not guess one). To keep that rare, the agent approves enough for 5 trades (`GASLESS_APPROVAL_TRADES`), only to the verified Delta contract, and USDC approvals never exceed `LIVE_MAX_USD`. Keep about $2 of ETH in the wallet for approvals and the gas-paying backups.

**Delta safety:** before signing, the agent checks the order field by field: right chain and contract, our wallet as owner and beneficiary, the exact tokens and amount we asked for, minimum output not below the price guard, short deadline, no partner fee, no bridging. Anything off means it does not sign and falls back. Orders expire after `DELTA_TTL_SEC` (default 90s) so an unfilled order cannot fill late. If the order status is unclear after expiry, the agent does NOT retry elsewhere; it re-reads wallet balances and records any fill that landed.

### Safety rails
- Fails closed: missing confirmation, viem, gas, or USDC means it exits without trading.
- Only these contracts are ever approved or sent to: the Delta contract above, Velora Augustus v6.2 `0x6a000f20005980200259b80c5102003040001068` and Kyber MetaAggregationRouterV2 `0x6131b5fae19ea4f9d964eac0408e4408b66337b5` (both from the providers' docs). A quote pointing anywhere else is rejected.
- On-chain preflight checks every token contract's `symbol()`; a mismatch disables that token. LINK is paper-only until you set `LINK_ADDRESS` after checking Basescan.
- Price guard: a quote is refused if its minimum output is worse than the live feed price by more than a per-token limit (6% to 15%).
- Approvals are exact-amount, never infinite. Swaps that ask for ETH value are refused. Every swap is dry-run (`eth_call`) first. 3 failed trades in a row halts new entries.
- Kill switch: dashboard "STOP ENTRIES" button, or create a file named `STOP`. Open positions are still managed.
- Live state is in `state-live.json`, separate from paper. Only positions the agent opened are managed; it never sells your other holdings.

### Not covered
- Tested against stub chain + mock routers, not mainnet. The Delta order layout (field names, EIP-712 types) is checked defensively because the docs do not spell it out; if it differs, the agent refuses to sign and uses a backup route, so watch the log on your first run. Do your first run with ~$20-30 and watch it.
- Fees and slippage are real; gas is paid in ETH. No MEV protection beyond slippage limits. Thin tokens (BRETT, DEGEN) can move between quote and fill.
- Private key sits in `wallet.json` (chmod 600). Anyone with that file can take the funds.

Env: DELTA_TTL_SEC, GASLESS_APPROVAL_TRADES, PORT, TICK_SECONDS, BASE_RPC, LIVE_MAX_USD, LIVE_MAX_TRADE_USD, LINK_ADDRESS, SWAP_ROUTERS, VELORA_BASE, KYBER_BASE, KYBER_API_KEY.

## Strategy check (backtest, 26 Oct 2026)
Replayed the rules on daily bars for ETH, BTC, LINK, AERO, MORPHO (23 Dec 2024 to 26 Oct 2026, 673 days; VIRTUAL, BRETT and DEGEN had no usable history), with 0.3% fee and per-token slippage, entries at next open.
That window was a bear market: ETH -32%, BTC -15%, LINK -53%, AERO -56%, MORPHO -25%.

| Variant | Return | Max drawdown | Profit factor |
|---|---|---|---|
| Original rules (stop -7%, TP +12%) | -33% | -41% | 0.77 |
| Random entries, same exits (median of 200) | -39% | | |
| Hold equal-weight basket | -36% | -63% | |
| BTC > 100d average filter only | -8% | -11% | 0.89 |
| Filter + stop -10% / TP +20% (**now default**) | +14% | -8% | 1.25 |
| Position size 25% instead of 15% | -49% | -58% | 0.78 |

What this does and does not show:
- The original entry signals had no measurable edge over random entries (72nd percentile). The gain comes from standing aside in downtrends and giving trades room, not from better signals.
- The two settings were picked after looking at about 15 variants on one window. Both halves of the sample were positive, but treat +14% as optimistic. Expect less, and losses are possible.
- Bigger positions made losses bigger. There is no leverage and none was added.
- Daily bars only approximate the live 1h/24h/7d signal, and the meme tokens and VIRTUAL were not tested.

## Deploy on Railway
1. Push this folder to a GitHub repo (`wallet.json`, `state*.json`, `.env` are git-ignored) and create a Railway project from it. `railway.json` sets the start command, the `/health` check and a single replica.
2. Add a **volume** mounted at `/data`. Set variables: `STATE_DIR=/data`, `DASH_TOKEN=<long random string>`, `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=60`. The agent refuses to start on a public address without `DASH_TOKEN`.
3. Generate a public domain, then open `https://<domain>/?token=<DASH_TOKEN>` once. It sets a cookie so your phone stays signed in.
4. Run **paper mode** first (no other variables). The wallet is created in `/data/wallet.json`; the address shows on the dashboard.
5. Live mode: add `AGENT_PRIVATE_KEY` (or keep the key on the volume), `LIVE=1`, `LIVE_CONFIRM=...`, and the caps. Fund the address with USDC on Base and a little ETH.

Railway notes: a service with a volume runs one replica and a redeploy has a short gap with no overlap, which is fine for this agent (positions and state live on the volume). SIGTERM triggers a graceful stop that waits for an in-flight swap before exiting. Back up the key: anyone with Railway access can read it from variables or the volume.

## New-coin scanner (under $20k market cap)
`scanner.js` watches new Base pools (GeckoTerminal) and screens them with GoPlus contract data. Both are free and need no key. It runs every 5 minutes and shows survivors in a dashboard card.

**It is paper-only by design.** It never touches the wallet, and there is no setting that makes it trade live. Tokens this small are mostly scams or illiquid, and a screen cannot make them safe. A passing token can still rug.

Every token must pass all of these, and anything unknown counts as a fail:
- **Market:** pair quoted in WETH or USDC; market cap (or FDV when unverified) between $3k and $20k; liquidity of at least $3k; age 15 min to 48 h; at least 8 buyers and real sells in the last hour; not already up 150% in an hour.
- **Contract:** source verified; not a honeypot; can sell the full balance; buy and sell tax at most 8%; no proxy, minting, hidden owner, ownership take-back, self-destruct, pause, blacklist, whitelist, cooldown or owner-adjustable tax.
- **Holders and liquidity:** at least 40 holders; creator and owner under 10%; no single wallet over 15%; at least 80% of liquidity burned or locked.
- **Confirmation:** must pass two scans in a row before the paper sleeve may enter.

The paper sleeve has a $30 budget, $10 per position, 3 positions at most. Fills are pessimistic (price impact, 3% extra buy slippage, 5% extra sell slippage, 1% pool fee). Exits: stop -30%, take-profit +100%, trailing stop, 12 h time stop, or immediately if liquidity falls by half. It halts itself if it loses half its budget and won't re-enter a token for 24 h after selling it.

Limits: GeckoTerminal only lists the newest pools, so fast launches can be missed, and free-tier data can lag or rate-limit (the scanner backs off for 5 minutes). Tune with `SCAN_MAX_MC`, `SCAN_MIN_LIQ`, `SCAN_BUDGET_USD`, `SCAN_TRADE_USD`, or turn it off with `SCAN=off`.

## Security notes
- Dashboard: `DASH_TOKEN` (16+ characters) is required whenever the agent listens on a public address. Wrong tokens are locked out after 10 tries per 5 minutes, the login cookie stores a hash rather than the token, and responses carry a strict CSP and anti-framing headers. The `?token=` link puts the token in the URL once, so open it only on devices you trust and don't share screenshots of the address bar.
- The kill switch (`STOP` file) lives in `STATE_DIR`, the same place the live executor checks.
- Private key: prefer the `AGENT_PRIVATE_KEY` variable. Anyone with access to your Railway project can read it, so fund the wallet with only what you can lose.
- Dependencies: only `viem` (live mode). Run `npm install` once and commit the generated `package-lock.json` so deploys stay pinned.
- Report problems via GitHub issues; never post keys or logs containing addresses you want private.
