/**
 * MemoryPanel — side drawer for memory and notes management.
 *
 * Tabs:
 *   Memory — long-term facts (view / add / edit / pin / delete) + summary
 *   Notes  — workspace notes (list / read / delete / save chat as note)
 *
 * Top of panel: active context selector (affects memory retrieval ranking).
 */

import { useState, useEffect, useMemo, useCallback, memo } from 'react'
import { useMemory } from '../hooks/useMemory'
import type { MemoryFact, Note, Message } from '../types'
import { CONTEXT_OPTIONS } from '../constants'

interface Props {
  open: boolean
  onClose: () => void
  model: string
  messages: Message[]
  activeContext: string
  onContextChange: (ctx: string) => void
}

type Tab = 'memory' | 'notes'

// ── Category badge ────────────────────────────────────────────────────────────

const CATEGORY_COLORS: Record<string, string> = {
  profile:     'bg-blue-900/50 text-blue-300',
  preference:  'bg-violet-900/50 text-violet-300',
  project:     'bg-amber-900/50 text-amber-300',
  goal:        'bg-emerald-900/50 text-emerald-300',
  instruction: 'bg-rose-900/50 text-rose-300',
}

function CategoryBadge({ category }: { category?: MemoryFact['category'] }) {
  if (!category) return null
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded-md ${CATEGORY_COLORS[category] ?? 'bg-zinc-800 text-zinc-400'}`}>
      {category}
    </span>
  )
}

function TagBadge({ tag }: { tag?: string }) {
  if (!tag) return null
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-indigo-900/50 text-indigo-300">
      {tag}
    </span>
  )
}

// ── Fact row ──────────────────────────────────────────────────────────────────

const FactRow = memo(function FactRow({
  fact,
  onPin,
  onDelete,
  onUpdate,
}: {
  fact: MemoryFact
  onPin: (id: string) => void
  onDelete: (id: string) => void
  onUpdate: (fact: MemoryFact) => void
}) {
  const [editing, setEditing]   = useState(false)
  const [editText, setEditText] = useState(fact.content)
  const [editTag,  setEditTag]  = useState(fact.projectTag ?? '')
  const [editCat,  setEditCat]  = useState<MemoryFact['category'] | ''>(fact.category ?? '')

  const saveEdit = () => {
    const trimmed = editText.trim()
    if (!trimmed) return
    onUpdate({
      ...fact,
      content:    trimmed,
      projectTag: editTag.trim() || undefined,
      category:   (editCat || undefined) as MemoryFact['category'],
    })
    setEditing(false)
  }

  const cancelEdit = () => {
    setEditText(fact.content)
    setEditTag(fact.projectTag ?? '')
    setEditCat(fact.category ?? '')
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="py-2 px-2 bg-zinc-800/80 rounded-lg border border-zinc-700/60 space-y-1.5">
        <textarea
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          rows={3}
          className="w-full text-xs bg-zinc-900 border border-zinc-700 text-zinc-200 rounded-lg px-2.5 py-1.5 resize-none focus:outline-none focus:border-indigo-500/60"
          autoFocus
        />
        <div className="flex gap-1.5">
          <input
            value={editTag}
            onChange={(e) => setEditTag(e.target.value)}
            placeholder="Tag (e.g. ToD)"
            className="flex-1 text-xs bg-zinc-900 border border-zinc-700 text-zinc-300 placeholder-zinc-600 rounded-lg px-2 py-1 focus:outline-none focus:border-indigo-500/60"
          />
          <select
            value={editCat}
            onChange={(e) => setEditCat(e.target.value as MemoryFact['category'] | '')}
            className="flex-1 text-xs bg-zinc-900 border border-zinc-700 text-zinc-300 rounded-lg px-2 py-1 focus:outline-none"
          >
            <option value="">category…</option>
            <option value="profile">profile</option>
            <option value="preference">preference</option>
            <option value="project">project</option>
            <option value="goal">goal</option>
            <option value="instruction">instruction</option>
          </select>
        </div>
        <div className="flex gap-1.5 justify-end">
          <button
            onClick={cancelEdit}
            className="text-xs px-2.5 py-1 rounded-lg border border-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={saveEdit}
            disabled={!editText.trim()}
            className="text-xs px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-30 text-white transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-start gap-2 group py-1.5 px-2 rounded-lg hover:bg-zinc-800/60 transition-colors">
      {/* Pin toggle */}
      <button
        onClick={() => onPin(fact.id)}
        title={fact.pinned ? 'Unpin' : 'Pin'}
        className={`mt-0.5 shrink-0 transition-colors ${
          fact.pinned ? 'text-amber-400 hover:text-amber-300' : 'text-zinc-600 hover:text-zinc-400'
        }`}
      >
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
          <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
        </svg>
      </button>

      <div className="flex-1 min-w-0 space-y-1">
        <p className="text-xs text-zinc-300 leading-relaxed break-words">{fact.content}</p>
        {(fact.projectTag || fact.category) && (
          <div className="flex gap-1 flex-wrap">
            <TagBadge tag={fact.projectTag} />
            <CategoryBadge category={fact.category} />
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-all mt-0.5">
        {/* Edit */}
        <button
          onClick={() => setEditing(true)}
          title="Edit"
          className="text-zinc-600 hover:text-zinc-300 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round"
              d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
            />
          </svg>
        </button>
        {/* Delete */}
        <button
          onClick={() => onDelete(fact.id)}
          title="Delete"
          className="text-zinc-600 hover:text-red-400 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  )
})

// ── Note row ──────────────────────────────────────────────────────────────────

const NoteRow = memo(function NoteRow({
  note,
  onDelete,
}: {
  note: Note
  onDelete: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="border border-zinc-800 rounded-lg overflow-hidden">
      <div
        className="flex items-center gap-2 px-2.5 py-2 cursor-pointer hover:bg-zinc-800/50 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        {note.isIdea && (
          <svg className="w-3 h-3 text-amber-400 shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path d="M11 3a1 1 0 10-2 0v1a1 1 0 102 0V3zM15.657 5.757a1 1 0 00-1.414-1.414l-.707.707a1 1 0 001.414 1.414l.707-.707zM18 10a1 1 0 01-1 1h-1a1 1 0 110-2h1a1 1 0 011 1zM5.05 6.464A1 1 0 106.464 5.05l-.707-.707a1 1 0 00-1.414 1.414l.707.707zM5 10a1 1 0 01-1 1H3a1 1 0 110-2h1a1 1 0 011 1zM8 16v-1h4v1a2 2 0 11-4 0zM12 14c.015-.34.208-.646.477-.859a4 4 0 10-4.954 0c.27.213.462.519.476.859h4.001z" />
          </svg>
        )}
        <span className="flex-1 text-xs text-zinc-300 truncate font-medium">{note.title}</span>
        <span className="text-[10px] text-zinc-600 shrink-0">
          {new Date(note.createdAt).toLocaleDateString()}
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(note.id) }}
          title="Delete note"
          className="shrink-0 text-zinc-700 hover:text-red-400 transition-colors"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        <svg
          className={`w-3 h-3 text-zinc-600 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </div>

      {expanded && (
        <div className="px-2.5 pb-2.5 pt-0 border-t border-zinc-800">
          <pre className="text-[11px] text-zinc-400 whitespace-pre-wrap break-words font-sans leading-relaxed max-h-48 overflow-y-auto mt-2">
            {note.content}
          </pre>
        </div>
      )}
    </div>
  )
})

// ── Main panel ────────────────────────────────────────────────────────────────

export function MemoryPanel({
  open,
  onClose,
  model,
  messages,
  activeContext,
  onContextChange,
}: Props) {
  const {
    facts,
    summary,
    isRebuildingSummary,
    isExtractingFacts,
    addFact,
    updateFact,
    togglePin,
    deleteFact,
    rebuildSummary,
    extractFacts,
  } = useMemory(open)

  const [tab,              setTab]              = useState<Tab>('memory')
  const [newFactText,      setNewFactText]      = useState('')
  const [newFactTag,       setNewFactTag]       = useState('')
  const [newFactCat,       setNewFactCat]       = useState<MemoryFact['category'] | ''>('')
  const [suggestions,      setSuggestions]      = useState<string[]>([])
  const [summaryExpanded,  setSummaryExpanded]  = useState(false)
  const [notes,            setNotes]            = useState<Note[]>([])
  const [notesLoading,     setNotesLoading]     = useState(false)
  const [savingChat,       setSavingChat]       = useState(false)

  // Load notes when Notes tab is opened
  useEffect(() => {
    if (tab === 'notes' && open) {
      setNotesLoading(true)
      window.electronAPI.listNotes().then((n) => {
        setNotes(n)
        setNotesLoading(false)
      })
    }
  }, [tab, open])

  const handleAddFact = useCallback(async () => {
    const trimmed = newFactText.trim()
    if (!trimmed) return
    await addFact(
      trimmed,
      false,
      (newFactCat || undefined) as MemoryFact['category'],
      newFactTag.trim() || undefined
    )
    setNewFactText('')
    setNewFactTag('')
    setNewFactCat('')
  }, [newFactText, newFactTag, newFactCat, addFact])

  const handleExtract = useCallback(async () => {
    const result = await extractFacts(model)
    const existing = new Set(facts.map((f) => f.content.toLowerCase()))
    setSuggestions(result.filter((s) => !existing.has(s.toLowerCase())))
  }, [extractFacts, model, facts])

  const acceptSuggestion = useCallback(async (text: string) => {
    await addFact(text)
    setSuggestions((prev) => prev.filter((s) => s !== text))
  }, [addFact])

  const handleDeleteNote = useCallback(async (id: string) => {
    await window.electronAPI.deleteNote(id)
    setNotes((prev) => prev.filter((n) => n.id !== id))
  }, [])

  const handleSaveChatAsNote = useCallback(async () => {
    if (messages.length === 0) return
    setSavingChat(true)
    try {
      const note = await window.electronAPI.exportChatHistory(messages)
      setNotes((prev) => [note, ...prev])
    } finally {
      setSavingChat(false)
    }
  }, [messages])

  const sortedFacts = useMemo(
    () =>
      [...facts].sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return a.createdAt - b.createdAt
      }),
    [facts]
  )

  const summaryPreview = summary
    ? summaryExpanded
      ? summary.content
      : summary.content.slice(0, 280) + (summary.content.length > 280 ? '…' : '')
    : null

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-20 bg-black/10 backdrop-blur-[1px]" onClick={onClose} />
      )}

      <div
        className={`fixed top-0 right-0 h-full w-80 z-30 bg-white border-l border-zinc-200 flex flex-col shadow-xl
          transition-transform duration-200 ease-in-out
          ${open ? 'translate-x-0' : 'translate-x-full'}`}
      >
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 shrink-0">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18"
              />
            </svg>
            <span className="text-sm font-medium text-zinc-800">Memory & Notes</span>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* ── Active context selector ──────────────────────────────────────── */}
        <div className="px-4 py-2.5 border-b border-zinc-200 shrink-0 flex items-center gap-2">
          <span className="text-[11px] text-zinc-400 shrink-0">Context:</span>
          <select
            value={activeContext}
            onChange={(e) => onContextChange(e.target.value)}
            className="flex-1 text-xs bg-white border border-zinc-300 text-zinc-700 rounded-lg px-2 py-1 focus:outline-none focus:border-indigo-400"
          >
            {CONTEXT_OPTIONS.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>

        {/* ── Tabs ────────────────────────────────────────────────────────── */}
        <div className="flex border-b border-zinc-200 shrink-0">
          {(['memory', 'notes'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-2 text-xs font-medium transition-colors ${
                tab === t
                  ? 'text-indigo-600 border-b-2 border-indigo-500'
                  : 'text-zinc-400 hover:text-zinc-600'
              }`}
            >
              {t === 'memory' ? 'Memory' : 'Notes'}
            </button>
          ))}
        </div>

        {/* ── Scrollable body ─────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">

          {/* ════════════════════════════════════════════════════════════════
              MEMORY TAB
          ═══════════════════════════════════════════════════════════════════ */}
          {tab === 'memory' && (
            <>
              {/* Add fact form */}
              <section>
                <p className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider mb-2 px-1">
                  Long-term memories
                </p>

                <div className="space-y-1.5 mb-2">
                  <div className="flex gap-1.5">
                    <input
                      value={newFactText}
                      onChange={(e) => setNewFactText(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleAddFact()}
                      placeholder="Add a memory…"
                      className="flex-1 text-xs bg-white border border-zinc-300 text-zinc-700 placeholder-zinc-400 rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-indigo-400"
                    />
                    <button
                      onClick={handleAddFact}
                      disabled={!newFactText.trim()}
                      className="px-2.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed text-white text-xs transition-colors shrink-0"
                    >
                      Add
                    </button>
                  </div>
                  <div className="flex gap-1.5">
                    <input
                      value={newFactTag}
                      onChange={(e) => setNewFactTag(e.target.value)}
                      placeholder="Tag (e.g. ToD, Dev)"
                      list="context-suggestions"
                      className="flex-1 text-xs bg-white border border-zinc-300 text-zinc-700 placeholder-zinc-400 rounded-lg px-2 py-1 focus:outline-none focus:border-indigo-400"
                    />
                    <datalist id="context-suggestions">
                      {CONTEXT_OPTIONS.map((c) => <option key={c} value={c} />)}
                    </datalist>
                    <select
                      value={newFactCat}
                      onChange={(e) => setNewFactCat(e.target.value as MemoryFact['category'] | '')}
                      className="flex-1 text-xs bg-white border border-zinc-300 text-zinc-700 rounded-lg px-2 py-1 focus:outline-none"
                    >
                      <option value="">category…</option>
                      <option value="profile">profile</option>
                      <option value="preference">preference</option>
                      <option value="project">project</option>
                      <option value="goal">goal</option>
                      <option value="instruction">instruction</option>
                    </select>
                  </div>
                </div>

                {/* Facts list */}
                {sortedFacts.length === 0 ? (
                  <p className="text-xs text-zinc-400 px-2 py-2">
                    No memories yet. Add one above or extract from conversation.
                  </p>
                ) : (
                  <div className="space-y-0.5">
                    {sortedFacts.map((f) => (
                      <FactRow
                        key={f.id}
                        fact={f}
                        onPin={togglePin}
                        onDelete={deleteFact}
                        onUpdate={updateFact}
                      />
                    ))}
                  </div>
                )}

                {/* AI-assisted extraction */}
                <button
                  onClick={handleExtract}
                  disabled={isExtractingFacts}
                  className="mt-3 w-full text-xs text-zinc-500 hover:text-zinc-300 border border-zinc-800 hover:border-zinc-700 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
                >
                  {isExtractingFacts ? (
                    <>
                      <span className="w-3 h-3 rounded-full border-2 border-zinc-600 border-t-zinc-300 animate-spin" />
                      Extracting…
                    </>
                  ) : (
                    <>
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                      Extract from conversation
                    </>
                  )}
                </button>

                {/* Suggestions */}
                {suggestions.length > 0 && (
                  <div className="mt-2 space-y-1.5">
                    <p className="text-[11px] text-zinc-500 px-1">Suggestions — click + to keep:</p>
                    {suggestions.map((s) => (
                      <div
                        key={s}
                        className="flex items-start gap-1.5 px-2 py-1.5 bg-zinc-800/60 rounded-lg border border-zinc-700/50"
                      >
                        <span className="flex-1 text-xs text-zinc-400 leading-relaxed">{s}</span>
                        <button
                          onClick={() => acceptSuggestion(s)}
                          title="Add"
                          className="shrink-0 text-emerald-500 hover:text-emerald-400 transition-colors mt-0.5"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                          </svg>
                        </button>
                        <button
                          onClick={() => setSuggestions((prev) => prev.filter((x) => x !== s))}
                          title="Dismiss"
                          className="shrink-0 text-zinc-600 hover:text-zinc-400 transition-colors mt-0.5"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Conversation summary */}
              <section>
                <p className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider mb-2 px-1">
                  Conversation summary
                </p>

                {summaryPreview ? (
                  <div className="bg-zinc-50 rounded-xl border border-zinc-200 p-3">
                    <p className="text-xs text-zinc-600 leading-relaxed whitespace-pre-wrap">
                      {summaryPreview}
                    </p>
                    {summary && summary.content.length > 280 && (
                      <button
                        onClick={() => setSummaryExpanded((v) => !v)}
                        className="text-[11px] text-indigo-400 hover:text-indigo-300 mt-1.5 transition-colors"
                      >
                        {summaryExpanded ? 'Show less' : 'Show more'}
                      </button>
                    )}
                    <p className="text-[11px] text-zinc-600 mt-2">
                      Updated {summary ? new Date(summary.updatedAt).toLocaleTimeString() : '—'}
                      {summary ? ` · covers ${summary.coveredMessageCount} messages` : ''}
                    </p>
                  </div>
                ) : (
                  <p className="text-xs text-zinc-400 px-2 py-1">
                    No summary yet. Auto-updates after ~{10 + 20} messages.
                  </p>
                )}

                <button
                  onClick={() => rebuildSummary(model)}
                  disabled={isRebuildingSummary}
                  className="mt-2 w-full text-xs text-zinc-500 hover:text-zinc-300 border border-zinc-800 hover:border-zinc-700 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
                >
                  {isRebuildingSummary ? (
                    <>
                      <span className="w-3 h-3 rounded-full border-2 border-zinc-600 border-t-zinc-300 animate-spin" />
                      Rebuilding…
                    </>
                  ) : (
                    <>
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round"
                          d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                        />
                      </svg>
                      Rebuild summary now
                    </>
                  )}
                </button>
              </section>
            </>
          )}

          {/* ════════════════════════════════════════════════════════════════
              NOTES TAB
          ═══════════════════════════════════════════════════════════════════ */}
          {tab === 'notes' && (
            <section className="space-y-3">
              {/* Save chat as note */}
              <button
                onClick={handleSaveChatAsNote}
                disabled={savingChat || messages.length === 0}
                className="w-full text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 hover:border-zinc-600 rounded-lg px-3 py-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
              >
                {savingChat ? (
                  <>
                    <span className="w-3 h-3 rounded-full border-2 border-zinc-600 border-t-zinc-300 animate-spin" />
                    Saving…
                  </>
                ) : (
                  <>
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round"
                        d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4"
                      />
                    </svg>
                    Save chat as note
                  </>
                )}
              </button>

              {/* Notes list */}
              {notesLoading ? (
                <div className="flex justify-center py-4">
                  <span className="w-5 h-5 rounded-full border-2 border-zinc-700 border-t-zinc-400 animate-spin" />
                </div>
              ) : notes.length === 0 ? (
                <p className="text-xs text-zinc-600 px-2 py-2">
                  No notes yet. Use "save note: …" in chat or save the current chat above.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {[...notes].reverse().map((n) => (
                    <NoteRow key={n.id} note={n} onDelete={handleDeleteNote} />
                  ))}
                </div>
              )}
            </section>
          )}
        </div>

        {/* ── Footer ─────────────────────────────────────────────────────── */}
        <div className="px-4 py-2.5 border-t border-zinc-200 shrink-0">
          <p className="text-[10px] text-zinc-400 leading-relaxed">
            📌 Pin facts to always include them in the prompt.
            Context biases memory retrieval. Alt+Space to toggle mic.
          </p>
        </div>
      </div>
    </>
  )
}
