import { shell } from 'electron'

const YT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
}

async function searchYoutube(query: string): Promise<{ url: string; title: string } | null> {
  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
  const res = await fetch(searchUrl, { headers: YT_HEADERS, signal: AbortSignal.timeout(10_000) })
  if (!res.ok) return null
  const html = await res.text()

  // First "videoId" in the page is the top search result
  const vidMatch = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/)
  if (!vidMatch) return null
  const videoId = vidMatch[1]

  // Extract title from the JSON chunk near the videoId
  const idx = html.indexOf(`"videoId":"${videoId}"`)
  const segment = html.slice(idx, idx + 800)
  const titleMatch = segment.match(/"title":\{"runs":\[\{"text":"([^"]+)"/)
  const title = titleMatch ? titleMatch[1] : query

  return { url: `https://www.youtube.com/watch?v=${videoId}`, title }
}

export async function searchAndPlayYoutube(query: string): Promise<{
  success: boolean
  title?: string
  url?: string
  error?: string
}> {
  try {
    const result = await searchYoutube(query)
    if (!result) return { success: false, error: 'Видео не найдено' }
    await shell.openExternal(result.url)
    return { success: true, title: result.title, url: result.url }
  } catch (e) {
    console.error('[YouTube] searchAndPlay:', e)
    return { success: false, error: String(e) }
  }
}
