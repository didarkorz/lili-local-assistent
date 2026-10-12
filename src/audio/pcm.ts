export const TARGET_SAMPLE_RATE = 16_000

export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i]
    sum += value * value
  }
  return Math.sqrt(sum / samples.length)
}

export function concatFloat32Chunks(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const merged = new Float32Array(total)
  let offset = 0

  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }

  return merged
}

export function downsampleToRate(
  samples: Float32Array,
  inputRate: number,
  targetRate = TARGET_SAMPLE_RATE,
): Float32Array {
  if (samples.length === 0 || inputRate === targetRate) return samples

  const ratio = inputRate / targetRate
  const outLen = Math.max(1, Math.round(samples.length / ratio))
  const out = new Float32Array(outLen)

  for (let i = 0; i < outLen; i++) {
    const srcPos = i * ratio
    const srcIdx = Math.floor(srcPos)
    const frac = srcPos - srcIdx
    const s0 = samples[Math.min(srcIdx, samples.length - 1)]
    const s1 = samples[Math.min(srcIdx + 1, samples.length - 1)]
    out[i] = s0 + (s1 - s0) * frac
  }

  return out
}

function floatToInt16(value: number): number {
  const clamped = Math.max(-1, Math.min(1, value))
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff)
}

export function encodeWavMono16(
  samples: Float32Array,
  sampleRate = TARGET_SAMPLE_RATE,
): ArrayBuffer {
  const bytesPerSample = 2
  const blockAlign = bytesPerSample
  const byteRate = sampleRate * blockAlign
  const dataSize = samples.length * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(offset, floatToInt16(samples[i]), true)
    offset += 2
  }

  return buffer
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i))
  }
}
