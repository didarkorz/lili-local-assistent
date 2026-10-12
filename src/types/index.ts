export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  streaming?: boolean  // true while streaming response, not persisted to disk
}

export interface OllamaResult {
  success: boolean
  text?: string
  error?: string
}

export type OllamaLifecycleStatus = 'checking' | 'starting' | 'connected' | 'failed'

export interface Settings {
  model: string
  activeContext?: string
  micDeviceId?: string
  wakeWordEnabled?: boolean
  dictationMode?: DictationMode
}

// ── Memory Layer 3 — long-term fact ──────────────────────────────────────────

export interface MemoryFact {
  id: string
  content: string
  /** Pinned facts appear first in the prompt and are never dropped. */
  pinned: boolean
  createdAt: number
  updatedAt?: number
  category?: 'profile' | 'preference' | 'project' | 'goal' | 'instruction'
  /** Optional project tag for context-aware retrieval (e.g. "ToD", "Dev") */
  projectTag?: string
}

// ── Memory Layer 2 — rolling conversation summary ────────────────────────────

export interface ConversationSummary {
  content: string
  updatedAt: number
  coveredMessageCount: number
}

// ── Voice / STT ───────────────────────────────────────────────────────────────

export interface TranscribeResult {
  success: boolean
  text?: string
  error?: string
  meta?: {
    engine: 'server' | 'cli'
    modelName: string
    modelTier: 'base' | 'small' | 'medium' | 'large'
    durationSec: number
    prepareMs: number
    inferMs: number
    cleanupMs: number
    totalMs: number
  }
}

export interface WhisperStatus {
  available: boolean
  binPath: string
  modelPath: string
  error?: string
}

export interface TranscribeAudioPayload {
  mimeType: string
  extension: string
  audioBuffer?: ArrayBuffer
  bytes?: number[]
}

export type DictationMode = 'submit' | 'insert'

export interface VoicePerf {
  captureMs: number
  finalizeMs: number
  transcribeMs: number
  sendMs: number
  totalMs: number
  sttEngine?: 'server' | 'cli'
  sttModelTier?: 'base' | 'small' | 'medium' | 'large'
  audioDurationSec?: number
  sttInferMs?: number
}

// ── TTS ───────────────────────────────────────────────────────────────────────

export interface TTSResult {
  success: boolean
  audioBase64?: string
  error?: string
}

// ── Workspace file tools ──────────────────────────────────────────────────────

export interface WorkspaceResult {
  success: boolean
  data?: string
  error?: string
  filename?: string
}

// ── Notes ─────────────────────────────────────────────────────────────────────

export interface Note {
  id: string
  title: string
  content: string
  isIdea: boolean
  createdAt: number
  updatedAt: number
}

// ── Preload API surface (injected by electron/preload.ts via contextBridge) ───

export interface ElectronAPI {
  // Chat
  sendChat(messages: Message[], model?: string, activeContext?: string): Promise<OllamaResult>

  // Ollama status
  getStatus(): Promise<OllamaLifecycleStatus>
  reconnect(): Promise<OllamaLifecycleStatus>
  onStatusUpdate(cb: (status: OllamaLifecycleStatus) => void): () => void

  // Available models
  getModels(): Promise<{ success: boolean; models: string[] }>

  // Chat history
  loadHistory(): Promise<Message[]>
  saveHistory(messages: Message[]): Promise<void>
  clearHistory(): Promise<void>

  // Settings
  loadSettings(): Promise<Settings>
  saveSettings(settings: Settings): Promise<void>

  // Memory Layer 3 — long-term facts
  loadFacts(): Promise<MemoryFact[]>
  saveFact(fact: MemoryFact): Promise<void>
  deleteFact(id: string): Promise<void>

  // Memory Layer 2 — rolling summary
  loadSummary(): Promise<ConversationSummary | null>
  regenerateSummary(model: string): Promise<boolean>
  extractFacts(model: string): Promise<string[]>

  // Notes
  createNote(title: string, content: string, isIdea?: boolean): Promise<Note>
  listNotes(ideasOnly?: boolean): Promise<Note[]>
  readNote(query: string): Promise<Note | null>
  openNotesFolder(): Promise<void>
  exportChatHistory(messages: Message[]): Promise<Note>
  deleteNote(id: string): Promise<void>

  // Workspace file tools (restricted to the configured workspace directory)
  createTextFile(filename: string | null, content: string): Promise<WorkspaceResult>
  writeTextFile(filename: string, content: string): Promise<WorkspaceResult>
  appendTextFile(filename: string, content: string): Promise<WorkspaceResult>
  readTextFile(filename: string): Promise<WorkspaceResult>
  listWorkspaceFiles(): Promise<WorkspaceResult>
  openWorkspaceFolder(): Promise<WorkspaceResult>
  searchFiles(query: string): Promise<WorkspaceResult>
  findKeywordInFiles(keyword: string): Promise<WorkspaceResult>
  summarizeFile(filename: string, model?: string): Promise<WorkspaceResult>
  deleteFile(filename: string): Promise<WorkspaceResult>
  deleteAllFiles(): Promise<WorkspaceResult>

  // Streaming chat
  startChatStream(messages: Message[], model?: string, activeContext?: string): void
  abortChatStream(): void
  onStreamChunk(cb: (chunk: string) => void): () => void
  onStreamEnd(cb: (result: { success: boolean; error?: string }) => void): () => void

  // Voice / local STT
  transcribeAudio(payload: TranscribeAudioPayload): Promise<TranscribeResult>
  getVoiceStatus(): Promise<WhisperStatus>

  // TTS
  speakText(text: string): Promise<TTSResult>

  // Voice hotkey listener (Alt+Space from main process)
  onVoiceHotkey(cb: () => void): () => void

  // Notifications
  showNotification(title: string, body: string): Promise<void>
  scheduleReminder(id: string, text: string, delayMs: number): Promise<{ success: boolean }>
  cancelReminder(id: string): Promise<{ cancelled: boolean }>
  listReminders(): Promise<{ reminders: Array<{ id: string; text: string; fireAt: number }> }>

  // App launcher
  openApp(name: string): Promise<{ success: boolean; error?: string }>
  listApps(): Promise<{ apps: string[] }>

  // Weather
  getWeather(city: string): Promise<{ success: boolean; data?: string; error?: string }>

  // Clipboard
  clipboardRead(): Promise<{ text: string }>
  clipboardWrite(text: string): Promise<{ success: boolean }>

  // System: volume
  volumeGet(): Promise<{ level: number }>
  volumeSet(pct: number): Promise<{ success: boolean }>
  volumeAdjust(delta: number): Promise<{ level: number }>
  mute(state?: boolean): Promise<{ muted: boolean }>

  // System: media
  mediaControl(action: string): Promise<{ success: boolean }>

  // System: info
  getSystemInfo(): Promise<{ text: string }>

  // Media: current track
  getCurrentTrack(): Promise<{ text: string }>

  // System: brightness
  brightnessGet(): Promise<{ level: number }>
  brightnessSet(pct: number): Promise<{ success: boolean; level: number }>
  brightnessAdjust(delta: number): Promise<{ level: number }>

  // Window management
  windowMinimizeAll(): Promise<{ success: boolean }>
  windowRestoreAll(): Promise<{ success: boolean }>
  windowFocus(name: string): Promise<{ found: boolean }>
  windowClose(name: string): Promise<{ success: boolean }>

  // Todo
  todoList(): Promise<{ tasks: Array<{ id: string; text: string; done: boolean; createdAt: number }> }>
  todoAdd(text: string): Promise<{ task: { id: string; text: string; done: boolean; createdAt: number } }>
  todoDone(query: string): Promise<{ task: { id: string; text: string } | null }>
  todoDelete(query: string): Promise<{ success: boolean }>
  todoClearDone(): Promise<{ count: number }>

  // Journal
  journalWrite(text: string): Promise<{ success: boolean }>
  journalRead(offset: number): Promise<{ content: string | null }>
  journalList(): Promise<{ days: string[] }>

  // Web search
  webSearch(query: string): Promise<{ success: boolean; text: string }>

  // Screenshot
  takeScreenshot(): Promise<{ success: boolean; path?: string; error?: string }>
  openScreenshotsFolder(): Promise<{ success: boolean }>

  // Command history
  commandHistoryWrite(text: string): Promise<{ success: boolean }>
  commandHistoryRead(offset?: number): Promise<{ content: string | null }>
  commandHistoryList(): Promise<{ days: string[] }>

  // Telegram
  telegramSend(to: string, text: string, autoSend: boolean): Promise<{ success: boolean; username?: string; error?: string }>
  telegramAddContact(name: string, username: string): Promise<{ success: boolean }>
  telegramRemoveContact(name: string): Promise<{ success: boolean }>
  telegramListContacts(): Promise<{ contacts: Record<string, string> }>

  // Music: YouTube autoplay
  musicPlayYT(): Promise<{ success: boolean }>

  // YouTube search & play
  youtubeSearch(query: string): Promise<{ success: boolean; title?: string; url?: string; error?: string }>

  // Window: compact mode
  setCompactMode(compact: boolean): Promise<{ compact: boolean }>
  onToggleCompact(cb: () => void): () => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
