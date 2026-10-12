import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { availableParallelism } from 'node:os'
import { app, type BrowserWindow } from 'electron'
import type { OllamaLifecycleStatus } from './types'

const QWEN_SERVER_HOST = '127.0.0.1'
const QWEN_SERVER_PORT = 18080
const QWEN_SERVER_URL = `http://${QWEN_SERVER_HOST}:${QWEN_SERVER_PORT}`

let qwenProcess: ChildProcess | null = null
let currentStatus: OllamaLifecycleStatus = 'checking'
let isStarting = false
let activeWindow: BrowserWindow | null = null

function appRoot(): string {
  return app.isPackaged ? process.resourcesPath : app.getAppPath()
}

function qwenPaths() {
  const root = appRoot()
  return {
    serverBin: process.env.LLAMA_SERVER_BIN ?? join(root, 'llama.cpp', 'bin', 'llama-server.exe'),
    modelFile: process.env.QWEN_GGUF_MODEL ?? join(root, 'Qwen3-4B-GGUF', 'Qwen3-4B-Q4_K_M.gguf'),
  }
}

function setStatus(win: BrowserWindow | null, status: OllamaLifecycleStatus): void {
  currentStatus = status
  try {
    win?.webContents.send('ollama:status-update', status)
  } catch {
    // window may have been destroyed
  }
}

async function isServerReady(): Promise<boolean> {
  try {
    const res = await fetch(`${QWEN_SERVER_URL}/v1/models`, {
      signal: AbortSignal.timeout(1_000),
    })
    return res.ok
  } catch {
    return false
  }
}

async function waitForReady(maxMs = 180_000): Promise<boolean> {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    if (await isServerReady()) return true
    await new Promise<void>((resolve) => setTimeout(resolve, 500))
    if (!qwenProcess) return false
  }
  return false
}

export async function startQwenIfNeeded(win: BrowserWindow | null): Promise<void> {
  activeWindow = win

  if (await isServerReady()) {
    setStatus(win, 'connected')
    return
  }

  if (qwenProcess || isStarting) {
    const ok = await waitForReady()
    setStatus(win, ok ? 'connected' : 'failed')
    return
  }

  setStatus(win, 'checking')
  const { serverBin, modelFile } = qwenPaths()

  if (!existsSync(serverBin)) {
    console.error('[qwen] llama-server.exe not found:', serverBin)
    setStatus(win, 'failed')
    return
  }

  if (!existsSync(modelFile)) {
    console.error('[qwen] GGUF model not found:', modelFile)
    setStatus(win, 'failed')
    return
  }

  isStarting = true
  setStatus(win, 'starting')

  const args = [
    '-m', modelFile,
    '--host', QWEN_SERVER_HOST,
    '--port', String(QWEN_SERVER_PORT),
    '-c', '4096',
    '-n', '256',
    '-t', String(Math.max(2, Math.min(8, availableParallelism() - 1 || 2))),
    '--parallel', '1',
    '--jinja',
    '--reasoning', 'off',
    '--reasoning-format', 'none',
    '--no-webui',
  ]

  try {
    const proc = spawn(serverBin, args, {
      cwd: appRoot(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    qwenProcess = proc

    proc.stdout.on('data', (data: Buffer) => {
      const text = data.toString('utf-8').trim()
      if (text) console.log('[qwen]', text)
    })

    proc.stderr.on('data', (data: Buffer) => {
      const text = data.toString('utf-8').trim()
      if (text) console.error('[qwen]', text)
    })

    proc.on('error', (err) => {
      console.error('[qwen] spawn error:', err.message)
      qwenProcess = null
      setStatus(activeWindow, 'failed')
    })

    proc.on('exit', (code) => {
      console.log('[qwen] llama-server exited, code:', code)
      qwenProcess = null
      if (currentStatus !== 'failed') setStatus(activeWindow, 'failed')
    })

    const ok = await waitForReady()
    setStatus(win, ok ? 'connected' : 'failed')
  } catch (err) {
    console.error('[qwen] could not spawn llama-server:', err)
    setStatus(win, 'failed')
  } finally {
    isStarting = false
  }
}

export function getStatus(): OllamaLifecycleStatus {
  return currentStatus
}

export function stopQwenProcess(): void {
  if (qwenProcess) {
    qwenProcess.kill()
    qwenProcess = null
  }
}

function cleanQwenText(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .trim()
}

export async function generateQwenChat(
  messages: Array<{ role: string; content: string }>,
  onChunk?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  if (!(await isServerReady())) {
    await startQwenIfNeeded(activeWindow)
  }
  if (currentStatus !== 'connected') {
    throw new Error('Qwen GGUF server is not ready.')
  }

  const timeoutSignal = AbortSignal.timeout(60_000)
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

  const res = await fetch(`${QWEN_SERVER_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen3:4b-gguf',
      messages,
      stream: Boolean(onChunk),
      max_tokens: 96,
      temperature: 0.4,
      top_p: 0.95,
    }),
    signal: requestSignal,
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Qwen HTTP ${res.status}: ${body.slice(0, 300)}`)
  }

  if (!onChunk) {
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
    return cleanQwenText(data.choices?.[0]?.message?.content ?? '')
  }

  const reader = res.body?.getReader()
  if (!reader) return ''

  const decoder = new TextDecoder()
  let buffered = ''
  let fullText = ''
  let emittedLength = 0

  while (true) {
    signal?.throwIfAborted()
    const { done, value } = await reader.read()
    if (done) break

    buffered += decoder.decode(value, { stream: true })
    const lines = buffered.split('\n')
    buffered = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (data === '[DONE]') continue
      try {
        const json = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> }
        const chunk = json.choices?.[0]?.delta?.content ?? ''
        if (chunk) {
          fullText += chunk
          const cleaned = cleanQwenText(fullText)
          const delta = cleaned.slice(emittedLength)
          if (delta) {
            emittedLength = cleaned.length
            onChunk(delta)
          }
        }
      } catch {
        // Skip malformed SSE fragments.
      }
    }
  }

  return cleanQwenText(fullText)
}
