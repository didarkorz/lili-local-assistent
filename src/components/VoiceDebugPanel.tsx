import type { ChatDebugInfo } from '../hooks/useChat'
import type { VoicePerf } from '../types'
import type { VoiceState } from '../hooks/useVoice'

interface Props {
  open: boolean
  voiceState: VoiceState
  voiceError: string | null
  voicePerf: VoicePerf | null
  voiceLevel: number
  lastTranscript: string
  chatDebug: ChatDebugInfo | null
  onClose: () => void
}

function fmtMs(value: number | undefined): string {
  return typeof value === 'number' ? `${Math.round(value)} ms` : '-'
}

function fmtSec(value: number | undefined): string {
  return typeof value === 'number' ? `${value.toFixed(1)} s` : '-'
}

function timeLabel(ts: number | undefined): string {
  return ts ? new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-'
}

export function VoiceDebugPanel({
  open,
  voiceState,
  voiceError,
  voicePerf,
  voiceLevel,
  lastTranscript,
  chatDebug,
  onClose,
}: Props) {
  if (!open) return null

  const levelPct = Math.round(Math.max(0, Math.min(1, voiceLevel)) * 100)

  return (
    <div className="fixed right-5 bottom-28 z-30 w-[360px] max-w-[calc(100vw-2.5rem)] rounded-lg border border-zinc-200 bg-white/95 shadow-xl backdrop-blur-sm">
      <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-2">
        <div>
          <div className="text-xs font-semibold text-zinc-800">Voice Debug</div>
          <div className="text-[11px] text-zinc-400">live STT / intent trace</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
          title="Hide debug panel"
        >
          Hide
        </button>
      </div>

      <div className="space-y-3 px-3 py-3 text-xs">
        <div>
          <div className="mb-1 flex items-center justify-between text-[11px] text-zinc-500">
            <span>Mic</span>
            <span>{voiceState} / {levelPct}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded bg-zinc-100">
            <div
              className={`h-full transition-all ${voiceState === 'recording' ? 'bg-emerald-500' : 'bg-zinc-300'}`}
              style={{ width: `${levelPct}%` }}
            />
          </div>
        </div>

        <div>
          <div className="mb-1 text-[11px] text-zinc-500">Whisper heard</div>
          <div className="min-h-9 rounded-md border border-zinc-100 bg-zinc-50 px-2 py-1.5 text-zinc-800">
            {lastTranscript || <span className="text-zinc-400">No transcript yet</span>}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-md border border-zinc-100 px-2 py-1.5">
            <div className="text-[10px] uppercase text-zinc-400">STT total</div>
            <div className="font-medium text-zinc-800">{fmtMs(voicePerf?.transcribeMs)}</div>
          </div>
          <div className="rounded-md border border-zinc-100 px-2 py-1.5">
            <div className="text-[10px] uppercase text-zinc-400">Infer</div>
            <div className="font-medium text-zinc-800">{fmtMs(voicePerf?.sttInferMs)}</div>
          </div>
          <div className="rounded-md border border-zinc-100 px-2 py-1.5">
            <div className="text-[10px] uppercase text-zinc-400">Engine</div>
            <div className="font-medium text-zinc-800">{voicePerf?.sttEngine ?? '-'}</div>
          </div>
          <div className="rounded-md border border-zinc-100 px-2 py-1.5">
            <div className="text-[10px] uppercase text-zinc-400">Model</div>
            <div className="font-medium text-zinc-800">{voicePerf?.sttModelTier ?? '-'}</div>
          </div>
          <div className="rounded-md border border-zinc-100 px-2 py-1.5">
            <div className="text-[10px] uppercase text-zinc-400">Audio</div>
            <div className="font-medium text-zinc-800">{fmtSec(voicePerf?.audioDurationSec)}</div>
          </div>
          <div className="rounded-md border border-zinc-100 px-2 py-1.5">
            <div className="text-[10px] uppercase text-zinc-400">Route time</div>
            <div className="font-medium text-zinc-800">{timeLabel(chatDebug?.at)}</div>
          </div>
        </div>

        <div className="rounded-md border border-zinc-100 px-2 py-1.5">
          <div className="mb-1 flex items-center justify-between text-[10px] uppercase text-zinc-400">
            <span>Intent</span>
            <span>{chatDebug?.route ?? '-'}</span>
          </div>
          <div className="font-mono text-[11px] text-zinc-800">{chatDebug?.intent ?? '-'}</div>
          {chatDebug?.input && (
            <div className="mt-1 truncate text-[11px] text-zinc-500" title={chatDebug.input}>
              input: {chatDebug.input}
            </div>
          )}
        </div>

        {voiceError && (
          <div className="rounded-md border border-red-100 bg-red-50 px-2 py-1.5 text-[11px] text-red-600">
            {voiceError}
          </div>
        )}
      </div>
    </div>
  )
}
