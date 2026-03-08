# HashLink LLM Proxy (Railway + Bun)

This is the LLM proxy used by HashLink Worker.

## Endpoints

- `GET /health`
- `POST /summarize`

## Required environment variables

- `OPENAI_API_KEY`
- `LLM_PROXY_TOKEN`
- `OPENAI_MODEL` (optional, default: `gpt-5-nano`)
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
  -d '{"model":"gpt-5-nano","prompt":"Summarize Bitcoin in 2 sentences."}'
```
