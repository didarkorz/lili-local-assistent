import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { ChatMessage, Settings } from './types'
import { DEFAULT_MODEL } from './constants'

interface StoreData {
  messages: ChatMessage[]
  settings: Settings
}

const DEFAULTS: StoreData = {
  messages: [],
  settings: { model: DEFAULT_MODEL },
}

function getPath(): string {
  return path.join(app.getPath('userData'), 'lili-data.json')
}

function read(): StoreData {
  try {
    const raw = fs.readFileSync(getPath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<StoreData>
    const settings = parsed.settings ?? DEFAULTS.settings
    return {
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      settings: { ...settings, model: DEFAULT_MODEL },
    }
  } catch {
    return { ...DEFAULTS }
  }
}

function write(data: StoreData): void {
  try {
    fs.writeFileSync(getPath(), JSON.stringify(data, null, 2), 'utf-8')
  } catch (err) {
    console.error('[store] write failed:', err)
  }
}

export function loadMessages(): ChatMessage[] {
  return read().messages
}

export function saveMessages(messages: ChatMessage[]): void {
  write({ ...read(), messages })
}

export function clearMessages(): void {
  write({ ...read(), messages: [] })
}

export function loadSettings(): Settings {
  return read().settings
}

export function saveSettings(settings: Settings): void {
  write({ ...read(), settings: { ...settings, model: DEFAULT_MODEL } })
}
