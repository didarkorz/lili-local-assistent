/**
 * Main-process local speech-to-text pipeline.
 *
 * Fast path:
 * - persistent whisper-server with a fast default model kept in RAM
 *
 * Adaptive path:
 * - command-length phrases use the fast server model (prefer ggml-base.bin)
 * - longer dictation can switch to a larger model through whisper-cli
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { availableParallelism, tmpdir } from 'node:os'
import { app } from 'electron'
import {
  WHISPER_BIN_NAME,
  WHISPER_SERVER_BIN_NAME,
  WHISPER_MODEL_NAME,
  WHISPER_SERVER_PORT,
} from './constants'
import { buildWhisperPrompt } from './whisperHints'

type WhisperModelTier = 'base' | 'small' | 'medium' | 'large'

export interface TranscribeResult {
  success: boolean
  text?: string
  error?: string
  meta?: {
    engine: 'server' | 'cli'
    modelName: string
    modelTier: WhisperModelTier
    durationSec: number
    prepareMs: number
    inferMs: number
    cleanupMs: number
    totalMs: number
  }
}

export interface WhisperStatus {
  available: boolean
  binPath: string
  modelPath: string
  error?: string
}

export interface TranscribeAudioInput {
  audioBuffer: Buffer
  mimeType: string
  extension: string
}

interface WhisperConfig {
  dir: string
  bin: string
  server: string
  defaultModel: string
  models: Partial<Record<WhisperModelTier, string>>
}

interface SelectedWhisperModel {
  path: string
  tier: WhisperModelTier
  name: string
}

const WHISPER_THREADS = Math.max(2, Math.min(8, availableParallelism() - 1 || 2))
const WHISPER_PROMPT = buildWhisperPrompt()

function getWhisperConfig(): WhisperConfig {
  const dir = app.isPackaged
    ? join(process.resourcesPath, 'whisper')
    : join(app.getAppPath(), 'whisper')

  const envModel = process.env.WHISPER_MODEL
  const defaultModelPath = join(dir, 'models', WHISPER_MODEL_NAME)

  const models: Partial<Record<WhisperModelTier, string>> = {
    base: existsSync(join(dir, 'models', 'ggml-base.bin')) ? join(dir, 'models', 'ggml-base.bin') : undefined,
    small: existsSync(join(dir, 'models', 'ggml-small.bin')) ? join(dir, 'models', 'ggml-small.bin') : undefined,
    medium: existsSync(join(dir, 'models', 'ggml-medium.bin')) ? join(dir, 'models', 'ggml-medium.bin') : undefined,
    large: existsSync(defaultModelPath) ? defaultModelPath : undefined,
  }

  const autoModel =
    models.base ??
    models.small ??
    models.medium ??
    models.large ??
    defaultModelPath

  return {
    dir,
    bin: process.env.WHISPER_BIN ?? join(dir, WHISPER_BIN_NAME),
    server: process.env.WHISPER_SERVER ?? join(dir, WHISPER_SERVER_BIN_NAME),
    defaultModel: envModel ?? autoModel,
    models,
  }
}

function detectModelTier(modelPath: string): WhisperModelTier {
  const lower = modelPath.toLowerCase()
  if (lower.includes('ggml-base')) return 'base'
  if (lower.includes('ggml-small')) return 'small'
  if (lower.includes('ggml-medium')) return 'medium'
  return 'large'
}

function selectModelForDuration(config: WhisperConfig, durationSec: number): SelectedWhisperModel {
  if (process.env.WHISPER_MODEL) {
    return {
      path: config.defaultModel,
      tier: detectModelTier(config.defaultModel),
      name: config.defaultModel.split(/[\\/]/).pop() ?? config.defaultModel,
    }
  }

  const shortModel = config.models.base ?? config.defaultModel
  const mediumModel = config.models.small ?? config.models.medium ?? shortModel
  const longModel = config.models.large ?? config.models.medium ?? config.models.small ?? shortModel

  const path =
    durationSec <= 12
      ? shortModel
      : durationSec <= 25
        ? mediumModel
        : longModel

  return {
    path,
    tier: detectModelTier(path),
    name: path.split(/[\\/]/).pop() ?? path,
  }
}

function estimateWavDurationSec(wavBuffer: Buffer): number {
  if (wavBuffer.length < 44) return 0
  const dataBytes = Math.max(0, wavBuffer.length - 44)
  return dataBytes / (16000 * 2)
}

let serverProcess: ChildProcess | null = null
let serverReady = false
let serverStarting = false
let serverModelPath = ''

export async function startWhisperServer(): Promise<void> {
  if (serverProcess || serverStarting) return
  serverStarting = true

  const { server, defaultModel } = getWhisperConfig()

  try {
    await fs.access(server)
  } catch {
    console.log('[whisper-server] whisper-server.exe not found, using whisper-cli fallback')
    serverStarting = false
    return
  }

  try {
    await fs.access(defaultModel)
  } catch {
    console.warn('[whisper-server] model not found, cannot start server')
    serverStarting = false
    return
  }

  const proc = spawn(server, [
    '-m', defaultModel,
    '--port', String(WHISPER_SERVER_PORT),
    '--host', '127.0.0.1',
    '-l', 'ru',
    '-t', String(WHISPER_THREADS),
  ], { windowsHide: true })

  serverProcess = proc
  serverModelPath = defaultModel

  proc.stderr.on('data', () => {
    // Keep quiet by default. Uncomment for debugging if needed.
  })

  proc.on('error', (err) => {
    console.warn('[whisper-server] process error:', err.message)
    serverProcess = null
    serverReady = false
    serverStarting = false
    serverModelPath = ''
  })

  proc.on('close', (code) => {
    console.log('[whisper-server] exited with code', code)
    serverProcess = null
    serverReady = false
    serverStarting = false
    serverModelPath = ''
  })

  const ok = await waitForServer()
  if (!ok) {
    console.warn('[whisper-server] did not become ready, falling back to whisper-cli')
    stopWhisperServer()
  }

  serverStarting = false
}

export function stopWhisperServer(): void {
  if (serverProcess) {
    try { serverProcess.kill() } catch { /* ignore */ }
    serverProcess = null
    serverReady = false
    serverModelPath = ''
  }
}

async function waitForServer(maxMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${WHISPER_SERVER_PORT}/health`, {
        signal: AbortSignal.timeout(1_000),
      })
      if (res.ok) {
        serverReady = true
        return true
      }
    } catch {
      // Not ready yet.
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 500))
    if (!serverProcess) return false
  }
  return false
}

export async function checkWhisperStatus(): Promise<WhisperStatus> {
  const { bin, defaultModel } = getWhisperConfig()

  let binOk = true
  let modelOk = true

  try { await fs.access(bin) } catch { binOk = false }
  try { await fs.access(defaultModel) } catch { modelOk = false }

  if (!binOk) {
    return {
      available: false,
      binPath: bin,
      modelPath: defaultModel,
      error: `whisper-cli not found:\n${bin}`,
    }
  }

  if (!modelOk) {
    return {
      available: false,
      binPath: bin,
      modelPath: defaultModel,
      error: `Model not found:\n${defaultModel}`,
    }
  }

  return { available: true, binPath: bin, modelPath: defaultModel }
}

export async function transcribeAudio(input: TranscribeAudioInput): Promise<TranscribeResult> {
  const config = getWhisperConfig()
  const { bin, defaultModel } = config
  const { audioBuffer, mimeType, extension } = input

  if (!serverReady) {
    try { await fs.access(bin) } catch {
      return {
        success: false,
        error: `whisper-cli не найден:\n${bin}\n\nПоложи whisper-cli.exe в папку whisper/.`,
      }
    }
    try { await fs.access(defaultModel) } catch {
      return {
        success: false,
        error: `Модель не найдена:\n${defaultModel}\n\nСкачай ${WHISPER_MODEL_NAME} и положи в whisper/models/.`,
      }
    }
  }

  const totalStartedAt = performance.now()
  const stamp = Date.now()
  const safeExt = normalizeExtension(extension, mimeType)
  const tempInput = join(tmpdir(), `lili-${stamp}.${safeExt}`)
  const tempWav = join(tmpdir(), `lili-${stamp}-16k.wav`)
  const outPrefix = join(tmpdir(), `lili-out-${stamp}`)
  const outTxt = outPrefix + '.txt'

  let prepareMs = 0
  let inferMs = 0
  let cleanupMs = 0
  let durationSec = 0
  let engine: 'server' | 'cli' = 'cli'
  let selectedModel = selectModelForDuration(config, 0)

  try {
    if (!audioBuffer || audioBuffer.length === 0) {
      return { success: false, error: 'Пустой аудиобуфер.' }
    }

    const prepareStartedAt = performance.now()
    let wavBuf: Buffer

    if (safeExt === 'wav') {
      wavBuf = toWav16kMono(audioBuffer)
    } else if (safeExt === 'webm') {
      await fs.writeFile(tempInput, audioBuffer)
      await convertWebmToWav(tempInput, tempWav)
      wavBuf = await fs.readFile(tempWav)
    } else {
      return {
        success: false,
        error: `Неподдерживаемый аудиоформат: ${mimeType || extension}`,
      }
    }

    durationSec = estimateWavDurationSec(wavBuf)
    selectedModel = selectModelForDuration(config, durationSec)
    prepareMs = performance.now() - prepareStartedAt

    const inferStartedAt = performance.now()
    let text: string

    if (serverReady && selectedModel.path === serverModelPath) {
      text = await transcribeViaServer(wavBuf)
      engine = 'server'
    } else {
      await fs.writeFile(tempWav, wavBuf)
      text = await runWhisper(bin, selectedModel.path, tempWav, outPrefix)
      engine = 'cli'
    }
    inferMs = performance.now() - inferStartedAt

    const cleanupStartedAt = performance.now()
    const cleaned = cleanWhisperOutput(text.trim())
    cleanupMs = performance.now() - cleanupStartedAt

    if (!cleaned) {
      return {
        success: false,
        error: 'Речь не распознана. Говори чётче или ближе к микрофону.',
      }
    }

    return {
      success: true,
      text: cleaned,
      meta: {
        engine,
        modelName: selectedModel.name,
        modelTier: selectedModel.tier,
        durationSec,
        prepareMs: Math.round(prepareMs),
        inferMs: Math.round(inferMs),
        cleanupMs: Math.round(cleanupMs),
        totalMs: Math.round(performance.now() - totalStartedAt),
      },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    await fs.unlink(tempInput).catch(() => {})
    await fs.unlink(tempWav).catch(() => {})
    await fs.unlink(outTxt).catch(() => {})
  }
}

async function transcribeViaServer(wavBuffer: Buffer): Promise<string> {
  const formData = new FormData()
  const ab = wavBuffer.buffer.slice(
    wavBuffer.byteOffset,
    wavBuffer.byteOffset + wavBuffer.byteLength,
  ) as ArrayBuffer
  const blob = new Blob([ab], { type: 'audio/wav' })

  formData.set('file', blob, 'audio.wav')
  formData.set('language', 'ru')
  formData.set('response_format', 'json')
  formData.set('prompt', WHISPER_PROMPT)

  const res = await fetch(`http://127.0.0.1:${WHISPER_SERVER_PORT}/inference`, {
    method: 'POST',
    body: formData,
    signal: AbortSignal.timeout(30_000),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`whisper-server HTTP ${res.status}: ${body.slice(0, 200)}`)
  }

  const json = await res.json() as { text?: string; error?: string }
  if (json.error) throw new Error(json.error)
  return (json.text ?? '').trim()
}

function normalizeExtension(extension: string, mimeType: string): 'wav' | 'webm' | 'unknown' {
  const ext = extension.toLowerCase().replace('.', '')
  const mime = mimeType.toLowerCase()

  if (ext === 'wav' || mime.includes('audio/wav')) return 'wav'
  if (ext === 'webm' || mime.includes('audio/webm')) return 'webm'

  return 'unknown'
}

function convertWebmToWav(inputFile: string, outputFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['-y', '-i', inputFile, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outputFile]
    let stderr = ''

    const proc = spawn('ffmpeg', args, { windowsHide: true })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('error', (e) => {
      reject(new Error(`Не удалось запустить ffmpeg: ${e.message}\n\nУстанови ffmpeg и добавь его в PATH.`))
    })
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg завершился с кодом ${code}.\n${stderr.slice(0, 600)}`))
        return
      }
      resolve()
    })
  })
}

function toWav16kMono(buf: Buffer): Buffer {
  if (buf.length < 44) throw new Error('Аудиобуфер слишком мал.')

  const riff = buf.toString('ascii', 0, 4)
  const wave = buf.toString('ascii', 8, 12)

  if (riff !== 'RIFF' || wave !== 'WAVE') {
    throw new Error(
      'Получен аудиофайл не в формате WAV.\n' +
      'Если запись идет в WebM, main process должен сначала конвертировать ее через ffmpeg.',
    )
  }

  let pos = 12
  let sampleRate = 0
  let numChannels = 0
  let bitsPerSample = 0

  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    if (id === 'fmt ') {
      numChannels = buf.readUInt16LE(pos + 10)
      sampleRate = buf.readUInt32LE(pos + 12)
      bitsPerSample = buf.readUInt16LE(pos + 22)
      pos += 8 + size
      break
    }
    pos += 8 + size
  }

  if (sampleRate === 0) throw new Error('Не удалось прочитать заголовок WAV.')
  if (bitsPerSample !== 16) throw new Error(`Поддерживается только 16-bit PCM WAV. Сейчас: ${bitsPerSample}-bit.`)

  let dataOffset = -1
  let dataBytes = 0
  pos = 12

  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    if (id === 'data') {
      dataOffset = pos + 8
      dataBytes = size
      break
    }
    pos += 8 + size
  }

  if (dataOffset < 0) throw new Error('WAV data chunk не найден.')

  const inputLen = Math.floor(dataBytes / 2)
  const input = new Int16Array(inputLen)
  for (let i = 0; i < inputLen; i++) {
    input[i] = buf.readInt16LE(dataOffset + i * 2)
  }

  let mono: Int16Array
  if (numChannels === 1) {
    mono = input
  } else {
    const monoLen = Math.floor(inputLen / numChannels)
    mono = new Int16Array(monoLen)
    for (let i = 0; i < monoLen; i++) {
      let sum = 0
      for (let c = 0; c < numChannels; c++) sum += input[i * numChannels + c]
      mono[i] = Math.round(sum / numChannels)
    }
  }

  let pcm16k: Int16Array
  if (sampleRate === 16000) {
    pcm16k = mono
  } else {
    const ratio = sampleRate / 16000
    const outLen = Math.ceil(mono.length / ratio)
    pcm16k = new Int16Array(outLen)
    for (let i = 0; i < outLen; i++) {
      const srcF = i * ratio
      const srcI = Math.floor(srcF)
      const frac = srcF - srcI
      const s0 = mono[Math.min(srcI, mono.length - 1)]
      const s1 = mono[Math.min(srcI + 1, mono.length - 1)]
      pcm16k[i] = Math.round(s0 + frac * (s1 - s0))
    }
  }

  return encodeWav(pcm16k, 16000)
}

function encodeWav(samples: Int16Array, sampleRate: number): Buffer {
  const dataLen = samples.length * 2
  const out = Buffer.alloc(44 + dataLen)

  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(36 + dataLen, 4)
  out.write('WAVE', 8, 'ascii')
  out.write('fmt ', 12, 'ascii')
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(1, 22)
  out.writeUInt32LE(sampleRate, 24)
  out.writeUInt32LE(sampleRate * 2, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36, 'ascii')
  out.writeUInt32LE(dataLen, 40)

  for (let i = 0; i < samples.length; i++) {
    out.writeInt16LE(samples[i], 44 + i * 2)
  }

  return out
}

function cleanWhisperOutput(text: string): string {
  return text
    .replace(/\[[^\]]{1,40}\]/g, '')
    .replace(/\([^)]{1,80}\)/g, '')
    .replace(/субтитры\s+сделаны.*/gi, '')
    .replace(/продолжение\s+следует.*/gi, '')
    .replace(/все\s+права\s+защищены.*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function runWhisper(bin: string, model: string, audioFile: string, outPrefix: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      '-m', model,
      '-f', audioFile,
      '-l', 'ru',
      '-nt',
      '--beam-size', '2',
      '-t', String(WHISPER_THREADS),
      '--prompt', WHISPER_PROMPT,
      '-otxt',
      '-of', outPrefix,
    ]

    let stdout = ''
    let stderr = ''

    const proc = spawn(bin, args, { windowsHide: true })
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('error', (e) => {
      reject(new Error(`Не удалось запустить whisper-cli: ${e.message}`))
    })
    proc.on('close', async (code) => {
      if (code !== 0) {
        reject(new Error(`whisper-cli завершился с кодом ${code}.\n${stderr.slice(0, 400)}`))
        return
      }

      try {
        const txt = await fs.readFile(outPrefix + '.txt', 'utf-8')
        resolve(txt)
      } catch {
        resolve(stdout)
      }
    })
  })
}
