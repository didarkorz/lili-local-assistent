/**
 * notesStore.ts
 *
 * Persistent storage for local notes and ideas.
 * File: userData/lili-notes.json
 *
 * Follows the same read/write pattern as memoryStore.ts.
 */

import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { Note } from './types'

function getPath(): string {
  return path.join(app.getPath('userData'), 'lili-notes.json')
}

function read(): Note[] {
  try {
    const raw = fs.readFileSync(getPath(), 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as Note[]) : []
  } catch {
    return []
  }
}

function write(notes: Note[]): void {
  try {
    fs.writeFileSync(getPath(), JSON.stringify(notes, null, 2), 'utf-8')
  } catch (err) {
    console.error('[notesStore] write failed:', err)
  }
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2)
}

export function createNote(title: string, content: string, isIdea = false): Note {
  const note: Note = {
    id: uid(),
    title: title.slice(0, 80),
    content,
    isIdea,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  const notes = read()
  notes.push(note)
  write(notes)
  return note
}

export function listNotes(ideasOnly = false): Note[] {
  const notes = read()
  return ideasOnly ? notes.filter((n) => n.isIdea) : notes
}

export function readNote(query: string): Note | null {
  const notes = read()
  const q = query.toLowerCase().trim()
  return notes.find((n) => n.title.toLowerCase().includes(q)) ?? null
}

export function deleteNote(id: string): void {
  write(read().filter((n) => n.id !== id))
}
