import { useState, useEffect, useRef, useCallback } from 'react'

interface Props {
  open: boolean
  onClose: () => void
  selectedDeviceId: string
  onDeviceChange: (deviceId: string) => void
}

export function MicSettings({ open, onClose, selectedDeviceId, onDeviceChange }: Props) {
  const [devices, setDevices]   = useState<MediaDeviceInfo[]>([])
  const [testing, setTesting]   = useState(false)
  const [level,   setLevel]     = useState(0)
  const [errMsg,  setErrMsg]    = useState<string | null>(null)

  const streamRef   = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const frameRef    = useRef<number>(0)

  // ── Load device list ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return
    navigator.mediaDevices.enumerateDevices()
      .then((all) => setDevices(all.filter((d) => d.kind === 'audioinput')))
      .catch(() => {})
  }, [open])

  // ── Stop test when panel closes ─────────────────────────────────────────────
  const stopTest = useCallback(() => {
    cancelAnimationFrame(frameRef.current)
    frameRef.current = 0
    audioCtxRef.current?.close().catch(() => {})
    audioCtxRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setTesting(false)
    setLevel(0)
  }, [])

  useEffect(() => {
    if (!open) stopTest()
  }, [open, stopTest])

  // ── Start mic test ──────────────────────────────────────────────────────────
  const startTest = async () => {
    setErrMsg(null)
    try {
      const audioConstraints: MediaTrackConstraints = {
        sampleRate:       { ideal: 16000 },
        channelCount:     { ideal: 1 },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl:  true,
      }
      if (selectedDeviceId) {
        audioConstraints.deviceId = { exact: selectedDeviceId }
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: false,
      })
      streamRef.current = stream

      const audioCtx = new AudioContext()
      await audioCtx.resume()
      audioCtxRef.current = audioCtx

      const source   = audioCtx.createMediaStreamSource(stream)
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.5
      source.connect(analyser)

      const dataArray = new Uint8Array(analyser.frequencyBinCount)

      const tick = () => {
        analyser.getByteFrequencyData(dataArray)
        const rms = Math.sqrt(dataArray.reduce((s, v) => s + v * v, 0) / dataArray.length)
        // Scale RMS (0–60 typical range) to 0–100%
        setLevel(Math.min(100, Math.round(rms * 1.8)))
        frameRef.current = requestAnimationFrame(tick)
      }
      frameRef.current = requestAnimationFrame(tick)
      setTesting(true)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setErrMsg(/permission|notallowed/i.test(msg)
        ? 'Нет доступа к микрофону. Разреши использование в настройках системы.'
        : `Ошибка: ${msg}`)
    }
  }

  if (!open) return null

  // Colour of level bar: grey → green → yellow → red
  const barColor =
    level > 80 ? 'bg-red-500' :
    level > 50 ? 'bg-yellow-400' :
    level > 12 ? 'bg-green-500' :
    'bg-zinc-300'

  const statusText =
    !testing          ? 'Нажми «Тест» чтобы проверить микрофон' :
    level > 12        ? '✓ Сигнал есть — микрофон работает' :
    'Говори в микрофон…'

  return (
    <div
      className="fixed inset-0 bg-black/20 backdrop-blur-sm z-50 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl border border-zinc-200 p-6 w-[22rem]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"
              />
            </svg>
            <h2 className="text-sm font-semibold text-zinc-800">Настройки микрофона</h2>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-600 text-lg leading-none"
          >
            ✕
          </button>
        </div>

        {/* Device selector */}
        <div className="mb-4">
          <label className="text-xs font-medium text-zinc-500 mb-1.5 block">
            Устройство ввода
          </label>
          <select
            value={selectedDeviceId}
            onChange={(e) => {
              onDeviceChange(e.target.value)
              if (testing) { stopTest() }
            }}
            className="w-full text-sm bg-white border border-zinc-300 rounded-xl px-3 py-2 text-zinc-700 focus:outline-none focus:border-indigo-400 cursor-pointer"
          >
            <option value="">По умолчанию</option>
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Микрофон (${d.deviceId.slice(0, 8)}…)`}
              </option>
            ))}
          </select>
        </div>

        {/* Level meter */}
        <div className="mb-1">
          <label className="text-xs font-medium text-zinc-500 mb-1.5 block">
            Уровень сигнала
          </label>
          <div className="h-5 bg-zinc-100 rounded-full overflow-hidden border border-zinc-200 relative">
            <div
              className={`h-full rounded-full transition-all duration-75 ${barColor}`}
              style={{ width: `${level}%` }}
            />
            {/* Tick marks */}
            {[25, 50, 75].map((pct) => (
              <div
                key={pct}
                className="absolute top-0 bottom-0 w-px bg-white/60"
                style={{ left: `${pct}%` }}
              />
            ))}
          </div>
          <p className={`text-[11px] mt-1.5 ${level > 12 && testing ? 'text-green-600' : 'text-zinc-400'}`}>
            {statusText}
          </p>
        </div>

        {/* Error */}
        {errMsg && (
          <p className="text-xs text-red-500 mb-3 mt-2">{errMsg}</p>
        )}

        {/* Test button */}
        <button
          onClick={testing ? stopTest : startTest}
          className={`w-full mt-4 text-sm py-2 rounded-xl border font-medium transition-colors ${
            testing
              ? 'border-red-200 bg-red-50 text-red-600 hover:bg-red-100'
              : 'border-indigo-200 bg-indigo-50 text-indigo-600 hover:bg-indigo-100'
          }`}
        >
          {testing ? '■ Стоп' : '▶ Тест микрофона'}
        </button>
      </div>
    </div>
  )
}
