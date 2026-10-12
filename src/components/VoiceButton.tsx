/**
 * VoiceButton.tsx
 *
 * Single button with three visual states:
 *   idle        → microphone icon, zinc/gray
 *   recording   → microphone icon, red + pulse ring
 *   transcribing → spinner, muted — not clickable
 */

import type { VoiceState } from '../hooks/useVoice'

interface Props {
  voiceState: VoiceState
  onToggle:   () => void
}

export function VoiceButton({ voiceState, onToggle }: Props) {
  const isRecording    = voiceState === 'recording'
  const isTranscribing = voiceState === 'transcribing'

  const label = isTranscribing
    ? 'Расшифровка…'
    : isRecording
      ? 'Остановить запись'
      : 'Голосовой ввод'

  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={isTranscribing}
      title={label}
      aria-label={label}
      className={[
        'relative w-8 h-8 rounded-xl flex items-center justify-center shrink-0 transition-all duration-150',
        isTranscribing
          ? 'bg-zinc-800 opacity-40 cursor-not-allowed'
          : isRecording
            ? 'bg-red-600 hover:bg-red-500 active:bg-red-700'
            : 'bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600',
      ].join(' ')}
    >
      {/* Pulse ring — visible only while recording */}
      {isRecording && (
        <span className="absolute inset-0 rounded-xl animate-ping bg-red-500 opacity-40 pointer-events-none" />
      )}

      {isTranscribing ? (
        /* Spinner */
        <svg
          className="w-3.5 h-3.5 text-zinc-400 animate-spin"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            className="opacity-20"
            cx="12" cy="12" r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-80"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
      ) : (
        /* Microphone icon */
        <svg
          className={`w-3.5 h-3.5 ${isRecording ? 'text-white' : 'text-zinc-400'}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {/* Mic body */}
          <rect x="9" y="2" width="6" height="12" rx="3" />
          {/* Mic stand arc */}
          <path d="M19 10a7 7 0 01-14 0" />
          {/* Stem */}
          <line x1="12" y1="19" x2="12" y2="22" />
          {/* Base */}
          <line x1="9"  y1="22" x2="15" y2="22" />
        </svg>
      )}
    </button>
  )
}
