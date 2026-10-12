import type { OllamaLifecycleStatus } from '../types'

interface Props {
  status: OllamaLifecycleStatus
  onReconnect?: () => void
}

const CONFIG: Record<
  OllamaLifecycleStatus,
  { dot: string; text: string; label: string; pulse: boolean }
> = {
  checking: { dot: 'bg-zinc-500', text: 'text-zinc-500', label: 'Checking Qwen...', pulse: true },
  starting: { dot: 'bg-amber-400', text: 'text-amber-400', label: 'Loading Qwen...', pulse: true },
  connected: { dot: 'bg-emerald-400', text: 'text-emerald-400', label: 'Qwen ready', pulse: false },
  failed: { dot: 'bg-red-500', text: 'text-red-400', label: 'Qwen unavailable', pulse: false },
}

export function StatusBadge({ status, onReconnect }: Props) {
  const { dot, text, label, pulse } = CONFIG[status]
  return (
    <div className={`flex items-center gap-1.5 text-xs ${text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot} ${pulse ? 'animate-pulse' : ''}`} />
      {label}
      {status === 'failed' && onReconnect && (
        <button
          onClick={onReconnect}
          className="ml-1 px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
        >
          Retry
        </button>
      )}
    </div>
  )
}
