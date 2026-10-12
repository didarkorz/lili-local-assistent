import { useState, useEffect, useRef } from 'react'

interface Reminder {
  id: string
  text: string
  fireAt: number
}

function formatMsLeft(ms: number): string {
  if (ms <= 0) return '0 сек'
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1_000)
  if (h > 0) return `${h}ч ${m}м`
  if (m > 0) return `${m}м ${s}с`
  return `${s} сек`
}

export function TimerBar() {
  const [reminders, setReminders] = useState<Reminder[]>([])
  const [, setTick] = useState(0)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Poll frequently so short timers are visible immediately.
  useEffect(() => {
    const poll = () => {
      window.electronAPI.listReminders().then(({ reminders: list }) => {
        setReminders(list)
      }).catch(() => {})
    }
    poll()
    const id = setInterval(poll, 500)
    return () => clearInterval(id)
  }, [])

  // Tick every second for live countdown
  useEffect(() => {
    if (reminders.length === 0) {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null }
      return
    }
    intervalRef.current = setInterval(() => setTick((t) => t + 1), 1_000)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [reminders.length])

  if (reminders.length === 0) return null

  const now = Date.now()

  return (
    <div className="mx-5 mt-2 flex flex-wrap gap-2 shrink-0">
      {reminders.map((r) => {
        const msLeft = r.fireAt - now
        const pct = Math.max(0, Math.min(100, (msLeft / (r.fireAt - (r.fireAt - msLeft))) * 100))
        void pct // progress bar future enhancement
        return (
          <div
            key={r.id}
            className="flex items-center gap-1.5 px-2.5 py-1 bg-amber-50 border border-amber-200 rounded-lg text-[11px] text-amber-700"
          >
            <span>⏰</span>
            <span className="font-medium max-w-[150px] truncate">{r.text}</span>
            <span className="text-amber-500 tabular-nums">{formatMsLeft(msLeft)}</span>
          </div>
        )
      })}
    </div>
  )
}
