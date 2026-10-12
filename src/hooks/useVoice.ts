import { useState, useCallback, useEffect, useRef } from 'react'
import type { DictationMode, VoicePerf } from '../types'

export type VoiceState = 'idle' | 'recording' | 'transcribing'

interface UseVoiceOptions {
  deviceId?: string
  dictationMode: DictationMode
  onSubmit: (text: string) => void | Promise<void>
  onInsert: (text: string) => void | Promise<void>
}

const TARGET_SAMPLE_RATE = 16_000
const MIN_BLOB_BYTES = 4_000
const MIN_SPEECH_MS = 250
const MIN_RECORDING_MS = 1_200
const SILENCE_MS = 950
const MAX_RECORDING_MS = 12_000
const RMS_THRESHOLD = 0.012
const ENABLE_PCM_CAPTURE = false
const NO_SPEECH_AUTO_SEND_MS = 2_000

function rms(samples: Float32Array): number {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / Math.max(1, samples.length))
}

function flattenChunks(chunks: Float32Array[]): Float32Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const out = new Float32Array(length)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function toPcm16(samples: Float32Array, inputRate: number): Int16Array {
  const ratio = inputRate / TARGET_SAMPLE_RATE
  const outputLength = Math.max(1, Math.floor(samples.length / ratio))
  const out = new Int16Array(outputLength)

  for (let i = 0; i < outputLength; i++) {
    const sourceIndex = i * ratio
    const left = Math.floor(sourceIndex)
    const right = Math.min(left + 1, samples.length - 1)
    const mix = sourceIndex - left
    const sample = samples[left] * (1 - mix) + samples[right] * mix
    out[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)))
  }

  return out
}

function encodeWav(samples: Int16Array): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)

  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
  }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, TARGET_SAMPLE_RATE, true)
  view.setUint32(28, TARGET_SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, samples.length * 2, true)

  let offset = 44
  for (let i = 0; i < samples.length; i++, offset += 2) {
    view.setInt16(offset, samples[i], true)
  }

  return buffer
}

function chunksToWav(chunks: Float32Array[], sampleRate: number): ArrayBuffer {
  return encodeWav(toPcm16(flattenChunks(chunks), sampleRate))
}

function getPreferredMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm']
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? ''
}

function extensionForMimeType(mimeType: string): string {
  return mimeType.includes('webm') ? 'webm' : 'wav'
}

export function useVoice({
  deviceId,
  dictationMode: initialDictationMode,
  onSubmit,
  onInsert,
}: UseVoiceOptions) {
  const [voiceState, setVoiceStateValue] = useState<VoiceState>('idle')
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [voicePerf, setVoicePerf] = useState<VoicePerf | null>(null)
  const [voiceLevel, setVoiceLevel] = useState(0)
  const [lastTranscript, setLastTranscript] = useState('')
  const [dictationMode, setDictationMode] = useState<DictationMode>(initialDictationMode)

  const voiceStateRef = useRef<VoiceState>('idle')
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const mimeTypeRef = useRef('')
  const audioCtxRef = useRef<AudioContext | null>(null)
  const vadAudioCtxRef = useRef<AudioContext | null>(null)
  const vadSourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const vadFrameRef = useRef<number | null>(null)
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null)
  const pcmChunksRef = useRef<Float32Array[]>([])
  const pcmSampleRateRef = useRef(TARGET_SAMPLE_RATE)
  const captureStartedAtRef = useRef(0)
  const speechStartedAtRef = useRef(0)
  const lastSpeechAtRef = useRef(0)
  const lastVoiceLevelAtRef = useRef(0)
  const stopRecordingRef = useRef<() => Promise<void>>(async () => {})
  const stoppingRef = useRef(false)

  useEffect(() => {
    setDictationMode(initialDictationMode)
  }, [initialDictationMode])

  const setVoiceState = useCallback((next: VoiceState) => {
    voiceStateRef.current = next
    setVoiceStateValue(next)
  }, [])

  const stopVadWatch = useCallback(() => {
    if (vadFrameRef.current !== null) {
      cancelAnimationFrame(vadFrameRef.current)
      vadFrameRef.current = null
    }
    vadSourceNodeRef.current?.disconnect()
    vadSourceNodeRef.current = null
    vadAudioCtxRef.current?.close().catch(() => {})
    vadAudioCtxRef.current = null
  }, [])

  const cleanup = useCallback(() => {
    stopVadWatch()

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
    chunksRef.current = []
    mimeTypeRef.current = ''
    pcmChunksRef.current = []
    setVoiceLevel(0)
    sourceNodeRef.current?.disconnect()
    processorNodeRef.current?.disconnect()
    sourceNodeRef.current = null
    processorNodeRef.current = null
    audioCtxRef.current?.close().catch(() => {})
    audioCtxRef.current = null
  }, [stopVadWatch])

  const startVadWatch = useCallback((stream: MediaStream) => {
    const AudioContextCtor =
      window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext

    if (!AudioContextCtor) return

    try {
      stopVadWatch()

      const audioCtx = new AudioContextCtor()
      const source = audioCtx.createMediaStreamSource(stream)
      const analyser = audioCtx.createAnalyser()
      const samples = new Float32Array(analyser.fftSize)

      analyser.fftSize = 2048
      analyser.smoothingTimeConstant = 0.1
      source.connect(analyser)

      vadAudioCtxRef.current = audioCtx
      vadSourceNodeRef.current = source
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {})
      }

      const tick = () => {
        if (voiceStateRef.current !== 'recording' || stoppingRef.current) return

        analyser.getFloatTimeDomainData(samples)
        const now = performance.now()
        const level = rms(samples)
        if (now - lastVoiceLevelAtRef.current >= 120) {
          lastVoiceLevelAtRef.current = now
          setVoiceLevel(Math.max(0, Math.min(1, level / 0.08)))
        }

        if (level >= RMS_THRESHOLD) {
          if (!speechStartedAtRef.current) speechStartedAtRef.current = now
          lastSpeechAtRef.current = now
        }

        const elapsed = now - captureStartedAtRef.current
        const hasSpeech = speechStartedAtRef.current > 0 && now - speechStartedAtRef.current >= MIN_SPEECH_MS
        const noSpeechYet = !speechStartedAtRef.current && elapsed >= NO_SPEECH_AUTO_SEND_MS
        const endedSpeaking = hasSpeech && lastSpeechAtRef.current > 0 && now - lastSpeechAtRef.current >= NO_SPEECH_AUTO_SEND_MS
        const tooLong = elapsed >= MAX_RECORDING_MS

        if (noSpeechYet || endedSpeaking || tooLong) {
          void stopRecordingRef.current()
          return
        }

        vadFrameRef.current = requestAnimationFrame(tick)
      }

      vadFrameRef.current = requestAnimationFrame(tick)
    } catch (err) {
      console.warn('[voice] VAD watch failed; manual stop still works:', err)
      stopVadWatch()
    }
  }, [stopVadWatch])

  const startRecording = useCallback(async () => {
    if (voiceStateRef.current !== 'idle') return

    if (!navigator.mediaDevices?.getUserMedia) {
      setVoiceError('Запись голоса недоступна в текущем окружении Electron.')
      return
    }

    setVoiceError(null)
    setVoicePerf(null)
    setVoiceLevel(0)

    try {
      const constraints: MediaTrackConstraints = {
        sampleRate: { ideal: TARGET_SAMPLE_RATE },
        channelCount: { ideal: 1 },
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: true,
      }

      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId ? { ...constraints, deviceId: { exact: deviceId } } : constraints,
          video: false,
        })
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: constraints,
          video: false,
        })
      }

      chunksRef.current = []
      pcmChunksRef.current = []
      speechStartedAtRef.current = 0
      lastSpeechAtRef.current = 0
      stoppingRef.current = false
      stopVadWatch()
      captureStartedAtRef.current = performance.now()
      streamRef.current = stream

      const AudioContextCtor =
        window.AudioContext ||
        (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (ENABLE_PCM_CAPTURE && AudioContextCtor) {
        try {
          const audioCtx = new AudioContextCtor()
          const source = audioCtx.createMediaStreamSource(stream)
          const processor = audioCtx.createScriptProcessor(2048, 1, 1)

          pcmSampleRateRef.current = audioCtx.sampleRate
          audioCtxRef.current = audioCtx
          sourceNodeRef.current = source
          processorNodeRef.current = processor

          processor.onaudioprocess = (event) => {
            const input = event.inputBuffer.getChannelData(0)
            const copy = new Float32Array(input.length)
            copy.set(input)
            pcmChunksRef.current.push(copy)

            const now = performance.now()
            const level = rms(copy)
            if (level >= RMS_THRESHOLD) {
              if (!speechStartedAtRef.current) speechStartedAtRef.current = now
              lastSpeechAtRef.current = now
            }

            const hasSpeech = speechStartedAtRef.current > 0 && now - speechStartedAtRef.current >= MIN_SPEECH_MS
            const hasSilence = lastSpeechAtRef.current > 0 && now - lastSpeechAtRef.current >= SILENCE_MS
            const canAutoStop = now - captureStartedAtRef.current >= MIN_RECORDING_MS
            const tooLong = now - captureStartedAtRef.current >= MAX_RECORDING_MS

            if ((canAutoStop && hasSpeech && hasSilence) || tooLong) {
              void stopRecordingRef.current()
            }
          }

          source.connect(processor)
          processor.connect(audioCtx.destination)
          if (audioCtx.state === 'suspended') {
            await audioCtx.resume().catch(() => {})
          }
          setVoiceState('recording')
          return
        } catch (err) {
          console.warn('[voice] WebAudio capture failed, falling back to MediaRecorder:', err)
          sourceNodeRef.current?.disconnect()
          processorNodeRef.current?.disconnect()
          sourceNodeRef.current = null
          processorNodeRef.current = null
          audioCtxRef.current?.close().catch(() => {})
          audioCtxRef.current = null
          pcmChunksRef.current = []
        }
      }

      if (typeof MediaRecorder === 'undefined') {
        throw new Error('MediaRecorder и WebAudio недоступны.')
      }

      const mimeType = getPreferredMimeType()
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream)

      mimeTypeRef.current = mimeType || recorder.mimeType || 'audio/webm'

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunksRef.current.push(event.data)
      }

      recorder.onerror = (event) => {
        console.warn('[voice] recorder error:', event)
        stopVadWatch()
        setVoiceError('Ошибка записи микрофона. Попробуй другой микрофон или перезапуск приложения.')
        setVoiceState('idle')
        cleanup()
      }

      streamRef.current = stream
      recorderRef.current = recorder
      recorder.start(250)
      setVoiceState('recording')
      startVadWatch(stream)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setVoiceError(
        /permission|notallowed/i.test(msg)
          ? 'Нет доступа к микрофону. Разреши использование и попробуй снова.'
          : `Ошибка микрофона: ${msg}`
      )
      cleanup()
    }
  }, [deviceId, cleanup, setVoiceState, startVadWatch, stopVadWatch])

  const stopRecording = useCallback(async () => {
    if (voiceStateRef.current !== 'recording') return
    if (stoppingRef.current) return
    stoppingRef.current = true
    stopVadWatch()

    const totalStartedAt = captureStartedAtRef.current || performance.now()
    const captureMs = Math.round(performance.now() - totalStartedAt)
    const recorder = recorderRef.current
    const isPcmRecording = audioCtxRef.current !== null

    if (!recorder && !isPcmRecording) {
      setVoiceState('idle')
      setVoiceError('Не удалось завершить запись: recorder не найден.')
      cleanup()
      return
    }

    setVoiceState('transcribing')

    try {
      const finalizeStartedAt = performance.now()
      let audioBuffer: ArrayBuffer
      let mimeType = 'audio/wav'
      let extension = 'wav'

      if (isPcmRecording) {
        processorNodeRef.current?.disconnect()
        sourceNodeRef.current?.disconnect()
        processorNodeRef.current = null
        sourceNodeRef.current = null
        await audioCtxRef.current?.close().catch(() => {})
        audioCtxRef.current = null
        streamRef.current?.getTracks().forEach((track) => track.stop())
        streamRef.current = null

        const pcmChunks = pcmChunksRef.current.slice()
        pcmChunksRef.current = []

        audioBuffer = chunksToWav(pcmChunks, pcmSampleRateRef.current)
      } else {
        await new Promise<void>((resolve, reject) => {
          recorder!.onstop = () => resolve()
          recorder!.onerror = (event) => reject(new Error(String(event)))
          try {
            recorder!.stop()
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)))
          }
        })

        streamRef.current?.getTracks().forEach((track) => track.stop())
        streamRef.current = null
        recorderRef.current = null

        const blob = new Blob(chunksRef.current, { type: mimeTypeRef.current || 'audio/webm' })
        chunksRef.current = []

        audioBuffer = await blob.arrayBuffer()
        mimeType = blob.type || mimeTypeRef.current || 'audio/webm'
        extension = extensionForMimeType(mimeType)
      }

      const finalizeMs = Math.round(performance.now() - finalizeStartedAt)

      if (audioBuffer.byteLength < MIN_BLOB_BYTES) {
        setVoiceError('Аудио не записалось. Попробуй говорить чуть дольше и ближе к микрофону.')
        return
      }

      const transcribeStartedAt = performance.now()
      const result = await window.electronAPI.transcribeAudio({
        audioBuffer,
        mimeType,
        extension,
      })
      const transcribeMs = Math.round(performance.now() - transcribeStartedAt)

      const audioDurationSec = result.meta?.durationSec ?? captureMs / 1000

      if (!result.success || !result.text) {
        setVoiceError(result.error ?? 'Расшифровка не удалась.')
        setVoicePerf({
          captureMs,
          finalizeMs,
          transcribeMs,
          sendMs: 0,
          totalMs: Math.round(performance.now() - totalStartedAt),
          sttEngine: result.meta?.engine,
          sttModelTier: result.meta?.modelTier,
          audioDurationSec,
          sttInferMs: result.meta?.inferMs,
        })
        return
      }

      setLastTranscript(result.text)
      const sendStartedAt = performance.now()
      if (dictationMode === 'insert') {
        await onInsert(result.text)
      } else {
        await onSubmit(result.text)
      }
      const sendMs = Math.round(performance.now() - sendStartedAt)

      setVoiceError(null)
      setVoicePerf({
        captureMs,
        finalizeMs,
        transcribeMs,
        sendMs,
        totalMs: Math.round(performance.now() - totalStartedAt),
        sttEngine: result.meta?.engine,
        sttModelTier: result.meta?.modelTier,
        audioDurationSec,
        sttInferMs: result.meta?.inferMs,
      })
    } catch (err) {
      setVoiceError(err instanceof Error ? err.message : String(err))
    } finally {
      mimeTypeRef.current = ''
      stoppingRef.current = false
      setVoiceLevel(0)
      setVoiceState('idle')
    }
  }, [cleanup, dictationMode, onInsert, onSubmit, setVoiceState, stopVadWatch])

  useEffect(() => {
    stopRecordingRef.current = stopRecording
  }, [stopRecording])

  const toggleRecording = useCallback(async () => {
    if (voiceStateRef.current === 'idle') {
      await startRecording()
    } else if (voiceStateRef.current === 'recording') {
      await stopRecording()
    }
  }, [startRecording, stopRecording])

  return {
    voiceState,
    voiceError,
    voicePerf,
    voiceLevel,
    lastTranscript,
    toggleRecording,
    setDictationMode,
  }
}
