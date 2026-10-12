import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { PIPER_BIN_NAME, PIPER_EN_MODEL, PIPER_RU_MODEL } from './constants'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TTSResult {
  success: boolean
  audioBase64?: string
  error?: string
}

type Language = 'ru' | 'en'

interface Segment {
  text: string
  lang: Language
}

// ── Config ────────────────────────────────────────────────────────────────────

function getPiperDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'piper')
    : join(app.getAppPath(), 'piper')
}

function getPiperConfig() {
  const dir = getPiperDir()
  return {
    bin:     process.env.PIPER_BIN      ?? join(dir, PIPER_BIN_NAME),
    modelEn: process.env.PIPER_MODEL_EN ?? join(dir, 'models', PIPER_EN_MODEL),
    modelRu: process.env.PIPER_MODEL_RU ?? join(dir, 'models', 'ru', PIPER_RU_MODEL),
  }
}

function getModelForLanguage(lang: Language): string {
  const { modelEn, modelRu } = getPiperConfig()
  return lang === 'ru' ? modelRu : modelEn
}

// ── Language detection ────────────────────────────────────────────────────────

function detectTokenLanguage(token: string): 'ru' | 'en' | 'neutral' {
  let ru = 0
  let en = 0
  for (const ch of token) {
    if (/[а-яёА-ЯЁ]/.test(ch)) ru++
    else if (/[a-zA-Z]/.test(ch)) en++
  }
  if (ru > en) return 'ru'
  if (en > ru) return 'en'
  return 'neutral'
}

// ── Markdown / punctuation cleanup before TTS ─────────────────────────────────
//
// Strips symbols that Piper would read aloud literally ("звезда звезда", etc.)
// Order matters: more specific patterns must run before generic ones.

function cleanTextForTTS(raw: string): string {
  let t = raw

  // Code blocks (``` ... ```) — keep content, drop fences
  t = t.replace(/```[\w]*\n?([\s\S]*?)```/g, '$1')

  // Inline code (`code`) — keep content
  t = t.replace(/`([^`]+)`/g, '$1')

  // Markdown links [text](url) → text
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')

  // Images ![alt](url) → drop entirely
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '')

  // Bold + italic ***text*** or ___text___
  t = t.replace(/\*{3}([^*]+)\*{3}/g, '$1')
  t = t.replace(/_{3}([^_]+)_{3}/g, '$1')

  // Bold **text** or __text__
  t = t.replace(/\*{2}([^*]+)\*{2}/g, '$1')
  t = t.replace(/_{2}([^_]+)_{2}/g, '$1')

  // Italic *text* or _text_
  t = t.replace(/\*([^*\n]+)\*/g, '$1')
  t = t.replace(/_([^_\n]+)_/g, '$1')

  // Headers: ## Title → Title
  t = t.replace(/^#{1,6}\s+/gm, '')

  // Horizontal rules (---, ***, ===)
  t = t.replace(/^[-*=]{3,}\s*$/gm, '')

  // Blockquotes: > text → text
  t = t.replace(/^>\s?/gm, '')

  // Unordered list bullets at line start (-, *, +)
  t = t.replace(/^[\-\*\+]\s+/gm, '')

  // Numbered list dots: "1. " → "1 " (keep number, drop dot)
  t = t.replace(/^(\d+)\.\s+/gm, '$1 ')

  // Table pipes and separator rows
  t = t.replace(/\|/g, ' ')
  t = t.replace(/^[\s\-:]+$/gm, '')

  // HTML tags
  t = t.replace(/<[^>]+>/g, '')

  // Bare URLs (http/https)
  t = t.replace(/https?:\/\/\S+/g, '')

  // Strip ALL [COMMAND: ...] block tags (CREATE_FILE, DELETE_FILE, etc.)
  // Paired blocks: [TAG: ...]...[/TAG]
  t = t.replace(/\[[A-Z_]+:[^\]]*\][\s\S]*?\[\/[A-Z_]+\]/gi, '')
  // Orphan opening or closing tags: [TAG: value] or [/TAG]
  t = t.replace(/\[[A-Z_]+:[^\]]*\]/gi, '')
  t = t.replace(/\[\/[A-Z_]+\]/gi, '')

  // Emoji — strip all Unicode emoji and pictographs
  t = t.replace(/[\u{1F000}-\u{1FFFF}]/gu, '')   // Emoticons, symbols, transport, etc.
  t = t.replace(/[\u{2600}-\u{27BF}]/gu, '')      // Misc symbols (☀️ ⛅ ❄️ etc.)
  t = t.replace(/[\u{2300}-\u{23FF}]/gu, '')      // Misc technical (⏰ etc.)
  t = t.replace(/[\u{FE00}-\u{FEFF}]/gu, '')      // Variation selectors (invisible modifiers)
  t = t.replace(/\u200D/g, '')                    // Zero-width joiner
  t = t.replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '')   // Flag emoji

  // Remaining stray markdown symbols that have no content value
  // (lone asterisks, underscores, backticks, tildes)
  t = t.replace(/[*_`~]+/g, '')

  // Ellipsis, em-dash, en-dash → natural pause (comma or space)
  t = t.replace(/…/g, ', ')
  t = t.replace(/[—–]/g, ', ')

  // Collapse multiple blank lines → single newline
  t = t.replace(/\n{3,}/g, '\n\n')

  // Collapse multiple spaces
  t = t.replace(/[ \t]{2,}/g, ' ')

  return t.trim()
}

// ── Text segmentation ─────────────────────────────────────────────────────────

// Splits text into [word + trailing whitespace] tokens, preserving original spacing.
function tokenizeMixedText(text: string): string[] {
  return text.match(/\S+\s*/g) ?? []
}

function splitTextByLanguage(text: string): Segment[] {
  const tokens = tokenizeMixedText(text)
  if (tokens.length === 0) return []

  // Detect language for each token; resolve neutral tokens by forward-fill
  // (defaulting to 'ru' so that leading punctuation or numbers stay Russian).
  let lastLang: Language = 'ru'
  const resolved: Language[] = tokens.map((token) => {
    const lang = detectTokenLanguage(token)
    if (lang !== 'neutral') {
      lastLang = lang
      return lang
    }
    return lastLang
  })

  // Group consecutive same-language tokens into segments
  const segments: Segment[] = []
  let cur: Segment | null = null

  for (let i = 0; i < tokens.length; i++) {
    const lang = resolved[i]
    if (cur === null || cur.lang !== lang) {
      if (cur !== null) segments.push(cur)
      cur = { text: tokens[i], lang }
    } else {
      cur.text += tokens[i]
    }
  }
  if (cur !== null) segments.push(cur)

  return segments
}

// ── Short-insert smoothing ────────────────────────────────────────────────────
//
// Problem: switching voices for every short English abbreviation inside mostly
// Russian text sounds fragmented ("API", "MVP", "UI", etc.).
//
// Rule: if an English segment has ≤ SHORT_EN_MAX_WORDS words AND
// ≤ SHORT_EN_MAX_CHARS characters, and it has a neighboring Russian segment,
// absorb it into that Russian neighbor.
// Repeat until stable (handles sequences of short EN inserts: "ToD app").

const SHORT_EN_MAX_WORDS = 2
const SHORT_EN_MAX_CHARS = 15

function isShortEnglishInsert(seg: Segment): boolean {
  if (seg.lang !== 'en') return false
  const trimmed = seg.text.trim()
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length
  return wordCount <= SHORT_EN_MAX_WORDS && trimmed.length <= SHORT_EN_MAX_CHARS
}

function smoothShortLanguageSwitches(segments: Segment[]): Segment[] {
  if (segments.length <= 1) return segments

  const result: Segment[] = [...segments]
  let changed = true

  while (changed) {
    changed = false
    for (let i = 0; i < result.length; i++) {
      if (!isShortEnglishInsert(result[i])) continue

      const prevIsRu = i > 0 && result[i - 1].lang === 'ru'
      const nextIsRu = i < result.length - 1 && result[i + 1].lang === 'ru'

      if (prevIsRu) {
        result[i - 1] = { text: result[i - 1].text + result[i].text, lang: 'ru' }
        result.splice(i, 1)
        changed = true
        break
      } else if (nextIsRu) {
        result[i + 1] = { text: result[i].text + result[i + 1].text, lang: 'ru' }
        result.splice(i, 1)
        changed = true
        break
      }
    }
  }

  return result
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function synthesizeSpeech(text: string): Promise<TTSResult> {
  const trimmed = cleanTextForTTS(text)
  if (!trimmed) return { success: false, error: 'Пустой текст.' }

  const { bin } = getPiperConfig()

  try {
    await fs.access(bin)
  } catch {
    return { success: false, error: `Piper не найден:\n${bin}` }
  }

  const rawSegments = splitTextByLanguage(trimmed)
  const segments = smoothShortLanguageSwitches(rawSegments)

  console.log('[TTS] segments:', segments.map(s => `[${s.lang}] "${s.text.trim()}"`))

  const stamp = Date.now()
  const segmentWavs: string[] = []
  let mergedWavPath: string | null = null

  try {
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      const model = getModelForLanguage(seg.lang)

      try {
        await fs.access(model)
      } catch {
        return { success: false, error: `Модель Piper не найдена:\n${model}` }
      }

      const textPath = join(tmpdir(), `lili-tts-${stamp}-${i}.txt`)
      const wavPath  = join(tmpdir(), `lili-tts-${stamp}-${i}.wav`)

      await fs.writeFile(textPath, seg.text.trim(), 'utf-8')
      await runPiper(bin, model, textPath, wavPath)
      await fs.unlink(textPath).catch(() => {})

      segmentWavs.push(wavPath)
    }

    let finalWavPath: string

    if (segmentWavs.length === 1) {
      finalWavPath = segmentWavs[0]
    } else {
      mergedWavPath = join(tmpdir(), `lili-tts-${stamp}-merged.wav`)
      await mergeWavFiles(segmentWavs, mergedWavPath)
      finalWavPath = mergedWavPath
    }

    const wavBuffer = await fs.readFile(finalWavPath)
    return { success: true, audioBase64: wavBuffer.toString('base64') }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    for (const f of segmentWavs) {
      await fs.unlink(f).catch(() => {})
    }
    if (mergedWavPath) {
      await fs.unlink(mergedWavPath).catch(() => {})
    }
  }
}

// ── Piper runner ──────────────────────────────────────────────────────────────

function runPiper(
  bin: string,
  model: string,
  textPath: string,
  wavPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['--model', model, '--output_file', wavPath]
    let stderr = ''

    const proc = spawn(bin, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('error', (e) => reject(new Error(`Не удалось запустить Piper: ${e.message}`)))

    fs.readFile(textPath, 'utf-8')
      .then((content) => {
        proc.stdin.write(content)
        proc.stdin.end()
      })
      .catch((err) => reject(err))

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Piper завершился с кодом ${code}.\n${stderr.slice(0, 400)}`))
        return
      }
      resolve()
    })
  })
}

// ── WAV merging via ffmpeg ────────────────────────────────────────────────────

async function mergeWavFiles(inputPaths: string[], outputPath: string): Promise<void> {
  const stamp = Date.now()
  const concatListPath = join(tmpdir(), `lili-tts-concat-${stamp}.txt`)

  // ffmpeg concat demuxer wants forward slashes even on Windows
  const lines = inputPaths
    .map(p => `file '${p.replace(/\\/g, '/')}'`)
    .join('\n')

  await fs.writeFile(concatListPath, lines, 'utf-8')

  try {
    await runFfmpegConcat(concatListPath, outputPath)
  } finally {
    await fs.unlink(concatListPath).catch(() => {})
  }
}

function runFfmpegConcat(concatListPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatListPath,
      '-c', 'copy',
      outputPath,
    ]

    let stderr = ''

    const proc = spawn('ffmpeg', args, { windowsHide: true })

    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('error', (e) =>
      reject(new Error(
        `Не удалось запустить ffmpeg: ${e.message}\nУстанови ffmpeg и добавь его в PATH.`
      ))
    )
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg завершился с кодом ${code}.\n${stderr.slice(0, 600)}`))
        return
      }
      resolve()
    })
  })
}
