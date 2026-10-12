/**
 * memoryStore.ts
 *
 * Persistent storage for the two long-lived memory layers:
 *   - Layer 2: rolling conversation summary  → lili-memory.json › summary
 *   - Layer 3: long-term user facts          → lili-memory.json › facts
 *
 * Kept in a *separate* file from lili-data.json (chat messages) so that
 * clearing the chat history does not wipe out long-term memories.
 */

import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { MemoryFact, ConversationSummary } from './types'

interface MemoryData {
  facts: MemoryFact[]
  summary: ConversationSummary | null
}

const DEFAULTS: MemoryData = { facts: [], summary: null }

function getPath(): string {
  return path.join(app.getPath('userData'), 'lili-memory.json')
}

function read(): MemoryData {
  try {
    const raw = fs.readFileSync(getPath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<MemoryData>
    return {
      facts: Array.isArray(parsed.facts) ? parsed.facts : [],
      summary: parsed.summary ?? null,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

function write(data: MemoryData): void {
  try {
    fs.writeFileSync(getPath(), JSON.stringify(data, null, 2), 'utf-8')
  } catch (err) {
    console.error('[memoryStore] write failed:', err)
  }
}

// ── Layer 3: facts ────────────────────────────────────────────────────────────

export function loadFacts(): MemoryFact[] {
  return read().facts
}

/** Add a new fact or update an existing one (matched by id). */
export function saveFact(fact: MemoryFact): void {
  const data = read()
  const idx = data.facts.findIndex((f) => f.id === fact.id)
  if (idx >= 0) {
    data.facts[idx] = fact
  } else {
    data.facts.push(fact)
  }
  write(data)
}

export function deleteFact(id: string): void {
  const data = read()
  write({ ...data, facts: data.facts.filter((f) => f.id !== id) })
}

// ── Layer 2: summary ──────────────────────────────────────────────────────────

export function loadSummary(): ConversationSummary | null {
  return read().summary
}

export function saveSummary(summary: ConversationSummary): void {
  write({ ...read(), summary })
}

/** Clear only the summary (called when chat history is wiped). */
export function clearSummary(): void {
  write({ ...read(), summary: null })
}
