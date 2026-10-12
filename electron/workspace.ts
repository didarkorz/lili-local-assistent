/**
 * workspace.ts
 *
 * Safe path helper for the restricted file workspace.
 * ALL user file access is sandboxed to WORKSPACE_ROOT only.
 *
 * Security model:
 *  - resolve() + join() normalises any path tricks
 *  - explicit block on absolute paths and ".." sequences
 *  - final startsWith() check ensures the resolved path is inside the root
 */

import { resolve, join, sep } from 'node:path'
import { app } from 'electron'

// The one and only folder Lili may read from or write to.
export const WORKSPACE_ROOT = resolve(
  process.env.LILI_WORKSPACE_DIR || join(
    app.isPackaged ? app.getPath('userData') : app.getAppPath(),
    'draftforlili',
  ),
)

export type PathCheckResult =
  | { safe: true; fullPath: string }
  | { safe: false; error: string }

/**
 * Safely resolve a user-supplied filename into an absolute path
 * inside WORKSPACE_ROOT.
 *
 * Rejects:
 *   • empty or blank filenames
 *   • absolute paths  (C:\..., D:\..., /...)
 *   • path traversal  (..\, ../)
 *   • anything that resolves outside WORKSPACE_ROOT
 */
export function safeWorkspacePath(filename: string): PathCheckResult {
  if (!filename || !filename.trim()) {
    return { safe: false, error: 'Filename cannot be empty.' }
  }

  const trimmed = filename.trim()

  // Block Windows absolute paths (C:\, D:\, etc.) and UNC paths (\\)
  if (/^[a-zA-Z]:[/\\]/.test(trimmed) || trimmed.startsWith('\\\\')) {
    return { safe: false, error: 'Absolute paths are not allowed. Provide a filename only.' }
  }

  // Block Unix-style absolute paths
  if (trimmed.startsWith('/')) {
    return { safe: false, error: 'Absolute paths are not allowed. Provide a filename only.' }
  }

  // Block all traversal sequences before resolve() even runs
  if (trimmed.includes('..')) {
    return { safe: false, error: 'Path traversal (..) is not allowed.' }
  }

  // Resolve: normalise and make absolute relative to WORKSPACE_ROOT
  const candidate = resolve(join(WORKSPACE_ROOT, trimmed))

  // Final gate: resolved path must be the root itself or a direct child inside it.
  // The trailing separator prevents a sibling named "draftforliliEscape" from passing.
  const rootWithSep = WORKSPACE_ROOT + sep

  if (candidate !== WORKSPACE_ROOT && !candidate.startsWith(rootWithSep)) {
    return { safe: false, error: 'Access denied: path resolves outside the workspace.' }
  }

  return { safe: true, fullPath: candidate }
}

/**
 * Generate an automatic filename based on the current timestamp.
 * Example: note-2025-03-31-14-22-05.txt
 */
export function autoFilename(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    'note-' +
    now.getFullYear() +
    '-' +
    pad(now.getMonth() + 1) +
    '-' +
    pad(now.getDate()) +
    '-' +
    pad(now.getHours()) +
    '-' +
    pad(now.getMinutes()) +
    '-' +
    pad(now.getSeconds()) +
    '.txt'
  )
}
