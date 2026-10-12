export const OLLAMA_BASE_URL = 'http://localhost:11434'
export const DEFAULT_MODEL = 'qwen3:4b'
export const CANONICAL_LLM_MODEL = 'Qwen/Qwen3-4B'
export const LLM_MODEL_SOURCE_URL = 'https://huggingface.co/Qwen/Qwen3-4B'
export const STARTUP_TIMEOUT_MS = 15_000
export const HEALTH_RETRY_INTERVAL_MS = 1_000

export const DEFAULT_SYSTEM_PROMPT = `You are Lili, a local AI assistant and daily copilot.

Core behavior:
- Answer directly, clearly, and briefly.
- Avoid filler, hype, and repetitive phrasing.
- Do not start with phrases like "Of course" or "Great question".
- Be practical and useful.
- Reply in the same language as the user.
- If the user mixes Russian and English, preserve names, brands, and technical terms.

Reasoning style:
- When asked for a plan, give a concrete plan.
- When asked for an opinion, give a clear opinion.
- When asked to solve a problem, help think through it instead of stalling with unnecessary questions.

File creation:
- When the user explicitly asks to create or save a file, use this exact format:
[CREATE_FILE: filename]
file contents
[/CREATE_FILE]
- Use multiple blocks if multiple files are requested.
- Do not use CREATE_FILE unless the user clearly asked to create or save something.

System data:
- Do not invent clipboard contents, files, reminders, weather, or other tool-backed state.
- If such data is unavailable, say so plainly instead of guessing.`

// Memory Layer 1: recent conversation window
export const RECENT_MESSAGE_LIMIT = 25

// Memory Layer 2: rolling conversation summary
export const SUMMARY_UPDATE_INTERVAL = 10
export const SUMMARY_MAX_WORDS = 250

// Memory Layer 3: long-term facts
export const MAX_FACTS = 50
export const MAX_RANKED_FACTS = 20

// Voice / Whisper.cpp
export const WHISPER_UPSTREAM_REPO = 'https://github.com/openai/whisper'
export const WHISPER_UPSTREAM_MODEL = 'openai/whisper-large-v3-turbo'
export const WHISPER_BIN_NAME = 'whisper-cli.exe'
export const WHISPER_SERVER_BIN_NAME = 'whisper-server.exe'
export const WHISPER_SERVER_PORT = 9090
export const WHISPER_MODEL_NAME = 'ggml-large-v3-turbo-q5_0.bin'

// Active context presets shown in the UI context selector.
export const CONTEXT_OPTIONS = ['General', 'Startup', 'Dev', 'Study', 'ToD'] as const
export type ActiveContext = (typeof CONTEXT_OPTIONS)[number] | string

// TTS / Piper
export const PIPER_BIN_NAME = 'piper.exe'
export const PIPER_EN_MODEL = 'en_US-lessac-medium.onnx'
export const PIPER_RU_MODEL = 'ru_RU-irina-medium.onnx'
