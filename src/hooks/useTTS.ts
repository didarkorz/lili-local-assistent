import { useCallback, useRef, useState } from 'react'

export type TTSState = 'idle' | 'generatingVoice' | 'speaking'

// ── Sentence extraction ───────────────────────────────────────────────────────
// Splits buffered text into complete sentences ready for synthesis.
// A sentence is considered complete when it ends with . ! ? or \n
// and has at least MIN_CHARS characters (to avoid synthesizing "Hi." alone).

const MIN_CHARS = 20

function extractSentences(buf: string): { sentences: string[]; remaining: string } {
  const sentences: string[] = []
  let pos = 0
  const re = /[.!?…]\s+|\n/g
  let m: RegExpExecArray | null

  while ((m = re.exec(buf)) !== null) {
    const end = m.index + m[0].length
    const seg = buf.slice(pos, end).trim()
    if (seg.length >= MIN_CHARS) {
      sentences.push(seg)
      pos = end
    }
  }

  return { sentences, remaining: buf.slice(pos) }
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useTTS() {
  const [ttsState,   setTtsState]   = useState<TTSState>('idle')
  const [ttsEnabled, setTtsEnabled] = useState(true)
  const [ttsError,   setTtsError]   = useState<string | null>(null)

  // Currently playing audio element
  const audioRef           = useRef<HTMLAudioElement | null>(null)
  const currentAudioUrlRef = useRef<string | null>(null)

  // Streaming pipeline state
  const textBufRef  = useRef('')           // incoming text buffer
  const synthQRef   = useRef<string[]>([]) // text segments pending synthesis
  const audioQRef   = useRef<string[]>([]) // blob URLs pending playback
  const synthingRef = useRef(false)        // synthesis worker running
  const playingRef  = useRef(false)        // playback worker running

  // ── Internal: audio playback worker ─────────────────────────────────────────

  const processAudio = useCallback(() => {
    if (playingRef.current || audioQRef.current.length === 0) return

    const url = audioQRef.current.shift()!
    playingRef.current = true
    setTtsState('speaking')

    const audio = new Audio(url)
    audioRef.current = audio
    currentAudioUrlRef.current = url

    const cleanup = () => {
      URL.revokeObjectURL(url)
      audioRef.current = null
      currentAudioUrlRef.current = null
      playingRef.current = false
    }

    audio.onended = () => {
      cleanup()
      if (audioQRef.current.length > 0) {
        processAudio()
      } else if (!synthingRef.current && synthQRef.current.length === 0) {
        setTtsState('idle')
      }
    }

    audio.onerror = () => {
      cleanup()
      processAudio()
    }

    audio.play().catch(() => {
      cleanup()
      processAudio()
    })
  }, [])

  // ── Internal: synthesis worker ───────────────────────────────────────────────

  const processSynth = useCallback(() => {
    if (synthingRef.current || synthQRef.current.length === 0) return

    const text = synthQRef.current.shift()!
    synthingRef.current = true
    setTtsState('generatingVoice')

    window.electronAPI.speakText(text).then((result) => {
      synthingRef.current = false

      if (result.success && result.audioBase64) {
        const binary = atob(result.audioBase64)
        const bytes  = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
        const blob = new Blob([bytes], { type: 'audio/wav' })
        audioQRef.current.push(URL.createObjectURL(blob))
        processAudio()
      }

      processSynth() // process next segment
    }).catch(() => {
      synthingRef.current = false
      processSynth()
    })
  }, [processAudio])

  // ── Internal: flush text buffer into synth queue ─────────────────────────────

  const flushBuffer = useCallback((force: boolean) => {
    const { sentences, remaining } = extractSentences(textBufRef.current)
    let toSynth = sentences

    if (force && remaining.trim()) {
      toSynth = [...sentences, remaining.trim()]
      textBufRef.current = ''
    } else {
      textBufRef.current = remaining
    }

    if (toSynth.length > 0) {
      synthQRef.current.push(...toSynth)
      processSynth()
    }
  }, [processSynth])

  // ── Public: stop everything and clear all queues ─────────────────────────────

  const stopSpeaking = useCallback(async () => {
    synthQRef.current = []
    for (const url of audioQRef.current) URL.revokeObjectURL(url)
    audioQRef.current  = []
    textBufRef.current = ''
    synthingRef.current = false
    playingRef.current  = false

    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    if (currentAudioUrlRef.current) {
      URL.revokeObjectURL(currentAudioUrlRef.current)
      currentAudioUrlRef.current = null
    }

    setTtsState('idle')
  }, [])

  // ── Public: speak full text at once (for command responses) ─────────────────

  const speak = useCallback(async (text: string) => {
    if (!ttsEnabled || !text.trim()) return
    setTtsError(null)
    await stopSpeaking()

    synthQRef.current = [text]
    processSynth()
  }, [ttsEnabled, stopSpeaking, processSynth])

  // ── Public: streaming TTS — feed chunk by chunk ──────────────────────────────

  const addStreamChunk = useCallback((chunk: string) => {
    if (!ttsEnabled || !chunk) return
    textBufRef.current += chunk
    flushBuffer(false)
  }, [ttsEnabled, flushBuffer])

  // Call this when streaming is fully done to flush remaining buffer
  const flushStream = useCallback(() => {
    if (!ttsEnabled) return
    flushBuffer(true)
  }, [ttsEnabled, flushBuffer])

  return {
    ttsEnabled,
    setTtsEnabled,
    ttsState,
    ttsError,
    speak,
    stopSpeaking,
    addStreamChunk,
    flushStream,
  }
}
