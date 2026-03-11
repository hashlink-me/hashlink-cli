const VENICE_API_KEY = Bun.env.VENICE_API_KEY
const LLM_PROXY_TOKEN = Bun.env.LLM_PROXY_TOKEN
const DEFAULT_MODEL = Bun.env.VENICE_MODEL || 'grok-41-fast'

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })

Bun.serve({
  port: Number(Bun.env.PORT || 3000),
  async fetch(req) {
    const url = new URL(req.url)

    if (req.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, model: DEFAULT_MODEL })
    }

    if (req.method !== 'POST' || url.pathname !== '/summarize') {
      return json({ error: 'not_found' }, 404)
    }

    const token = req.headers.get('x-llm-proxy-token')
    if (!LLM_PROXY_TOKEN || token !== LLM_PROXY_TOKEN) {
      return json({ error: 'unauthorized' }, 401)
    }

    if (!VENICE_API_KEY) {
      return json({ error: 'missing_venice_key' }, 500)
    }

    let body: any
    try {
      body = await req.json()
    } catch {
      return json({ error: 'invalid_json' }, 400)
    }

    const prompt = String(body?.prompt || '').trim()
    const messages = Array.isArray(body?.messages) ? body.messages : null
    if (!prompt && (!messages || messages.length === 0)) {
      return json({ error: 'missing_prompt' }, 400)
    }

    const model = String(body?.model || DEFAULT_MODEL)

    try {
      const r = await fetch('https://api.venice.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${VENICE_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages:
            messages && messages.length > 0
              ? messages
              : [{ role: 'user', content: prompt }],
        }),
      })

      const raw = await r.text()
      if (!r.ok) {
        return json({ error: 'llm_failed', status: r.status, detail: raw }, 502)
      }

      let payload: any = {}
      try {
        payload = JSON.parse(raw)
      } catch {
        return json({ error: 'invalid_llm_json', detail: raw }, 502)
      }

      const rawContent = payload?.choices?.[0]?.message?.content
      const text = Array.isArray(rawContent)
        ? rawContent
            .map((c: any) => String(c?.text || c?.content || ''))
            .join('\n')
            .trim()
        : String(rawContent || '').trim()
      if (!text) {
        return json({ error: 'empty_output', detail: raw }, 502)
      }

      return json({ text })
    } catch (e: any) {
      return json({ error: 'proxy_exception', detail: String(e?.message || e) }, 502)
    }
  },
})
