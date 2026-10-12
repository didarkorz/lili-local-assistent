import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useChat } from './hooks/useChat'
import { useOllamaStatus } from './hooks/useOllamaStatus'
import { useMemory } from './hooks/useMemory'
import { useVoice } from './hooks/useVoice'
import { useTTS } from './hooks/useTTS'
import { useWakeWord } from './hooks/useWakeWord'
import { MessageList } from './components/MessageList'
import { ChatInput } from './components/ChatInput'
import { StatusBadge } from './components/StatusBadge'
import { MemoryPanel } from './components/MemoryPanel'
import { MicSettings } from './components/MicSettings'
import { TimerBar } from './components/TimerBar'
import { VoiceDebugPanel } from './components/VoiceDebugPanel'
import { DEFAULT_MODEL } from './constants'
import type { DictationMode } from './types'

const WAKE_WORD_RUNTIME_ENABLED = false
const SHOW_VOICE_DEBUG = false

export default function App() {
  const [model, setModel] = useState(DEFAULT_MODEL)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [activeContext, setActiveContext] = useState('General')
  const [wakeEnabled, setWakeEnabled] = useState(false)
  const [dictationMode, setDictationMode] = useState<DictationMode>('submit')
  const [compactMode, setCompactMode] = useState(false)
  const [micSettingsOpen, setMicSettingsOpen] = useState(false)
  const [voiceDebugOpen, setVoiceDebugOpen] = useState(false)
  const [micDeviceId, setMicDeviceId] = useState('')
  const [inputValue, setInputValue] = useState('')

  const { status, reconnect } = useOllamaStatus()

  const {
    ttsEnabled,
    setTtsEnabled,
    ttsState,
    ttsError,
    speak,
    stopSpeaking,
    addStreamChunk,
    flushStream,
  } = useTTS()

  const {
    messages,
    isLoading,
    error,
    sendMessage,
    clearMessages,
    stopGeneration,
    prewarmMessage,
    chatDebug,
  } = useChat(model, activeContext)

  const { refreshSummary } = useMemory(false)

  const settingsLoadedRef = useRef(false)
  const lastSpokenMessageIdRef = useRef<string | null>(null)
  const streamingMessageIdRef = useRef<string | null>(null)
  const prevStreamContentRef = useRef('')
  const wakeCallbackRef = useRef<(cmd: string) => void>(() => {})
  const handleVoiceToggleRef = useRef<() => void>(() => {})

  const {
    voiceState,
    voiceError,
    voicePerf,
    voiceLevel,
    lastTranscript,
    toggleRecording,
    setDictationMode: setVoiceDictationMode,
  } = useVoice({
    deviceId: micDeviceId || undefined,
    dictationMode,
    onSubmit: (text) => sendMessage(text, 'voice'),
    onInsert: (text) => {
      setInputValue((prev) => (prev.trim() ? `${prev.trimEnd()} ${text}` : text))
    },
  })

  useEffect(() => {
    window.electronAPI.loadSettings().then((settings) => {
      setModel(DEFAULT_MODEL)
      if (settings?.activeContext) setActiveContext(settings.activeContext)
      if (settings?.micDeviceId) setMicDeviceId(settings.micDeviceId)

      if (WAKE_WORD_RUNTIME_ENABLED && typeof settings?.wakeWordEnabled === 'boolean') {
        setWakeEnabled(settings.wakeWordEnabled)
      } else {
        setWakeEnabled(false)
      }

      if (settings?.dictationMode) {
        setDictationMode(settings.dictationMode)
        setVoiceDictationMode(settings.dictationMode)
      }

      settingsLoadedRef.current = true
    }).catch((err) => {
      console.error('[app] failed to load settings:', err)
      settingsLoadedRef.current = true
    })
  }, [setVoiceDictationMode])

  useEffect(() => {
    if (!settingsLoadedRef.current) return

    void window.electronAPI.saveSettings({
      model: DEFAULT_MODEL,
      activeContext,
      micDeviceId: micDeviceId || undefined,
      wakeWordEnabled: WAKE_WORD_RUNTIME_ENABLED ? wakeEnabled : false,
      dictationMode,
    }).catch((err) => {
      console.error('[app] failed to save settings:', err)
    })
  }, [activeContext, micDeviceId, wakeEnabled, dictationMode])

  const lastAssistantMessage = useMemo(
    () => [...messages].reverse().find((message) => message.role === 'assistant'),
    [messages]
  )

  useEffect(() => {
    if (!ttsEnabled || !lastAssistantMessage) return

    if (lastAssistantMessage.streaming) {
      if (streamingMessageIdRef.current !== lastAssistantMessage.id) {
        streamingMessageIdRef.current = lastAssistantMessage.id
        prevStreamContentRef.current = ''
      }

      const delta = lastAssistantMessage.content.slice(prevStreamContentRef.current.length)
      if (delta) {
        prevStreamContentRef.current = lastAssistantMessage.content
        addStreamChunk(delta)
      }
      return
    }

    if (streamingMessageIdRef.current === lastAssistantMessage.id) {
      streamingMessageIdRef.current = null
      prevStreamContentRef.current = ''
      flushStream()
      lastSpokenMessageIdRef.current = lastAssistantMessage.id
      return
    }

    if (lastSpokenMessageIdRef.current !== lastAssistantMessage.id) {
      lastSpokenMessageIdRef.current = lastAssistantMessage.id
      void speak(lastAssistantMessage.content)
    }
  }, [lastAssistantMessage, ttsEnabled, speak, addStreamChunk, flushStream])

  useEffect(() => {
    wakeCallbackRef.current = async (command: string) => {
      if (ttsState !== 'idle') await stopSpeaking()
      if (isLoading) stopGeneration()
      if (command) await sendMessage(command, 'voice')
    }
  }, [ttsState, isLoading, stopSpeaking, stopGeneration, sendMessage])

  useWakeWord(
    useCallback((command: string) => {
      wakeCallbackRef.current(command)
    }, []),
    WAKE_WORD_RUNTIME_ENABLED && wakeEnabled,
    voiceState === 'idle',
    micDeviceId || undefined,
  )

  const handleVoiceToggle = useCallback(async () => {
    if (voiceState === 'idle') {
      if (ttsState !== 'idle') await stopSpeaking()
      if (isLoading) stopGeneration()
    }
    await toggleRecording()
  }, [voiceState, ttsState, isLoading, stopSpeaking, stopGeneration, toggleRecording])

  useEffect(() => {
    handleVoiceToggleRef.current = handleVoiceToggle
  }, [handleVoiceToggle])

  const toggleCompact = useCallback(async () => {
    const next = !compactMode
    setCompactMode(next)
    await window.electronAPI.setCompactMode(next)
  }, [compactMode])

  useEffect(() => {
    return window.electronAPI.onToggleCompact(() => {
      void toggleCompact()
    })
  }, [toggleCompact])

  useEffect(() => {
    return window.electronAPI.onVoiceHotkey(() => {
      handleVoiceToggleRef.current()
    })
  }, [])

  useEffect(() => {
    if (!ttsEnabled) void stopSpeaking()
  }, [ttsEnabled, stopSpeaking])

  const handleSend = useCallback(async (text: string) => {
    if (ttsState !== 'idle') await stopSpeaking()
    await sendMessage(text, 'text')
  }, [sendMessage, stopSpeaking, ttsState])

  const handleDictationModeChange = (mode: DictationMode) => {
    setDictationMode(mode)
    setVoiceDictationMode(mode)
  }

  const handleClearChat = () => {
    clearMessages()
    refreshSummary()
  }

  const voiceStatusLabel =
    voiceState === 'recording' ? 'Listening...' :
    voiceState === 'transcribing' ? 'Transcribing...' :
    isLoading ? 'Thinking...' :
    ttsState === 'generatingVoice' ? 'Generating voice...' :
    ttsState === 'speaking' ? 'Speaking...' :
    null

  const voicePerfLabel = SHOW_VOICE_DEBUG && voicePerf
    ? `Voice ${voicePerf.totalMs}ms`
    : null

  return (
    <div className="h-screen flex flex-col text-zinc-800 select-none overflow-hidden">
      <header className="flex items-center justify-between px-5 py-3 border-b border-zinc-200 bg-white/90 backdrop-blur-sm shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-indigo-600 flex items-center justify-center shrink-0">
            <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
              />
            </svg>
          </div>

          <div>
            <h1 className="text-sm font-semibold text-zinc-800 leading-none">Lili</h1>
            <p className="text-[11px] text-zinc-400 mt-0.5">Local AI Assistant</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <StatusBadge status={status} onReconnect={reconnect} />

          {voiceStatusLabel && (
            <span className="text-[11px] px-2 py-0.5 rounded-lg bg-zinc-100 text-zinc-500 border border-zinc-200">
              {voiceStatusLabel}
            </span>
          )}

          <span className="text-[11px] text-zinc-400">{model}</span>

          <button
            onClick={() => setVoiceDebugOpen((value) => !value)}
            className={`text-[11px] px-2.5 py-1 rounded-lg border transition-colors ${
              voiceDebugOpen
                ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                : 'border-zinc-200 bg-white text-zinc-500 hover:bg-zinc-50'
            }`}
            title="Show voice debug panel"
          >
            Debug
          </button>

          <button
            onClick={() => setTtsEnabled(!ttsEnabled)}
            className={`text-[11px] px-2.5 py-1 rounded-lg border transition-colors ${
              ttsEnabled
                ? 'border-indigo-300 bg-indigo-50 text-indigo-600'
                : 'border-zinc-200 bg-white text-zinc-500'
            }`}
          >
            {ttsEnabled ? 'Voice On' : 'Voice Off'}
          </button>

          <button
            onClick={() => setMicSettingsOpen(true)}
            title="Microphone settings"
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"
              />
            </svg>
          </button>

          {WAKE_WORD_RUNTIME_ENABLED && (
            <button
              onClick={() => setWakeEnabled((value) => !value)}
              title='Wake word: say "Lili, [command]" hands-free'
              className={`text-[11px] px-2.5 py-1 rounded-lg border transition-colors ${
                wakeEnabled
                  ? 'border-violet-300 bg-violet-50 text-violet-600'
                  : 'border-zinc-200 bg-white text-zinc-500'
              }`}
            >
              {wakeEnabled ? 'Wake On' : 'Wake Off'}
            </button>
          )}

          {isLoading && (
            <button
              onClick={stopGeneration}
              className="text-[11px] px-2.5 py-1 rounded-lg border border-red-200 bg-red-50 text-red-500 flex items-center gap-1"
            >
              <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="currentColor">
                <rect x="4" y="4" width="16" height="16" rx="2" />
              </svg>
              Stop
            </button>
          )}

          {ttsState === 'speaking' && !isLoading && (
            <button
              onClick={() => void stopSpeaking()}
              className="text-[11px] px-2.5 py-1 rounded-lg border border-red-200 bg-red-50 text-red-500"
            >
              Stop
            </button>
          )}

          <button
            onClick={() => setMemoryOpen((value) => !value)}
            title="Memory and notes"
            className={`p-1.5 rounded-lg transition-colors ${
              memoryOpen
                ? 'bg-indigo-100 text-indigo-600'
                : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100'
            }`}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18"
              />
            </svg>
          </button>

          <button
            onClick={() => void toggleCompact()}
            title={compactMode ? 'Normal mode' : 'Compact mode'}
            className={`p-1.5 rounded-lg transition-colors ${
              compactMode
                ? 'bg-indigo-100 text-indigo-600'
                : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100'
            }`}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              {compactMode
                ? <path strokeLinecap="round" strokeLinejoin="round" d="M4 8h16M4 16h16" />
                : <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              }
            </svg>
          </button>

          {messages.length > 0 && !compactMode && (
            <button
              onClick={handleClearChat}
              className="text-[11px] text-zinc-400 hover:text-zinc-600 transition-colors"
            >
              Clear
            </button>
          )}
        </div>
      </header>

      {status === 'failed' && (
        <div className="mx-5 mt-3 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-700 shrink-0">
          <span className="font-medium">Qwen is not ready.</span> Make sure{' '}
          <code className="bg-amber-100 px-1.5 py-0.5 rounded font-mono text-xs">
            Qwen3-4B
          </code>{' '}
          exists in the project root and click <strong>Retry</strong>.
        </div>
      )}

      {error && (
        <div className="mx-5 mt-3 px-4 py-2.5 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600 shrink-0">
          <span className="font-medium">Error: </span>
          {error}
        </div>
      )}

      {ttsError && (
        <div className="mx-5 mt-3 px-4 py-2.5 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600 shrink-0">
          <span className="font-medium">Voice error: </span>
          {ttsError}
        </div>
      )}

      {!compactMode && <TimerBar />}
      {!compactMode && <MessageList messages={messages} isLoading={isLoading} />}

      <ChatInput
        value={inputValue}
        onValueChange={setInputValue}
        onSend={handleSend}
        onPrewarm={prewarmMessage}
        disabled={isLoading || status !== 'connected'}
        model={model}
        voiceState={voiceState}
        onVoiceToggle={handleVoiceToggle}
        voiceError={voiceError}
        voicePerfLabel={voicePerfLabel}
        dictationMode={dictationMode}
        onDictationModeChange={handleDictationModeChange}
      />

      <MemoryPanel
        open={memoryOpen}
        onClose={() => setMemoryOpen(false)}
        model={model}
        messages={messages}
        activeContext={activeContext}
        onContextChange={setActiveContext}
      />

      <MicSettings
        open={micSettingsOpen}
        onClose={() => setMicSettingsOpen(false)}
        selectedDeviceId={micDeviceId}
        onDeviceChange={setMicDeviceId}
      />

      <VoiceDebugPanel
        open={voiceDebugOpen}
        voiceState={voiceState}
        voiceError={voiceError}
        voicePerf={voicePerf}
        voiceLevel={voiceLevel}
        lastTranscript={lastTranscript}
        chatDebug={chatDebug}
        onClose={() => setVoiceDebugOpen(false)}
      />
    </div>
  )
}
