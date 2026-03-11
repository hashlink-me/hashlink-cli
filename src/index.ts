import { Redis } from '@upstash/redis'
import { load } from 'cheerio'

type AppConfig = {
  upstashUrl?: string
  upstashToken?: string
  veniceApiKey?: string
  veniceModel?: string
  adminToken?: string
}

const DEXSCREENER_ENDPOINT = 'https://api.dexscreener.com/latest/dex/tokens'
const MARKDOWN_NEW_ENDPOINT = 'https://markdown.new/'
const DEX_TRENDING_ENDPOINTS = [
  'https://api.dexscreener.com/token-boosts/top/v1',
  'https://api.dexscreener.com/token-boosts/latest/v1',
  'https://api.dexscreener.com/token-profiles/latest/v1',
]
const GOPLUS_EVM_ENDPOINT = 'https://api.gopluslabs.io/api/v1/token_security'
const RUGCHECK_SOLANA_SUMMARY_ENDPOINT = 'https://api.rugcheck.xyz/v1/tokens'
const RATE_LIMIT_PER_MINUTE = 60
const REFRESH_LIMIT_PER_MINUTE = 5
const SUMMARY_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60
const MARKET_CACHE_TTL_SECONDS = 5 * 60
const SAFETY_CACHE_TTL_SECONDS = 24 * 60 * 60
const SAFETY_FETCH_BUDGET_MS = 1800
const DEFAULT_VENICE_MODEL = 'grok-41-fast'

interface CacheService {
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>
  delete(key: string): Promise<void>
  incrWithExpiry(key: string, ttlSeconds: number): Promise<number>
}

class UpstashCache implements CacheService {
  constructor(private redis: Redis) {}

  async get<T>(key: string): Promise<T | null> {
    const value = await this.redis.get<T>(key)
    return value ?? null
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, { ex: ttlSeconds })
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(key)
  }

  async incrWithExpiry(key: string, ttlSeconds: number): Promise<number> {
    const current = await this.redis.incr(key)
    if (current === 1) {
      await this.redis.expire(key, ttlSeconds)
    }
    return current
  }
}

interface MemoryCacheEntry<T = any> {
  value: T
  expiresAt: number
}

class MemoryCache implements CacheService {
  private values = new Map<string, MemoryCacheEntry>()
  private counters = new Map<string, MemoryCacheEntry<number>>()

  private cleanup(map: Map<string, MemoryCacheEntry<any>>) {
    const now = Date.now()
    for (const [key, item] of map.entries()) {
      if (item.expiresAt <= now) {
        map.delete(key)
      }
    }
  }

  async get<T>(key: string): Promise<T | null> {
    this.cleanup(this.values)
    const item = this.values.get(key)
    return item ? (item.value as T) : null
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    this.values.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    })
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key)
    this.counters.delete(key)
  }

  async incrWithExpiry(key: string, ttlSeconds: number): Promise<number> {
    this.cleanup(this.counters)
    const current = this.counters.get(key)
    const next = (current?.value ?? 0) + 1
    this.counters.set(key, {
      value: next,
      expiresAt: Date.now() + ttlSeconds * 1000,
    })
    return next
  }
}

interface TokenPair {
  baseToken?: { name?: string; symbol?: string }
  info?: {
    links?: Record<string, string>
    websites?: Array<{ label?: string; url?: string }>
    socials?: Array<{ type?: string; url?: string }>
  }
  chainId?: string
  dexId?: string
  priceUsd?: string
  marketCap?: number
  fdv?: number
  liquidity?: { usd?: number }
  volume?: { h24?: number }
  priceChange?: { h24?: number }
}

interface ScrapeResult {
  title: string
  description: string
  bodyText: string
}

interface SummaryPayload {
  projectName: string
  ticker: string
  links: {
    website?: string
    twitter?: string
    telegram?: string
  }
  summaryText: string
}

interface MarketPayload {
  pair: TokenPair
}

interface SafetyPayload {
  provider: 'goplus' | 'rugcheck'
  chain: string
  chainId: string
  checkedAt: string
  honeypot: string
  cannotSellAll: string
  blacklisted: string
  proxy: string
  openSource: string
  ownerCanChangeBalance: string
  buyTax: string
  sellTax: string
  riskScore?: string
  riskScoreNormalized?: string
  lpLockedPct?: string
  topRisks?: string
}

interface CachedPayload<T> {
  data: T
  generatedAt: string
}

interface WarmTokenCandidate {
  tokenAddress?: string
}

const compactWhitespace = (text: string) => text.replace(/\s+/g, ' ').trim()
const nowIso = () => new Date().toISOString()
const textResponse = (text: string, status = 200) =>
  new Response(text, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  })

const jsonResponse = (data: Record<string, any>, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })

const getClientIp = (request: Request): string => {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }

  return (
    request.headers.get('x-real-ip') ||
    request.headers.get('cf-connecting-ip') ||
    'unknown'
  )
}

const sanitizeUrl = (raw?: string): string | undefined => {
  if (!raw || typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    return new URL(candidate).toString()
  } catch {
    return undefined
  }
}

const canonicalTokenAddress = (address: string) => {
  const trimmed = address.trim()
  if (/^0x[a-fA-F0-9]{40,64}$/.test(trimmed)) return trimmed.toLowerCase()
  return trimmed
}
const isLikelyTokenAddress = (value: string): boolean => {
  if (!value || value.includes('/') || value.includes('.')) return false
  if (/^0x[a-f0-9]{40,64}$/i.test(value)) return true
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return true
  return false
}

const extractSocialLinks = (pair: TokenPair) => {
  const rawLinks = pair.info?.links ?? {}
  const websiteFromArray = pair.info?.websites?.find((w) => sanitizeUrl(w.url))?.url
  const socials = pair.info?.socials ?? []
  const twitterFromSocials = socials.find((s) => /twitter|x/i.test(s.type || '') && sanitizeUrl(s.url))?.url
  const telegramFromSocials = socials.find((s) => /telegram|tg/i.test(s.type || '') && sanitizeUrl(s.url))?.url

  return {
    website: sanitizeUrl(
      rawLinks.website || rawLinks.web || rawLinks.www || rawLinks.mainSite || websiteFromArray,
    ),
    twitter: sanitizeUrl(
      rawLinks.twitter || rawLinks.x || rawLinks.twitterUrl || rawLinks.xUrl || twitterFromSocials,
    ),
    telegram: sanitizeUrl(
      rawLinks.telegram || rawLinks.tg || rawLinks.telegramUrl || rawLinks.tgUrl || telegramFromSocials,
    ),
  }
}

const parseTwitterHandle = (url: string): string => {
  const reserved = new Set(['i', 'intent', 'share', 'home', 'explore', 'search'])
  try {
    const parsed = new URL(url)
    const parts = parsed.pathname.split('/').filter(Boolean).map((p) => p.replace(/^@/, ''))
    const firstValid = parts.find((p) => p && !reserved.has(p.toLowerCase()))
    return firstValid || 'N/A'
  } catch {
    const match = url.match(/(?:twitter\.com|x\.com)\/([^/?#]+)/i)
    if (!match || !match[1]) return 'N/A'
    const handle = match[1].replace(/^@/, '')
    return reserved.has(handle.toLowerCase()) ? 'N/A' : handle
  }
}

const truncateByTokens = (text: string, maxTokens = 6000): string => {
  const maxChars = maxTokens * 4
  return text.length <= maxChars ? text : text.slice(0, maxChars)
}

const formatNumber = (value?: number | string, decimals = 2): string => {
  if (value === undefined || value === null) return 'N/A'
  const num = Number(value)
  if (!Number.isFinite(num)) return 'N/A'
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  }).format(num)
}

const formatUsd = (value?: number | string): string => {
  if (value === undefined || value === null) return 'N/A'
  const num = Number(value)
  if (!Number.isFinite(num)) return 'N/A'
  if (num > 0 && num < 0.00000001) return `$${num.toExponential(2)}`
  if (num >= 1) return `$${formatNumber(num, 2)}`
  return `$${formatNumber(num, 8)}`
}

const formatPct = (value?: number): string => {
  if (value === undefined || value === null || !Number.isFinite(value)) return 'N/A'
  const sign = value > 0 ? '+' : ''
  return `${sign}${formatNumber(value, 2)}%`
}

const formatChain = (chainId?: string): string => {
  if (!chainId) return 'N/A'
  const normalized = chainId.trim().toLowerCase()
  if (!normalized) return 'N/A'
  if (normalized === 'bsc') return 'BSC'
  if (normalized === 'eth' || normalized === 'ethereum') return 'Ethereum'
  if (normalized === 'sol' || normalized === 'solana') return 'Solana'
  if (normalized === 'base') return 'Base'
  return normalized.charAt(0).toUpperCase() + normalized.slice(1)
}

const formatChainId = (chainId?: string): string => {
  if (!chainId) return 'N/A'
  const normalized = chainId.trim().toLowerCase()
  if (normalized === 'eth' || normalized === 'ethereum') return '1'
  if (normalized === 'bsc') return '56'
  if (normalized === 'base') return '8453'
  return 'N/A'
}

const formatFlag = (value: unknown): string => {
  if (value === undefined || value === null || value === '') return 'N/A'
  const raw = String(value).trim().toLowerCase()
  if (raw === '1' || raw === 'true' || raw === 'yes') return 'Yes'
  if (raw === '0' || raw === 'false' || raw === 'no') return 'No'
  return String(value)
}

const formatTax = (value: unknown): string => {
  if (value === undefined || value === null || value === '') return 'N/A'
  const num = Number(value)
  if (!Number.isFinite(num)) return String(value)
  return `${formatNumber(num, 2)}%`
}

const parseWarmCandidates = (payload: unknown): WarmTokenCandidate[] => {
  if (!Array.isArray(payload)) return []
  return payload
    .map((item) => {
      const record = item as Record<string, unknown>
      const tokenAddress =
        typeof record.tokenAddress === 'string'
          ? record.tokenAddress
          : typeof record.address === 'string'
            ? record.address
            : undefined
      return { tokenAddress }
    })
    .filter((item) => Boolean(item.tokenAddress))
}

const fetchWarmCandidates = async (limit: number): Promise<string[]> => {
  const responses = await Promise.all(
    DEX_TRENDING_ENDPOINTS.map(async (endpoint) => {
      try {
        const response = await fetchWithTimeout(endpoint, 5000)
        if (!response.ok) return []
        const payload = (await response.json()) as unknown
        return parseWarmCandidates(payload)
      } catch {
        return []
      }
    }),
  )

  const unique = new Set<string>()
  for (const group of responses) {
    for (const item of group) {
      const address = canonicalTokenAddress(item.tokenAddress || '')
      if (!isLikelyTokenAddress(address)) continue
      unique.add(address)
      if (unique.size >= limit) return [...unique]
    }
  }
  return [...unique]
}

const summaryCacheKey = (address: string) => `token-summary:${address}`
const marketCacheKey = (address: string) => `token-market:${address}`
const safetyCacheKey = (address: string) => `token-safety:${address}`
const rlKey = (type: 'rl' | 'refresh', ip: string) => `rl:${type}:${ip}`

const renderMarkdown = (
  projectName: string,
  ticker: string,
  address: string,
  links: ReturnType<typeof extractSocialLinks>,
  pair: TokenPair,
  summaryText: string,
  safety?: SafetyPayload | null,
) => {
  const handle = links.twitter ? parseTwitterHandle(links.twitter) : 'N/A'
  const marketCap = pair.marketCap ?? pair.fdv
  const summary = compactWhitespace(summaryText)
    ? summaryText
    : 'Summary unavailable from model output.'
  const safetyProvider = safety?.provider === 'rugcheck' ? 'RugCheck' : safety?.provider === 'goplus' ? 'GoPlus' : ''
  const safetyHeader = safetyProvider
    ? `### 🛡️ Token Safety (${safetyProvider})`
    : '### 🛡️ Token Safety'

  return [
    `# 💎 ${projectName} (${ticker})`,
    `**CA:** \`${address}\``,
    `**Chain:** \`${formatChain(pair.chainId)}\``,
    `**Chain ID:** \`${formatChainId(pair.chainId)}\``,
    '',
    '### 🔗 Important Links',
    `- **Web:** ${links.website ? `[${links.website}](${links.website})` : 'N/A'}`,
    `- **X:** ${handle === 'N/A' || !links.twitter ? 'N/A' : `[${handle}](https://x.com/${handle})`}`,
    `- **TG:** ${links.telegram ? `[Join Community](${links.telegram})` : 'N/A'}`,
    '',
    '### 📊 Market Data',
    `- **Price:** ${formatUsd(pair.priceUsd)}`,
    `- **Price Change (24h):** ${formatPct(pair.priceChange?.h24)}`,
    `- **Volume (24h):** ${formatUsd(pair.volume?.h24)}`,
    `- **Liquidity:** ${formatUsd(pair.liquidity?.usd)}`,
    `- **Market Cap:** ${formatUsd(marketCap)}`,
    '',
    safetyHeader,
    `- **Honeypot:** ${safety?.honeypot || 'N/A'}`,
    `- **Cannot Sell All:** ${safety?.cannotSellAll || 'N/A'}`,
    `- **Blacklisted:** ${safety?.blacklisted || 'N/A'}`,
    `- **Proxy Contract:** ${safety?.proxy || 'N/A'}`,
    `- **Open Source:** ${safety?.openSource || 'N/A'}`,
    `- **Owner Can Change Balance:** ${safety?.ownerCanChangeBalance || 'N/A'}`,
    `- **Buy Tax:** ${safety?.buyTax || 'N/A'}`,
    `- **Sell Tax:** ${safety?.sellTax || 'N/A'}`,
    `- **Risk Score:** ${safety?.riskScore || 'N/A'}`,
    `- **Risk Score (Normalized):** ${safety?.riskScoreNormalized || 'N/A'}`,
    `- **LP Locked %:** ${safety?.lpLockedPct || 'N/A'}`,
    `- **Top Risks:** ${safety?.topRisks || 'N/A'}`,
    `- **Checked At:** ${safety?.checkedAt || 'N/A'}`,
    '',
    '### 📝 Token Summary',
    summary,
    '',
    'Token Research Powered by Hashlink.me',
    '',
  ].join('\n')
}

const fallbackSummaryFromScrape = (scrape: ScrapeResult | null): string =>
  compactWhitespace([scrape?.description, scrape?.bodyText].filter(Boolean).join(' ').slice(0, 600)) ||
  'Summary unavailable from model output.'

const emptySummaryPayload = (): SummaryPayload => ({
  projectName: 'N/A',
  ticker: 'N/A',
  links: {},
  summaryText: 'Summary unavailable.',
})

const fetchTokenSafety = async (address: string, pair: TokenPair): Promise<SafetyPayload | null> => {
  const normalizedChain = (pair.chainId || '').trim().toLowerCase()
  if (normalizedChain === 'sol' || normalizedChain === 'solana') {
    try {
      const endpoint = `${RUGCHECK_SOLANA_SUMMARY_ENDPOINT}/${encodeURIComponent(address)}/report/summary`
      const response = await fetchWithTimeout(endpoint, 6000)
      if (!response.ok) return null
      const payload = (await response.json()) as {
        score?: number
        score_normalised?: number
        lpLockedPct?: number
        risks?: Array<{
          name?: string
          level?: string
          description?: string
        }>
      }

      const topRisks = (payload.risks || [])
        .slice(0, 3)
        .map((r) => {
          const name = compactWhitespace(r.name || r.description || '')
          const level = compactWhitespace(r.level || '')
          if (!name && !level) return ''
          if (name && level) return `${level}:${name}`
          return name || level
        })
        .filter(Boolean)
        .join(' | ')

      return {
        provider: 'rugcheck',
        chain: formatChain(pair.chainId),
        chainId: 'N/A',
        checkedAt: nowIso(),
        honeypot: 'N/A',
        cannotSellAll: 'N/A',
        blacklisted: 'N/A',
        proxy: 'N/A',
        openSource: 'N/A',
        ownerCanChangeBalance: 'N/A',
        buyTax: 'N/A',
        sellTax: 'N/A',
        riskScore:
          payload.score === undefined || payload.score === null || !Number.isFinite(payload.score)
            ? 'N/A'
            : String(payload.score),
        riskScoreNormalized:
          payload.score_normalised === undefined ||
          payload.score_normalised === null ||
          !Number.isFinite(payload.score_normalised)
            ? 'N/A'
            : String(payload.score_normalised),
        lpLockedPct:
          payload.lpLockedPct === undefined || payload.lpLockedPct === null || !Number.isFinite(payload.lpLockedPct)
            ? 'N/A'
            : `${formatNumber(payload.lpLockedPct, 2)}%`,
        topRisks: topRisks || 'N/A',
      }
    } catch {
      return null
    }
  }

  const chain = formatChainId(pair.chainId)
  if (chain === 'N/A') return null

  try {
    const endpoint = `${GOPLUS_EVM_ENDPOINT}/${chain}?contract_addresses=${encodeURIComponent(address)}`
    const response = await fetchWithTimeout(endpoint, 6000)
    if (!response.ok) return null
    const payload = (await response.json()) as { result?: Record<string, Record<string, any>> }
    const result = payload.result || {}
    const key =
      Object.keys(result).find((k) => k.toLowerCase() === address.toLowerCase()) ||
      Object.keys(result)[0]
    const token = (key && result[key]) || {}
    return {
      provider: 'goplus',
      chain: formatChain(pair.chainId),
      chainId: formatChainId(pair.chainId),
      checkedAt: nowIso(),
      honeypot: formatFlag(token.is_honeypot ?? token.honeypot),
      cannotSellAll: formatFlag(token.cannot_sell_all),
      blacklisted: formatFlag(token.is_blacklisted ?? token.blacklist),
      proxy: formatFlag(token.is_proxy),
      openSource: formatFlag(token.is_open_source),
      ownerCanChangeBalance: formatFlag(token.owner_change_balance),
      buyTax: formatTax(token.buy_tax),
      sellTax: formatTax(token.sell_tax),
      riskScore: 'N/A',
      riskScoreNormalized: 'N/A',
      lpLockedPct: 'N/A',
      topRisks: 'N/A',
    }
  } catch {
    return null
  }
}

const fetchWithTimeout = async (url: string, timeoutMs: number): Promise<Response> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
      },
    })
  } finally {
    clearTimeout(timer)
  }
}

const withTimeoutOrNull = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> => {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race<T | null>([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const fetchDexScreener = async (address: string): Promise<{ pair: TokenPair }> => {
  const response = await fetchWithTimeout(`${DEXSCREENER_ENDPOINT}/${address}`, 5000)
  if (!response.ok) {
    throw new Error('TOKEN_NOT_FOUND')
  }

  const payload = (await response.json()) as { pairs?: TokenPair[] }
  const pairs = payload.pairs ?? []
  const pairWithLinks = pairs.find((p) => {
    const info = p.info
    if (!info) return false
    const hasLinks = Boolean(info.links && Object.keys(info.links).length > 0)
    const hasWebsites = Boolean(info.websites && info.websites.length > 0)
    const hasSocials = Boolean(info.socials && info.socials.length > 0)
    return hasLinks || hasWebsites || hasSocials
  })
  const pair = pairWithLinks || pairs[0]
  if (!pair) throw new Error('TOKEN_NOT_FOUND')
  return { pair }
}

const markdownNewUrls = (websiteUrl: string): string[] => {
  const trimmed = websiteUrl.trim()
  return [
    `${MARKDOWN_NEW_ENDPOINT}${trimmed}`,
    `${MARKDOWN_NEW_ENDPOINT}${encodeURIComponent(trimmed)}`,
  ]
}

const markdownToPlainText = (markdown: string): string => {
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, ' ')
  const withoutImages = withoutCode.replace(/!\[[^\]]*]\([^)]+\)/g, ' ')
  const withoutLinks = withoutImages.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ')
  const withoutInlineCode = withoutLinks.replace(/`[^`]*`/g, ' ')

  const lines = withoutInlineCode
    .split('\n')
    .map((line) => compactWhitespace(line.replace(/^#+\s*/, '').replace(/^[-*]\s+/, '')))
    .filter(Boolean)
    .filter((line) => line.length >= 25)
    .filter((line) => !/^(home|about|blog|docs|documentation|pricing|features|login|sign up|contact)$/i.test(line))

  return compactWhitespace(lines.join('. '))
}

const extractMarkdownTitle = (markdown: string): string => {
  const heading = markdown
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /^#\s+/.test(line))
  if (heading) return compactWhitespace(heading.replace(/^#\s+/, ''))

  const firstLongLine = markdown
    .split('\n')
    .map((line) => compactWhitespace(line))
    .find((line) => line.length >= 20)
  return firstLongLine || ''
}

const fetchViaMarkdownNew = async (websiteUrl: string): Promise<ScrapeResult | null> => {
  for (const url of markdownNewUrls(websiteUrl)) {
    try {
      const response = await fetchWithTimeout(url, 7000)
      if (!response.ok) continue
      const markdown = await response.text()
      const plain = markdownToPlainText(markdown).slice(0, 12000)
      if (!plain) continue

      const title = extractMarkdownTitle(markdown)
      const description = plain.slice(0, 260)
      return { title, description, bodyText: plain }
    } catch {
      continue
    }
  }
  return null
}

const extractWebsiteText = async (websiteUrl: string): Promise<ScrapeResult | null> => {
  const markdownFirst = await fetchViaMarkdownNew(websiteUrl)
  if (markdownFirst) return markdownFirst

  try {
    const response = await fetchWithTimeout(websiteUrl, 5000)
    const html = await response.text()
    const $ = load(html)

    const challengeText = compactWhitespace(
      $('title').first().text() + ' ' + $('body').text().slice(0, 500),
    )
    if (/just a moment|checking your browser|cloudflare/i.test(challengeText)) {
      return null
    }

    const title = compactWhitespace(
      $('title').first().text() ||
        $('meta[property="og:title"]').attr('content') ||
        $('meta[name="twitter:title"]').attr('content') ||
        '',
    )
    const description = compactWhitespace(
      $('meta[name="description"]').attr('content') ||
        $('meta[property="og:description"]').attr('content') ||
        $('meta[name="twitter:description"]').attr('content') ||
        '',
    )

    $('script, style, nav, footer, iframe').remove()
    const prioritizedBlocks = $('main, article, section, h1, h2, h3, p, li')
      .map((_, el) => compactWhitespace($(el).text()))
      .get()
      .filter((block) => block.length >= 40 && block.length <= 320)
      .slice(0, 120)

    const fallbackBlocks = $('body, body p, body li')
      .map((_, el) => compactWhitespace($(el).text()))
      .get()
      .filter((block) => block.length >= 40 && block.length <= 320)
      .slice(0, 120)

    const prioritizedText = compactWhitespace(prioritizedBlocks.join('. '))
    const fallbackText = compactWhitespace(fallbackBlocks.join('. '))
    const bodyText = (prioritizedText.length >= 120 ? prioritizedText : fallbackText).slice(
      0,
      12000,
    )

    if (!response.ok && !title && !description && !bodyText) return null

    return {
      title,
      description,
      bodyText,
    }
  } catch {
    return null
  }
}

const summarizeMarkdown = async (params: {
  projectName: string
  ticker: string
  address: string
  links: ReturnType<typeof extractSocialLinks>
  pair: TokenPair
  scrape: ScrapeResult | null
  veniceApiKey: string | null
  veniceModel: string
  strictLlmOutput?: boolean
}): Promise<string> => {
  const {
    projectName,
    ticker,
    address,
    links,
    pair,
    scrape,
    veniceApiKey,
    veniceModel,
    strictLlmOutput,
  } = params
  const sourceText = compactWhitespace(
    [scrape?.title, scrape?.description, scrape?.bodyText].filter(Boolean).join('\n\n'),
  )

  if (!veniceApiKey) {
    if (strictLlmOutput) {
      throw new Error('LLM_DISABLED')
    }
    return fallbackSummaryFromScrape(scrape)
  }

  const truncated = truncateByTokens(sourceText, 4000)

  const prompt =
    `System: You are a crypto project analyst working for a quant firm, your role is to summarize crypto token project. It could be a defi protocol, meme tokens or even shitcoin.\n` +
    `Task: Write a complete summary in exactly 2 short paragraphs. Use your deep knowledge in crypto twitter and web3. Explain inside jokes, figure out the meme context and its significance in the community.\n` +
    `Goal: Extract key points, core concepts, and main themes of the token from the website content.\n` +
    `Constraints: Use given facts only, no CTA text, no menus, no copied blocks, no markdown headings, no contract address.\n` +
    `Tone: neutral analyst language.\n\n` +
    `Project: ${projectName} (${ticker})\n` +
    'Website contents:\n' +
    `${truncated || 'N/A'}\n\n` +
    'Output rules:\n' +
    '1) Exactly 2 paragraphs separated by a blank line.\n' +
    '2) Each paragraph 2-4 full sentences.\n' +
    '3) No bullet points, no headings, no links.\n' +
    '4) Try your best to understand the token and project. Summarize meaning; do not quote or copy long fragments verbatim.'

  try {
    const response = await fetch('https://api.venice.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${veniceApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: veniceModel,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    const raw = await response.text()
    if (!response.ok) {
      throw new Error(`[Venice Error]: ${response.status} ${response.statusText} ${raw}`)
    }
    const payload = JSON.parse(raw) as {
      choices?: Array<{
        message?: {
          content?: string | Array<{ text?: string; content?: string }>
        }
      }>
    }
    const content = payload.choices?.[0]?.message?.content
    const outputText = Array.isArray(content)
      ? content
          .map((item) => String(item?.text || item?.content || ''))
          .join('\n')
          .trim()
      : String(content || '').trim()

    const summaryText = outputText.trim()
    if (!summaryText) {
      if (strictLlmOutput) {
        throw new Error('LLM_EMPTY:Venice returned empty text')
      }
      return fallbackSummaryFromScrape(scrape)
    }
    return summaryText
  } catch (error) {
    if (strictLlmOutput) {
      const message =
        error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown Venice error'
      throw new Error(`LLM_FAILED:${message}`)
    }
    return fallbackSummaryFromScrape(scrape)
  }
}

const validateAdmin = (request: Request, adminToken?: string): boolean => {
  if (!adminToken) return false
  const provided =
    request.headers.get('x-admin-token') || request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  return provided === adminToken
}

export const createHandler = (config?: AppConfig) => {
  const adminToken = config?.adminToken
  const veniceApiKey = config?.veniceApiKey || null
  const veniceModel = config?.veniceModel || DEFAULT_VENICE_MODEL

  const cacheService: CacheService =
    config?.upstashUrl && config?.upstashToken
      ? new UpstashCache(new Redis({ url: config.upstashUrl, token: config.upstashToken }))
      : new MemoryCache()

  const safeIncrWithExpiry = async (key: string, ttl: number): Promise<number> => {
    try {
      return await cacheService.incrWithExpiry(key, ttl)
    } catch {
      return 1
    }
  }

  const safeGet = async <T>(key: string): Promise<T | null> => {
    try {
      return await cacheService.get<T>(key)
    } catch {
      return null
    }
  }

  const safeSet = async <T>(key: string, value: T, ttl: number): Promise<void> => {
    try {
      await cacheService.set(key, value, ttl)
    } catch {
      return
    }
  }

  const safeDelete = async (key: string): Promise<void> => {
    try {
      await cacheService.delete(key)
    } catch {
      return
    }
  }

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const pathname = url.pathname
    const method = request.method.toUpperCase()

    if (method === 'GET' && pathname === '/health') {
      return jsonResponse({
        status: 'ok',
        cache: config?.upstashUrl ? 'upstash' : 'memory',
        llm: veniceApiKey ? `venice:${veniceModel}` : 'disabled',
        timestamp: nowIso(),
      })
    }

    if (method === 'DELETE' && pathname.startsWith('/cache/')) {
      if (!validateAdmin(request, adminToken)) return textResponse('Unauthorized', 401)
      const address = canonicalTokenAddress(pathname.slice('/cache/'.length))
      if (!address) return textResponse('Invalid token address', 400)
      await safeDelete(summaryCacheKey(address))
      await safeDelete(marketCacheKey(address))
      await safeDelete(safetyCacheKey(address))
      return textResponse(`Cache cleared for ${address}`)
    }

    if (method === 'POST' && pathname === '/internal/warm') {
      if (!validateAdmin(request, adminToken)) return textResponse('Unauthorized', 401)

      const target = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 100)))
      const includeSafety = (url.searchParams.get('safety') || 'true').toLowerCase() !== 'false'
      const includeMarket = (url.searchParams.get('market') || 'true').toLowerCase() !== 'false'
      const includeSummary = (url.searchParams.get('summary') || 'true').toLowerCase() !== 'false'

      const candidates = await fetchWarmCandidates(Math.max(target * 2, 100))
      let processed = 0
      let eligible = 0
      let warmed = 0
      let skipped = 0

      for (const address of candidates) {
        if (processed >= target) break
        try {
          const dex = await fetchDexScreener(address)
          const pair = dex.pair
          const marketCap = Number(pair.marketCap ?? pair.fdv ?? 0)
          const volume24h = Number(pair.volume?.h24 ?? 0)
          const links = extractSocialLinks(pair)
          if (!links.website || !Number.isFinite(marketCap) || !Number.isFinite(volume24h)) {
            skipped += 1
            continue
          }
          if (marketCap < 100_000 || volume24h < 50_000) {
            skipped += 1
            continue
          }

          eligible += 1
          processed += 1

          if (includeMarket) {
            await safeSet(
              marketCacheKey(address),
              { data: { pair }, generatedAt: nowIso() },
              MARKET_CACHE_TTL_SECONDS,
            )
          }

          if (includeSafety) {
            const safety = await withTimeoutOrNull(fetchTokenSafety(address, pair), SAFETY_FETCH_BUDGET_MS)
            if (safety) {
              await safeSet(
                safetyCacheKey(address),
                { data: safety, generatedAt: nowIso() },
                SAFETY_CACHE_TTL_SECONDS,
              )
            }
          }

          if (includeSummary) {
            const cachedSummary = await safeGet<CachedPayload<SummaryPayload>>(summaryCacheKey(address))
            if (!cachedSummary) {
              const scrape = links.website ? await extractWebsiteText(links.website) : null
              const llmOutput = await summarizeMarkdown({
                projectName: pair.baseToken?.name || 'N/A',
                ticker: pair.baseToken?.symbol || 'N/A',
                address,
                links,
                pair,
                scrape,
                veniceApiKey,
                veniceModel,
                strictLlmOutput: false,
              })
              const summaryPayload: SummaryPayload = {
                projectName: pair.baseToken?.name || 'N/A',
                ticker: pair.baseToken?.symbol || 'N/A',
                links,
                summaryText: llmOutput,
              }
              await safeSet(
                summaryCacheKey(address),
                { data: summaryPayload, generatedAt: nowIso() },
                SUMMARY_CACHE_TTL_SECONDS,
              )
            }
          }

          warmed += 1
        } catch {
          skipped += 1
          continue
        }
      }

      return jsonResponse({
        status: 'ok',
        requested: target,
        candidateCount: candidates.length,
        eligible,
        warmed,
        skipped,
      })
    }

    if (method === 'GET') {
      const address = canonicalTokenAddress(pathname.slice(1))
      if (!isLikelyTokenAddress(address)) return textResponse('Not Found', 404)

      const refreshMode = (url.searchParams.get('refresh') || '').toLowerCase()
      const refreshAll = refreshMode === 'true' || refreshMode === 'all'
      let refreshSummary = refreshAll || refreshMode === 'summary'
      const refreshMarket = refreshAll || refreshMode === 'market'
      const refreshSafety = refreshAll || refreshMode === 'safety'
      const debug = (url.searchParams.get('debug') || '').toLowerCase() === 'true'
      if (debug && !validateAdmin(request, adminToken)) {
        return textResponse('Unauthorized', 401)
      }
      const llmOnly = (url.searchParams.get('llmOnly') || '').toLowerCase() === 'true'
      const isAdmin = validateAdmin(request, adminToken)
      if (llmOnly && !isAdmin) {
        return textResponse('Unauthorized', 401)
      }
      if ((refreshSummary || refreshMarket || refreshSafety) && !isAdmin) {
        return textResponse('Unauthorized', 401)
      }
      if (llmOnly) {
        refreshSummary = true
      }
      const ip = getClientIp(request)

      const rateLimit = await safeIncrWithExpiry(rlKey('rl', ip), 60)
      if (rateLimit > RATE_LIMIT_PER_MINUTE) return textResponse('Rate limit exceeded', 429)

      if (refreshSummary || refreshMarket || refreshSafety) {
        const refreshRate = await safeIncrWithExpiry(rlKey('refresh', ip), 60)
        if (refreshRate > REFRESH_LIMIT_PER_MINUTE) return textResponse('Refresh limit exceeded', 429)
      }

      try {
        const summaryCached = !refreshSummary
          ? await safeGet<CachedPayload<SummaryPayload>>(summaryCacheKey(address))
          : null
        const marketCached = !refreshMarket
          ? await safeGet<CachedPayload<MarketPayload>>(marketCacheKey(address))
          : null
        const safetyCached =
          !refreshSafety && !llmOnly
            ? await safeGet<CachedPayload<SafetyPayload>>(safetyCacheKey(address))
            : null

        let summaryData = summaryCached?.data || null
        let marketData = marketCached?.data || null
        let safetyData = safetyCached?.data || null

        let pair: TokenPair | null = null
        if (!summaryData || !marketData) {
          const dex = await fetchDexScreener(address)
          pair = dex.pair
        }

        if (!marketData) {
          marketData = { pair: pair || {} }
          await safeSet(
            marketCacheKey(address),
            { data: marketData, generatedAt: nowIso() },
            MARKET_CACHE_TTL_SECONDS,
          )
        }

        let scrape: ScrapeResult | null = null
        const sourcePair = pair || marketData.pair
        const summaryPromise: Promise<SummaryPayload | null> = !summaryData
          ? (async () => {
              const links = extractSocialLinks(sourcePair)
              const projectName = sourcePair.baseToken?.name || 'N/A'
              const ticker = sourcePair.baseToken?.symbol || 'N/A'
              scrape = links.website ? await extractWebsiteText(links.website) : null

              const llmOutput = await summarizeMarkdown({
                projectName,
                ticker,
                address,
                links,
                pair: sourcePair,
                scrape,
                veniceApiKey,
                veniceModel,
                strictLlmOutput: llmOnly,
              })

              return {
                projectName,
                ticker,
                links,
                summaryText: llmOutput,
              }
            })()
          : Promise.resolve(null)

        const safetyPromise: Promise<SafetyPayload | null> =
          !llmOnly && !safetyData
            ? withTimeoutOrNull(fetchTokenSafety(address, sourcePair), SAFETY_FETCH_BUDGET_MS)
            : Promise.resolve(null)

        const [freshSummary, freshSafety] = await Promise.all([summaryPromise, safetyPromise])
        if (freshSummary) {
          summaryData = freshSummary
        }
        if (freshSafety) {
          safetyData = freshSafety
        }

        const cacheWrites: Array<Promise<void>> = []
        if (freshSummary) {
          cacheWrites.push(
            safeSet(
              summaryCacheKey(address),
              { data: freshSummary, generatedAt: nowIso() },
              SUMMARY_CACHE_TTL_SECONDS,
            ),
          )
        }
        if (freshSafety) {
          cacheWrites.push(
            safeSet(
              safetyCacheKey(address),
              { data: freshSafety, generatedAt: nowIso() },
              SAFETY_CACHE_TTL_SECONDS,
            ),
          )
        }
        if (cacheWrites.length) {
          await Promise.all(cacheWrites)
        }

        if (!summaryData) summaryData = emptySummaryPayload()
        if (!marketData) marketData = { pair: {} }

        if (llmOnly) {
          return textResponse(summaryData.summaryText || 'LLM summary unavailable', 200)
        }

        const markdown = renderMarkdown(
          summaryData.projectName,
          summaryData.ticker,
          address,
          summaryData.links,
          marketData.pair,
          summaryData.summaryText,
          safetyData,
        )

        if (debug) {
          return jsonResponse({
            cache: {
              summary: Boolean(summaryCached),
              market: Boolean(marketCached),
              safety: Boolean(safetyCached),
              summaryTtlSeconds: SUMMARY_CACHE_TTL_SECONDS,
              marketTtlSeconds: MARKET_CACHE_TTL_SECONDS,
              safetyTtlSeconds: SAFETY_CACHE_TTL_SECONDS,
            },
            token: {
              name: summaryData.projectName,
              ticker: summaryData.ticker,
              address,
              chainId: marketData.pair.chainId,
              dexId: marketData.pair.dexId,
            },
            links: summaryData.links,
            safety: safetyData,
            scrapedWebsiteRaw: scrape
              ? {
                  title: scrape.title,
                  description: scrape.description,
                  bodyText: scrape.bodyText,
                }
              : null,
            tokenSummary: summaryData.summaryText,
            markdown,
          })
        }
        return textResponse(markdown, 200)
      } catch (error) {
        if (error instanceof Error && /^LLM_/.test(error.message)) {
          if (debug) {
            return jsonResponse({
              error: 'LLM summary unavailable',
              detail: error.message,
              hint: 'Check VENICE_API_KEY and VENICE_MODEL, then verify provider availability and quota.',
            }, 502)
          }
          return textResponse('LLM summary unavailable', 502)
        }
        if (error instanceof Error && error.message === 'TOKEN_NOT_FOUND') {
          return textResponse('Token not found', 404)
        }
        return textResponse('Internal server error', 500)
      }
    }

    return textResponse('Not Found', 404)
  }
}

export type { AppConfig }
