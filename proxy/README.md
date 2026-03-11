# HashLink LLM Proxy (Railway + Bun)

This is the LLM proxy used by HashLink Worker.

## Endpoints

- `GET /health`
- `POST /summarize`

## Required environment variables

- `VENICE_API_KEY`
- `LLM_PROXY_TOKEN`
- `VENICE_MODEL` (optional, default: `grok-41-fast`)
- `PORT` (optional, default: `3000`)

## Local run

```bash
cd proxy
bun run dev
```

## Deploy on Railway

1. Create a new Railway service (Bun / Function).
2. Set service root to `proxy/`.
3. Set the environment variables above.
4. Deploy and expose a public domain.

## Test

```bash
curl -s https://<your-proxy-domain>/health
```

```bash
curl -s -X POST https://<your-proxy-domain>/summarize \
  -H "content-type: application/json" \
  -H "x-llm-proxy-token: <LLM_PROXY_TOKEN>" \
  -d '{"model":"grok-41-fast","prompt":"Summarize Bitcoin in 2 sentences."}'
```
