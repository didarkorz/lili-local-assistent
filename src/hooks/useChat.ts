import { useState, useCallback, useEffect, useRef } from 'react'
import type { Message, MemoryFact } from '../types'

type MessageSource = 'text' | 'voice'

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

// ── Response cache ────────────────────────────────────────────────────────────
//
// Caches LLM responses by a normalized prompt key for TTL_MS.
// Key = last user message lowercased + trimmed (conversation context ignored for
// short single-turn questions; longer context is too dynamic to cache usefully).
//
// Only caches responses that are >= MIN_LEN chars to avoid caching "errors".

const CACHE_TTL_MS = 60 * 60 * 1000  // 1 hour
const CACHE_MIN_LEN = 20              // don't cache very short/error responses
const CACHE_VERSION = 'v2'
const DEFAULT_WEATHER_CITY = 'Кызылорда'
const TIME_UNIT_PATTERN = 'секунд(?:а|у|ы)?|сек|минут(?:а|у|ы)?|мин|час(?:а|ов)?|ч|seconds?|secs?|minutes?|mins?|hours?|hrs?'
const TIME_UNIT_RE = `(?:${TIME_UNIT_PATTERN})`

interface CacheEntry {
  response: string
  ts: number
}

const responseCache = new Map<string, CacheEntry>()

function cacheKey(content: string): string {
  // Normalize: lowercase, collapse whitespace, strip punctuation at end
  const normalized = content.toLowerCase().trim().replace(/\s+/g, ' ').replace(/[?!.,]+$/, '')
  return `${CACHE_VERSION}|${normalized}`
}

function shouldUseCache(content: string): boolean {
  const normalized = content.toLowerCase().trim().replace(/\s+/g, ' ').replace(/[?!.,]+$/, '')
  if (normalized.length < 16) return false
  if (normalized.split(' ').length < 3) return false
  return true
}

function cacheGet(content: string): string | null {
  if (!shouldUseCache(content)) return null
  const key = cacheKey(content)
  const entry = responseCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    responseCache.delete(key)
    return null
  }
  return entry.response
}

function cacheSet(content: string, response: string): void {
  if (!shouldUseCache(content)) return
  if (response.length < CACHE_MIN_LEN) return
  responseCache.set(cacheKey(content), { response, ts: Date.now() })
}

// ── Pre-warm ──────────────────────────────────────────────────────────────────
//
// Starts an Ollama stream while the user is still typing.
// If the user submits before the pre-warm finishes, we wait for it.
// If the user changes the text, the pre-warm is aborted.

interface PreWarm {
  key: string
  chunks: string[]
  done: boolean
  error: string | null
  resolve: (() => void) | null
}

let prewarm: PreWarm | null = null
const ENABLE_STREAM_PREWARM = false

// Called from ChatInput (via ref on useChat) when input text changes.
// Debounced externally — call this after 1.2s of no typing.
function startPrewarm(content: string, messages: Message[], model: string, activeContext: string) {
  if (!ENABLE_STREAM_PREWARM) return

  const key = cacheKey(content)

  // Already pre-warming this exact prompt
  if (prewarm?.key === key) return

  // Abort any existing pre-warm
  if (prewarm && !prewarm.done) {
    window.electronAPI.abortChatStream()
  }

  // Check cache first — no need to pre-warm
  if (cacheGet(content)) return

  const userMsg: Message = { id: uid(), role: 'user', content: content.trim(), createdAt: Date.now() }
  const pw: PreWarm = { key, chunks: [], done: false, error: null, resolve: null }
  prewarm = pw

  const cleanupChunk = window.electronAPI.onStreamChunk((chunk) => {
    if (prewarm?.key === key) pw.chunks.push(chunk)
  })

  window.electronAPI.onStreamEnd((result) => {
    cleanupChunk()
    if (prewarm?.key !== key) return
    pw.done = true
    if (!result.success) pw.error = result.error ?? 'Stream failed'
    pw.resolve?.()
  })

  window.electronAPI.startChatStream([...messages, userMsg], model, activeContext)
}

function clearPrewarm() {
  prewarm = null
}

// ── Command parser ────────────────────────────────────────────────────────────
//
// Intercepts well-known commands before they reach Ollama.
// Returns { handled: true, response } to short-circuit the normal chat flow,
// or { handled: false } to let the message go to Ollama as usual.

interface CommandResult {
  handled: boolean
  response: string
  contextTarget?: CommandContextTarget
  contextUpdate?: CommandMemoryUpdate
  debugIntent?: string
}

type CommandContextTarget = 'brightness' | 'volume' | 'timer' | 'music' | 'file' | 'app'

type CommandMemoryValue = number | string | null

interface CommandMemoryEntry {
  target: CommandContextTarget
  value: CommandMemoryValue
  previousValue: CommandMemoryValue
  label?: string
  updatedAt: number
}

interface CommandMemoryUpdate {
  target: CommandContextTarget
  value?: CommandMemoryValue
  previousValue?: CommandMemoryValue
  label?: string
}

interface CommandContext {
  lastApp: string
  pendingAction: string
  lastTarget: CommandContextTarget | ''
  lastValue: CommandMemoryValue
  previousValue: CommandMemoryValue
  lastCommandAt: number
  history: Partial<Record<CommandContextTarget, CommandMemoryEntry>>
}

interface PendingVoiceConfirmation {
  command: string
  createdAt: number
}

export interface ChatDebugInfo {
  source: MessageSource
  input: string
  route: 'command' | 'chat' | 'cache' | 'diagnostics' | 'blocked'
  intent: string
  handled: boolean
  at: number
}

// ── Multi-command splitter ────────────────────────────────────────────────────
// Splits "включи X и поставь громкость на 100" into two sub-commands.
// Only splits when "и/потом/затем" is followed by a known command verb.

const MULTI_CMD_VERBS = [
  'открой','открывай','открыть','включи','включай','включить','запусти','запускай','запустить',
  'выключи','выключай','выключить','закрой','закрывай','закрыть','поставь','поставить','установи','добавь',
  'напиши','написать','отправь','отправить','найди','найти','поищи','сделай','сделать','покажи','показать','сверни','свернуть','разверни','развернуть',
  'переключи','переключить','таймер','напомни','напомнить','скриншот','погода','громче','тише','яркость',
  'убери','удали','очисти','запиши','прочитай','сыграй','воспроизведи',
].join('|')

function splitMultiCommand(input: string): string[] {
  const re = new RegExp(`\\s+(?:и|потом|а\\s+потом|затем)\\s+(?=${MULTI_CMD_VERBS})`, 'i')
  const parts = input.split(re).map(s => s.trim()).filter(Boolean)
  return parts.length > 1 ? parts : [input]
}

const VOICE_CONFIRM_TIMEOUT_MS = 10_000
const VOICE_CONFIRM_RE = /^(РґР°|РїРѕРґС‚РІРµСЂР¶РґР°СЋ|confirm)$/i
const VOICE_CANCEL_RE = /^(РЅРµС‚|РѕС‚РјРµРЅР°|cancel)$/i

function isDangerousVoiceCommand(input: string): boolean {
  const lower = input.toLowerCase().trim()
  return [
    /^(?:СѓРґР°Р»Рё|СѓРґР°Р»РёС‚СЊ|СЃС‚РµСЂРµС‚СЊ|delete|remove|erase)\s+С„Р°Р№Р»/i,
    /^(?:СѓРґР°Р»Рё|СѓРґР°Р»РёС‚СЊ|РѕС‡РёСЃС‚Рё|СЃС‚РµСЂРµС‚СЊ|delete|remove|clear)\s+(?:РІСЃРµ\s+С„Р°Р№Р»С‹|РїР°РїРєСѓ|workspace|all files)/i,
    /^(?:Р·Р°РєСЂРѕР№|close)\s+/i,
    /^(?:delete|remove)\s+task/i,
    /^(?:clear|РѕС‡РёСЃС‚Рё)\s+(?:done|completed|РІС‹РїРѕР»РЅРµРЅРЅС‹Рµ)/i,
  ].some((re) => re.test(lower))
}

function buildVoiceConfirmationPrompt(command: string): string {
  return `РљРѕРјР°РЅРґР° Р·РІСѓС‡РёС‚ РѕРїР°СЃРЅРѕ: **${command}**.\n\nРЎРєР°Р¶Рё РёР»Рё РЅР°РїРёС€Рё: **РґР°**, **РїРѕРґС‚РІРµСЂР¶РґР°СЋ** РёР»Рё **confirm** РІ С‚РµС‡РµРЅРёРµ 10 СЃРµРєСѓРЅРґ.`
}

function formatNotesList(notes: Array<{ title: string; isIdea: boolean; createdAt: number }>): string {
  if (notes.length === 0) return ''
  return notes
    .map(
      (n, i) =>
        `${i + 1}. **${n.title}**${n.isIdea ? ' 💡' : ''} — ${new Date(n.createdAt).toLocaleDateString()}`
    )
    .join('\n')
}

// ── [CREATE_FILE] block executor ─────────────────────────────────────────────
//
// Parses Ollama responses for [CREATE_FILE: name]...[/CREATE_FILE] blocks
// and physically creates those files in the workspace folder.

function executeCreateFileBlocks(text: string): void {
  const re = /\[CREATE_FILE:\s*([^\]]+)\]([\s\S]*?)\[\/CREATE_FILE\]/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const filename = match[1].trim()
    const content  = match[2].trim()
    if (filename) {
      window.electronAPI.createTextFile(filename, content).catch((err: unknown) => {
        console.error('[CREATE_FILE] failed:', err)
      })
    }
  }
}

// ── Reminder helpers ─────────────────────────────────────────────────────────

function parseReminderText(input: string): { delayMs: number; text: string } {
  const normalized = normalizeRuNumberWords(input.trim().replace(/^на\s+/i, ''))
    .replace(/[.,!?;:()[\]{}"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  // Handle "через минуту / через час" (no explicit number → 1)
  const reNoNum = new RegExp(`^(?:через\\s+|in\\s+)?(${TIME_UNIT_PATTERN}|a minute|an hour|a second)\\s*(.*)`, 'i')
  const mNoNum = reNoNum.exec(normalized)
  if (mNoNum) {
    const unit = mNoNum[1].toLowerCase()
    const text = mNoNum[2].trim() || input
    const ms =
      /час|ч|hour/.test(unit) ? 3_600_000 :
      /мин|min/.test(unit)    ? 60_000 :
      1_000
    return { delayMs: ms, text }
  }

  // "через 10 минут: текст" / "in 10 minutes: text"
  const re = new RegExp(`^(?:через\\s+|in\\s+)?(\\d+)\\s*(${TIME_UNIT_PATTERN})\\s*(.*)`, 'i')
  const m = re.exec(normalized)
  if (!m) return { delayMs: 0, text: input }
  const n = parseInt(m[1])
  const unit = m[2].toLowerCase()
  const text = m[3].trim() || input
  const ms =
    /час|ч|hour|hr/.test(unit) ? n * 3_600_000 :
    /мин|min/.test(unit)       ? n * 60_000 :
    n * 1_000
  return { delayMs: ms, text }
}

function normalizeRuNumberWords(input: string): string {
  const ones: Record<string, number> = {
    один: 1,
    одну: 1,
    одна: 1,
    два: 2,
    две: 2,
    три: 3,
    четыре: 4,
    пять: 5,
    шесть: 6,
    семь: 7,
    восемь: 8,
    девять: 9,
  }
  const teens: Record<string, number> = {
    десять: 10,
    одиннадцать: 11,
    двенадцать: 12,
    тринадцать: 13,
    четырнадцать: 14,
    пятнадцать: 15,
    шестнадцать: 16,
    семнадцать: 17,
    восемнадцать: 18,
    девятнадцать: 19,
  }
  const tens: Record<string, number> = {
    двадцать: 20,
    тридцать: 30,
    сорок: 40,
    пятьдесят: 50,
    шестьдесят: 60,
  }

  return input
    .toLowerCase()
    .replace(/[ё]/g, 'е')
    .replace(
      /\b(двадцать|тридцать|сорок|пятьдесят|шестьдесят)(?:\s+(один|одну|одна|два|две|три|четыре|пять|шесть|семь|восемь|девять))?\b/g,
      (_match, ten: string, one?: string) => String((tens[ten] ?? 0) + (one ? ones[one] ?? 0 : 0)),
    )
    .replace(
      /\b(одиннадцать|двенадцать|тринадцать|четырнадцать|пятнадцать|шестнадцать|семнадцать|восемнадцать|девятнадцать|десять)\b/g,
      (match) => String(teens[match] ?? match),
    )
    .replace(
      /\b(один|одну|одна|два|две|три|четыре|пять|шесть|семь|восемь|девять)\b/g,
      (match) => String(ones[match] ?? match),
    )
}

function formatDelay(ms: number): string {
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)} ч`
  if (ms >= 60_000)    return `${Math.round(ms / 60_000)} мин`
  return `${Math.round(ms / 1_000)} сек`
}

function applyCommandContextResult(ctx: CommandContext, result: CommandResult): void {
  const target = result.contextUpdate?.target ?? result.contextTarget
  if (!target) return

  const previousEntry = ctx.history[target]
  const value = result.contextUpdate?.value ?? previousEntry?.value ?? null
  const previousValue =
    result.contextUpdate?.previousValue !== undefined
      ? result.contextUpdate.previousValue
      : previousEntry?.value ?? null

  ctx.lastTarget = target
  ctx.lastValue = value
  ctx.previousValue = previousValue
  ctx.lastCommandAt = Date.now()
  ctx.history[target] = {
    target,
    value,
    previousValue,
    label: result.contextUpdate?.label ?? previousEntry?.label,
    updatedAt: ctx.lastCommandAt,
  }
}

function normalizeIntentText(input: string): string {
  return normalizeRuNumberWords(input)
    .toLowerCase()
    .replace(/[ё]/g, 'е')
    .replace(/[.,!?;:()[\]{}"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:лили|лиля|лилии|плили|пили|пилили|lili|lily|lilly)\s+/i, '')
    .replace(/^в\s+ключи\s+/, 'включи ')
    .replace(/\bтайме[нр]\b/g, 'таймер')
    .replace(/\bтаймерн\b/g, 'таймер')
}

function polishMusicQuery(raw: string): string {
  let query = normalizeIntentText(raw)
    .replace(/\b(?:музыку|музыка|песню|песня|трек|клип|видео|song|track|music|video)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const replacements: Array<[RegExp, string]> = [
    [/\b(?:фотограма|фотограм|фотограф|photograma|photogram|fotograma|fotogram|photograph)\b/gi, 'Photograph'],
    [/\b(?:шейп|шеип|shape)\s+(?:оф|of|ов)\s+(?:ю|you)\b/gi, 'Shape of You'],
    [/\b(?:ед|эд|ed)\s+(?:ширан[а-я]*|шеран[а-я]*|ширана|sheran[a-z]*|sheeran[a-z]*)\b/gi, 'Ed Sheeran'],
    [/\b(?:билли|billi|billie)\s+(?:айлиш|eilish|elish)\b/gi, 'Billie Eilish'],
    [/\b(?:уикенд|weeknd|the weeknd)\b/gi, 'The Weeknd'],
  ]

  for (const [pattern, replacement] of replacements) {
    query = query.replace(pattern, replacement)
  }

  return query
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

type FastIntent =
  | { intent: 'music.play'; query: string }
  | { intent: 'music.resume' }
  | { intent: 'app.open'; appName: string }
  | { intent: 'timer.set'; rawTime: string }
  | { intent: 'weather.default' }
  | { intent: 'brightness.set'; pct: number }
  | { intent: 'brightness.adjust'; delta: number }
  | { intent: 'volume.set'; pct: number }
  | { intent: 'volume.adjust'; delta: number }
  | { intent: 'context.undo' }
  | { intent: 'file.notepad'; filename: string | null }

const FAST_APP_ALIASES: Record<string, string> = {
  discord: 'Discord',
  дискорд: 'Discord',
  дискорт: 'Discord',
  telegram: 'Telegram',
  телеграм: 'Telegram',
  телегам: 'Telegram',
  chrome: 'Chrome',
  хром: 'Chrome',
  firefox: 'Firefox',
  фаерфокс: 'Firefox',
  edge: 'Edge',
  spotify: 'Spotify',
  спотифай: 'Spotify',
  vscode: 'VS Code',
  'vs code': 'VS Code',
  cursor: 'Cursor',
  vlc: 'VLC',
  notepad: 'Notepad',
  блокнот: 'Блокнот',
  explorer: 'Explorer',
  проводник: 'Проводник',
  slack: 'Slack',
  skype: 'Skype',
  скайп: 'Skype',
  whatsapp: 'WhatsApp',
  вотсап: 'WhatsApp',
  word: 'Word',
  excel: 'Excel',
  powerpoint: 'PowerPoint',
  калькулятор: 'Калькулятор',
  calculator: 'Calculator',
  настройки: 'Настройки',
  settings: 'Settings',
  диспетчер: 'Диспетчер',
  youtube: 'YouTube',
  ютуб: 'YouTube',
  google: 'Google',
  гугл: 'Google',
  github: 'GitHub',
  гитхаб: 'GitHub',
  gmail: 'Gmail',
}

function resolveFastAppName(raw: string): string | null {
  const name = normalizeIntentText(raw)
    .replace(/^(?:программу|приложение|app|application)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()

  return FAST_APP_ALIASES[name] ?? null
}

function parseFastIntent(input: string, ctx?: CommandContext): FastIntent | null {
  const text = normalizeIntentText(input)

  if (/^(?:верни|вернуть)\s+(?:обратно|назад|как\s+было)$|^(?:как\s+было|отмени\s+последнее|откатись|назад)$/.test(text)) {
    return { intent: 'context.undo' }
  }

  const continuationSetMatch = /^(?:(?:поставь|поставить|сделай|установи|установить|выставь)\s+)?(?:теперь\s+|сейчас\s+)?(?:(?:его|ее|это|уровень|значение)\s+)?(?:на\s+|до\s+)?(\d{1,3})(?:\s*(?:процентов?|%))?$/.exec(text)
  if (continuationSetMatch && ctx?.lastTarget) {
    const pct = Math.max(0, Math.min(100, parseInt(continuationSetMatch[1])))
    if (ctx.lastTarget === 'brightness') return { intent: 'brightness.set', pct }
    if (ctx.lastTarget === 'volume') return { intent: 'volume.set', pct }
  }

  const notepadMatch = /^(?:создай|создать|сделай|открой)\s+(?:блокнот|блокнотик|заметку)(?:\s+(.+))?$/.exec(text)
  if (notepadMatch) {
    return { intent: 'file.notepad', filename: notepadMatch[1]?.trim() || null }
  }

  const timerMatch = /^(?:(?:поставь|поставить|запусти|запустить|создай|включи|включить)\s+)?таймер\s+(?:на\s+)?(.+)$/.exec(text)
  if (timerMatch) {
    return { intent: 'timer.set', rawTime: timerMatch[1].trim() }
  }

  const timerTailMatch = new RegExp(`(\\d+\\s*${TIME_UNIT_RE})\\s+таймер`, 'i').exec(text)
  if (timerTailMatch) {
    return { intent: 'timer.set', rawTime: timerTailMatch[1].trim() }
  }

  const brightnessSetMatch =
    /(?:поставь|поставить|сделай|установи|установить|выставь|brightness|яркость)\s+(?:яркость\s+)?(?:на\s+|до\s+)?(\d{1,3})/.exec(text) ??
    /яркость\s+(?:на\s+|до\s+)?(\d{1,3})/.exec(text)
  if (brightnessSetMatch && /яркост|brightness/.test(text)) {
    return { intent: 'brightness.set', pct: Math.max(0, Math.min(100, parseInt(brightnessSetMatch[1]))) }
  }

  if (/(?:глаза\s+слепит|глаза\s+слепят|слишком\s+ярко|ярко\s+очень)/.test(text)) {
    return { intent: 'brightness.adjust', delta: -25 }
  }
  if (/(?:ярче|сделай\s+ярче|brightness\s+up|brighter)/.test(text)) {
    return { intent: 'brightness.adjust', delta: 10 }
  }
  if (/(?:темнее|сделай\s+темнее|убавь\s+яркость|уменьши\s+яркость|brightness\s+down|dimmer)/.test(text)) {
    return { intent: 'brightness.adjust', delta: -10 }
  }

  const volumeSetMatch =
    /(?:поставь|поставить|сделай|установи|установить|выставь|volume|громкость)\s+(?:громкость\s+)?(?:на\s+|до\s+)?(\d{1,3})/.exec(text) ??
    /громкость\s+(?:на\s+|до\s+)?(\d{1,3})/.exec(text)
  if (volumeSetMatch && /громкост|volume/.test(text)) {
    return { intent: 'volume.set', pct: Math.max(0, Math.min(100, parseInt(volumeSetMatch[1]))) }
  }

  if (/(?:громче|сделай\s+громче|volume\s+up|louder)/.test(text)) {
    return { intent: 'volume.adjust', delta: 10 }
  }
  if (/(?:тише|сделай\s+тише|убавь\s+звук|убавь\s+громкость|volume\s+down|quieter)/.test(text)) {
    return { intent: 'volume.adjust', delta: -10 }
  }

  if (/^(?:погода|погодка|какая\s+(?:сегодня\s+)?погода|что\s+с\s+погодой)$/.test(text)) {
    return { intent: 'weather.default' }
  }

  const appOpenMatch = /^(?:открой|открывай|открыть|включи|включай|включить|запусти|запускай|запустить|open|launch|start)\s+(.+)$/.exec(text)
  if (appOpenMatch) {
    const appName = resolveFastAppName(appOpenMatch[1])
    if (appName) return { intent: 'app.open', appName }
  }

  const musicBare = /^(?:поставь|поставить|включи|включить|вруби|запусти|запустить|ставь|сыграй|play)\s+(?:музыку|music)$/.test(text)
  if (musicBare) return { intent: 'music.resume' }

  const musicMatch = /^(?:поставь|поставить|включи|включить|вруби|запусти|запустить|ставь|сыграй|play)\s+(.+)$/.exec(text)
  if (musicMatch) {
    const raw = musicMatch[1].trim()
    if (/^(?:теперь\s+)?(?:(?:его|ее|это|уровень)\s+)?(?:на\s+|до\s+)?\d{1,3}$/.test(raw)) {
      return null
    }
    if (/^(?:таймер|таймен|таймерн|напоминание|будильник|погоду|погода|файл|блокнот|заметку|задачу)\b/.test(raw)) {
      return null
    }
    const query = polishMusicQuery(raw)
    if (query) return { intent: 'music.play', query }
  }

  return null
}

async function executeFastIntent(intent: FastIntent, ctx: CommandContext): Promise<CommandResult> {
  if (intent.intent === 'app.open') {
    const result = await window.electronAPI.openApp(intent.appName)
    if (!result.success) {
      return {
        handled: true,
        response: `Не могу открыть **${intent.appName}**: ${result.error ?? 'приложение не найдено.'}`,
        debugIntent: intent.intent,
      }
    }
    return {
      handled: true,
      response: `Открываю **${intent.appName}**…`,
      contextTarget: 'app',
      contextUpdate: { target: 'app', value: intent.appName.toLowerCase(), label: intent.appName },
      debugIntent: intent.intent,
    }
  }

  if (intent.intent === 'music.resume') {
    await window.electronAPI.openApp('youtube music')
    window.electronAPI.musicPlayYT().catch(() => {})
    return {
      handled: true,
      response: '▶ Открываю YouTube Music и запускаю воспроизведение…',
      contextTarget: 'music',
      contextUpdate: { target: 'music', value: 'youtube music', label: 'YouTube Music' },
      debugIntent: intent.intent,
    }
  }

  if (intent.intent === 'music.play') {
    const yt = await window.electronAPI.youtubeSearch(intent.query)
    if (yt.success) {
      return {
        handled: true,
        response: `🎵 Включаю: **${yt.title}**`,
        contextTarget: 'music',
        contextUpdate: { target: 'music', value: yt.title ?? intent.query, label: yt.title ?? intent.query },
        debugIntent: intent.intent,
      }
    }
    return {
      handled: true,
      response: `Не нашёл «${intent.query}» на YouTube.`,
      contextTarget: 'music',
      contextUpdate: { target: 'music', value: intent.query, label: intent.query },
      debugIntent: intent.intent,
    }
  }

  if (intent.intent === 'timer.set') {
    const { delayMs } = parseReminderText(intent.rawTime)
    if (!delayMs) return { handled: true, response: 'Укажи время. Пример: «таймер на 5 минут», «таймер 30 секунд»' }
    const id = 'timer-' + Math.random().toString(36).slice(2)
    const label = `⏱ Таймер ${formatDelay(delayMs)}`
    await window.electronAPI.scheduleReminder(id, label, delayMs)
    return {
      handled: true,
      response: `Таймер поставлен на **${formatDelay(delayMs)}**.`,
      contextTarget: 'timer',
      debugIntent: intent.intent,
      contextUpdate: {
        target: 'timer',
        value: delayMs,
        previousValue: ctx.history.timer?.value ?? null,
        label,
      },
    }
  }

  if (intent.intent === 'weather.default') {
    const r = await window.electronAPI.getWeather(DEFAULT_WEATHER_CITY)
    if (!r.success) return { handled: true, response: `Не могу получить погоду: ${r.error}`, debugIntent: intent.intent }
    return { handled: true, response: r.data!, debugIntent: intent.intent }
  }

  if (intent.intent === 'brightness.set') {
    const before = await window.electronAPI.brightnessGet().then((r) => r.level).catch(() => -1)
    const { success, level } = await window.electronAPI.brightnessSet(intent.pct)
    return {
      handled: true,
      response: success
        ? `Яркость: **${level}%**.`
        : 'Не получилось изменить яркость через Windows WMI. Возможно, это внешний монитор или Windows запрещает доступ.',
      contextTarget: 'brightness',
      debugIntent: intent.intent,
      contextUpdate: {
        target: 'brightness',
        value: success ? level : intent.pct,
        previousValue: before >= 0 ? before : ctx.history.brightness?.value ?? null,
        label: 'яркость',
      },
    }
  }

  if (intent.intent === 'brightness.adjust') {
    const before = await window.electronAPI.brightnessGet().then((r) => r.level).catch(() => -1)
    const { level } = await window.electronAPI.brightnessAdjust(intent.delta)
    return {
      handled: true,
      response: level >= 0
        ? `Яркость: **${level}%**`
        : 'Не получилось изменить яркость через Windows WMI. Возможно, это внешний монитор или Windows запрещает доступ.',
      contextTarget: 'brightness',
      debugIntent: intent.intent,
      contextUpdate: {
        target: 'brightness',
        value: level >= 0 ? level : null,
        previousValue: before >= 0 ? before : ctx.history.brightness?.value ?? null,
        label: 'яркость',
      },
    }
  }

  if (intent.intent === 'volume.set') {
    const before = await window.electronAPI.volumeGet().then((r) => r.level).catch(() => -1)
    await window.electronAPI.volumeSet(intent.pct)
    return {
      handled: true,
      response: `Громкость установлена на **${intent.pct}%**.`,
      contextTarget: 'volume',
      debugIntent: intent.intent,
      contextUpdate: {
        target: 'volume',
        value: intent.pct,
        previousValue: before >= 0 ? before : ctx.history.volume?.value ?? null,
        label: 'громкость',
      },
    }
  }

  if (intent.intent === 'volume.adjust') {
    const before = await window.electronAPI.volumeGet().then((r) => r.level).catch(() => -1)
    const { level } = await window.electronAPI.volumeAdjust(intent.delta)
    return {
      handled: true,
      response: level >= 0 ? `Громкость: **${level}%**` : 'Громкость изменена.',
      contextTarget: 'volume',
      debugIntent: intent.intent,
      contextUpdate: {
        target: 'volume',
        value: level >= 0 ? level : null,
        previousValue: before >= 0 ? before : ctx.history.volume?.value ?? null,
        label: 'громкость',
      },
    }
  }

  if (intent.intent === 'context.undo') {
    const target = ctx.lastTarget
    const entry = target ? ctx.history[target] : undefined
    const previous = entry?.previousValue

    if (!target || previous === undefined || previous === null) {
      return { handled: true, response: 'Пока нечего возвращать обратно.', debugIntent: intent.intent }
    }

    if (target === 'brightness' && typeof previous === 'number') {
      const before = await window.electronAPI.brightnessGet().then((r) => r.level).catch(() => -1)
      const { success, level } = await window.electronAPI.brightnessSet(previous)
      return {
        handled: true,
        response: success
          ? `Вернула яркость обратно: **${level}%**.`
          : 'Не получилось вернуть яркость через Windows WMI.',
        contextTarget: 'brightness',
        debugIntent: intent.intent,
        contextUpdate: {
          target: 'brightness',
          value: success ? level : previous,
          previousValue: before >= 0 ? before : entry?.value ?? null,
          label: 'яркость',
        },
      }
    }

    if (target === 'volume' && typeof previous === 'number') {
      const before = await window.electronAPI.volumeGet().then((r) => r.level).catch(() => -1)
      await window.electronAPI.volumeSet(previous)
      return {
        handled: true,
        response: `Вернула громкость обратно: **${previous}%**.`,
        contextTarget: 'volume',
        debugIntent: intent.intent,
        contextUpdate: {
          target: 'volume',
          value: previous,
          previousValue: before >= 0 ? before : entry?.value ?? null,
          label: 'громкость',
        },
      }
    }

    return { handled: true, response: `Для **${entry?.label ?? target}** пока не умею делать откат.`, debugIntent: intent.intent }
  }

  const r = await window.electronAPI.createTextFile(intent.filename, '')
  if (!r.success) return { handled: true, response: `Ошибка: ${r.error ?? 'неизвестная ошибка.'}` }
  return {
    handled: true,
    response: `Готово. Создала блокнот **${r.filename}**.`,
    contextTarget: 'file',
    contextUpdate: { target: 'file', value: r.filename ?? intent.filename ?? null, label: r.filename ?? 'блокнот' },
    debugIntent: intent.intent,
  }
}

// ── Workspace command parser ──────────────────────────────────────────────────

async function parseWorkspaceCommand(input: string): Promise<CommandResult> {
  const lower = input.toLowerCase().trim()
  const noop: CommandResult = { handled: false, response: '' }

  function wsError(error: string | undefined): CommandResult {
    return { handled: true, response: `Ошибка: ${error ?? 'неизвестная ошибка.'}` }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SEARCH FILES (RU + EN)
  // ══════════════════════════════════════════════════════════════════════════

  // "search files {query}" / "find file {query}" / "search for {query}"
  // "найди файл {query}" / "поиск файлов {query}" / "покажи файл {query}"
  const EN_SEARCH_FILES = ['search files ', 'find file ', 'search for file ']
  const RU_SEARCH_FILES = ['найди файл ', 'поиск файлов ', 'покажи файл ']

  const searchFilePrefix = [...EN_SEARCH_FILES, ...RU_SEARCH_FILES].find((p) =>
    lower.startsWith(p)
  )
  if (searchFilePrefix) {
    const query = input.slice(searchFilePrefix.length).trim()
    const r = await window.electronAPI.searchFiles(query)
    if (!r.success) return wsError(r.error)
    const files: string[] = r.data ? JSON.parse(r.data) : []
    if (files.length === 0) {
      return { handled: true, response: `Файлов с "${query}" не найдено.` }
    }
    const list = files.map((f, i) => `${i + 1}. ${f}`).join('\n')
    return { handled: true, response: `Найдено файлов (${files.length}):\n\n${list}` }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // FIND KEYWORD IN FILES (RU + EN)
  // ══════════════════════════════════════════════════════════════════════════

  // "find keyword {kw} in files" / "find {kw} in files"
  // "найди слово {kw} в файлах" / "найди {kw} в файлах"
  const EN_FIND_KW1 = 'find keyword '
  const EN_FIND_KW2 = 'find '
  const RU_FIND_KW1 = 'найди слово '
  const RU_FIND_KW2 = 'найди '

  if (lower.startsWith(EN_FIND_KW1) && (lower.endsWith(' in files') || lower.endsWith(' в файлах'))) {
    const kw = input.slice(EN_FIND_KW1.length).replace(/ in files$/i, '').replace(/ в файлах$/i, '').trim()
    return handleFindKeyword(kw)
  }
  if (lower.startsWith(EN_FIND_KW2) && (lower.endsWith(' in files') || lower.endsWith(' в файлах'))) {
    const kw = input.slice(EN_FIND_KW2.length).replace(/ in files$/i, '').replace(/ в файлах$/i, '').trim()
    return handleFindKeyword(kw)
  }
  if (lower.startsWith(RU_FIND_KW1) && (lower.endsWith(' в файлах') || lower.endsWith(' in files'))) {
    const kw = input.slice(RU_FIND_KW1.length).replace(/ в файлах$/i, '').replace(/ in files$/i, '').trim()
    return handleFindKeyword(kw)
  }
  if (lower.startsWith(RU_FIND_KW2) && (lower.endsWith(' в файлах') || lower.endsWith(' in files'))) {
    const kw = input.slice(RU_FIND_KW2.length).replace(/ в файлах$/i, '').replace(/ in files$/i, '').trim()
    return handleFindKeyword(kw)
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SUMMARIZE FILE (RU + EN)
  // ══════════════════════════════════════════════════════════════════════════

  // "summarize file {name}" / "summarise file {name}"
  // "суммаризируй файл {name}" / "кратко файл {name}"
  const EN_SUMMARIZE = ['summarize file ', 'summarise file ']
  const RU_SUMMARIZE = ['суммаризируй файл ', 'кратко файл ']

  const summarizePrefix = [...EN_SUMMARIZE, ...RU_SUMMARIZE].find((p) =>
    lower.startsWith(p)
  )
  if (summarizePrefix) {
    const filename = input.slice(summarizePrefix.length).trim()
    if (!filename) return { handled: true, response: 'Укажи имя файла.' }
    const r = await window.electronAPI.summarizeFile(filename)
    if (!r.success) return wsError(r.error)
    return { handled: true, response: `**Краткое содержание файла ${filename}:**\n\n${r.data}` }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RUSSIAN COMMANDS (existing)
  // ══════════════════════════════════════════════════════════════════════════

  const RU_NOTEPAD = 'создай блокнот и напиши туда:'
  if (lower.startsWith(RU_NOTEPAD)) {
    const content = input.slice(RU_NOTEPAD.length).trim()
    if (!content) return { handled: true, response: 'Что записать? Добавь текст после двоеточия.' }
    const r = await window.electronAPI.createTextFile(null, content)
    if (!r.success) return wsError(r.error)
    return { handled: true, response: `Готово. Создала файл **${r.filename}** и записала туда текст.` }
  }

  const RU_NOTEPAD_SIMPLE_RE = /^(?:создай|создать|сделай)\s+блокнот(?:\s+(.+))?$/i
  const notepadSimpleMatch = RU_NOTEPAD_SIMPLE_RE.exec(input)
  if (notepadSimpleMatch) {
    const filename = notepadSimpleMatch[1]?.trim() || null
    const r = await window.electronAPI.createTextFile(filename, '')
    if (!r.success) return wsError(r.error)
    return { handled: true, response: `Готово. Создала блокнот **${r.filename}**.` }
  }

  const RU_CREATE_FILE_PREFIXES = ['создай файл ', 'создать файл ', 'сделай файл ', 'создай файл.', 'создать файл.']
  const RU_CREATE_FILE = RU_CREATE_FILE_PREFIXES.find(p => lower.startsWith(p)) ?? 'создай файл '
  if (RU_CREATE_FILE_PREFIXES.some(p => lower.startsWith(p))) {
    const rest     = input.slice(RU_CREATE_FILE.length)
    const markerRu = ' и напиши туда:'
    const markerIdx = rest.toLowerCase().indexOf(markerRu)

    if (markerIdx !== -1) {
      const filename = rest.slice(0, markerIdx).trim()
      const content  = rest.slice(markerIdx + markerRu.length).trim()
      if (!filename) return { handled: true, response: 'Укажи имя файла.' }
      const r = await window.electronAPI.createTextFile(filename, content)
      if (!r.success) return wsError(r.error)
      return {
        handled: true,
        response: content
          ? `Готово. Создала файл **${r.filename}** и записала туда текст.`
          : `Готово. Создала файл **${r.filename}**.`,
      }
    } else {
      const filename = rest.trim()
      if (!filename) return { handled: true, response: 'Укажи имя файла.' }
      const r = await window.electronAPI.createTextFile(filename, '')
      if (!r.success) return wsError(r.error)
      return { handled: true, response: `Готово. Создала файл **${r.filename}**.` }
    }
  }

  const RU_WRITE = 'запиши в файл '
  if (lower.startsWith(RU_WRITE)) {
    const rest      = input.slice(RU_WRITE.length)
    const colonIdx  = rest.indexOf(':')
    if (colonIdx === -1) return { handled: true, response: 'Формат: запиши в файл имя.txt: текст' }
    const filename  = rest.slice(0, colonIdx).trim()
    const content   = rest.slice(colonIdx + 1).trim()
    if (!filename) return { handled: true, response: 'Укажи имя файла.' }
    const r = await window.electronAPI.writeTextFile(filename, content)
    if (!r.success) return wsError(r.error)
    return { handled: true, response: `Сделано. Записала текст в файл **${filename}**.` }
  }

  const RU_APPEND = 'допиши в файл '
  if (lower.startsWith(RU_APPEND)) {
    const rest     = input.slice(RU_APPEND.length)
    const colonIdx = rest.indexOf(':')
    if (colonIdx === -1) return { handled: true, response: 'Формат: допиши в файл имя.txt: текст' }
    const filename = rest.slice(0, colonIdx).trim()
    const content  = rest.slice(colonIdx + 1).trim()
    if (!filename) return { handled: true, response: 'Укажи имя файла.' }
    const r = await window.electronAPI.appendTextFile(filename, content)
    if (!r.success) return wsError(r.error)
    return { handled: true, response: `Сделано. Дописала текст в файл **${filename}**.` }
  }

  const RU_READ = 'прочитай файл '
  if (lower.startsWith(RU_READ)) {
    const filename = input.slice(RU_READ.length).trim()
    if (!filename) return { handled: true, response: 'Укажи имя файла.' }
    const r = await window.electronAPI.readTextFile(filename)
    if (!r.success) return wsError(r.error)
    return { handled: true, response: `Вот содержимое файла **${filename}**:\n\n${r.data}` }
  }

  const LIST_FILES_RE = /^(покажи|перечисли|список|список|что в|какие|есть ли|какие файлы|что за файлы|что есть в|посмотри|проверь|выведи|покажи мне).{0,30}(файл|папк)/i
  const LIST_FILES_EXACT = ['покажи файлы', 'список файлов', 'мои файлы', 'все файлы', 'что в папке', 'файлы в папке', 'что за файлы', 'перечисли файлы', 'перечисли все файлы', 'какие файлы есть', 'какие файлы', 'файлы', 'list files', 'show files', 'my files', 'all files', 'what files', 'list my files']
  if (LIST_FILES_EXACT.includes(lower) || LIST_FILES_RE.test(lower)) {
    const r = await window.electronAPI.listWorkspaceFiles()
    if (!r.success) return wsError(r.error)
    const files: string[] = r.data ? JSON.parse(r.data) : []
    if (files.length === 0) return { handled: true, response: 'Рабочая папка пуста.' }
    const list = files.map((f, i) => `${i + 1}. ${f}`).join('\n')
    return { handled: true, response: `Файлы в рабочей папке (${files.length}):\n\n${list}` }
  }

  if (lower === 'открой папку') {
    const r = await window.electronAPI.openWorkspaceFolder()
    if (!r.success) return wsError(r.error)
    return { handled: true, response: 'Открыла рабочую папку.' }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DELETE FILE (RU + EN)
  // ══════════════════════════════════════════════════════════════════════════

  const RU_DELETE_FILE = ['удали файл ', 'удалить файл ', 'удалить файл ', 'убери файл ', 'стёрь файл ']
  const EN_DELETE_FILE = ['delete file ', 'remove file ', 'erase file ']

  const deleteFilePrefix = [...RU_DELETE_FILE, ...EN_DELETE_FILE].find((p) =>
    lower.startsWith(p)
  )
  if (deleteFilePrefix) {
    const filename = input.slice(deleteFilePrefix.length).trim()
    if (!filename) return { handled: true, response: 'Укажи имя файла.' }
    const r = await window.electronAPI.deleteFile(filename)
    if (!r.success) return wsError(r.error)
    return { handled: true, response: `Файл **${filename}** удалён.` }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DELETE ALL FILES (RU + EN)
  // ══════════════════════════════════════════════════════════════════════════

  const DELETE_ALL_TRIGGERS = [
    'удали все файлы', 'удалить все файлы', 'очисти папку', 'очистить папку',
    'удали все', 'стереть все файлы',
    'delete all files', 'remove all files', 'clear workspace', 'clear all files',
  ]

  if (DELETE_ALL_TRIGGERS.includes(lower)) {
    const r = await window.electronAPI.deleteAllFiles()
    if (!r.success) return wsError(r.error)
    const count = r.data ?? '0'
    return {
      handled: true,
      response: `Удалено файлов: **${count}**. Рабочая папка очищена.`,
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ENGLISH COMMANDS (existing + new)
  // ══════════════════════════════════════════════════════════════════════════

  const EN_NOTEPAD_1 = 'create a note and write this:'
  const EN_NOTEPAD_2 = 'create note and write this:'
  if (lower.startsWith(EN_NOTEPAD_1) || lower.startsWith(EN_NOTEPAD_2)) {
    const prefixLen = lower.startsWith(EN_NOTEPAD_1) ? EN_NOTEPAD_1.length : EN_NOTEPAD_2.length
    const content   = input.slice(prefixLen).trim()
    if (!content) return { handled: true, response: 'What should I write? Add content after the colon.' }
    const r = await window.electronAPI.createTextFile(null, content)
    if (!r.success) return wsError(r.error)
    return { handled: true, response: `Done. Created file **${r.filename}** and wrote the content.` }
  }

  const EN_CREATE_FILE = 'create file '
  if (lower.startsWith(EN_CREATE_FILE)) {
    const rest     = input.slice(EN_CREATE_FILE.length)
    const markerEn = ' and write this:'
    const markerIdx = rest.toLowerCase().indexOf(markerEn)

    if (markerIdx !== -1) {
      const filename = rest.slice(0, markerIdx).trim()
      const content  = rest.slice(markerIdx + markerEn.length).trim()
      if (!filename) return { handled: true, response: 'Provide a filename.' }
      const r = await window.electronAPI.createTextFile(filename, content)
      if (!r.success) return wsError(r.error)
      return {
        handled: true,
        response: content
          ? `Done. Created **${r.filename}** and wrote the content.`
          : `Done. Created **${r.filename}**.`,
      }
    } else {
      const filename = rest.trim()
      if (!filename) return { handled: true, response: 'Provide a filename.' }
      const r = await window.electronAPI.createTextFile(filename, '')
      if (!r.success) return wsError(r.error)
      return { handled: true, response: `Done. Created **${r.filename}**.` }
    }
  }

  const EN_WRITE = 'write to file '
  if (lower.startsWith(EN_WRITE)) {
    const rest     = input.slice(EN_WRITE.length)
    const colonIdx = rest.indexOf(':')
    if (colonIdx === -1) return { handled: true, response: 'Format: write to file name.txt: content' }
    const filename = rest.slice(0, colonIdx).trim()
    const content  = rest.slice(colonIdx + 1).trim()
    if (!filename) return { handled: true, response: 'Provide a filename.' }
    const r = await window.electronAPI.writeTextFile(filename, content)
    if (!r.success) return wsError(r.error)
    return { handled: true, response: `Done. Wrote content to **${filename}**.` }
  }

  const EN_APPEND = 'append to file '
  if (lower.startsWith(EN_APPEND)) {
    const rest     = input.slice(EN_APPEND.length)
    const colonIdx = rest.indexOf(':')
    if (colonIdx === -1) return { handled: true, response: 'Format: append to file name.txt: content' }
    const filename = rest.slice(0, colonIdx).trim()
    const content  = rest.slice(colonIdx + 1).trim()
    if (!filename) return { handled: true, response: 'Provide a filename.' }
    const r = await window.electronAPI.appendTextFile(filename, content)
    if (!r.success) return wsError(r.error)
    return { handled: true, response: `Done. Appended content to **${filename}**.` }
  }

  const EN_READ = 'read file '
  if (lower.startsWith(EN_READ)) {
    const filename = input.slice(EN_READ.length).trim()
    if (!filename) return { handled: true, response: 'Provide a filename.' }
    const r = await window.electronAPI.readTextFile(filename)
    if (!r.success) return wsError(r.error)
    return { handled: true, response: `Contents of **${filename}**:\n\n${r.data}` }
  }

  if (lower === 'open folder' || lower === 'open workspace' || lower === 'open workspace folder') {
    const r = await window.electronAPI.openWorkspaceFolder()
    if (!r.success) return wsError(r.error)
    return { handled: true, response: 'Opened the workspace folder.' }
  }

  // ── Broad catch-all: любая фраза упоминающая файлы + действие просмотра ──────
  // Перехватывает голосовые фразы вроде "ты его уже создала? перечисли все файлы"
  const BROAD_LIST_RE = /(перечисли|покажи|список|какие|что в|что есть|проверь|выведи|есть ли).{0,60}(файл|папк)|(файл|папк).{0,40}(перечисли|покажи|список|какие|выведи)/i
  if (BROAD_LIST_RE.test(lower)) {
    const r = await window.electronAPI.listWorkspaceFiles()
    if (!r.success) return wsError(r.error)
    const files: string[] = r.data ? JSON.parse(r.data) : []
    if (files.length === 0) return { handled: true, response: 'Рабочая папка пуста.' }
    const list = files.map((f, i) => `${i + 1}. ${f}`).join('\n')
    return { handled: true, response: `Файлы в рабочей папке (${files.length}):\n\n${list}` }
  }

  return noop
}

async function handleFindKeyword(keyword: string): Promise<CommandResult> {
  if (!keyword) return { handled: true, response: 'Укажи слово для поиска.' }
  const r = await window.electronAPI.findKeywordInFiles(keyword)
  if (!r.success) return { handled: true, response: `Ошибка: ${r.error}` }

  const results: Array<{ file: string; snippets: string[] }> = r.data
    ? JSON.parse(r.data)
    : []

  if (results.length === 0) {
    return { handled: true, response: `Слово "${keyword}" не найдено ни в одном файле.` }
  }

  const lines = results.flatMap(({ file, snippets }) => [
    `**${file}:**`,
    ...snippets.map((s) => `  › ${s}`),
  ])
  return {
    handled: true,
    response: `Найдено в ${results.length} файле(ах):\n\n${lines.join('\n')}`,
  }
}

// ── Process name map (for windowClose — maps display/voice names to OS process names) ──

const PROCESS_NAME_MAP: Record<string, string> = {
  discord: 'Discord',    дискорд: 'Discord',    дискорт: 'Discord',
  telegram: 'Telegram',  телеграм: 'Telegram',  телегам: 'Telegram',
  chrome: 'chrome',      хром: 'chrome',
  firefox: 'firefox',    фаерфокс: 'firefox',
  edge: 'msedge',
  spotify: 'Spotify',    спотифай: 'Spotify',
  vscode: 'Code',        cursor: 'Cursor',
  vlc: 'vlc',
  notepad: 'notepad',    блокнот: 'notepad',
  explorer: 'explorer',  проводник: 'explorer',
  slack: 'slack',
  skype: 'Skype',        скайп: 'Skype',
  whatsapp: 'WhatsApp',  вотсап: 'WhatsApp',
  word: 'WINWORD',       excel: 'EXCEL',        powerpoint: 'POWERPNT',
}

function resolveProcessName(name: string): string {
  return PROCESS_NAME_MAP[name.toLowerCase().trim()] ?? name
}

// ── General command parser ────────────────────────────────────────────────────

async function parseCommand(
  input: string,
  conversationMessages: Message[],
  ctx: CommandContext
): Promise<CommandResult> {
  const lower = input.toLowerCase().trim()
  const noop: CommandResult = { handled: false, response: '' }

  const fastIntent = parseFastIntent(input, ctx)
  if (fastIntent) {
    const result = await executeFastIntent(fastIntent, ctx)
    applyCommandContextResult(ctx, result)
    return result
  }

  const wsResult = await parseWorkspaceCommand(input)
  if (wsResult.handled) return wsResult

  // ── Music: open YouTube Music + autoplay ─────────────────────────────────────
  const MUSIC_RE = /^(?:(?:поставь|поставить|включи|включить|запусти|запустить|play)\s+(?:музыку|музыка|music)|(?:поставь|поставить|включи|включить|запусти|запустить)\s+ютуб(?:\s+(?:музыку|музыки|песни|треки|музыка))?|music\s+on|музыку\s+включи|музыку\s+включить|ютуб\s*музык\w*|ютуб\s*песн\w*)$/i
  if (MUSIC_RE.test(lower)) {
    await window.electronAPI.openApp('youtube music')
    // Async: poll for Chrome window with YouTube Music title and trigger play
    window.electronAPI.musicPlayYT().catch(() => {})
    applyCommandContextResult(ctx, {
      handled: true,
      response: '',
      contextUpdate: { target: 'music', value: 'youtube music', previousValue: ctx.history.music?.value ?? null, label: 'YouTube Music' },
    })
    return { handled: true, response: '▶ Открываю YouTube Music и запускаю воспроизведение…' }
  }

  // ── Memory: remember ────────────────────────────────────────────────────────
  let payload = ''
  if (lower.startsWith('remember this:'))  { payload = input.slice(14).trim() }
  else if (lower.startsWith('save memory:'))   { payload = input.slice(12).trim() }
  else if (lower.startsWith('remember that ')) { payload = input.slice(14).trim() }

  if (payload) {
    const trimmed = payload.trim()
    if (!trimmed) return { handled: true, response: "Nothing to remember — what should I save?" }
    const fact: MemoryFact = {
      id: uid(),
      content: trimmed,
      pinned: false,
      createdAt: Date.now(),
    }
    await window.electronAPI.saveFact(fact)
    return { handled: true, response: `Got it. Saved to memory: "${trimmed}"` }
  }

  // ── Memory: forget ──────────────────────────────────────────────────────────
  let forgetQuery = ''
  if (lower.startsWith('forget this:'))    { forgetQuery = input.slice(12).trim() }
  else if (lower.startsWith('remove memory:')) { forgetQuery = input.slice(14).trim() }

  if (forgetQuery) {
    const q = forgetQuery.trim().toLowerCase()
    if (!q) return { handled: true, response: "What should I forget?" }
    const facts = await window.electronAPI.loadFacts()
    const match = facts.find((f) => f.content.toLowerCase().includes(q))
    if (!match) return { handled: true, response: `No matching memory found for "${forgetQuery.trim()}".` }
    await window.electronAPI.deleteFact(match.id)
    return { handled: true, response: `Deleted memory: "${match.content}"` }
  }

  // ── Memory: list ────────────────────────────────────────────────────────────
  if (
    lower === 'show memories' ||
    lower === 'list memories' ||
    lower === 'my memories' ||
    lower === 'show my memories' ||
    lower === 'list my memories'
  ) {
    const facts = await window.electronAPI.loadFacts()
    if (facts.length === 0) return { handled: true, response: "No memories saved yet." }
    const pinned = facts.filter((f) => f.pinned)
    const other  = facts.filter((f) => !f.pinned)
    const lines: string[] = []
    if (pinned.length > 0) {
      lines.push('**Pinned:**')
      pinned.forEach((f, i) => lines.push(`${i + 1}. 📌 ${f.content}${f.projectTag ? ` [${f.projectTag}]` : ''}`))
    }
    if (other.length > 0) {
      if (pinned.length > 0) lines.push('')
      lines.push('**Memories:**')
      other.forEach((f, i) => lines.push(`${i + 1}. ${f.content}${f.projectTag ? ` [${f.projectTag}]` : ''}`))
    }
    return { handled: true, response: lines.join('\n') }
  }

  // ── Notes: save note ────────────────────────────────────────────────────────
  let notePayload = ''
  let isIdea = false

  if (lower.startsWith('save note:'))       { notePayload = input.slice(10).trim() }
  else if (lower.startsWith('create note:')) { notePayload = input.slice(12).trim() }
  else if (lower.startsWith('save idea:'))   { notePayload = input.slice(10).trim(); isIdea = true }
  else if (lower.startsWith('new idea:'))    { notePayload = input.slice(9).trim();  isIdea = true }

  if (notePayload) {
    const trimmed = notePayload.trim()
    if (!trimmed) {
      return {
        handled: true,
        response: isIdea ? "What's the idea?" : "What should I save?",
      }
    }
    const lines  = trimmed.split('\n')
    const title  = lines[0].slice(0, 80)
    const note   = await window.electronAPI.createNote(title, trimmed, isIdea)
    return {
      handled: true,
      response: isIdea ? `Idea saved: **${note.title}**` : `Note saved: **${note.title}**`,
    }
  }

  // ── Notes: list ─────────────────────────────────────────────────────────────
  if (
    lower === 'list notes' || lower === 'show notes' ||
    lower === 'my notes'   || lower === 'show my notes' || lower === 'list my notes'
  ) {
    const notes = await window.electronAPI.listNotes(false)
    if (notes.length === 0) return { handled: true, response: "No notes saved yet." }
    return { handled: true, response: `**Notes (${notes.length}):**\n${formatNotesList(notes)}` }
  }

  if (
    lower === 'list ideas' || lower === 'show ideas' ||
    lower === 'my ideas'   || lower === 'show my ideas' || lower === 'list my ideas'
  ) {
    const ideas = await window.electronAPI.listNotes(true)
    if (ideas.length === 0) return { handled: true, response: "No ideas saved yet." }
    return { handled: true, response: `**Ideas (${ideas.length}):**\n${formatNotesList(ideas)}` }
  }

  if (lower.startsWith('read note ')) {
    const query = input.slice(10).trim()
    if (!query) return { handled: true, response: "Which note?" }
    const note = await window.electronAPI.readNote(query)
    if (!note) return { handled: true, response: `No note found matching "${query}".` }
    return { handled: true, response: `**${note.title}**\n\n${note.content}` }
  }

  if (lower === 'open notes folder' || lower === 'show notes folder') {
    await window.electronAPI.openNotesFolder()
    return { handled: true, response: "Opened the app data folder in File Explorer." }
  }

  // ── Chat: export ────────────────────────────────────────────────────────────
  if (lower === 'export chat' || lower === 'save chat as note' || lower === 'сохрани чат как заметку') {
    if (conversationMessages.length === 0) {
      return { handled: true, response: "Nothing to export — the conversation is empty." }
    }
    const note = await window.electronAPI.exportChatHistory(conversationMessages)
    return { handled: true, response: `Chat exported as note: **${note.title}**` }
  }

  // ── Timer («поставь таймер на 5 минут») ──────────────────────────────────────
  // Reuses scheduleReminder — timer IS a reminder with label "⏱ Таймер N"
  const TIMER_SET_RE    = /^(?:поставь\s+)?таймер\s+(?:на\s+)?(.+)|^(?:set\s+)?timer\s+(?:for\s+)?(.+)/i
  const TIMER_CANCEL_RE = /^(?:отмени\s+таймер|стоп\s+таймер|сбрось\s+таймер|cancel\s+timer|stop\s+timer)/i
  const TIMER_STATUS    = ['сколько осталось', 'таймер', 'timer status', 'покажи таймер']

  const timerMatch = TIMER_SET_RE.exec(lower)
  if (timerMatch) {
    const raw = (timerMatch[1] ?? timerMatch[2]).trim()
    const { delayMs } = parseReminderText(raw)
    if (!delayMs) return { handled: true, response: 'Укажи время. Пример: «таймер на 5 минут», «таймер 30 секунд»' }
    const id = 'timer-' + Math.random().toString(36).slice(2)
    const label = `⏱ Таймер ${formatDelay(delayMs)}`
    await window.electronAPI.scheduleReminder(id, label, delayMs)
    return { handled: true, response: `Таймер поставлен на **${formatDelay(delayMs)}**.` }
  }
  if (TIMER_CANCEL_RE.test(lower)) {
    const { reminders } = await window.electronAPI.listReminders()
    const timers = reminders.filter((r) => r.id.startsWith('timer-'))
    if (timers.length === 0) return { handled: true, response: 'Активных таймеров нет.' }
    for (const t of timers) await window.electronAPI.cancelReminder(t.id)
    return { handled: true, response: `Таймер отменён (${timers.length} шт.).` }
  }
  if (TIMER_STATUS.includes(lower)) {
    const { reminders } = await window.electronAPI.listReminders()
    const timers = reminders.filter((r) => r.id.startsWith('timer-'))
    if (timers.length === 0) return { handled: true, response: 'Активных таймеров нет.' }
    const now = Date.now()
    const lines = timers.map((t) => `⏱ **${t.text}** — осталось ${formatDelay(Math.max(0, t.fireAt - now))}`)
    return { handled: true, response: lines.join('\n') }
  }

  // ── Reminders ────────────────────────────────────────────────────────────────
  const REMIND_RE = /^(напомни|напомнить|remind me?|reminder)[,:]?\s+/i
  if (REMIND_RE.test(lower)) {
    const rest = input.replace(REMIND_RE, '').trim()
    const { delayMs, text } = parseReminderText(rest)
    if (!text) return { handled: true, response: 'Что напомнить? Пример: «напомни через 20 минут: позвонить маме»' }
    if (!delayMs) return noop
    const id = Math.random().toString(36).slice(2)
    await window.electronAPI.scheduleReminder(id, text, delayMs)
    const when = formatDelay(delayMs)
    return { handled: true, response: `Напомню через ${when}: **${text}**` }
  }

  // ── List reminders ────────────────────────────────────────────────────────────
  const LIST_REMINDERS = ['покажи напоминания', 'список напоминаний', 'мои напоминания', 'активные напоминания', 'show reminders', 'list reminders', 'my reminders']
  if (LIST_REMINDERS.includes(lower)) {
    const { reminders } = await window.electronAPI.listReminders()
    if (reminders.length === 0) return { handled: true, response: 'Активных напоминаний нет.' }
    const now = Date.now()
    const lines = reminders.map((r, i) => {
      const msLeft = r.fireAt - now
      const timeLeft = msLeft <= 0 ? 'скоро' : formatDelay(msLeft)
      return `${i + 1}. **${r.text}** — через ${timeLeft}`
    })
    return { handled: true, response: `Активные напоминания (${reminders.length}):\n\n${lines.join('\n')}` }
  }

  // ── Telegram via "открой телеграм и напиши/отправь …" ────────────────────────
  // Must come BEFORE app launcher so "открой телеграм и напиши X: Y" isn't swallowed.
  // parseTgArgs: splits "Жамбо: как дела" or "Жамбо как дела" into [to, text]
  // If colon present → everything before colon = to, after = text
  // If no colon → first word = to, rest = text
  function parseTgArgs(raw: string): [string, string] | null {
    const colonIdx = raw.indexOf(':')
    if (colonIdx > 0) {
      return [raw.slice(0, colonIdx).trim(), raw.slice(colonIdx + 1).trim()]
    }
    const spaceIdx = raw.search(/\s/)
    if (spaceIdx > 0) {
      return [raw.slice(0, spaceIdx).trim(), raw.slice(spaceIdx + 1).trim()]
    }
    return null
  }

  const TG_OPEN_WRITE_RE = /^(?:открой телеграм|открой telegram|open telegram)\s+и\s+напиши\s+(.+)/i
  const TG_OPEN_SEND_RE  = /^(?:открой телеграм|открой telegram|open telegram)\s+и\s+(?:отправь|send)\s+(.+)/i

  const tgOpenWriteMatch = TG_OPEN_WRITE_RE.exec(input)
  if (tgOpenWriteMatch) {
    const args = parseTgArgs(tgOpenWriteMatch[1].trim())
    if (!args) return { handled: true, response: 'Укажи получателя и текст. Пример: «открой телеграм и напиши Жамбо как дела»' }
    const [to, text] = args
    const r = await window.electronAPI.telegramSend(to, text, false)
    if (!r.success) return { handled: true, response: `Telegram: ${r.error}` }
    return { handled: true, response: `Открываю Telegram для @${r.username} с сообщением:\n«${text}»\n\nНажми Enter в Telegram чтобы отправить.` }
  }

  const tgOpenSendMatch = TG_OPEN_SEND_RE.exec(input)
  if (tgOpenSendMatch) {
    const args = parseTgArgs(tgOpenSendMatch[1].trim())
    if (!args) return { handled: true, response: 'Укажи получателя и текст. Пример: «открой телеграм и отправь Жамбо как дела»' }
    const [to, text] = args
    const r = await window.electronAPI.telegramSend(to, text, true)
    if (!r.success) return { handled: true, response: `Telegram: ${r.error}` }
    return { handled: true, response: `Отправляю в Telegram @${r.username}:\n«${text}»` }
  }

  // ── YouTube explicit play: "поставь трек X", "сыграй X" ─────────────────────
  const YOUTUBE_EXPLICIT_RE = /^(?:поставь\s+(?:трек|песню|клип|видео)\s+|поставить\s+(?:трек|песню|клип|видео)\s+|включи\s+(?:трек|песню|клип)\s+|включить\s+(?:трек|песню|клип)\s+|сыграй\s+|найди\s+и\s+включи\s+|найди\s+и\s+включить\s+)(.+)$/i
  const ytExplicit = YOUTUBE_EXPLICIT_RE.exec(lower)
  if (ytExplicit) {
    const query = input.slice(input.toLowerCase().indexOf(ytExplicit[1])).trim()
    const yt = await window.electronAPI.youtubeSearch(query)
    if (yt.success) {
      const result: CommandResult = {
        handled: true,
        response: `🎵 Включаю: **${yt.title}**`,
        contextTarget: 'music',
        contextUpdate: { target: 'music', value: yt.title ?? query, label: yt.title ?? query },
      }
      applyCommandContextResult(ctx, result)
      return result
    }
    const result: CommandResult = {
      handled: true,
      response: `Не нашёл «${query}» на YouTube.`,
      contextTarget: 'music',
      contextUpdate: { target: 'music', value: query, label: query },
    }
    applyCommandContextResult(ctx, result)
    return result
  }

  // ── App launcher ─────────────────────────────────────────────────────────────
  const OPEN_APP_RE = /^(открой|открывай|открыть|включи|включай|включить|запусти|запускай|запустить|open|launch|start)\s+/i
  if (OPEN_APP_RE.test(lower) && lower !== 'открой папку' && lower !== 'open folder' && lower !== 'open workspace' && lower !== 'open workspace folder') {
    const rawName = input.replace(OPEN_APP_RE, '').trim()
    // Strip trailing " и закрой (его)" — user said "открой Discord и закрой"
    const closeAfter = /\s+и\s+закрой(\s+его)?$/i.test(rawName)
    const appName = rawName.replace(/\s+и\s+закрой(\s+его)?$/i, '').trim()
    const result = await window.electronAPI.openApp(appName)
    if (!result.success) {
      const known = await window.electronAPI.listApps()
      return { handled: true, response: `Не могу открыть «${appName}».\nДоступные приложения: ${known.apps.join(', ')}` }
    }
    ctx.lastApp = appName.toLowerCase().trim()
    applyCommandContextResult(ctx, {
      handled: true,
      response: '',
      contextUpdate: { target: 'app', value: ctx.lastApp, previousValue: ctx.history.app?.value ?? null, label: appName },
    })
    if (closeAfter) {
      // Small delay then close
      setTimeout(() => window.electronAPI.windowClose(resolveProcessName(appName)), 3000)
      return { handled: true, response: `Открываю **${appName}** и закрою через несколько секунд…` }
    }
    return { handled: true, response: `Открываю **${appName}**…` }
  }

  // ── Web search ────────────────────────────────────────────────────────────────
  const SEARCH_RE = /^(?:найди в интернете|поищи в интернете|поищи|найди|search for|search|find)[:\s]+(.+)/i
  const searchMatch = SEARCH_RE.exec(lower)
  if (searchMatch) {
    const query = input.slice(input.toLowerCase().indexOf(searchMatch[1])).trim()
    const r = await window.electronAPI.webSearch(query)
    return { handled: true, response: r.text }
  }

  // ── Command history ───────────────────────────────────────────────────────────
  const HISTORY_TODAY  = ['что я делал сегодня', 'история команд', 'мои команды', 'command history', 'what did i do today']
  const HISTORY_YEST   = ['что я делал вчера', 'вчерашние команды', 'what did i do yesterday']
  const HISTORY_LIST   = ['список дней', 'history list', 'все дни истории']

  if (HISTORY_TODAY.includes(lower)) {
    const { content } = await window.electronAPI.commandHistoryRead(0)
    if (!content) return { handled: true, response: 'Сегодня команд ещё не было.' }
    return { handled: true, response: `**Сегодня:**\n\n${content.replace(/^#.+\n\n?/, '')}` }
  }
  if (HISTORY_YEST.includes(lower)) {
    const { content } = await window.electronAPI.commandHistoryRead(1)
    if (!content) return { handled: true, response: 'Вчерашней истории нет.' }
    return { handled: true, response: `**Вчера:**\n\n${content.replace(/^#.+\n\n?/, '')}` }
  }
  if (HISTORY_LIST.includes(lower)) {
    const { days } = await window.electronAPI.commandHistoryList()
    if (days.length === 0) return { handled: true, response: 'История пуста.' }
    return { handled: true, response: `**Дни с историей команд:**\n\n${days.map((d) => `• ${d}`).join('\n')}` }
  }

  // ── Todo ──────────────────────────────────────────────────────────────────────
  const TODO_ADD_RE = /^(?:добавь задачу|добавить задачу|новая задача|add task|new task)[:\s]+(.+)/i
  const todoAddMatch = TODO_ADD_RE.exec(input)
  if (todoAddMatch) {
    const text = todoAddMatch[1].trim()
    await window.electronAPI.todoAdd(text)
    return { handled: true, response: `Задача добавлена: **${text}**` }
  }

  const TODO_LIST = ['задачи', 'список дел', 'мои задачи', 'покажи задачи', 'что надо сделать', 'todo', 'list tasks', 'show tasks', 'my tasks']
  if (TODO_LIST.includes(lower)) {
    const { tasks } = await window.electronAPI.todoList()
    if (tasks.length === 0) return { handled: true, response: 'Список задач пуст.' }
    const pending = tasks.filter((t) => !t.done)
    const done    = tasks.filter((t) => t.done)
    const lines: string[] = []
    if (pending.length > 0) {
      lines.push(`**Активные (${pending.length}):**`)
      pending.forEach((t, i) => lines.push(`${i + 1}. ☐ ${t.text}`))
    }
    if (done.length > 0) {
      if (lines.length) lines.push('')
      lines.push(`**Выполненные (${done.length}):**`)
      done.forEach((t) => lines.push(`✅ ~~${t.text}~~`))
    }
    return { handled: true, response: lines.join('\n') }
  }

  const TODO_DONE_RE = /^(?:выполнено|сделано|готово|задача выполнена|done|complete)[:\s]+(.+)/i
  const todoDoneMatch = TODO_DONE_RE.exec(input)
  if (todoDoneMatch) {
    const query = todoDoneMatch[1].trim()
    const { task } = await window.electronAPI.todoDone(query)
    if (!task) return { handled: true, response: `Задача «${query}» не найдена.` }
    return { handled: true, response: `Выполнено: ✅ ~~${task.text}~~` }
  }

  const TODO_DELETE_RE = /^(?:удали задачу|удалить задачу|delete task|remove task)[:\s]+(.+)/i
  const todoDeleteMatch = TODO_DELETE_RE.exec(input)
  if (todoDeleteMatch) {
    const query = todoDeleteMatch[1].trim()
    const { success } = await window.electronAPI.todoDelete(query)
    return { handled: true, response: success ? `Задача удалена.` : `Задача «${query}» не найдена.` }
  }

  const TODO_CLEAR = ['очисти выполненные', 'удали выполненные задачи', 'clear done', 'clear completed']
  if (TODO_CLEAR.includes(lower)) {
    const { count } = await window.electronAPI.todoClearDone()
    return { handled: true, response: `Удалено выполненных задач: **${count}**.` }
  }

  // ── Journal ───────────────────────────────────────────────────────────────────
  const JOURNAL_WRITE_RE = /^(?:запиши в дневник|дневник запись|journal|write to journal|добавь в дневник)[:\s]+(.+)/is
  const journalWriteMatch = JOURNAL_WRITE_RE.exec(input)
  if (journalWriteMatch) {
    const text = journalWriteMatch[1].trim()
    await window.electronAPI.journalWrite(text)
    return { handled: true, response: `Записано в дневник.` }
  }

  const JOURNAL_TODAY = ['дневник', 'открой дневник', 'что я писал сегодня', 'записи сегодня', 'journal today', 'today journal']
  if (JOURNAL_TODAY.includes(lower)) {
    const { content } = await window.electronAPI.journalRead(0)
    return { handled: true, response: content ?? 'Сегодня записей нет.' }
  }

  const JOURNAL_YESTERDAY = ['что я писал вчера', 'дневник вчера', 'записи вчера', 'yesterday journal']
  if (JOURNAL_YESTERDAY.includes(lower)) {
    const { content } = await window.electronAPI.journalRead(1)
    return { handled: true, response: content ?? 'Вчера записей нет.' }
  }

  // ── Brightness ────────────────────────────────────────────────────────────────
  const BRIGHT_UP_RE   = /^(ярче|сделай ярче|увеличь яркость|brightness up|brighter)/i
  const BRIGHT_DOWN_RE = /^(темнее|сделай темнее|уменьши яркость|brightness down|dimmer)/i
  const BRIGHT_SET_RE  = /^(?:яркость|поставь яркость|set brightness(?:\s+to)?)\s+(\d+)|(?:поставь|сделай)\s+(\d+)\s*(?:процентов?|%|прцентов?)?\s*яркост[ьи]/i

  if (BRIGHT_UP_RE.test(lower)) {
    const { level } = await window.electronAPI.brightnessAdjust(10)
    return { handled: true, response: level >= 0 ? `Яркость: **${level}%**` : 'Яркость увеличена.' }
  }
  if (BRIGHT_DOWN_RE.test(lower)) {
    const { level } = await window.electronAPI.brightnessAdjust(-10)
    return { handled: true, response: level >= 0 ? `Яркость: **${level}%**` : 'Яркость уменьшена.' }
  }
  const brightSetMatch = BRIGHT_SET_RE.exec(lower)
  if (brightSetMatch) {
    const pct = Math.max(0, Math.min(100, parseInt(brightSetMatch[1] ?? brightSetMatch[2])))
    const { success, level } = await window.electronAPI.brightnessSet(pct)
    return {
      handled: true,
      response: success
        ? `Яркость: **${level}%**`
        : 'Не получилось изменить яркость через Windows WMI. Возможно, это внешний монитор или Windows запрещает доступ.',
    }
  }
  if (lower === 'яркость' || lower === 'brightness' || lower === 'какая яркость') {
    const { level } = await window.electronAPI.brightnessGet()
    return { handled: true, response: level >= 0 ? `Текущая яркость: **${level}%**` : 'Не удалось получить яркость.' }
  }

  // ── Window management ─────────────────────────────────────────────────────────
  const WIN_MIN_ALL = ['сверни все окна', 'сверни все', 'minimize all', 'minimise all']
  const WIN_RES_ALL = ['разверни окна', 'восстанови окна', 'restore all windows', 'restore all']
  const WIN_FOCUS_RE = /^(?:переключи на|открой окно|switch to|focus on)\s+(.+)/i
  const WIN_CLOSE_RE = /^(?:закрой|close)\s+(?:приложение\s+|окно\s+)?(.+)/i

  if (WIN_MIN_ALL.includes(lower)) {
    await window.electronAPI.windowMinimizeAll()
    return { handled: true, response: 'Все окна свёрнуты.' }
  }
  if (WIN_RES_ALL.includes(lower)) {
    await window.electronAPI.windowRestoreAll()
    return { handled: true, response: 'Окна восстановлены.' }
  }
  const winFocusMatch = WIN_FOCUS_RE.exec(lower)
  if (winFocusMatch) {
    // Strip trailing " и закрой (его)" to get clean name
    const raw = winFocusMatch[1].trim()
    const closeAfter = /\s+и\s+закрой(\s+его)?$/i.test(raw)
    const name = raw.replace(/\s+и\s+закрой(\s+его)?$/i, '').trim()
    const processName = resolveProcessName(name)
    ctx.lastApp = name.toLowerCase().trim()
    applyCommandContextResult(ctx, {
      handled: true,
      response: '',
      contextUpdate: { target: 'app', value: ctx.lastApp, previousValue: ctx.history.app?.value ?? null, label: name },
    })
    const { found } = await window.electronAPI.windowFocus(processName)
    if (closeAfter) {
      await window.electronAPI.windowClose(processName)
      return { handled: true, response: found ? `Переключаю и закрываю **${name}**.` : `Закрываю **${name}**.` }
    }
    return { handled: true, response: found ? `Переключаю на **${name}**.` : `Окно «${name}» не найдено.` }
  }
  const winCloseMatch = WIN_CLOSE_RE.exec(lower)
  if (winCloseMatch && !lower.startsWith('закрой файл') && !lower.startsWith('close file')) {
    let rawName = winCloseMatch[1].trim()
    // Resolve pronouns ("его", "его", "это") using last mentioned app
    const PRONOUNS = ['его', 'него', 'это', 'it', 'that']
    if (PRONOUNS.includes(rawName) && ctx.lastApp) {
      rawName = ctx.lastApp
    }
    const processName = resolveProcessName(rawName)
    await window.electronAPI.windowClose(processName)
    applyCommandContextResult(ctx, {
      handled: true,
      response: '',
      contextUpdate: { target: 'app', value: rawName, previousValue: ctx.history.app?.value ?? null, label: rawName },
    })
    return { handled: true, response: `Закрываю **${rawName}**.` }
  }

  // ── System info ──────────────────────────────────────────────────────────────
  const SYSINFO_RE = /^(системная информация|сколько ram|сколько памяти|оперативная память|температура|заряд батареи|батарея|диск|system info|how much ram|cpu temp|battery|disk usage)$/i
  if (SYSINFO_RE.test(lower)) {
    const { text } = await window.electronAPI.getSystemInfo()
    return { handled: true, response: text }
  }

  // ── Current track ─────────────────────────────────────────────────────────────
  const TRACK_RE = /^(что сейчас играет|что играет|текущий трек|what('s| is) playing|current track|now playing)$/i
  if (TRACK_RE.test(lower)) {
    const { text } = await window.electronAPI.getCurrentTrack()
    return { handled: true, response: text }
  }

  // ── Volume control ────────────────────────────────────────────────────────────
  const VOLUME_UP_RE   = /^(громче|сделай громче|увеличь громкость|volume up|louder|increase volume)(\s+на\s+(\d+))?/i
  const VOLUME_DOWN_RE = /^(тише|сделай тише|уменьши громкость|volume down|quieter|decrease volume)(\s+на\s+(\d+))?/i
  // Matches: "громкость 70", "поставь громкость 70", "поставь 70 громкость",
  //          "поставь 70 процентов громкость", "set volume 70", "volume 70%"
  const VOLUME_SET_RE  = /(?:громкост[ьи]|поставь\s+громкост[ьи]|установи\s+громкост[ьи]|set volume(?:\s+to)?)\s+(?:на\s+|до\s+)?(\d+)|(?:поставь|сделай|установи)\s+(\d+)\s*(?:процентов?|проц\.?|%|прцентов?)?\s*громкост[ьи]/i
  const MUTE_RE        = /^(выключи звук|заглуши|без звука|mute)/i
  const UNMUTE_RE      = /^(включи звук|unmute|верни звук)/i

  if (VOLUME_UP_RE.test(lower)) {
    const m = VOLUME_UP_RE.exec(lower)
    const delta = m?.[3] ? parseInt(m[3]) : 10
    const { level } = await window.electronAPI.volumeAdjust(delta)
    return { handled: true, response: level >= 0 ? `Громкость: **${level}%**` : 'Громкость увеличена.' }
  }
  if (VOLUME_DOWN_RE.test(lower)) {
    const m = VOLUME_DOWN_RE.exec(lower)
    const delta = m?.[3] ? parseInt(m[3]) : 10
    const { level } = await window.electronAPI.volumeAdjust(-delta)
    return { handled: true, response: level >= 0 ? `Громкость: **${level}%**` : 'Громкость уменьшена.' }
  }
  const volSetMatch = VOLUME_SET_RE.exec(lower)
  if (volSetMatch) {
    const pct = Math.max(0, Math.min(100, parseInt(volSetMatch[1] ?? volSetMatch[2])))
    await window.electronAPI.volumeSet(pct)
    return { handled: true, response: `Громкость: **${pct}%**` }
  }
  if (MUTE_RE.test(lower)) {
    await window.electronAPI.mute(true)
    return { handled: true, response: 'Звук выключен.' }
  }
  if (UNMUTE_RE.test(lower)) {
    await window.electronAPI.mute(false)
    return { handled: true, response: 'Звук включён.' }
  }
  if (lower === 'громкость' || lower === 'volume' || lower === 'какая громкость') {
    const { level } = await window.electronAPI.volumeGet()
    return { handled: true, response: level >= 0 ? `Текущая громкость: **${level}%**` : 'Не удалось получить уровень громкости.' }
  }

  // ── Media control ─────────────────────────────────────────────────────────────
  const MEDIA_MAP: Array<[RegExp, string, string]> = [
    [/^(пауза|поставь паузу|поставь на паузу|pause|stop music|стоп музыка)$/i, 'playpause', 'Пауза.'],
    [/^(воспроизвести|продолжить|play|возобнови|продолжи музыку)$/i,      'playpause', 'Воспроизведение.'],
    [/^(следующий трек|следующая песня|next track|next song|следующий)$/i,'next',      'Следующий трек.'],
    [/^(предыдущий трек|предыдущая песня|prev|previous|предыдущий)$/i,    'prev',      'Предыдущий трек.'],
    [/^(стоп|stop playback|остановить музыку)$/i,                         'stop',      'Остановлено.'],
  ]
  for (const [re, action, reply] of MEDIA_MAP) {
    if (re.test(lower)) {
      await window.electronAPI.mediaControl(action)
      return { handled: true, response: reply }
    }
  }

  // ── Weather ───────────────────────────────────────────────────────────────────
  // Matches: "погода в Москве", "покажи погоду Астана", "какая погода в Алматы",
  //          "weather in London", "what's the weather in Paris"
  const WEATHER_DEFAULT_RE = /^(?:погода|какая\s+(?:сегодня\s+)?погода|покажи\s+(?:сегодняшнюю\s+)?погоду|weather|today'?s\s+weather)$/i
  if (WEATHER_DEFAULT_RE.test(lower)) {
    const r = await window.electronAPI.getWeather(DEFAULT_WEATHER_CITY)
    if (!r.success) return { handled: true, response: `Не могу получить погоду: ${r.error}` }
    return { handled: true, response: r.data! }
  }

  const WEATHER_RE = /(?:покажи\s+(?:сегодняшнюю\s+)?погод[ую]|какая\s+(?:сегодня\s+)?погода|погода|weather|what(?:'s|\s+is)\s+the\s+weather(?:\s+like)?)\s+(?:в\s+|in\s+|for\s+|of\s+)?(.+)/i
  const weatherMatch = WEATHER_RE.exec(lower)
  if (weatherMatch) {
    // Preserve original casing from input
    const matchedCity = weatherMatch[1].trim()
    const cityStartIdx = lower.lastIndexOf(matchedCity)
    const city = input.slice(cityStartIdx).trim()
    const r = await window.electronAPI.getWeather(city)
    if (!r.success) return { handled: true, response: `Не могу получить погоду: ${r.error}` }
    return { handled: true, response: r.data! }
  }
  // ── Screenshot ───────────────────────────────────────────────────────────────
  const SCREENSHOT_RE     = /^(?:сделай\s+скриншот|скриншот|screenshot|сфоткай\s+экран|захвати\s+экран|capture\s+screen)/i
  const SCREENSHOT_FOLDER = /^(?:открой\s+папку\s+скриншотов|open\s+screenshots\s+folder|папка\s+скриншотов)/i

  if (SCREENSHOT_RE.test(lower)) {
    const r = await window.electronAPI.takeScreenshot()
    if (!r.success) return { handled: true, response: `Не удалось сделать скриншот: ${r.error}` }
    const filename = r.path!.split(/[/\\]/).pop()!
    return { handled: true, response: `Скриншот сохранён: **${filename}**` }
  }
  if (SCREENSHOT_FOLDER.test(lower)) {
    await window.electronAPI.openScreenshotsFolder()
    return { handled: true, response: 'Открываю папку со скриншотами.' }
  }

  // ── Clipboard ─────────────────────────────────────────────────────────────────
  const CLIPBOARD_READ_RE = /(?:прочитай|покажи|что\s+в|проверь|выведи)\s+буфер(?:\s+обмена)?|буфер\s+обмена|read\s+clipboard|show\s+clipboard|what(?:'s|\s+is)\s+in\s+(?:the\s+)?clipboard|paste\s+clipboard/i
  if (CLIPBOARD_READ_RE.test(lower)) {
    const { text } = await window.electronAPI.clipboardRead()
    if (!text.trim()) return { handled: true, response: 'Буфер обмена пуст.' }
    const preview = text.length > 500 ? text.slice(0, 500) + '…' : text
    return { handled: true, response: `Содержимое буфера обмена:\n\n${preview}` }
  }

  const COPY_RE = /^(?:скопируй|copy to clipboard)[:\s]+(.+)/is
  const copyMatch = COPY_RE.exec(input)
  if (copyMatch) {
    const textToCopy = copyMatch[1].trim()
    await window.electronAPI.clipboardWrite(textToCopy)
    return { handled: true, response: `Скопировано в буфер обмена: **${textToCopy.slice(0, 60)}${textToCopy.length > 60 ? '…' : ''}**` }
  }

  // ── Telegram ─────────────────────────────────────────────────────────────────
  //
  // «напиши Ивану: текст»       → открыть Telegram с предзаполнением (не отправлять)
  // «отправь Ивану: текст»      → открыть Telegram + автоматически нажать Enter
  // «добавь контакт Иван @username» → сохранить алиас
  // «удали контакт Иван»        → удалить алиас
  // «покажи контакты телеграм»  → список сохранённых контактов

  const TG_WRITE_RE  = /^(?:напиши|напишиему|написать|write to|message)\s+(.+)/i
  const TG_SEND_RE   = /^(?:отправь|отправить|send to|send)\s+(.+)/i
  const TG_ADD_RE    = /^(?:добавь контакт|добавить контакт|add contact|сохрани контакт)\s+(.+?)\s+(@?\S+)/i
  const TG_DEL_RE    = /^(?:удали контакт|удалить контакт|remove contact|delete contact)\s+(.+)/i
  const TG_LIST      = ['контакты телеграм', 'покажи контакты', 'список контактов', 'telegram contacts', 'list contacts']

  const tgWriteMatch = TG_WRITE_RE.exec(input)
  if (tgWriteMatch) {
    const args = parseTgArgs(tgWriteMatch[1].trim())
    if (!args) return { handled: true, response: 'Укажи получателя и текст. Пример: «напиши Жамбо как дела»' }
    const [to, text] = args
    const r = await window.electronAPI.telegramSend(to, text, false)
    if (!r.success) return { handled: true, response: `Telegram: ${r.error}` }
    return { handled: true, response: `Открываю Telegram для @${r.username} с сообщением:\n«${text}»\n\nНажми Enter в Telegram чтобы отправить.` }
  }

  const tgSendMatch = TG_SEND_RE.exec(input)
  if (tgSendMatch) {
    const args = parseTgArgs(tgSendMatch[1].trim())
    if (!args) return { handled: true, response: 'Укажи получателя и текст. Пример: «отправь Жамбо как дела»' }
    const [to, text] = args
    const r = await window.electronAPI.telegramSend(to, text, true)
    if (!r.success) return { handled: true, response: `Telegram: ${r.error}` }
    return { handled: true, response: `Отправляю в Telegram @${r.username}:\n«${text}»` }
  }

  const tgAddMatch = TG_ADD_RE.exec(input)
  if (tgAddMatch) {
    const name = tgAddMatch[1].trim()
    const username = tgAddMatch[2].trim()
    await window.electronAPI.telegramAddContact(name, username)
    return { handled: true, response: `Контакт сохранён: **${name}** → @${username.replace('@', '')}` }
  }

  const tgDelMatch = TG_DEL_RE.exec(input)
  if (tgDelMatch) {
    const name = tgDelMatch[1].trim()
    const { success } = await window.electronAPI.telegramRemoveContact(name)
    if (!success) return { handled: true, response: `Контакт «${name}» не найден.` }
    return { handled: true, response: `Контакт **${name}** удалён.` }
  }

  if (TG_LIST.includes(lower)) {
    const { contacts } = await window.electronAPI.telegramListContacts()
    const entries = Object.entries(contacts)
    if (entries.length === 0) return { handled: true, response: 'Контакты пусты.\n\nДобавь: «добавь контакт Иван @ivanpetrov»' }
    const lines = entries.map(([name, username]) => `• **${name}** → @${username}`)
    return { handled: true, response: `Контакты Telegram (${entries.length}):\n\n${lines.join('\n')}` }
  }

  // ── /test — run all diagnostics ─────────────────────────────────────────────
  if (lower === '/test' || lower === 'тест' || lower === '/тест') {
    return { handled: true, response: '__RUN_DIAGNOSTICS__' }
  }

  return noop
}

// ── Diagnostics runner ────────────────────────────────────────────────────────
//
// Runs each feature in sequence and calls onUpdate(markdown) after every step.
// Safe: only read/non-destructive calls; no files are deleted, no windows closed.

type DiagUpdate = (md: string) => void

async function runDiagnostics(onUpdate: DiagUpdate): Promise<void> {
  const lines: string[] = ['## Диагностика Лили\n']
  const tick = () => onUpdate(lines.join('\n'))

  async function test(label: string, fn: () => Promise<string>) {
    lines.push(`⏳ **${label}**…`)
    tick()
    try {
      const result = await fn()
      // Replace last line (the ⏳ one) with result
      lines[lines.length - 1] = `✅ **${label}** — ${result}`
    } catch (e) {
      lines[lines.length - 1] = `❌ **${label}** — ${e instanceof Error ? e.message : String(e)}`
    }
    tick()
    // Small pause so updates are visible one by one
    await new Promise((r) => setTimeout(r, 300))
  }

  // 1. Volume
  await test('Громкость (get)', async () => {
    const { level } = await window.electronAPI.volumeGet()
    if (level < 0) throw new Error('не удалось получить уровень')
    return `${level}%`
  })

  // 2. Brightness
  await test('Яркость (get)', async () => {
    const { level } = await window.electronAPI.brightnessGet()
    if (level < 0) throw new Error('WMI недоступен (ноутбук/настройки WMI?)')
    return `${level}%`
  })

  // 3. Ollama status
  await test('Ollama статус', async () => {
    const status = await window.electronAPI.getStatus()
    return status
  })

  // 4. Models list
  await test('Список моделей', async () => {
    const { success, models } = await window.electronAPI.getModels()
    if (!success || models.length === 0) throw new Error('нет моделей')
    return models.join(', ')
  })

  // 5. Weather
  await test('Погода (Астана)', async () => {
    const r = await window.electronAPI.getWeather('Астана')
    if (!r.success) throw new Error(r.error ?? 'нет ответа')
    return 'OK'
  })

  // 6. Web search
  await test('Веб-поиск (DuckDuckGo)', async () => {
    const r = await window.electronAPI.webSearch('test')
    if (!r.success) throw new Error('нет результатов')
    return 'OK'
  })

  // 7. Clipboard
  await test('Буфер обмена (read)', async () => {
    const { text } = await window.electronAPI.clipboardRead()
    return text.length > 0 ? `«${text.slice(0, 30)}…»` : '(пусто, норма)'
  })

  // 8. System info
  await test('Системная информация', async () => {
    const { text } = await window.electronAPI.getSystemInfo()
    if (!text) throw new Error('нет данных')
    return 'OK'
  })

  // 9. Current track
  await test('Текущий трек (SMTC)', async () => {
    const { text } = await window.electronAPI.getCurrentTrack()
    return text || '(ничего не играет, норма)'
  })

  // 10. Todo list
  await test('Список задач', async () => {
    const { tasks } = await window.electronAPI.todoList()
    return `${tasks.length} задач`
  })

  // 11. Journal list
  await test('Журнал (список дней)', async () => {
    const { days } = await window.electronAPI.journalList()
    return `${days.length} записей`
  })

  // 12. Notes list
  await test('Заметки', async () => {
    const notes = await window.electronAPI.listNotes(false)
    return `${notes.length} заметок`
  })

  // 13. Facts (memory)
  await test('Долгосрочная память', async () => {
    const facts = await window.electronAPI.loadFacts()
    return `${facts.length} фактов`
  })

  // 14. Reminders
  await test('Напоминания', async () => {
    const { reminders } = await window.electronAPI.listReminders()
    return `${reminders.length} активных`
  })

  // 15. Known apps
  await test('Список приложений', async () => {
    const { apps } = await window.electronAPI.listApps()
    return `${apps.length} приложений`
  })

  // 16. Voice status
  await test('Голосовой ввод (Whisper)', async () => {
    const s = await window.electronAPI.getVoiceStatus()
    if (!s.available) throw new Error(s.error ?? 'недоступен')
    return `bin: ${s.binPath}`
  })

  // 17. Workspace files
  await test('Файловый workspace', async () => {
    const r = await window.electronAPI.listWorkspaceFiles()
    if (!r.success) throw new Error(r.error ?? 'ошибка')
    return 'OK'
  })

  // 18. Timer (create → list → cancel)
  await test('Таймер', async () => {
    await window.electronAPI.scheduleReminder('_test_timer_', '⏱ test', 60000)
    const { reminders } = await window.electronAPI.listReminders()
    const found = reminders.find((r) => r.id === '_test_timer_')
    await window.electronAPI.cancelReminder('_test_timer_')
    if (!found) throw new Error('таймер не создался')
    return 'OK'
  })

  // 19. Screenshot
  await test('Скриншот', async () => {
    const r = await window.electronAPI.takeScreenshot()
    if (!r.success) throw new Error(r.error ?? 'ошибка')
    return r.path!.split(/[/\\]/).pop() ?? 'OK'
  })

  // 20. Command history
  await test('История команд', async () => {
    const { days } = await window.electronAPI.commandHistoryList()
    return `${days.length} дней`
  })

  // Count pass/fail
  const passed = lines.filter((l) => l.startsWith('✅')).length
  const failed  = lines.filter((l) => l.startsWith('❌')).length
  lines.push('')
  lines.push(`---\n**Итог: ${passed} прошло, ${failed} ошибок**`)
  tick()
}

// ── useChat hook ──────────────────────────────────────────────────────────────

export function useChat(model: string, activeContext = '') {
  const [messages, setMessages]   = useState<Message[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError]         = useState<string | null>(null)
  const [chatDebug, setChatDebug] = useState<ChatDebugInfo | null>(null)
  const historyLoaded             = useRef(false)
  const messagesRef               = useRef<Message[]>([])
  const saveTimerRef              = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastAppCtxRef             = useRef<CommandContext>({
    lastApp: '',
    pendingAction: '',
    lastTarget: '',
    lastValue: null,
    previousValue: null,
    lastCommandAt: 0,
    history: {},
  })
  const prewarmTimerRef           = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingVoiceConfirmationRef = useRef<PendingVoiceConfirmation | null>(null)

  // Keep ref in sync so sendMessage always sees latest messages without being in deps
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(() => {
    window.electronAPI.loadHistory().then((saved) => {
      if (saved.length > 0) setMessages(saved)
      historyLoaded.current = true
    })
  }, [])

  // Debounced save — avoids disk thrashing on rapid message updates
  useEffect(() => {
    if (!historyLoaded.current) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      window.electronAPI.saveHistory(messagesRef.current)
    }, 500)
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [messages])

  const sendMessage = useCallback(
    async (content: string, source: MessageSource = 'text') => {
      let effectiveContent = content.trim()
      if (!effectiveContent || isLoading) return
      setChatDebug({
        source,
        input: effectiveContent,
        route: 'chat',
        intent: 'pending',
        handled: false,
        at: Date.now(),
      })

      if (source === 'voice') {
        const pending = pendingVoiceConfirmationRef.current
        if (pending) {
          if (Date.now() - pending.createdAt > VOICE_CONFIRM_TIMEOUT_MS) {
            pendingVoiceConfirmationRef.current = null
            setChatDebug({
              source,
              input: effectiveContent,
              route: 'blocked',
              intent: 'voice.confirm.timeout',
              handled: true,
              at: Date.now(),
            })
            setMessages((prev) => [
              ...prev,
              {
                id: uid(),
                role: 'assistant',
                content: 'Подтверждение голосовой команды истекло. Повтори команду заново, если она все еще нужна.',
                createdAt: Date.now(),
              },
            ])
            return
          }

          if (VOICE_CANCEL_RE.test(effectiveContent)) {
            pendingVoiceConfirmationRef.current = null
            setChatDebug({
              source,
              input: effectiveContent,
              route: 'blocked',
              intent: 'voice.confirm.cancel',
              handled: true,
              at: Date.now(),
            })
            setMessages((prev) => [
              ...prev,
              {
                id: uid(),
                role: 'assistant',
                content: 'Опасная голосовая команда отменена.',
                createdAt: Date.now(),
              },
            ])
            return
          }

          if (VOICE_CONFIRM_RE.test(effectiveContent)) {
            effectiveContent = pending.command
            pendingVoiceConfirmationRef.current = null
          }
        }

        if (isDangerousVoiceCommand(effectiveContent)) {
          pendingVoiceConfirmationRef.current = {
            command: effectiveContent,
            createdAt: Date.now(),
          }
          setChatDebug({
            source,
            input: effectiveContent,
            route: 'blocked',
            intent: 'voice.confirm.required',
            handled: true,
            at: Date.now(),
          })
          setMessages((prev) => [
            ...prev,
            {
              id: uid(),
              role: 'assistant',
              content: buildVoiceConfirmationPrompt(effectiveContent),
              createdAt: Date.now(),
            },
          ])
          return
        }
      }

      const currentMessages = messagesRef.current
      const userMsg: Message = {
        id: uid(),
        role: 'user',
        content: effectiveContent,
        createdAt: Date.now(),
      }

      const nextMessages = [...currentMessages, userMsg]
      setMessages(nextMessages)
      setIsLoading(true)
      setError(null)

      try {
        // ── Multi-command: "включи X и поставь громкость на 100" ─────────────
        const parts = splitMultiCommand(effectiveContent)
        if (parts.length > 1) {
          const results: CommandResult[] = []
          for (const part of parts) {
            results.push(await parseCommand(part, currentMessages, lastAppCtxRef.current))
          }
          if (results.every(r => r.handled)) {
            setChatDebug({
              source,
              input: effectiveContent,
              route: 'command',
              intent: results.map((r) => r.debugIntent ?? 'command.legacy').join(' + '),
              handled: true,
              at: Date.now(),
            })
            window.electronAPI.commandHistoryWrite(effectiveContent).catch(() => {})
            const combined = results.map(r => r.response).filter(Boolean).join('\n')
            setMessages(prev => [...prev, { id: uid(), role: 'assistant', content: combined, createdAt: Date.now() }])
            return
          }
          // Not all parts handled — fall through to single parseCommand below
        }

        // Check for built-in commands first
        const cmd = await parseCommand(effectiveContent, currentMessages, lastAppCtxRef.current)
        if (cmd.handled) {
          setChatDebug({
            source,
            input: effectiveContent,
            route: cmd.response === '__RUN_DIAGNOSTICS__' ? 'diagnostics' : 'command',
            intent: cmd.debugIntent ?? 'command.legacy',
            handled: true,
            at: Date.now(),
          })
          // Auto-log every handled command (skip diagnostics and history queries)
          const skipLog = ['__RUN_DIAGNOSTICS__', 'что я делал сегодня', 'что я делал вчера', 'история команд', 'список дней']
          if (!skipLog.some((s) => cmd.response === s || effectiveContent.toLowerCase() === s)) {
            window.electronAPI.commandHistoryWrite(effectiveContent).catch(() => {})
          }

          // Special case: /test — create a live-updating message
          if (cmd.response === '__RUN_DIAGNOSTICS__') {
            const diagId = uid()
            setMessages((prev) => [
              ...prev,
              { id: diagId, role: 'assistant', content: '## Диагностика Лили\n\n⏳ Запускаю тесты…', createdAt: Date.now(), streaming: true },
            ])
            await runDiagnostics((md) => {
              setMessages((prev) =>
                prev.map((m) => (m.id === diagId ? { ...m, content: md } : m))
              )
            })
            setMessages((prev) =>
              prev.map((m) => (m.id === diagId ? { ...m, streaming: false } : m))
            )
            return
          }

          const assistantMsg: Message = {
            id: uid(),
            role: 'assistant',
            content: cmd.response,
            createdAt: Date.now(),
          }
          setMessages((prev) => [...prev, assistantMsg])
          return
        }

        // ── Cache hit: instant response ───────────────────────────────────
        const cached = cacheGet(effectiveContent)
        if (cached) {
          setChatDebug({
            source,
            input: effectiveContent,
            route: 'cache',
            intent: 'response.cache',
            handled: true,
            at: Date.now(),
          })
          const cachedMsg: Message = {
            id: uid(),
            role: 'assistant',
            content: cached,
            createdAt: Date.now(),
          }
          setMessages((prev) => [...prev, cachedMsg])
          return
        }

        // ── Create streaming message placeholder ──────────────────────────
        setChatDebug({
          source,
          input: effectiveContent,
          route: 'chat',
          intent: 'qwen.stream',
          handled: false,
          at: Date.now(),
        })
        const assistantId = uid()
        setMessages((prev) => [
          ...prev,
          { id: assistantId, role: 'assistant', content: '', createdAt: Date.now(), streaming: true },
        ])

        // ── Pre-warm: if already started for this prompt, drain its chunks ─
        const pw = prewarm?.key === cacheKey(effectiveContent) ? prewarm : null
        clearPrewarm()

        if (pw) {
          // Replay already-received chunks immediately
          if (pw.chunks.length > 0) {
            const partial = pw.chunks.join('')
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: partial } : m))
            )
          }

          if (pw.done) {
            // Pre-warm finished before user hit send
            const fullText = pw.chunks.join('')
            if (pw.error) throw new Error(pw.error)
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: fullText, streaming: false } : m))
            )
            cacheSet(effectiveContent, fullText)
            executeCreateFileBlocks(fullText)
            return
          }

          // Pre-warm still in progress — subscribe to remaining chunks
          await new Promise<void>((resolve, reject) => {
            // Forward remaining chunks (pre-warm already registered its own listener,
            // but it wrote to pw.chunks; we need to mirror those into the message)
            const interval = setInterval(() => {
              const current = pw.chunks.join('')
              setMessages((prev) =>
                prev.map((m) => (m.id === assistantId ? { ...m, content: current } : m))
              )
              if (pw.done) {
                clearInterval(interval)
                setMessages((prev) =>
                  prev.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m))
                )
                if (pw.error) { reject(new Error(pw.error)); return }
                const fullText = pw.chunks.join('')
                cacheSet(effectiveContent, fullText)
                executeCreateFileBlocks(fullText)
                resolve()
              }
            }, 50)
          })
          return
        }

        // ── Normal stream from Ollama ─────────────────────────────────────
        await new Promise<void>((resolve, reject) => {
          let fullText = ''
          const cleanupChunk = window.electronAPI.onStreamChunk((chunk) => {
            fullText += chunk
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + chunk } : m))
            )
          })

          window.electronAPI.onStreamEnd((result) => {
            cleanupChunk()
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m))
            )
            if (result.success) {
              if (!fullText.trim()) {
                const message = 'Qwen не прислал текст. Попробуй еще раз или нажми Retry, если сервер завис.'
                setMessages((prev) =>
                  prev.map((m) => (m.id === assistantId ? { ...m, content: message } : m))
                )
                reject(new Error(message))
                return
              }
              setMessages((prev) => {
                const msg = prev.find((m) => m.id === assistantId)
                if (msg) {
                  cacheSet(effectiveContent, msg.content)
                  executeCreateFileBlocks(msg.content)
                }
                return prev
              })
              resolve()
            } else {
              const message = result.error ?? 'Stream failed'
              setMessages((prev) =>
                prev.map((m) => (m.id === assistantId ? { ...m, content: `Ошибка: ${message}` } : m))
              )
              reject(new Error(message))
            }
          })

          window.electronAPI.startChatStream(nextMessages, model, activeContext)
        })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to reach Ollama')
      } finally {
        setIsLoading(false)
      }
    },
    [isLoading, model, activeContext]
  )

  const clearMessages = useCallback(() => {
    setMessages([])
    setError(null)
    window.electronAPI.clearHistory()
  }, [])

  const stopGeneration = useCallback(() => {
    if (!isLoading) return
    window.electronAPI.abortChatStream()
    // Mark any streaming message as done immediately
    setMessages((prev) =>
      prev.map((m) => (m.streaming ? { ...m, streaming: false } : m))
    )
    setIsLoading(false)
  }, [isLoading])

  // Called from ChatInput on every keystroke — debounces pre-warm by 1.2s
  const prewarmMessage = useCallback(
    (content: string) => {
      if (prewarmTimerRef.current) clearTimeout(prewarmTimerRef.current)
      if (!ENABLE_STREAM_PREWARM) return
      if (!content.trim() || isLoading) return
      prewarmTimerRef.current = setTimeout(() => {
        startPrewarm(content.trim(), messagesRef.current, model, activeContext)
      }, 1200)
    },
    [isLoading, model, activeContext]
  )

  return { messages, isLoading, error, sendMessage, clearMessages, stopGeneration, prewarmMessage, chatDebug }
}
