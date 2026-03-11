import { createHandler } from './index'

const port = Number(process.env.PORT || 3000)

const handler = createHandler({
  upstashUrl: process.env.UPSTASH_REDIS_REST_URL,
  upstashToken: process.env.UPSTASH_REDIS_REST_TOKEN,
  veniceApiKey: process.env.VENICE_API_KEY,
  veniceModel: process.env.VENICE_MODEL,
  adminToken: process.env.ADMIN_TOKEN,
})

Bun.serve({
  port,
  fetch: handler,
})

console.log(`HashLink Info API listening on ${port}`)
