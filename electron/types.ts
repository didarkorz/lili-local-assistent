export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
}

export interface Settings {
  model: string
  activeContext?: string
  micDeviceId?: string
  wakeWordEnabled?: boolean
  dictationMode?: 'submit' | 'insert'
}

export type OllamaLifecycleStatus = 'checking' | 'starting' | 'connected' | 'failed'

// ── Memory Layer 3 — long-term fact ──────────────────────────────────────────

export interface MemoryFact {
  id: string
  content: string
  /** Pinned facts are injected first, above all other context. */
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

// ── Notes ─────────────────────────────────────────────────────────────────────

export interface Note {
  id: string
  title: string
  content: string
  isIdea: boolean
  createdAt: number
  updatedAt: number
}
