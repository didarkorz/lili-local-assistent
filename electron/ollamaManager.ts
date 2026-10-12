import { spawn, type ChildProcess } from 'node:child_process'
import type { BrowserWindow } from 'electron'
import {
  OLLAMA_BASE_URL,
  STARTUP_TIMEOUT_MS,
  HEALTH_RETRY_INTERVAL_MS,
} from './constants'
import type { OllamaLifecycleStatus } from './types'

let ollamaProcess: ChildProcess | null = null
let currentStatus: OllamaLifecycleStatus = 'checking'
let isStarting = false

function setStatus(win: BrowserWindow | null, status: OllamaLifecycleStatus): void {
  currentStatus = status
  try {
    win?.webContents.send('ollama:status-update', status)
  } catch {
    // window may have been destroyed
  }
}

async function healthCheck(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(3_000),
    })
    return res.ok
  } catch {
    return false
  }
}

async function pollUntilReady(win: BrowserWindow | null): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, HEALTH_RETRY_INTERVAL_MS))
    if (await healthCheck()) {
      setStatus(win, 'connected')
      return
    }
  }
  setStatus(win, 'failed')
}

export async function startOllamaIfNeeded(win: BrowserWindow | null): Promise<void> {
  if (isStarting) return
  isStarting = true

  setStatus(win, 'checking')

  if (await healthCheck()) {
    setStatus(win, 'connected')
    isStarting = false
    return
  }

  setStatus(win, 'starting')

  try {
    ollamaProcess = spawn('ollama', ['serve'], {
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
    })

    ollamaProcess.on('error', (err) => {
      console.error('[ollama] spawn error:', err.message)
    })

    ollamaProcess.on('exit', (code) => {
      console.log('[ollama] process exited, code:', code)
      ollamaProcess = null
    })
  } catch (err) {
    console.error('[ollama] could not spawn:', err)
  }

  await pollUntilReady(win)
  isStarting = false
}

export function getStatus(): OllamaLifecycleStatus {
  return currentStatus
}

export function killOllamaProcess(): void {
  if (ollamaProcess) {
    ollamaProcess.kill()
    ollamaProcess = null
  }
}
