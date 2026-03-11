# HashLink CLI Tool & OpenClaw Agent Skill

HashLink CLI is a crypto token research tool built for AI agents, trading bots, and professional traders who need fast, reliable intelligence from a single token address. Instead of jumping across Dexscreener, project websites, and security tools, HashLink returns one clean, structured markdown report with market data, important links, chain context, and token safety signals. 

It supports Ethereum, Base, BSC, and Solana with chain-aware routing, including RugCheck for Solana risk scoring and GoPlus security checks for EVM contract risk analysis. 

The HashLink Skill standardizes this workflow so agents can run repeatable due diligence at scale. With smart caching, fresh market snapshots, and low-latency architecture on Cloudflare Workers, HashLink reduces API cost while keeping data useful for real trading decisions.

If you need automated crypto intelligence, token due diligence, and faster on-chain research in CLI format, HashLink gives you a trusted, production-ready solution.

## Use it for free

You can use the public hosted endpoint for free:

```bash
curl "https://data.hashlink.me/<TOKEN_ADDRESS>"
```

## Install terminal shortcut (`ca`)

Install from this repo:

```bash
bash ./scripts/install.sh
```

Install directly from GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/hashlink-me/hashlink-cli/main/scripts/install.sh | bash
```

Reload your shell:

```bash
source ~/.zshrc
```

Use it:

```bash
ca <TOKEN_ADDRESS>
ca <TOKEN_ADDRESS> refresh=true
```

## API endpoints

- `GET /{token_address}`: returns markdown report.
- `GET /health`: service health.
- `DELETE /cache/{token_address}`: admin-only cache invalidation.
- `POST /internal/warm`: admin-only cache warm-up job.

## What the report includes

- Project name and ticker
- Contract address
- Chain and chain ID
- Important links (website, X, Telegram)
- Market data (price, 24h change, volume, liquidity, market cap)
- Token safety section
- Token summary

## HashLink pipeline (how it works)

1. Receive token address request.
2. Load split caches.
3. Get market data from Dexscreener.
4. Discover links from Dexscreener metadata.
5. Pull website content from `markdown.new` (HTML scrape fallback).
6. Generate summary via LLM proxy.
7. Fetch token safety.
8. Render standardized markdown.
9. Save split caches.

## Cache strategy

- Summary cache: `30 days`
- Safety cache: `24 hours`
- Market cache: `5 minutes`

This keeps market data fresh while reducing LLM and security API cost.

## Security defaults

- `debug=true`: admin-only
- `llmOnly=true`: admin-only
- `refresh=*`: admin-only
- `/internal/warm`: admin-only
- `/cache/*`: admin-only

## Self-host and run your own HashLink pipeline

### 1) Clone and install

### 2) Create dependencies

- Cloudflare Worker (API runtime)
- Upstash Redis (cache + rate limiting)
- Venice API key for summarization

### 3) Deploy LLM proxy (Railway)

Set Railway variables:

- `VENICE_API_KEY`
- `VENICE_MODEL` (optional, default `grok-41-fast`)



### 4) Configure Worker secrets

```bash
bunx wrangler secret put ADMIN_TOKEN
bunx wrangler secret put UPSTASH_REDIS_REST_URL
bunx wrangler secret put UPSTASH_REDIS_REST_TOKEN
bunx wrangler secret put VENICE_API_KEY
```

### 5) Run locally

```bash
bun run dev
```

or Worker local:

```bash
bun run dev:worker
curl "http://127.0.0.1:8787/health"
```

### 6) Deploy Worker

```bash
bun run deploy
```

### 7) Add custom domain

Add your Worker custom domain such as `data.hashlink.me` in Cloudflare dashboard.

### 8) Configure cron warm-up

Add 3 cron triggers:

- `*/5 * * * *` for market warm-up
- `0 0 * * *` for daily safety warm-up
- `0 0 * * 0` (or `0 0 * * 1`) for weekly summary warm-up


## Example request

```bash
curl "https://data.hashlink.me/0x6982508145454Ce325dDbE47a25d4ec3d2311933"
```
