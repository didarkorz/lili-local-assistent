/**
 * commandHistoryManager.ts
 *
 * Logs every handled command to a daily .md file in userData/commands/.
 * Pattern mirrors journalManager.ts.
 *
 * Format of each day file:
 *   # История команд — 3 апреля 2026
 *   **14:23** открой Discord
 *   **14:25** погода в Астане
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

function getDir(): string {
  return join(app.getPath('userData'), 'commands')
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(getDir(), { recursive: true })
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10)   // "2026-04-03"
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
}

function filePath(d: Date): string {
  return join(getDir(), `${dateKey(d)}.md`)
}

// ── Write ─────────────────────────────────────────────────────────────────────

export async function writeCommandEntry(text: string): Promise<void> {
  await ensureDir()
  const now = new Date()
  const fp = filePath(now)
  let content = ''
  try {
    content = await fs.readFile(fp, 'utf-8')
  } catch {
    content = `# История команд — ${formatDate(now)}\n\n`
  }
  content += `**${formatTime(now)}** ${text.trim()}\n`
  await fs.writeFile(fp, content, 'utf-8')
}

// ── Read ──────────────────────────────────────────────────────────────────────

/**
 * @param offset  0 = today, 1 = yesterday, 2 = two days ago, …
 */
export async function readCommandDay(offset = 0): Promise<string | null> {
  const d = new Date()
  d.setDate(d.getDate() - offset)
  try {
    return await fs.readFile(filePath(d), 'utf-8')
  } catch {
    return null
  }
}

export async function listCommandDays(): Promise<string[]> {
  await ensureDir()
  try {
    const files = await fs.readdir(getDir())
    return files
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace('.md', ''))
      .sort()
      .reverse()
  } catch {
    return []
  }
}
