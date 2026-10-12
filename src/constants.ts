export const DEFAULT_MODEL = 'qwen3:4b'
export const CANONICAL_LLM_MODEL = 'Qwen/Qwen3-4B'

export const CONTEXT_OPTIONS = ['General', 'Startup', 'Dev', 'Study', 'ToD'] as const
export type ActiveContext = (typeof CONTEXT_OPTIONS)[number] | string
