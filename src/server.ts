import { createHandler } from './index'

const port = Number(process.env.PORT || 3000)

const handler = createHandler({
  upstashUrl: process.env.UPSTASH_REDIS_REST_URL,
  upstashToken: process.env.UPSTASH_REDIS_REST_TOKEN,
  llmProxyUrl: process.env.LLM_PROXY_URL,
  llmProxyToken: process.env.LLM_PROXY_TOKEN,
  adminToken: process.env.ADMIN_TOKEN,
})

Bun.serve({
  port,
  fetch: handler,
})

console.log(`HashLink Info API listening on ${port}`)
