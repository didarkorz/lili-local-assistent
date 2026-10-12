import { useRef, type KeyboardEvent } from 'react'
import { VoiceButton } from './VoiceButton'
import type { VoiceState } from '../hooks/useVoice'
import type { DictationMode } from '../types'
import { DEFAULT_MODEL } from '../constants'

interface Props {
  value: string
  onValueChange: (value: string) => void
  onSend: (message: string) => void | Promise<void>
  onPrewarm?: (message: string) => void
  disabled: boolean
  model?: string
  voiceState?: VoiceState
  onVoiceToggle?: () => void
  voiceError?: string | null
  voicePerfLabel?: string | null
  dictationMode: DictationMode
  onDictationModeChange: (mode: DictationMode) => void
}

export function ChatInput({
  value,
  onValueChange,
  onSend,
  onPrewarm,
  disabled,
  model = DEFAULT_MODEL,
  voiceState,
  onVoiceToggle,
  voiceError,
  voicePerfLabel,
  dictationMode,
  onDictationModeChange,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleSend = () => {
    const trimmed = value.trim()
    if (!trimmed || disabled) return
    void onSend(trimmed)
    onValueChange('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      handleSend()
    }
  }

  const handleInput = () => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

  const isVoiceBusy = voiceState === 'transcribing'

  return (
    <div className="px-5 py-4 border-t border-zinc-200 bg-white/80 backdrop-blur-sm shrink-0">
      <div
        className={`flex items-end gap-3 bg-white border rounded-2xl px-4 py-3 transition-colors shadow-sm ${
          disabled || isVoiceBusy
            ? 'border-zinc-200'
            : 'border-zinc-300 focus-within:border-indigo-400'
        }`}
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => {
            onValueChange(event.target.value)
            onPrewarm?.(event.target.value)
          }}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          placeholder={
            voiceState === 'recording'
              ? 'Recording... tap the microphone again to stop'
              : voiceState === 'transcribing'
                ? 'Transcribing...'
                : 'Message Lili... (Enter to send, Shift+Enter for newline)'
          }
          rows={1}
          disabled={disabled || isVoiceBusy}
          className="flex-1 bg-transparent text-zinc-800 placeholder-zinc-400 text-sm resize-none outline-none max-h-40 min-h-[22px] leading-relaxed disabled:opacity-40"
        />

        {onVoiceToggle && voiceState !== undefined && (
          <VoiceButton
            voiceState={voiceState}
            onToggle={onVoiceToggle}
          />
        )}

        <button
          onClick={handleSend}
          disabled={disabled || !value.trim() || isVoiceBusy}
          className="w-8 h-8 rounded-xl bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 disabled:opacity-25 disabled:cursor-not-allowed flex items-center justify-center transition-colors shrink-0"
          title="Send message"
        >
          <svg
            className="w-3.5 h-3.5 text-white"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2.5}
              d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
            />
          </svg>
        </button>
      </div>

      {voiceError && (
        <p className="text-red-500 text-[11px] mt-1.5 px-1 leading-relaxed">
          {voiceError}
        </p>
      )}

      {!voiceError && voicePerfLabel && (
        <p className="text-zinc-500 text-[11px] mt-1.5 px-1 leading-relaxed">
          {voicePerfLabel}
        </p>
      )}

      <div className="mt-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-1 rounded-xl border border-zinc-200 bg-white px-1 py-1">
          <button
            type="button"
            onClick={() => onDictationModeChange('submit')}
            className={`rounded-lg px-2.5 py-1 text-[11px] transition-colors ${
              dictationMode === 'submit'
                ? 'bg-indigo-50 text-indigo-600'
                : 'text-zinc-500 hover:bg-zinc-50'
            }`}
          >
            Auto-send
          </button>
          <button
            type="button"
            onClick={() => onDictationModeChange('insert')}
            className={`rounded-lg px-2.5 py-1 text-[11px] transition-colors ${
              dictationMode === 'insert'
                ? 'bg-indigo-50 text-indigo-600'
                : 'text-zinc-500 hover:bg-zinc-50'
            }`}
          >
            Insert only
          </button>
        </div>

        <p className="text-zinc-400 text-[11px] text-right">
          Powered by <span className="text-zinc-500">{model}</span> - runs entirely on your machine
        </p>
      </div>
    </div>
  )
}
