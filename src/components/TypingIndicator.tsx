export function TypingIndicator() {
  return (
    <div className="flex justify-start mb-4">
      <div className="w-7 h-7 rounded-full bg-indigo-600 flex items-center justify-center text-white text-[10px] font-bold mr-2 mt-1 shrink-0">
        AI
      </div>
      <div className="bg-zinc-800 border border-zinc-700/60 rounded-2xl rounded-bl-sm px-4 py-3">
        <div className="flex items-center gap-1">
          <span
            className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce"
            style={{ animationDelay: '-0.3s' }}
          />
          <span
            className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce"
            style={{ animationDelay: '-0.15s' }}
          />
          <span className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce" />
        </div>
      </div>
    </div>
  )
}
