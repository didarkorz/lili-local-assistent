import { useState, useEffect, useCallback } from 'react'
import type { OllamaLifecycleStatus } from '../types'

export function useOllamaStatus() {
  const [status, setStatus] = useState<OllamaLifecycleStatus>('checking')

  useEffect(() => {
    // Pull current status on mount (handles case where main already resolved)
    window.electronAPI.getStatus().then(setStatus)

    // Listen for push updates from main process
    const unlisten = window.electronAPI.onStatusUpdate(setStatus)
    return unlisten
  }, [])

  const reconnect = useCallback(async () => {
    setStatus('checking')
    const s = await window.electronAPI.reconnect()
    setStatus(s)
  }, [])

  return { status, reconnect }
}
