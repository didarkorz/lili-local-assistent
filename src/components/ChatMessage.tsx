import { memo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Message } from '../types'

interface Props {
  message: Message
}

// Strip [CREATE_FILE:...]...[/CREATE_FILE] blocks from displayed text,
// replacing them with a clean confirmation line.
function cleanDisplayContent(text: string): string {
  return text
    // CREATE_FILE blocks → pretty confirmation
    .replace(
      /\[CREATE_FILE:\s*([^\]]+)\][\s\S]*?\[\/CREATE_FILE\]/gi,
      (_match, name) => `📄 Файл создан: **${name.trim()}**`,
    )
    // Any other paired [TAG: ...]...[/TAG] blocks — strip silently
    .replace(/\[[A-Z_]+:[^\]]*\][\s\S]*?\[\/[A-Z_]+\]/gi, '')
    // Orphan tags
    .replace(/\[[A-Z_]+:[^\]]*\]/gi, '')
    .replace(/\[\/[A-Z_]+\]/gi, '')
    .trim()
}

export const ChatMessage = memo(function ChatMessage({ message }: Props) {
  const isUser = message.role === 'user'
  const [copied, setCopied] = useState(false)
  const displayContent = isUser ? message.content : cleanDisplayContent(message.content)

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4 group`}>
      {!isUser && (
        <div className="w-7 h-7 rounded-full bg-indigo-600 flex items-center justify-center text-white text-[10px] font-bold mr-2 mt-1 shrink-0">
          AI
        </div>
      )}

      <div className="relative max-w-[72%]">
        <div
          className={`px-4 py-3 rounded-2xl text-sm leading-relaxed select-text break-words ${
            isUser
              ? 'bg-indigo-600 text-white rounded-br-sm'
              : 'bg-white text-zinc-800 border border-zinc-200 rounded-bl-sm shadow-sm'
          }`}
        >
          {message.streaming ? (
            // While streaming show plain text for speed
            <span className="whitespace-pre-wrap">{displayContent}
              <span className="inline-block w-1.5 h-4 bg-current ml-0.5 animate-pulse align-middle opacity-70" />
            </span>
          ) : (
            <div className={`md-content ${isUser ? 'md-content-user' : ''}`}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {displayContent}
              </ReactMarkdown>
            </div>
          )}
        </div>

        {/* Copy button */}
        {!message.streaming && displayContent && (
          <button
            onClick={handleCopy}
            title="Копировать"
            className={`absolute -bottom-1 ${isUser ? 'left-0 -translate-x-full pl-0 pr-1.5' : 'right-0 translate-x-full pr-0 pl-1.5'}
              opacity-0 group-hover:opacity-100 transition-opacity text-zinc-400 hover:text-zinc-600`}
          >
            {copied ? (
              <svg className="w-3.5 h-3.5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            )}
          </button>
        )}
      </div>

      {isUser && (
        <div className="w-7 h-7 rounded-full bg-zinc-200 flex items-center justify-center text-zinc-600 text-[10px] font-bold ml-2 mt-1 shrink-0">
          You
        </div>
      )}
    </div>
  )
})
