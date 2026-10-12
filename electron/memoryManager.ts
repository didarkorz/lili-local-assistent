/**
 * memoryManager.ts
 *
 * Implements the 3-layer memory system for Lili.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  Prompt sent to Ollama on every chat request:                           │
 * │                                                                         │
 * │  [system]  Base instructions                                            │
 * │            + Active context (if set)                                    │
 * │            + Layer 3a: pinned facts (always present, top priority)      │
 * │            + Layer 3b: ranked long-term facts                           │
 * │            + Layer 2:  rolling summary of older conversation            │
 * │  [user/assistant] … last RECENT_MESSAGE_LIMIT messages verbatim         │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Ranking strategy (deterministic, no embeddings):
 *   1. Pinned facts — always included, highest priority
 *   2. Score remaining facts:
 *      +3  if projectTag matches active context
 *      +1  per keyword from the user message found in the fact content
 *   3. Sort by score desc, then by createdAt desc
 *   4. Take top MAX_RANKED_FACTS non-pinned facts
 */

import {
  DEFAULT_SYSTEM_PROMPT,
  RECENT_MESSAGE_LIMIT,
  SUMMARY_UPDATE_INTERVAL,
  SUMMARY_MAX_WORDS,
  MAX_RANKED_FACTS,
} from './constants'
import { generateQwenChat } from './qwenManager'
import {
  loadFacts,
  loadSummary,
  saveSummary,
  clearSummary,
} from './memoryStore'
import type { ChatMessage, MemoryFact, ConversationSummary } from './types'

// ── Relevance ranking ─────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'are', 'was', 'were',
  'have', 'has', 'had', 'not', 'but', 'from', 'they', 'their', 'been',
  'will', 'would', 'could', 'should', 'what', 'when', 'where', 'which',
  'how', 'who', 'some', 'more', 'also', 'than', 'then', 'about', 'into',
  'can', 'you', 'your', 'just', 'like', 'make', 'know', 'think', 'say',
])

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
}

function scoreFactForContext(
  fact: MemoryFact,
  keywords: string[],
  activeContext: string,
): number {
  let score = 0

  // Project tag match gets the highest bonus
  if (activeContext && activeContext !== 'General' && fact.projectTag) {
    if (fact.projectTag.toLowerCase() === activeContext.toLowerCase()) {
      score += 3
    }
  }

  // Keyword overlap with current message
  if (keywords.length > 0) {
    const contentLower = fact.content.toLowerCase()
    for (const kw of keywords) {
      if (contentLower.includes(kw)) score += 1
    }
  }

  return score
}

/**
 * Return facts in retrieval priority order:
 *   1. All pinned facts
 *   2. Top MAX_RANKED_FACTS non-pinned facts by relevance score
 */
function rankFacts(
  facts: MemoryFact[],
  lastUserMessage: string,
  activeContext: string,
): MemoryFact[] {
  const pinned   = facts.filter((f) => f.pinned)
  const unpinned = facts.filter((f) => !f.pinned)

  const keywords = extractKeywords(lastUserMessage)

  const scored = unpinned
    .map((f) => ({ fact: f, score: scoreFactForContext(f, keywords, activeContext) }))
    .sort((a, b) => b.score - a.score || b.fact.createdAt - a.fact.createdAt)

  const maxUnpinned = Math.max(0, MAX_RANKED_FACTS - pinned.length)
  return [...pinned, ...scored.slice(0, maxUnpinned).map((s) => s.fact)]
}

// ── Prompt construction ───────────────────────────────────────────────────────

function buildSystemPrompt(
  facts: MemoryFact[],
  summary: ConversationSummary | null,
  activeContext: string,
): string {
  const parts: string[] = [DEFAULT_SYSTEM_PROMPT]

  // Active context hint
  if (activeContext && activeContext !== 'General') {
    parts.push(`\n## Active working context: ${activeContext}`)
  }

  // ── Layer 3a: pinned facts ────────────────────────────────────────────────
  const pinned = facts.filter((f) => f.pinned)
  if (pinned.length > 0) {
    parts.push(
      `\n## Always remember (pinned):\n${pinned.map((f) => `- ${f.content}`).join('\n')}`
    )
  }

  // ── Layer 3b: other ranked facts ──────────────────────────────────────────
  const other = facts.filter((f) => !f.pinned)
  if (other.length > 0) {
    parts.push(
      `\n## Long-term memories:\n${other
        .map((f) => `- ${f.content}${f.projectTag ? ` [${f.projectTag}]` : ''}`)
        .join('\n')}`
    )
  }

  // ── Layer 2: rolling summary ──────────────────────────────────────────────
  if (summary) {
    parts.push(`\n## Summary of earlier conversation:\n${summary.content}`)
  }

  return parts.join('\n')
}

/**
 * Build the complete Ollama message array for a chat request.
 *
 * Called by the ollama:chat IPC handler in main.ts.
 * activeContext biases fact retrieval toward the selected project/context.
 */
export function buildPayload(
  messages: ChatMessage[],
  activeContext = '',
): Array<{ role: string; content: string }> {
  const allFacts = loadFacts()
  const summary  = loadSummary()

  // Use the last user message to score fact relevance
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
  const ranked = rankFacts(allFacts, lastUserMsg, activeContext)

  let systemPrompt = buildSystemPrompt(ranked, summary, activeContext)

  // Inject current date/time so Lili can answer "который час?" etc.
  const now = new Date()
  const timeStr = now.toLocaleString('ru-RU', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
    hour:    '2-digit',
    minute:  '2-digit',
  })
  systemPrompt += `\n\n## Текущее время\n${timeStr}`

  const recent = messages.slice(-RECENT_MESSAGE_LIMIT)

  return [
    { role: 'system', content: systemPrompt },
    ...recent.map((m) => ({ role: m.role, content: m.content })),
  ]
}

// ── Rolling summary generation (Layer 2) ─────────────────────────────────────

let isSummarizing = false

export function maybeTriggerSummary(allMessages: ChatMessage[], model: string): void {
  if (isSummarizing) return

  const summarisableCount = allMessages.length - RECENT_MESSAGE_LIMIT
  if (summarisableCount <= 0) return

  const existing    = loadSummary()
  const coveredCount = existing?.coveredMessageCount ?? 0
  const newCount    = summarisableCount - coveredCount

  if (newCount < SUMMARY_UPDATE_INTERVAL) return

  isSummarizing = true
  doGenerateSummary(allMessages, model)
    .catch((err) => console.error('[memory] summary generation failed:', err))
    .finally(() => { isSummarizing = false })
}

export async function regenerateSummary(
  allMessages: ChatMessage[],
  model: string,
): Promise<boolean> {
  const summarisableCount = allMessages.length - RECENT_MESSAGE_LIMIT
  if (summarisableCount <= 0) return false

  clearSummary()

  try {
    await doGenerateSummary(allMessages, model)
    return true
  } catch (err) {
    console.error('[memory] regenerateSummary failed:', err)
    return false
  }
}

async function doGenerateSummary(allMessages: ChatMessage[], model: string): Promise<void> {
  const toSummarise = allMessages.slice(0, allMessages.length - RECENT_MESSAGE_LIMIT)
  if (toSummarise.length === 0) return

  const existing = loadSummary()
  let prompt: string

  if (existing && existing.coveredMessageCount > 0) {
    const newMessages = toSummarise.slice(existing.coveredMessageCount)
    if (newMessages.length === 0) return

    const newTranscript = newMessages
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n')

    prompt =
      `You are maintaining a running memory summary for an AI assistant.\n\n` +
      `Previous summary:\n${existing.content}\n\n` +
      `New conversation to incorporate:\n${newTranscript}\n\n` +
      `Update the summary to include the new information. ` +
      `Keep it under ${SUMMARY_MAX_WORDS} words. ` +
      `Preserve: user preferences, names, project details, decisions, important context. ` +
      `Write in concise bullet points or short paragraphs.`
  } else {
    const transcript = toSummarise
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n')

    prompt =
      `You are maintaining a memory summary for an AI assistant.\n\n` +
      `Summarise the following conversation. ` +
      `Keep it under ${SUMMARY_MAX_WORDS} words. ` +
      `Preserve: user preferences, names, project details, decisions, important context. ` +
      `Write in concise bullet points or short paragraphs.\n\n` +
      `Conversation:\n${transcript}`
  }

  void model
  const content = (await generateQwenChat([{ role: 'user', content: prompt }])).trim()
  if (!content) return

  saveSummary({
    content,
    updatedAt: Date.now(),
    coveredMessageCount: toSummarise.length,
  })

  console.log(`[memory] summary updated — covers ${toSummarise.length} messages`)
}

// ── AI-assisted fact extraction (Layer 3) ─────────────────────────────────────

export async function extractFacts(
  allMessages: ChatMessage[],
  model: string,
): Promise<string[]> {
  void model
  if (allMessages.length === 0) return []

  const transcript = allMessages
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n')

  const prompt =
    `Read this conversation and extract important facts about the user worth remembering long-term.\n\n` +
    `Focus on: name, profession, ongoing projects, goals, tool/language preferences, recurring instructions.\n\n` +
    `Return ONLY a JSON array of strings. Max 8 items. Only include genuinely important, reusable facts.\n` +
    `Example: ["User's name is Alex", "User prefers TypeScript", "User is building a desktop app called Lili"]\n\n` +
    `Conversation:\n${transcript}\n\n` +
    `Return only the JSON array, no other text:`

  try {
    const raw = (await generateQwenChat([{ role: 'user', content: prompt }])).trim()

    const match = raw.match(/\[[\s\S]*\]/)
    if (!match) return []

    const parsed = JSON.parse(match[0]) as unknown[]
    return parsed.filter((f): f is string => typeof f === 'string')
  } catch {
    return []
  }
}
