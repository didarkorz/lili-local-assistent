import { shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

interface AppEntry {
  scheme?: string
  exe?: string[]
}

const USERNAME = process.env.USERNAME ?? process.env.USER ?? ''

const APP_MAP: Record<string, AppEntry> = {
  // Мессенджеры
  telegram:         { scheme: 'tg://' },
  телеграм:         { scheme: 'tg://' },
  discord:          { scheme: 'discord://' },
  дискорд:          { scheme: 'discord://' },
  whatsapp:         { scheme: 'whatsapp://' },
  вотсап:           { scheme: 'whatsapp://' },
  skype:            { scheme: 'skype://' },
  скайп:            { scheme: 'skype://' },
  slack:            { scheme: 'slack://' },

  // Браузеры
  браузер:          { scheme: 'https://www.google.com' }, // открывает браузер по умолчанию
  browser:          { scheme: 'https://www.google.com' },
  chrome:           { exe: [
    `C:/Program Files/Google/Chrome/Application/chrome.exe`,
    `C:/Program Files (x86)/Google/Chrome/Application/chrome.exe`,
  ]},
  хром:             { exe: [
    `C:/Program Files/Google/Chrome/Application/chrome.exe`,
    `C:/Program Files (x86)/Google/Chrome/Application/chrome.exe`,
  ]},
  firefox:          { exe: [
    `C:/Program Files/Mozilla Firefox/firefox.exe`,
    `C:/Program Files (x86)/Mozilla Firefox/firefox.exe`,
  ]},
  фаерфокс:         { exe: [`C:/Program Files/Mozilla Firefox/firefox.exe`] },
  edge:             { exe: [
    `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`,
    `C:/Program Files/Microsoft/Edge/Application/msedge.exe`,
  ]},

  // Сайты
  youtube:          { scheme: 'https://youtube.com' },
  ютуб:             { scheme: 'https://youtube.com' },
  google:           { scheme: 'https://google.com' },
  гугл:             { scheme: 'https://google.com' },
  github:           { scheme: 'https://github.com' },
  гитхаб:           { scheme: 'https://github.com' },
  gmail:            { scheme: 'https://mail.google.com' },
  'google mail':    { scheme: 'https://mail.google.com' },
  maps:             { scheme: 'https://maps.google.com' },
  карты:            { scheme: 'https://maps.google.com' },

  // Музыка
  spotify:          { scheme: 'spotify://' },
  спотифай:         { scheme: 'spotify://' },
  'youtube music':  { scheme: 'https://music.youtube.com/' },
  'ютуб музыка':    { scheme: 'https://music.youtube.com/' },

  // Редакторы
  vscode:           { exe: [
    `C:/Users/${USERNAME}/AppData/Local/Programs/Microsoft VS Code/Code.exe`,
    `C:/Program Files/Microsoft VS Code/Code.exe`,
  ]},
  'vs code':        { exe: [`C:/Users/${USERNAME}/AppData/Local/Programs/Microsoft VS Code/Code.exe`] },
  cursor:           { exe: [
    `C:/Users/${USERNAME}/AppData/Local/Programs/cursor/Cursor.exe`,
  ]},

  // Системные
  проводник:        { exe: ['explorer.exe'] },
  explorer:         { exe: ['explorer.exe'] },
  блокнот:          { exe: ['notepad.exe'] },
  notepad:          { exe: ['notepad.exe'] },
  калькулятор:      { scheme: 'calculator://' },
  calculator:       { scheme: 'calculator://' },
  настройки:        { scheme: 'ms-settings://' },
  settings:         { scheme: 'ms-settings://' },
  диспетчер:        { exe: ['taskmgr.exe'] },
  'task manager':   { exe: ['taskmgr.exe'] },

  // Офис
  word:             { exe: [
    `C:/Program Files/Microsoft Office/root/Office16/WINWORD.EXE`,
    `C:/Program Files (x86)/Microsoft Office/root/Office16/WINWORD.EXE`,
  ]},
  excel:            { exe: [
    `C:/Program Files/Microsoft Office/root/Office16/EXCEL.EXE`,
    `C:/Program Files (x86)/Microsoft Office/root/Office16/EXCEL.EXE`,
  ]},
  powerpoint:       { exe: [
    `C:/Program Files/Microsoft Office/root/Office16/POWERPNT.EXE`,
    `C:/Program Files (x86)/Microsoft Office/root/Office16/POWERPNT.EXE`,
  ]},

  // Медиа
  vlc:              { exe: [
    `C:/Program Files/VideoLAN/VLC/vlc.exe`,
    `C:/Program Files (x86)/VideoLAN/VLC/vlc.exe`,
  ]},
}

// ── Fuzzy matching ────────────────────────────────────────────────────────────
//
// Levenshtein distance: counts minimum edits (insert/delete/replace) to transform
// one string into another. Used to handle speech recognition errors like:
//   "дискорт" → "дискорд" (final consonant devoicing)
//   "телегам"  → "телеграм" (dropped letter)

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  )
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[m][n]
}

// Find the best matching key in APP_MAP, allowing up to maxDist edits.
// Short keys need stricter threshold to avoid false positives.
function fuzzyFind(query: string, maxDist = 2): string | null {
  let best: string | null = null
  let bestDist = maxDist + 1

  for (const key of Object.keys(APP_MAP)) {
    // Skip very short keys if query is much longer (avoid "vlc" matching "калькулятор")
    if (Math.abs(key.length - query.length) > 4) continue
    const dist = levenshtein(query, key)
    if (dist <= maxDist && dist < bestDist) {
      bestDist = dist
      best = key
    }
  }
  return best
}

export async function openApp(name: string): Promise<{ success: boolean; error?: string }> {
  const key = name.toLowerCase().trim()

  // Exact match first
  let entry = APP_MAP[key]

  // Fuzzy fallback — tolerate 1 edit for short names, 2 for longer
  if (!entry) {
    const maxDist = key.length <= 5 ? 1 : 2
    const fuzzyKey = fuzzyFind(key, maxDist)
    if (fuzzyKey) {
      entry = APP_MAP[fuzzyKey]
      console.log(`[AppManager] fuzzy match: "${key}" → "${fuzzyKey}"`)
    }
  }

  if (!entry) {
    return { success: false, error: `Приложение «${name}» не найдено` }
  }

  // URL scheme — открываем через shell.openExternal
  if (entry.scheme) {
    try {
      await shell.openExternal(entry.scheme)
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  // EXE — ищем первый существующий путь
  if (entry.exe) {
    for (const exePath of entry.exe) {
      // Системные exe (без пути) — запускаем напрямую
      const isSystemExe = !exePath.includes('/') && !exePath.includes('\\')
      if (isSystemExe || existsSync(exePath)) {
        try {
          spawn(exePath, [], { detached: true, stdio: 'ignore', shell: isSystemExe }).unref()
          return { success: true }
        } catch (e) {
          return { success: false, error: String(e) }
        }
      }
    }
    return { success: false, error: `${name} не установлен или не найден` }
  }

  return { success: false, error: `Не могу открыть «${name}»` }
}

export function listKnownApps(): string[] {
  return Object.keys(APP_MAP)
}
