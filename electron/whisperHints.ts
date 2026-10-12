/**
 * whisperHints.ts
 *
 * Builds the --prompt string for whisper-cli.
 * A good prompt biases the model toward words it's likely to hear,
 * reducing hallucinations and improving recognition of command keywords,
 * app names, and domain-specific vocabulary.
 *
 * Rules:
 * - Keep it under ~224 tokens (~900 chars) — whisper's initial prompt window
 * - Use the same language(s) the user speaks (Russian + English mix)
 * - List concrete words/phrases, not sentences
 */

// ── Wake word variants ────────────────────────────────────────────────────────
const WAKE_WORDS = ['Лили', 'Лиля', 'Лилии', 'Плили', 'Пили', 'Lily', 'Lili']

// ── Core command verbs (RU + EN) ─────────────────────────────────────────────
const COMMAND_VERBS = [
  // Reminders
  'напомни', 'напомнить', 'напоминание', 'remind me', 'reminder',
  'через минуту', 'через час', 'через минут', 'через часов',
  // Apps
  'открой', 'открыть', 'запусти', 'запустить', 'включи', 'включить', 'выключи', 'выключить',
  'поставь', 'ставь', 'вруби', 'включай', 'нужен', 'нужна', 'сделай', 'установи',
  'open', 'launch', 'start', 'play',
  // Media
  'музыку', 'песню', 'трек', 'ютуб', 'youtube',
  'эд ширан', 'ed sheeran', 'фотограф', 'photograph', 'shape of you',
  // Files
  'создай файл', 'создать файл', 'прочитай файл', 'удали файл',
  'запиши в файл', 'допиши в файл', 'покажи файлы', 'список файлов',
  'create file', 'read file', 'delete file', 'list files',
  // Weather
  'погода', 'какая погода', 'покажи погоду', 'weather',
  // System
  'яркость', 'экран', 'свет', 'глаза слепят', 'громкость', 'звук',
  'на ноль', 'на сто', 'на тридцать', 'на пятьдесят',
  // Memory
  'запомни', 'remember this', 'save memory', 'forget this',
  // Clipboard
  'буфер обмена', 'прочитай буфер', 'clipboard',
  // Notes
  'сохрани заметку', 'создай заметку', 'список заметок',
  // General
  'стоп', 'остановись', 'отмена', 'stop', 'cancel',
]

// ── App names the user is likely to say ─────────────────────────────────────
const APP_NAMES = [
  'Телеграм', 'Telegram',
  'Дискорд', 'Discord',
  'Ватсап', 'WhatsApp',
  'Скайп', 'Skype',
  'Спотифай', 'Spotify',
  'Хром', 'Chrome',
  'Файерфокс', 'Firefox',
  'Ютуб', 'YouTube',
  'Гугл', 'Google',
  'Гитхаб', 'GitHub',
  'Джимейл', 'Gmail',
  'Блокнот', 'Notepad',
  'Калькулятор', 'Calculator',
  'Проводник', 'Explorer',
  'VS Code', 'Cursor',
  'Word', 'Excel', 'PowerPoint',
  'VLC', 'Яндекс Музыка', 'Yandex Music',
]

// ── City names (for weather) ─────────────────────────────────────────────────
const CITIES = [
  'Москва', 'Moscow',
  'Астана', 'Astana',
  'Алматы', 'Almaty',
  'Кызылорда', 'Qyzylorda', 'Казахстан',
  'Санкт-Петербург', 'Saint Petersburg',
  'Лондон', 'London',
  'Нью-Йорк', 'New York',
]

// ── Time expressions ─────────────────────────────────────────────────────────
const TIME_WORDS = [
  'минуту', 'минут', 'минуты',
  'час', 'часа', 'часов',
  'секунду', 'секунд',
  'сегодня', 'завтра', 'сейчас',
]

// ── Builder ───────────────────────────────────────────────────────────────────

export function buildWhisperPrompt(): string {
  const parts = [
    ...WAKE_WORDS,
    ...COMMAND_VERBS,
    ...APP_NAMES,
    ...CITIES,
    ...TIME_WORDS,
  ]

  // Join as comma-separated list, keep under ~900 chars
  const prompt = parts.join(', ')
  return prompt.length > 900 ? prompt.slice(0, 900) : prompt
}
