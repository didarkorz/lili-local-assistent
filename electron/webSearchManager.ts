/**
 * webSearchManager.ts — DuckDuckGo search (no API key required)
 */

interface SearchResult {
  title: string
  snippet: string
  url: string
}

export async function webSearch(query: string): Promise<{ success: boolean; results?: SearchResult[]; error?: string }> {
  try {
    const encoded = encodeURIComponent(query)

    // Try Instant Answer API first
    const iaRes = await fetch(
      `https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1&skip_disambig=1`,
      { signal: AbortSignal.timeout(8_000), headers: { 'User-Agent': 'LiliAssistant/1.0' } }
    )

    if (iaRes.ok) {
      const data = await iaRes.json() as {
        AbstractText?: string
        AbstractURL?: string
        AbstractSource?: string
        RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Name?: string }>
      }

      const results: SearchResult[] = []

      // Main abstract
      if (data.AbstractText) {
        results.push({
          title:   data.AbstractSource ?? 'Результат',
          snippet: data.AbstractText.slice(0, 300),
          url:     data.AbstractURL ?? '',
        })
      }

      // Related topics
      for (const topic of (data.RelatedTopics ?? []).slice(0, 4)) {
        if (topic.Text && topic.FirstURL) {
          results.push({
            title:   topic.Name ?? extractDomain(topic.FirstURL),
            snippet: topic.Text.slice(0, 200),
            url:     topic.FirstURL,
          })
          if (results.length >= 4) break
        }
      }

      if (results.length > 0) return { success: true, results }
    }

    // Fallback: parse DuckDuckGo HTML lite
    const htmlRes = await fetch(
      `https://html.duckduckgo.com/html/?q=${encoded}&kl=ru-ru`,
      { signal: AbortSignal.timeout(8_000), headers: { 'User-Agent': 'Mozilla/5.0' } }
    )

    if (!htmlRes.ok) return { success: false, error: `HTTP ${htmlRes.status}` }

    const html = await htmlRes.text()
    const results = parseHtmlResults(html)

    if (results.length === 0) return { success: false, error: 'Ничего не найдено.' }
    return { success: true, results }

  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError') {
      return { success: false, error: 'Поиск не отвечает. Проверь интернет.' }
    }
    return { success: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function parseHtmlResults(html: string): SearchResult[] {
  const results: SearchResult[] = []
  // Match result blocks: <a class="result__a" href="...">title</a>
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/g
  const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([^<]+(?:<[^>]+>[^<]*<\/[^>]+>[^<]*)*)<\/a>/g

  const links: Array<{ url: string; title: string }> = []
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(html)) !== null) {
    links.push({ url: decodeURIComponent(m[1]), title: stripTags(m[2]) })
  }

  const snippets: string[] = []
  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push(stripTags(m[1]))
  }

  for (let i = 0; i < Math.min(links.length, 4); i++) {
    results.push({
      title:   links[i].title,
      snippet: snippets[i] ?? '',
      url:     links[i].url,
    })
  }
  return results
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
}

function extractDomain(url: string): string {
  try { return new URL(url).hostname } catch { return url }
}

export function formatSearchResults(query: string, results: SearchResult[]): string {
  const lines = [`🔍 **Результаты по запросу «${query}»:**\n`]
  results.forEach((r, i) => {
    lines.push(`**${i + 1}. ${r.title}**`)
    if (r.snippet) lines.push(r.snippet)
    if (r.url) lines.push(`🔗 ${extractDomain(r.url)}`)
    lines.push('')
  })
  return lines.join('\n').trim()
}
