import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

function getJournalDir(): string {
  return join(app.getPath('userData'), 'journal')
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10) // "2026-04-03"
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('ru-RU', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  })
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(getJournalDir(), { recursive: true })
}

function journalFilePath(date: Date): string {
  return join(getJournalDir(), `${dateKey(date)}.md`)
}

export async function writeJournalEntry(text: string): Promise<void> {
  await ensureDir()
  const now = new Date()
  const filePath = journalFilePath(now)
  let content = ''
  try {
    content = await fs.readFile(filePath, 'utf-8')
  } catch {
    content = `# Дневник — ${formatDate(now)}\n\n`
  }
  content += `**${formatTime(now)}** ${text.trim()}\n`
  await fs.writeFile(filePath, content, 'utf-8')
}

export async function readJournalDay(date: Date): Promise<string | null> {
  try {
    return await fs.readFile(journalFilePath(date), 'utf-8')
  } catch {
    return null
  }
}

export async function listJournalDays(): Promise<string[]> {
  await ensureDir()
  const files = await fs.readdir(getJournalDir())
  return files
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace('.md', ''))
    .sort()
    .reverse()
}
