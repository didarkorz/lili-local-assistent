/**
 * workspaceTools.ts
 *
 * File I/O tools that operate strictly inside WORKSPACE_ROOT.
 * Every function validates the path through safeWorkspacePath() before
 * touching the filesystem.  No file access happens outside the workspace.
 */

import { promises as fs } from 'node:fs'
import { shell } from 'electron'
import { safeWorkspacePath, autoFilename, WORKSPACE_ROOT } from './workspace'

export interface WorkspaceResult {
  success: boolean
  data?: string    // file content or JSON-encoded file list / search results
  error?: string
  filename?: string
}

// ── Ensure the workspace folder exists ───────────────────────────────────────

async function ensureRoot(): Promise<void> {
  await fs.mkdir(WORKSPACE_ROOT, { recursive: true })
}

// ── Text file extensions that support keyword search / summarization ──────────

const TEXT_EXTENSIONS = /\.(txt|md|json)$/i

// ── Smart extension resolver ──────────────────────────────────────────────────
// Maps natural language hints in filename to proper extensions.
// If filename already has a known extension — keep it as-is.

const KNOWN_EXTENSIONS = /\.(txt|md|json|csv|html|css|js|ts|py|xml|yaml|yml|docx|xlsx|pptx|pdf)$/i

function resolveExtension(filename: string): string {
  // Already has an extension — keep it
  if (KNOWN_EXTENSIONS.test(filename)) return filename

  const lower = filename.toLowerCase()

  // Word / document
  if (/ворд|word|документ(?!.*(расписани|таблиц|презентаци))|document/.test(lower))
    return filename + '.docx'

  // Excel / table
  if (/excel|эксель|таблиц|xlsx|spreadsheet/.test(lower))
    return filename + '.xlsx'

  // PowerPoint
  if (/powerpoint|повер ?поинт|презентац|слайд/.test(lower))
    return filename + '.pptx'

  // Markdown — plans, readme, notes with structure
  if (/readme|план|roadmap|структур/.test(lower))
    return filename + '.md'

  // Default for everything else (блокнот, файл, заметка, список, расписание, etc.)
  return filename + '.txt'
}

// ── Tool implementations ──────────────────────────────────────────────────────

/**
 * createTextFile(filename | null, content)
 * Creates a new .txt file in the workspace.
 */
export async function wsCreateTextFile(
  filename: string | null | undefined,
  content: string,
): Promise<WorkspaceResult> {
  const fname   = resolveExtension(filename?.trim() || autoFilename())
  const checked = safeWorkspacePath(fname)
  if (!checked.safe) return { success: false, error: checked.error }

  try {
    await ensureRoot()
    await fs.writeFile(checked.fullPath, content, 'utf-8')
    return { success: true, filename: fname }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

/**
 * writeTextFile(filename, content)
 * Overwrites an existing (or new) file with content.
 */
export async function wsWriteTextFile(
  filename: string,
  content: string,
): Promise<WorkspaceResult> {
  const checked = safeWorkspacePath(filename)
  if (!checked.safe) return { success: false, error: checked.error }

  try {
    await ensureRoot()
    await fs.writeFile(checked.fullPath, content, 'utf-8')
    return { success: true, filename }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

/**
 * appendTextFile(filename, content)
 * Appends text to an existing file (creates it if it does not exist).
 */
export async function wsAppendTextFile(
  filename: string,
  content: string,
): Promise<WorkspaceResult> {
  const checked = safeWorkspacePath(filename)
  if (!checked.safe) return { success: false, error: checked.error }

  try {
    await ensureRoot()
    await fs.appendFile(checked.fullPath, content, 'utf-8')
    return { success: true, filename }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

/**
 * readTextFile(filename)
 * Reads a file from the workspace and returns its content.
 */
export async function wsReadTextFile(filename: string): Promise<WorkspaceResult> {
  const checked = safeWorkspacePath(filename)
  if (!checked.safe) return { success: false, error: checked.error }

  try {
    const text = await fs.readFile(checked.fullPath, 'utf-8')
    return { success: true, data: text, filename }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { success: false, error: `Файл не найден: ${filename}` }
    }
    return { success: false, error: String(err) }
  }
}

/**
 * listWorkspaceFiles()
 * Returns a JSON-encoded array of all filenames in the workspace folder.
 */
export async function wsListWorkspaceFiles(): Promise<WorkspaceResult> {
  try {
    await ensureRoot()
    const entries = await fs.readdir(WORKSPACE_ROOT, { withFileTypes: true })
    const files   = entries.filter((e) => e.isFile()).map((e) => e.name)
    return { success: true, data: JSON.stringify(files) }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

/**
 * searchFiles(query)
 * Returns a JSON-encoded array of filenames that contain the query string.
 * Empty query returns all files.
 */
export async function wsSearchFiles(query: string): Promise<WorkspaceResult> {
  try {
    await ensureRoot()
    const entries = await fs.readdir(WORKSPACE_ROOT, { withFileTypes: true })
    const q       = query.toLowerCase().trim()
    const matches = entries
      .filter((e) => e.isFile() && (q === '' || e.name.toLowerCase().includes(q)))
      .map((e) => e.name)
    return { success: true, data: JSON.stringify(matches) }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

/**
 * findKeywordInFiles(keyword)
 * Scans all .txt / .md / .json files for the keyword.
 * Returns JSON: Array<{ file: string; snippets: string[] }>
 * Each entry has up to 3 matching line snippets (max 120 chars each).
 */
export async function wsFindKeywordInFiles(keyword: string): Promise<WorkspaceResult> {
  if (!keyword.trim()) {
    return { success: false, error: 'Keyword cannot be empty.' }
  }

  try {
    await ensureRoot()
    const entries   = await fs.readdir(WORKSPACE_ROOT, { withFileTypes: true })
    const textFiles = entries
      .filter((e) => e.isFile() && TEXT_EXTENSIONS.test(e.name))
      .map((e) => e.name)

    const kw      = keyword.toLowerCase()
    const results: Array<{ file: string; snippets: string[] }> = []

    for (const fname of textFiles) {
      const checked = safeWorkspacePath(fname)
      if (!checked.safe) continue

      try {
        const content  = await fs.readFile(checked.fullPath, 'utf-8')
        const snippets = content
          .split('\n')
          .filter((line) => line.toLowerCase().includes(kw))
          .slice(0, 3)
          .map((line) => line.trim().slice(0, 120))

        if (snippets.length > 0) {
          results.push({ file: fname, snippets })
        }
      } catch {
        // Skip files that can't be read
      }
    }

    return { success: true, data: JSON.stringify(results) }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

/**
 * deleteFile(filename)
 * Deletes a single file from the workspace.
 */
export async function wsDeleteFile(filename: string): Promise<WorkspaceResult> {
  const checked = safeWorkspacePath(filename)
  if (!checked.safe) return { success: false, error: checked.error }

  try {
    await fs.unlink(checked.fullPath)
    return { success: true, filename }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { success: false, error: `Файл не найден: ${filename}` }
    }
    return { success: false, error: String(err) }
  }
}

/**
 * deleteAllFiles()
 * Deletes every file inside the workspace folder (does not remove subdirectories).
 * Returns the count of deleted files.
 */
export async function wsDeleteAllFiles(): Promise<WorkspaceResult> {
  try {
    await ensureRoot()
    const entries = await fs.readdir(WORKSPACE_ROOT, { withFileTypes: true })
    const files   = entries.filter((e) => e.isFile()).map((e) => e.name)

    for (const fname of files) {
      const checked = safeWorkspacePath(fname)
      if (checked.safe) {
        await fs.unlink(checked.fullPath).catch(() => { /* skip locked files */ })
      }
    }

    return { success: true, data: String(files.length) }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

/**
 * openWorkspaceFolder()
 * Opens the workspace folder in the OS file manager.
 */
export async function wsOpenWorkspaceFolder(): Promise<WorkspaceResult> {
  try {
    await ensureRoot()
    await shell.openPath(WORKSPACE_ROOT)
    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}
