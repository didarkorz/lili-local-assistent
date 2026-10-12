import { useCallback, useEffect, useRef } from 'react'

const CHUNK_MS = 2600
const RETRIGGER_COOLDOWN_MS = 1200
const MIN_BLOB_BYTES = 12_000

const WAKE_RE = /(Р В»Р С‘Р В»[Р С‘РЎРЏРЎРЉ]|lily|lil[iy]|lilly|Р В»Р С‘\s+Р В»Р С‘)[,.\s!?РІР‚вЂќ]*/i
const HOTWORD_RE = /^(Р С•РЎвЂљР С”РЎР‚Р С•Р в„–|Р С•РЎвЂљР С”РЎР‚РЎвЂ№РЎвЂљРЎРЉ|Р В·Р В°Р С—РЎС“РЎРѓРЎвЂљР С‘|Р В·Р В°Р С—РЎС“РЎРѓРЎвЂљР С‘РЎвЂљРЎРЉ|Р В·Р В°Р С”РЎР‚Р С•Р в„–|Р В·Р В°Р С”РЎР‚РЎвЂ№РЎвЂљРЎРЉ|Р Р…Р В°Р С—Р С‘РЎв‚¬Р С‘|Р Р…Р В°Р С—Р С‘РЎРѓР В°РЎвЂљРЎРЉ|Р С•РЎвЂљР С—РЎР‚Р В°Р Р†РЎРЉ|Р С•РЎвЂљР С—РЎР‚Р В°Р Р†Р С‘РЎвЂљРЎРЉ|Р С—Р С•РЎРѓРЎвЂљР В°Р Р†РЎРЉ|Р С—Р С•РЎРѓРЎвЂљР В°Р Р†Р С‘РЎвЂљРЎРЉ|РЎРѓР Т‘Р ВµР В»Р В°Р в„–|РЎРѓР Т‘Р ВµР В»Р В°РЎвЂљРЎРЉ|Р Р…Р В°Р в„–Р Т‘Р С‘|Р Р…Р В°Р в„–РЎвЂљР С‘|Р Р†Р С”Р В»РЎР‹РЎвЂЎР С‘|Р Р†Р С”Р В»РЎР‹РЎвЂЎР С‘РЎвЂљРЎРЉ|Р Р†РЎвЂ№Р С”Р В»РЎР‹РЎвЂЎР С‘|Р Р†РЎвЂ№Р С”Р В»РЎР‹РЎвЂЎР С‘РЎвЂљРЎРЉ|Р С—Р ВµРЎР‚Р ВµР С”Р В»РЎР‹РЎвЂЎР С‘|Р С—Р ВµРЎР‚Р ВµР С”Р В»РЎР‹РЎвЂЎР С‘РЎвЂљРЎРЉ|РЎРѓР Р†Р ВµРЎР‚Р Р…Р С‘|РЎРѓР Р†Р ВµРЎР‚Р Р…РЎС“РЎвЂљРЎРЉ|РЎР‚Р В°Р В·Р Р†Р ВµРЎР‚Р Р…Р С‘|РЎР‚Р В°Р В·Р Р†Р ВµРЎР‚Р Р…РЎС“РЎвЂљРЎРЉ|Р С—Р С•Р С”Р В°Р В¶Р С‘|Р С—Р С•Р С”Р В°Р В·Р В°РЎвЂљРЎРЉ|РЎРѓР С”РЎР‚Р С‘Р Р…РЎв‚¬Р С•РЎвЂљ|РЎвЂљР В°Р в„–Р СР ВµРЎР‚|Р Р…Р В°Р С—Р С•Р СР Р…Р С‘|Р Р…Р В°Р С—Р С•Р СР Р…Р С‘РЎвЂљРЎРЉ|Р С—Р С•Р С–Р С•Р Т‘Р В°|Р С–РЎР‚Р С•Р СРЎвЂЎР Вµ|РЎвЂљР С‘РЎв‚¬Р Вµ)/i

function stripWakeWord(text: string): string {
  const match = WAKE_RE.exec(text)
  if (!match) return text.trim()
  return text.slice(match.index + match[0].length).trim()
}

function getPreferredMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm']
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? ''
}

function extensionForMimeType(mimeType: string): string {
  return mimeType.includes('webm') ? 'webm' : 'wav'
}

export function useWakeWord(
  onActivated: (command: string) => void,
  enabled: boolean,
  voiceIdle: boolean,
  deviceId?: string,
) {
  const onActivatedRef = useRef(onActivated)
  const activeRef = useRef(false)
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const transcribingRef = useRef(false)
  const cooldownUntilRef = useRef(0)
  const mimeTypeRef = useRef('')

  useEffect(() => {
    onActivatedRef.current = onActivated
  }, [onActivated])

  const stopBackground = useCallback(() => {
    if (!activeRef.current) return
    activeRef.current = false

    const recorder = recorderRef.current
    recorderRef.current = null
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop()
      } catch {
        // ignore
      }
    }

    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null

    transcribingRef.current = false
    cooldownUntilRef.current = 0
    mimeTypeRef.current = ''
  }, [])

  const transcribeChunk = useCallback(async (blob: Blob) => {
    if (!activeRef.current) return
    if (blob.size < MIN_BLOB_BYTES) return
    if (transcribingRef.current) return
    if (performance.now() < cooldownUntilRef.current) return

    transcribingRef.current = true
    try {
      const mimeType = blob.type || mimeTypeRef.current || 'audio/webm'
      const audioBuffer = await blob.arrayBuffer()
      const result = await window.electronAPI.transcribeAudio({
        audioBuffer,
        mimeType,
        extension: extensionForMimeType(mimeType),
      })

      if (!result.success || !result.text || !activeRef.current) return

      const text = result.text.trim()
      if (WAKE_RE.test(text)) {
        onActivatedRef.current(stripWakeWord(text))
        cooldownUntilRef.current = performance.now() + RETRIGGER_COOLDOWN_MS
      } else if (HOTWORD_RE.test(text)) {
        onActivatedRef.current(text)
        cooldownUntilRef.current = performance.now() + RETRIGGER_COOLDOWN_MS
      }
    } catch (err) {
      console.warn('[wake] transcription error:', err)
    } finally {
      transcribingRef.current = false
    }
  }, [])

  const startBackground = useCallback(async () => {
    if (activeRef.current) return

    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      console.warn('[wake] MediaRecorder/getUserMedia not available, wake word disabled')
      return
    }

    activeRef.current = true

    try {
      const constraints: MediaTrackConstraints = {
        channelCount: { ideal: 1 },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      }

      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId ? { ...constraints, deviceId: { exact: deviceId } } : constraints,
          video: false,
        })
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false })
      }

      if (!activeRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }

      const mimeType = getPreferredMimeType()
      mimeTypeRef.current = mimeType
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream)

      recorder.ondataavailable = (event) => {
        if (!activeRef.current || !event.data || event.data.size === 0) return
        void transcribeChunk(event.data)
      }

      recorder.onerror = (event) => {
        console.warn('[wake] recorder error:', event)
        stopBackground()
      }

      recorderRef.current = recorder
      streamRef.current = stream
      cooldownUntilRef.current = performance.now() + RETRIGGER_COOLDOWN_MS
      recorder.start(CHUNK_MS)
    } catch (err) {
      console.warn('[wake] startup failed:', err)
      activeRef.current = false
      stopBackground()
    }
  }, [deviceId, stopBackground, transcribeChunk])

  useEffect(() => {
    if (enabled && voiceIdle) {
      void startBackground()
    } else {
      stopBackground()
    }

    return () => stopBackground()
  }, [enabled, voiceIdle, deviceId, startBackground, stopBackground])
}
