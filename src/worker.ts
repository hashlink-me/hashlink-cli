import { createHandler } from './index'

export type Env = {
  UPSTASH_REDIS_REST_URL?: string
  UPSTASH_REDIS_REST_TOKEN?: string
  VENICE_API_KEY?: string
  VENICE_MODEL?: string
  ADMIN_TOKEN?: string
}

type CachedHandler = ReturnType<typeof createHandler>
let handler: CachedHandler | null = null

const buildHandler = (env: Env): CachedHandler => {
  if (handler) return handler
  handler = createHandler({
    upstashUrl: env.UPSTASH_REDIS_REST_URL,
    upstashToken: env.UPSTASH_REDIS_REST_TOKEN,
    veniceApiKey: env.VENICE_API_KEY,
    veniceModel: env.VENICE_MODEL,
    adminToken: env.ADMIN_TOKEN,
  })
  return handler
}

export default {
  fetch(request: Request, env: Env) {
    return buildHandler(env)(request)
  },
  scheduled(event: any, env: Env, ctx: any) {
    const adminToken = env.ADMIN_TOKEN
    if (!adminToken) return
    const handler = buildHandler(env)
    const cron = String(event?.cron || '')

    let query = ''
    if (cron === '*/5 * * * *') {
      query = 'limit=100&market=true&safety=false&summary=false'
    } else if (cron === '0 0 * * *') {
      query = 'limit=100&market=false&safety=true&summary=false'
    } else if (cron === '0 0 * * 0' || cron === '0 0 * * 1') {
      query = 'limit=100&market=false&safety=false&summary=true'
    } else {
      return
    }

    const request = new Request(`https://internal/internal/warm?${query}`, {
      method: 'POST',
      headers: {
        'x-admin-token': adminToken,
      },
    })
    ctx.waitUntil(handler(request).then(() => undefined))
  },
}
