import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Settings } from '../src/types'

contextBridge.exposeInMainWorld('electronAPI', {
  // ── Chat ─────────────────────────────────────────────────────────────────
  sendChat: (messages: unknown[], model?: string, activeContext?: string) =>
    ipcRenderer.invoke('ollama:chat', { messages, model, activeContext }),

  // ── Ollama status ─────────────────────────────────────────────────────────
  getStatus: () => ipcRenderer.invoke('ollama:getStatus'),
  reconnect: () => ipcRenderer.invoke('ollama:reconnect'),

  onStatusUpdate: (cb: (status: string) => void) => {
    const listener = (_: IpcRendererEvent, status: string) => cb(status)
    ipcRenderer.on('ollama:status-update', listener)
    return () => ipcRenderer.removeListener('ollama:status-update', listener)
  },

  // ── Available models ──────────────────────────────────────────────────────
  getModels: () => ipcRenderer.invoke('ollama:getModels'),

  // ── Chat history ──────────────────────────────────────────────────────────
  loadHistory: () => ipcRenderer.invoke('history:load'),
  saveHistory: (messages: unknown[]) => ipcRenderer.invoke('history:save', messages),
  clearHistory: () => ipcRenderer.invoke('history:clear'),

  // ── Settings ──────────────────────────────────────────────────────────────
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings: Settings) =>
    ipcRenderer.invoke('settings:save', settings),

  // ── Memory Layer 3: long-term facts ───────────────────────────────────────
  loadFacts: () => ipcRenderer.invoke('memory:loadFacts'),
  saveFact: (fact: unknown) => ipcRenderer.invoke('memory:saveFact', fact),
  deleteFact: (id: string) => ipcRenderer.invoke('memory:deleteFact', id),

  // ── Memory Layer 2: rolling conversation summary ───────────────────────────
  loadSummary: () => ipcRenderer.invoke('memory:loadSummary'),
  regenerateSummary: (model: string) =>
    ipcRenderer.invoke('memory:regenerateSummary', model),
  extractFacts: (model: string) =>
    ipcRenderer.invoke('memory:extractFacts', model),

  // ── Notes ───────────────────────────────────────────────────────────────────
  createNote: (title: string, content: string, isIdea?: boolean) =>
    ipcRenderer.invoke('notes:create', { title, content, isIdea }),

  listNotes: (ideasOnly?: boolean) =>
    ipcRenderer.invoke('notes:list', { ideasOnly }),

  readNote: (query: string) =>
    ipcRenderer.invoke('notes:read', query),

  openNotesFolder: () =>
    ipcRenderer.invoke('notes:openFolder'),

  exportChatHistory: (messages: unknown[]) =>
    ipcRenderer.invoke('notes:exportChat', messages),

  deleteNote: (id: string) =>
    ipcRenderer.invoke('notes:delete', id),

  // ── Workspace file tools (sandboxed to draftforlili) ───────────────────────
  createTextFile: (filename: string | null, content: string) =>
    ipcRenderer.invoke('workspace:createTextFile', filename, content),

  writeTextFile: (filename: string, content: string) =>
    ipcRenderer.invoke('workspace:writeTextFile', filename, content),

  appendTextFile: (filename: string, content: string) =>
    ipcRenderer.invoke('workspace:appendTextFile', filename, content),

  readTextFile: (filename: string) =>
    ipcRenderer.invoke('workspace:readTextFile', filename),

  listWorkspaceFiles: () =>
    ipcRenderer.invoke('workspace:listFiles'),

  openWorkspaceFolder: () =>
    ipcRenderer.invoke('workspace:openFolder'),

  searchFiles: (query: string) =>
    ipcRenderer.invoke('workspace:searchFiles', query),

  findKeywordInFiles: (keyword: string) =>
    ipcRenderer.invoke('workspace:findKeyword', keyword),

  summarizeFile: (filename: string, model?: string) =>
    ipcRenderer.invoke('workspace:summarizeFile', filename, model),

  deleteFile: (filename: string) =>
    ipcRenderer.invoke('workspace:deleteFile', filename),

  deleteAllFiles: () =>
    ipcRenderer.invoke('workspace:deleteAllFiles'),

  // Streaming chat
  startChatStream: (messages: unknown[], model?: string, activeContext?: string) => {
    ipcRenderer.send('ollama:stream:start', { messages, model, activeContext })
  },

  abortChatStream: () => {
    ipcRenderer.send('ollama:stream:abort')
  },

  onStreamChunk: (cb: (chunk: string) => void) => {
    const listener = (_: IpcRendererEvent, chunk: string) => cb(chunk)
    ipcRenderer.on('ollama:stream:chunk', listener)
    return () => ipcRenderer.removeListener('ollama:stream:chunk', listener)
  },

  onStreamEnd: (cb: (result: { success: boolean; error?: string }) => void) => {
    const listener = (_: IpcRendererEvent, result: { success: boolean; error?: string }) => cb(result)
    ipcRenderer.once('ollama:stream:end', listener)
    return () => ipcRenderer.removeListener('ollama:stream:end', listener)
  },

  // ── Voice / local STT ──────────────────────────────────────────────────────
  transcribeAudio: (wavBytes: unknown) =>
    ipcRenderer.invoke('voice:transcribe', wavBytes),

  getVoiceStatus: () =>
    ipcRenderer.invoke('voice:status'),

  // ── TTS ───────────────────────────────────────────────────────────────────
  speakText: (text: string) =>
    ipcRenderer.invoke('tts:speak', text),

  // ── Voice hotkey (main → renderer push) ───────────────────────────────────
  // Register a callback for Alt+Space hotkey. Returns cleanup function.
  onVoiceHotkey: (cb: () => void) => {
    const listener = () => cb()
    ipcRenderer.on('voice:hotkey', listener)
    return () => ipcRenderer.removeListener('voice:hotkey', listener)
  },

  // ── Notifications ─────────────────────────────────────────────────────────
  showNotification: (title: string, body: string) =>
    ipcRenderer.invoke('notification:show', { title, body }),

  scheduleReminder: (id: string, text: string, delayMs: number) =>
    ipcRenderer.invoke('notification:schedule', { id, text, delayMs }),

  cancelReminder: (id: string) =>
    ipcRenderer.invoke('notification:cancel', { id }),

  listReminders: () =>
    ipcRenderer.invoke('notification:list'),

  // ── App launcher ──────────────────────────────────────────────────────────
  openApp: (name: string) =>
    ipcRenderer.invoke('app:open', { name }),

  listApps: () =>
    ipcRenderer.invoke('app:list'),

  // ── Weather ───────────────────────────────────────────────────────────────
  getWeather: (city: string) =>
    ipcRenderer.invoke('weather:get', { city }),

  // ── Clipboard ─────────────────────────────────────────────────────────────
  clipboardRead: () =>
    ipcRenderer.invoke('clipboard:read'),

  clipboardWrite: (text: string) =>
    ipcRenderer.invoke('clipboard:write', { text }),

  // ── System: volume ────────────────────────────────────────────────────────
  volumeGet: () =>
    ipcRenderer.invoke('system:volumeGet'),

  volumeSet: (pct: number) =>
    ipcRenderer.invoke('system:volumeSet', { pct }),

  volumeAdjust: (delta: number) =>
    ipcRenderer.invoke('system:volumeAdjust', { delta }),

  mute: (state?: boolean) =>
    ipcRenderer.invoke('system:mute', { state }),

  // ── System: media ─────────────────────────────────────────────────────────
  mediaControl: (action: string) =>
    ipcRenderer.invoke('system:media', { action }),

  // ── System: info ──────────────────────────────────────────────────────────
  getSystemInfo: () =>
    ipcRenderer.invoke('system:info'),

  // ── Media: current track ──────────────────────────────────────────────────
  getCurrentTrack: () =>
    ipcRenderer.invoke('media:currentTrack'),

  // ── System: brightness ───────────────────────────────────────────────────────
  brightnessGet: () => ipcRenderer.invoke('system:brightnessGet'),
  brightnessSet: (pct: number) => ipcRenderer.invoke('system:brightnessSet', { pct }),
  brightnessAdjust: (delta: number) => ipcRenderer.invoke('system:brightnessAdjust', { delta }),

  // ── Window management ─────────────────────────────────────────────────────────
  windowMinimizeAll: () => ipcRenderer.invoke('system:windowMinimizeAll'),
  windowRestoreAll:  () => ipcRenderer.invoke('system:windowRestoreAll'),
  windowFocus: (name: string) => ipcRenderer.invoke('system:windowFocus', { name }),
  windowClose: (name: string) => ipcRenderer.invoke('system:windowClose', { name }),

  // ── Todo ──────────────────────────────────────────────────────────────────────
  todoList:      () => ipcRenderer.invoke('todo:list'),
  todoAdd:       (text: string)  => ipcRenderer.invoke('todo:add',      { text }),
  todoDone:      (query: string) => ipcRenderer.invoke('todo:done',     { query }),
  todoDelete:    (query: string) => ipcRenderer.invoke('todo:delete',   { query }),
  todoClearDone: () => ipcRenderer.invoke('todo:clearDone'),

  // ── Journal ───────────────────────────────────────────────────────────────────
  journalWrite: (text: string)   => ipcRenderer.invoke('journal:write', { text }),
  journalRead:  (offset: number) => ipcRenderer.invoke('journal:read',  { offset }),
  journalList:  () => ipcRenderer.invoke('journal:list'),

  // ── Web search ────────────────────────────────────────────────────────────────
  webSearch: (query: string) => ipcRenderer.invoke('web:search', { query }),

  // ── Screenshot ───────────────────────────────────────────────────────────────
  takeScreenshot: () =>
    ipcRenderer.invoke('screenshot:take'),

  openScreenshotsFolder: () =>
    ipcRenderer.invoke('screenshot:openFolder'),

  // ── Command history ───────────────────────────────────────────────────────────
  commandHistoryWrite: (text: string) =>
    ipcRenderer.invoke('commandHistory:write', { text }),

  commandHistoryRead: (offset?: number) =>
    ipcRenderer.invoke('commandHistory:read', { offset }),

  commandHistoryList: () =>
    ipcRenderer.invoke('commandHistory:list'),

  // ── Telegram ─────────────────────────────────────────────────────────────────
  telegramSend: (to: string, text: string, autoSend: boolean) =>
    ipcRenderer.invoke('telegram:send', { to, text, autoSend }),

  telegramAddContact: (name: string, username: string) =>
    ipcRenderer.invoke('telegram:addContact', { name, username }),

  telegramRemoveContact: (name: string) =>
    ipcRenderer.invoke('telegram:removeContact', { name }),

  telegramListContacts: () =>
    ipcRenderer.invoke('telegram:listContacts'),

  // ── Music: YouTube autoplay ───────────────────────────────────────────────
  musicPlayYT: () => ipcRenderer.invoke('music:playYT'),

  // ── YouTube search & play ─────────────────────────────────────────────────
  youtubeSearch: (query: string) => ipcRenderer.invoke('youtube:search', { query }),

  // ── Window: compact mode ──────────────────────────────────────────────────
  setCompactMode: (compact: boolean) =>
    ipcRenderer.invoke('window:setCompact', { compact }),

  onToggleCompact: (cb: () => void) => {
    const listener = () => cb()
    ipcRenderer.on('window:toggleCompact', listener)
    return () => ipcRenderer.removeListener('window:toggleCompact', listener)
  },
})
