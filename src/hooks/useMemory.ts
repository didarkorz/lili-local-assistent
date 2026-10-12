/**
 * useMemory — React hook for the 3-layer memory system.
 *
 * Manages client-side state for:
 *   - Layer 3: long-term facts (CRUD + pin toggle + edit)
 *   - Layer 2: rolling conversation summary (read + force-rebuild)
 *   - AI-assisted fact extraction
 */

import { useState, useEffect, useCallback } from 'react'
import type { MemoryFact, ConversationSummary } from '../types'

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2)
}

export function useMemory(isActive = true) {
  const [facts,   setFacts]   = useState<MemoryFact[]>([])
  const [summary, setSummary] = useState<ConversationSummary | null>(null)

  const [isRebuildingSummary, setIsRebuildingSummary] = useState(false)
  const [isExtractingFacts,   setIsExtractingFacts]   = useState(false)

  useEffect(() => {
    window.electronAPI.loadFacts().then(setFacts)
    window.electronAPI.loadSummary().then(setSummary)
  }, [])

  // Poll for background summary updates every 12 s — only when active
  useEffect(() => {
    if (!isActive) return
    const id = setInterval(async () => {
      const s = await window.electronAPI.loadSummary()
      setSummary(s)
    }, 12_000)
    return () => clearInterval(id)
  }, [isActive])

  // ── Facts CRUD ──────────────────────────────────────────────────────────────

  const addFact = useCallback(
    async (
      content: string,
      pinned = false,
      category?: MemoryFact['category'],
      projectTag?: string
    ) => {
      const fact: MemoryFact = {
        id: uid(),
        content,
        pinned,
        createdAt: Date.now(),
        ...(category   ? { category }   : {}),
        ...(projectTag ? { projectTag } : {}),
      }
      await window.electronAPI.saveFact(fact)
      setFacts((prev) => [...prev, fact])
    },
    []
  )

  const updateFact = useCallback(async (fact: MemoryFact) => {
    const updated = { ...fact, updatedAt: Date.now() }
    await window.electronAPI.saveFact(updated)
    setFacts((prev) => prev.map((f) => (f.id === fact.id ? updated : f)))
  }, [])

  const togglePin = useCallback(async (id: string) => {
    let toggled: MemoryFact | undefined
    setFacts((prev) => {
      const next = prev.map((f) =>
        f.id === id ? ((toggled = { ...f, pinned: !f.pinned, updatedAt: Date.now() }), toggled) : f
      )
      return next
    })
    if (toggled) await window.electronAPI.saveFact(toggled)
  }, [])

  const deleteFact = useCallback(async (id: string) => {
    await window.electronAPI.deleteFact(id)
    setFacts((prev) => prev.filter((f) => f.id !== id))
  }, [])

  // ── Summary ─────────────────────────────────────────────────────────────────

  const refreshSummary = useCallback(async () => {
    const s = await window.electronAPI.loadSummary()
    setSummary(s)
  }, [])

  const rebuildSummary = useCallback(async (model: string) => {
    setIsRebuildingSummary(true)
    try {
      await window.electronAPI.regenerateSummary(model)
      const s = await window.electronAPI.loadSummary()
      setSummary(s)
    } finally {
      setIsRebuildingSummary(false)
    }
  }, [])

  // ── AI extraction ────────────────────────────────────────────────────────────

  const extractFacts = useCallback(async (model: string): Promise<string[]> => {
    setIsExtractingFacts(true)
    try {
      return await window.electronAPI.extractFacts(model)
    } finally {
      setIsExtractingFacts(false)
    }
  }, [])

  return {
    facts,
    summary,
    isRebuildingSummary,
    isExtractingFacts,
    addFact,
    updateFact,
    togglePin,
    deleteFact,
    refreshSummary,
    rebuildSummary,
    extractFacts,
  }
}
