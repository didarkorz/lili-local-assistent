/**
 * tools.ts
 *
 * Tool functions executed in the main process and exposed via IPC.
 * All file I/O goes through notesStore — never directly to the renderer.
 */

import { shell, app } from 'electron'
import { createNote, listNotes, readNote } from './notesStore'
import type { Note, ChatMessage } from './types'

export function toolCreateNote(title: string, content: string, isIdea = false): Note {
  return createNote(title, content, isIdea)
}

export function toolListNotes(ideasOnly = false): Note[] {
  return listNotes(ideasOnly)
}

export function toolReadNote(query: string): Note | null {
  return readNote(query)
}

export async function toolOpenNotesFolder(): Promise<void> {
  const folder = app.getPath('userData')
  await shell.openPath(folder)
}

export function toolExportChatHistory(messages: ChatMessage[]): Note {
  if (messages.length === 0) {
    return createNote(
      `Chat export — ${new Date().toLocaleDateString()}`,
      '(empty conversation)',
      false
    )
  }
  const title = `Chat export — ${new Date().toLocaleDateString()}`
  const content = messages
    .map(
      (m) =>
        `**${m.role === 'user' ? 'You' : 'Lili'}** (${new Date(m.createdAt).toLocaleTimeString()})\n${m.content}`
    )
    .join('\n\n---\n\n')
  return createNote(title, content, false)
}
