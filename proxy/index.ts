const OPENAI_API_KEY = Bun.env.OPENAI_API_KEY
const LLM_PROXY_TOKEN = Bun.env.LLM_PROXY_TOKEN
const DEFAULT_MODEL = Bun.env.OPENAI_MODEL || 'gpt-5-nano'

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

    if (!OPENAI_API_KEY) {
      return json({ error: 'missing_openai_key' }, 500)
    }

    let body: any
    try {
      body = await req.json()
    } catch {
      return json({ error: 'invalid_json' }, 400)
    }

    const prompt = String(body?.prompt || '').trim()
    if (!prompt) return json({ error: 'missing_prompt' }, 400)

    const model = String(body?.model || DEFAULT_MODEL)

    try {
      const r = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          input: prompt,
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

      const textFromOutput = Array.isArray(payload?.output)
        ? payload.output
            .flatMap((o: any) => (Array.isArray(o?.content) ? o.content : []))
            .filter((c: any) => c?.type === 'output_text' || c?.type === 'text')
            .map((c: any) => String(c?.text || ''))
            .join('\n')
            .trim()
        : ''

      const text = String(payload?.output_text || textFromOutput || '').trim()
      if (!text) {
        return json({ error: 'empty_output', detail: raw }, 502)
      }

      return json({ text })
    } catch (e: any) {
      return json({ error: 'proxy_exception', detail: String(e?.message || e) }, 502)
    }
  },
})
