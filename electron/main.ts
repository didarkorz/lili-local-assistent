import { app, BrowserWindow, ipcMain, session, globalShortcut, Tray, Menu, nativeImage } from 'electron'
import { join } from 'node:path'
import { startQwenIfNeeded, getStatus, stopQwenProcess, generateQwenChat } from './qwenManager'
import {
  loadMessages,
  saveMessages,
  clearMessages,
  loadSettings,
  saveSettings,
} from './store'
import {
  loadFacts,
  saveFact,
  deleteFact,
  loadSummary,
  clearSummary,
} from './memoryStore'
import {
  buildPayload,
  maybeTriggerSummary,
  regenerateSummary,
  extractFacts,
} from './memoryManager'
import { DEFAULT_MODEL } from './constants'
import type { ChatMessage, MemoryFact, Settings } from './types'
import {
  toolCreateNote,
  toolListNotes,
  toolReadNote,
  toolOpenNotesFolder,
  toolExportChatHistory,
} from './tools'
import { deleteNote } from './notesStore'
import {
  wsCreateTextFile,
  wsWriteTextFile,
  wsAppendTextFile,
  wsReadTextFile,
  wsListWorkspaceFiles,
  wsOpenWorkspaceFolder,
  wsSearchFiles,
  wsFindKeywordInFiles,
  wsDeleteFile,
  wsDeleteAllFiles,
} from './workspaceTools'
import { transcribeAudio, checkWhisperStatus, startWhisperServer, stopWhisperServer } from './voiceManager'
import { synthesizeSpeech } from './ttsManager'
import { showNotification, scheduleReminder, cancelReminder, listReminders } from './notificationManager'
import { openApp, listKnownApps } from './appManager'
import { getWeather } from './weatherManager'
import { clipboard } from 'electron'
import { getVolume, setVolume, adjustVolume, toggleMute, setMute, mediaControl, getBrightness, setBrightness, adjustBrightness, windowMinimizeAll, windowRestoreAll, windowFocus, windowClose, playInYoutubeMusicWindow } from './systemManager'
import { getSystemInfoFormatted } from './sysInfoManager'
import { getCurrentTrackFormatted } from './mediaInfoManager'
import { loadTasks, addTask, completeTask, deleteTask, clearDoneTasks } from './todoStore'
import { writeJournalEntry, readJournalDay, listJournalDays } from './journalManager'
import { webSearch, formatSearchResults } from './webSearchManager'
import { sendTelegramMessage, addContact, removeContact, loadContacts } from './telegramManager'
import { writeCommandEntry, readCommandDay, listCommandDays } from './commandHistoryManager'
import { searchAndPlayYoutube } from './youtubeManager'
import { takeScreenshot, openScreenshotsFolder } from './screenshotManager'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isCompact = false

if (process.platform === 'win32') {
  app.setAppUserModelId('com.lili.local-assistant')
}

const NORMAL_SIZE  = { width: 1100, height: 750 }
const COMPACT_SIZE = { width: 480,  height: 72  }

// в”Ђв”Ђ Tray icon (16Г—16 purple circle, encoded as PNG base64) в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
const TRAY_ICON_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlz' +
  'AAALEwAACxMBAJqcGAAAAFVJREFUOI3tkjEKgDAMRV+kg9/Fk/QqHsKTuHQqgoOTk5OTnMGhVP' +
  'gQEsibJC+QBP5lwVhr4O4MgJIkSZIkSZIkSf8BAADwAwAA8A8AAAD4DwAASHwFSmGNHgAAAABJ' +
  'RU5ErkJggg=='

function getTrayIcon() {
  return nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_B64}`)
}

function createTray(): void {
  tray = new Tray(getTrayIcon())
  tray.setToolTip('Lili вЂ” Local AI Assistant')

  const updateMenu = () => {
    const menu = Menu.buildFromTemplate([
      {
        label: isCompact ? 'РћР±С‹С‡РЅС‹Р№ СЂРµР¶РёРј' : 'РљРѕРјРїР°РєС‚РЅС‹Р№ СЂРµР¶РёРј',
        click: () => { mainWindow?.webContents.send('window:toggleCompact') },
      },
      { label: 'РџРѕРєР°Р·Р°С‚СЊ / СЃРєСЂС‹С‚СЊ', click: () => {
        if (!mainWindow) return
        if (mainWindow.isVisible()) mainWindow.hide()
        else { mainWindow.show(); mainWindow.focus() }
      }},
      { type: 'separator' },
      { label: 'Р’С‹С…РѕРґ', click: () => { app.quit() } },
    ])
    tray!.setContextMenu(menu)
  }

  updateMenu()
  tray.on('double-click', () => {
    if (!mainWindow) return
    if (mainWindow.isVisible()) mainWindow.focus()
    else { mainWindow.show(); mainWindow.focus() }
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 600,
    center: true,
    title: 'Lili вЂ” Local AI Assistant',
    backgroundColor: '#09090b',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.once('did-finish-load', () => {
    startQwenIfNeeded(mainWindow).catch(console.error)
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[window] render-process-gone:', details)
    try {
      const current = loadSettings()
      if (current.wakeWordEnabled) {
        saveSettings({ ...current, wakeWordEnabled: false })
      }
    } catch (err) {
      console.error('[window] failed to reset wakeWordEnabled after renderer crash:', err)
    }

    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.reload()
      }
    }, 300)
  })

  mainWindow.webContents.on('unresponsive', () => {
    console.error('[window] renderer became unresponsive')
  })

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) {
      console.error(`[renderer:${level}] ${message} (${sourceId}:${line})`)
    }
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../dist/index.html'))
  }

  // Minimize to tray instead of closing
  mainWindow.on('close', (e) => {
    if (tray) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.on('closed', () => { mainWindow = null })
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media')
  })

  globalShortcut.register('Alt+Space', () => {
    mainWindow?.webContents.send('voice:hotkey')
  })

  createWindow()
  createTray()
  startWhisperServer().catch(console.error)
})

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll()
  stopQwenProcess()
  stopWhisperServer()
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

// в”Ђв”Ђ Ollama lifecycle в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

ipcMain.handle('ollama:getStatus', () => getStatus())

ipcMain.handle('ollama:reconnect', async () => {
  await startQwenIfNeeded(mainWindow)
  return getStatus()
})

// в”Ђв”Ђ Chat вЂ” 3-layer memory prompt with active context в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

ipcMain.handle(
  'ollama:chat',
  async (
    _event,
    {
      messages,
      activeContext,
    }: { messages: ChatMessage[]; model?: string; activeContext?: string }
  ) => {
    const contextStr     = activeContext ?? loadSettings().activeContext ?? ''

    const payload = buildPayload(messages, contextStr)

    try {
      const text = await generateQwenChat(payload)
      return { success: true, text }
    } catch (err: unknown) {
      if (err instanceof Error) {
        return { success: false, error: err.message }
      }
      return { success: false, error: String(err) }
    }
  }
)

// в”Ђв”Ђ Chat вЂ” streaming в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

let streamAbortController: AbortController | null = null
let streamRequestSeq = 0

ipcMain.on('ollama:stream:abort', () => {
  streamAbortController?.abort()
  streamAbortController = null
})

ipcMain.on(
  'ollama:stream:start',
  async (
    event,
    { messages, activeContext }: { messages: ChatMessage[]; model?: string; activeContext?: string }
  ) => {
    // Cancel any previous stream
    streamAbortController?.abort()
    streamAbortController = new AbortController()
    const controller = streamAbortController
    const signal = controller.signal
    const requestId = ++streamRequestSeq

    const contextStr    = activeContext ?? loadSettings().activeContext ?? ''
    const payload       = buildPayload(messages, contextStr)

    try {
      signal.throwIfAborted()
      await generateQwenChat(payload, (chunk) => {
        if (!signal.aborted && requestId === streamRequestSeq) {
          event.sender.send('ollama:stream:chunk', chunk)
        }
      }, signal)

      if (requestId === streamRequestSeq) {
        event.sender.send('ollama:stream:end', { success: true })
      }
    } catch (err: unknown) {
      if (requestId !== streamRequestSeq) return
      if (err instanceof Error && err.name === 'AbortError') {
        // User cancelled вЂ” send success so UI cleans up gracefully
        event.sender.send('ollama:stream:end', { success: true, aborted: true })
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        event.sender.send('ollama:stream:end', { success: false, error: msg })
      }
    } finally {
      if (requestId === streamRequestSeq && streamAbortController === controller) {
        streamAbortController = null
      }
    }
  }
)

// в”Ђв”Ђ Available models в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

ipcMain.handle('ollama:getModels', async () => {
  return { success: true, models: [DEFAULT_MODEL] }
})

// в”Ђв”Ђ Chat history persistence в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

ipcMain.handle('history:load', () => loadMessages())

ipcMain.handle('history:save', (_event, messages: ChatMessage[]) => {
  saveMessages(messages)
  maybeTriggerSummary(messages, DEFAULT_MODEL)
})

ipcMain.handle('history:clear', () => {
  clearMessages()
  clearSummary()
})

// в”Ђв”Ђ Settings в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

ipcMain.handle('settings:load', () => loadSettings())
ipcMain.handle('settings:save', (_event, settings: Settings) => saveSettings(settings))

// в”Ђв”Ђ Memory Layer 3: long-term facts в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

ipcMain.handle('memory:loadFacts', () => loadFacts())
ipcMain.handle('memory:saveFact', (_event, fact: MemoryFact) => saveFact(fact))
ipcMain.handle('memory:deleteFact', (_event, id: string) => deleteFact(id))

// в”Ђв”Ђ Memory Layer 2: conversation summary в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

ipcMain.handle('memory:loadSummary', () => loadSummary())

ipcMain.handle('memory:regenerateSummary', async (_event, model: string) => {
  const messages = loadMessages()
  return regenerateSummary(messages, model)
})

ipcMain.handle('memory:extractFacts', async (_event, model: string) => {
  const messages = loadMessages()
  return extractFacts(messages, model)
})

// в”Ђв”Ђ Notes & tools в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

ipcMain.handle(
  'notes:create',
  (_event, { title, content, isIdea }: { title: string; content: string; isIdea?: boolean }) =>
    toolCreateNote(title, content, isIdea)
)

ipcMain.handle(
  'notes:list',
  (_event, { ideasOnly }: { ideasOnly?: boolean } = {}) =>
    toolListNotes(ideasOnly)
)

ipcMain.handle('notes:read', (_event, query: string) => toolReadNote(query))

ipcMain.handle('notes:openFolder', () => toolOpenNotesFolder())

ipcMain.handle('notes:exportChat', (_event, messages: ChatMessage[]) =>
  toolExportChatHistory(messages)
)

ipcMain.handle('notes:delete', (_event, id: string) => deleteNote(id))

// в”Ђв”Ђ Workspace file tools (sandboxed to draftforlili) в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

ipcMain.handle(
  'workspace:createTextFile',
  (_event, filename: string | null, content: string) =>
    wsCreateTextFile(filename, content)
)

ipcMain.handle(
  'workspace:writeTextFile',
  (_event, filename: string, content: string) =>
    wsWriteTextFile(filename, content)
)

ipcMain.handle(
  'workspace:appendTextFile',
  (_event, filename: string, content: string) =>
    wsAppendTextFile(filename, content)
)

ipcMain.handle(
  'workspace:readTextFile',
  (_event, filename: string) =>
    wsReadTextFile(filename)
)

ipcMain.handle('workspace:listFiles', () => wsListWorkspaceFiles())

ipcMain.handle('workspace:openFolder', () => wsOpenWorkspaceFolder())

ipcMain.handle('workspace:searchFiles', (_event, query: string) =>
  wsSearchFiles(query)
)

ipcMain.handle('workspace:findKeyword', (_event, keyword: string) =>
  wsFindKeywordInFiles(keyword)
)

ipcMain.handle('workspace:deleteFile', (_event, filename: string) =>
  wsDeleteFile(filename)
)

ipcMain.handle('workspace:deleteAllFiles', () =>
  wsDeleteAllFiles()
)

/**
 * workspace:summarizeFile
 * Reads a workspace file and asks local Qwen to summarise it.
 * Returns { success, data: summaryText } or { success: false, error }.
 */
ipcMain.handle(
  'workspace:summarizeFile',
  async (_event, filename: string) => {
    const readResult = await wsReadTextFile(filename)
    if (!readResult.success || !readResult.data) {
      return readResult
    }

    const content = readResult.data
    const wordCount = content.split(/\s+/).length
    if (wordCount > 4000) {
      return {
        success: false,
        error: 'File is too large to summarize (> 4000 words).',
      }
    }

    try {
      const summary = await generateQwenChat([
        {
          role: 'user',
          content:
            `Summarize this file concisely in 3-5 bullet points. ` +
            `Preserve key facts, decisions, and action items.\n\n` +
            `File: ${filename}\n\nContent:\n${content}`,
        },
      ])
      return { success: true, data: summary }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }
)

// Voice / local STT (whisper.cpp) в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

ipcMain.handle(
  'voice:transcribe',
  async (
    _event,
    payload: { audioBuffer?: ArrayBuffer; bytes?: number[]; mimeType: string; extension: string }
  ) => {
    const { audioBuffer, bytes, mimeType, extension } = payload

    let buffer: Buffer
    if (audioBuffer instanceof ArrayBuffer) {
      buffer = Buffer.from(new Uint8Array(audioBuffer))
    } else if (Array.isArray(bytes)) {
      buffer = Buffer.from(bytes)
    } else {
      return { success: false, error: 'Invalid audio payload.' }
    }

    return transcribeAudio({
      audioBuffer: buffer,
      mimeType,
      extension,
    })
  }
)

ipcMain.handle('voice:status', () => checkWhisperStatus())

ipcMain.handle('tts:speak', async (_event, text: string) => {
  return synthesizeSpeech(text)
})

// в”Ђв”Ђ Notifications в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

ipcMain.handle('notification:show', (_event, { title, body }: { title: string; body: string }) => {
  showNotification(title, body)
})

ipcMain.handle('notification:schedule', (_event, { id, text, delayMs }: { id: string; text: string; delayMs: number }) => {
  scheduleReminder(id, text, delayMs)
  return { success: true }
})

ipcMain.handle('notification:cancel', (_event, { id }: { id: string }) => {
  return { cancelled: cancelReminder(id) }
})

// в”Ђв”Ђ App launcher в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

ipcMain.handle('app:open', async (_event, { name }: { name: string }) => openApp(name))

ipcMain.handle('app:list', () => ({ apps: listKnownApps() }))

// в”Ђв”Ђ Reminders: list active в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

ipcMain.handle('notification:list', () => ({ reminders: listReminders() }))

// в”Ђв”Ђ Weather в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

ipcMain.handle('weather:get', async (_event, { city }: { city: string }) =>
  getWeather(city)
)

// в”Ђв”Ђ Clipboard в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

ipcMain.handle('clipboard:read', () => ({ text: clipboard.readText() }))

ipcMain.handle('clipboard:write', (_event, { text }: { text: string }) => {
  clipboard.writeText(text)
  return { success: true }
})

// в”Ђв”Ђ System: volume в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

ipcMain.handle('system:volumeGet', async () => {
  const level = await getVolume()
  return { level }
})

ipcMain.handle('system:volumeSet', async (_event, { pct }: { pct: number }) => {
  await setVolume(pct)
  return { success: true }
})

ipcMain.handle('system:volumeAdjust', async (_event, { delta }: { delta: number }) => {
  const level = await adjustVolume(delta)
  return { level }
})

ipcMain.handle('system:mute', async (_event, { state }: { state?: boolean }) => {
  if (state === undefined) {
    const muted = await toggleMute()
    return { muted }
  }
  await setMute(state)
  return { muted: state }
})

// в”Ђв”Ђ System: media control в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

ipcMain.handle('system:media', async (_event, { action }: { action: string }) => {
  await mediaControl(action as Parameters<typeof mediaControl>[0])
  return { success: true }
})

// в”Ђв”Ђ System: info (RAM, CPU, battery, disk) в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

ipcMain.handle('system:info', async () => {
  const text = await getSystemInfoFormatted()
  return { text }
})

// в”Ђв”Ђ Media: current track в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

ipcMain.handle('media:currentTrack', async () => {
  const text = await getCurrentTrackFormatted()
  return { text }
})

// в”Ђв”Ђ System: brightness в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

ipcMain.handle('system:brightnessGet', async () => {
  const level = await getBrightness()
  return { level }
})

ipcMain.handle('system:brightnessSet', async (_event, { pct }: { pct: number }) => {
  const level = await setBrightness(pct)
  return { success: level >= 0, level }
})

ipcMain.handle('system:brightnessAdjust', async (_event, { delta }: { delta: number }) => {
  const level = await adjustBrightness(delta)
  return { level }
})

// в”Ђв”Ђ Window management в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

ipcMain.handle('system:windowMinimizeAll', async () => {
  await windowMinimizeAll()
  return { success: true }
})

ipcMain.handle('system:windowRestoreAll', async () => {
  await windowRestoreAll()
  return { success: true }
})

ipcMain.handle('system:windowFocus', async (_event, { name }: { name: string }) => {
  const found = await windowFocus(name)
  return { found }
})

ipcMain.handle('system:windowClose', async (_event, { name }: { name: string }) => {
  await windowClose(name)
  return { success: true }
})

// в”Ђв”Ђ Todo в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

ipcMain.handle('todo:list', async () => {
  const tasks = await loadTasks()
  return { tasks }
})

ipcMain.handle('todo:add', async (_event, { text }: { text: string }) => {
  const task = await addTask(text)
  return { task }
})

ipcMain.handle('todo:done', async (_event, { query }: { query: string }) => {
  const task = await completeTask(query)
  return { task }
})

ipcMain.handle('todo:delete', async (_event, { query }: { query: string }) => {
  const ok = await deleteTask(query)
  return { success: ok }
})

ipcMain.handle('todo:clearDone', async () => {
  const count = await clearDoneTasks()
  return { count }
})

// в”Ђв”Ђ Journal в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

ipcMain.handle('journal:write', async (_event, { text }: { text: string }) => {
  await writeJournalEntry(text)
  return { success: true }
})

ipcMain.handle('journal:read', async (_event, { offset }: { offset: number }) => {
  const d = new Date()
  d.setDate(d.getDate() - (offset ?? 0))
  const content = await readJournalDay(d)
  return { content }
})

ipcMain.handle('journal:list', async () => {
  const days = await listJournalDays()
  return { days }
})

// в”Ђв”Ђ Web search в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

ipcMain.handle('web:search', async (_event, { query }: { query: string }) => {
  const r = await webSearch(query)
  if (!r.success || !r.results) return { success: false, text: `РћС€РёР±РєР° РїРѕРёСЃРєР°: ${r.error}` }
  return { success: true, text: formatSearchResults(query, r.results) }
})

// в”Ђв”Ђ Screenshot в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

ipcMain.handle('screenshot:take', async () => takeScreenshot())

ipcMain.handle('screenshot:openFolder', async () => {
  await openScreenshotsFolder()
  return { success: true }
})

// в”Ђв”Ђ Command history в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

ipcMain.handle('commandHistory:write', async (_event, { text }: { text: string }) => {
  await writeCommandEntry(text)
  return { success: true }
})

ipcMain.handle('commandHistory:read', async (_event, { offset }: { offset?: number }) => {
  const content = await readCommandDay(offset ?? 0)
  return { content }
})

ipcMain.handle('commandHistory:list', async () => {
  const days = await listCommandDays()
  return { days }
})

// в”Ђв”Ђ Telegram в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

ipcMain.handle(
  'telegram:send',
  async (_event, { to, text, autoSend }: { to: string; text: string; autoSend: boolean }) => {
    return sendTelegramMessage(to, text, autoSend)
  }
)

ipcMain.handle(
  'telegram:addContact',
  async (_event, { name, username }: { name: string; username: string }) => {
    await addContact(name, username)
    return { success: true }
  }
)

ipcMain.handle(
  'telegram:removeContact',
  async (_event, { name }: { name: string }) => {
    const ok = await removeContact(name)
    return { success: ok }
  }
)

ipcMain.handle('telegram:listContacts', async () => {
  const contacts = await loadContacts()
  return { contacts }
})

// в”Ђв”Ђ Music: YouTube autoplay в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

ipcMain.handle('music:playYT', async () => {
  const ok = await playInYoutubeMusicWindow()
  return { success: ok }
})

// в”Ђв”Ђ YouTube search & play в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

ipcMain.handle('youtube:search', async (_event, { query }: { query: string }) => {
  return searchAndPlayYoutube(query)
})

// в”Ђв”Ђ Window: compact mode в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

ipcMain.handle('window:setCompact', (_event, { compact }: { compact: boolean }) => {
  if (!mainWindow) return
  isCompact = compact
  if (compact) {
    mainWindow.setResizable(false)
    mainWindow.setAlwaysOnTop(true)
    mainWindow.setSize(COMPACT_SIZE.width, COMPACT_SIZE.height, true)
    mainWindow.setMinimumSize(COMPACT_SIZE.width, COMPACT_SIZE.height)
  } else {
    mainWindow.setAlwaysOnTop(false)
    mainWindow.setResizable(true)
    mainWindow.setMinimumSize(800, 600)
    mainWindow.setSize(NORMAL_SIZE.width, NORMAL_SIZE.height, true)
    mainWindow.center()
  }
  return { compact }
})

