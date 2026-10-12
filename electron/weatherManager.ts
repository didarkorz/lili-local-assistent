/**
 * weatherManager.ts
 * Fetches weather data from wttr.in (free, no API key required).
 */

interface WttrCondition {
  temp_C: string
  FeelsLikeC: string
  humidity: string
  windspeedKmph: string
  weatherDesc: Array<{ value: string }>
  weatherIconUrl?: Array<{ value: string }>
}

interface WttrResponse {
  current_condition: WttrCondition[]
  nearest_area: Array<{
    areaName: Array<{ value: string }>
    country: Array<{ value: string }>
  }>
}

const WEATHER_ICONS: Record<string, string> = {
  'Sunny':                     '☀️',
  'Clear':                     '🌙',
  'Partly cloudy':             '⛅',
  'Cloudy':                    '☁️',
  'Overcast':                  '☁️',
  'Mist':                      '🌫️',
  'Fog':                       '🌫️',
  'Freezing fog':              '🌫️',
  'Light rain':                '🌦️',
  'Moderate rain':             '🌧️',
  'Heavy rain':                '🌧️',
  'Light drizzle':             '🌦️',
  'Drizzle':                   '🌦️',
  'Light snow':                '🌨️',
  'Moderate snow':             '❄️',
  'Heavy snow':                '❄️',
  'Blizzard':                  '🌨️',
  'Thundery outbreaks':        '⛈️',
  'Patchy rain possible':      '🌦️',
  'Patchy snow possible':      '🌨️',
  'Blowing snow':              '🌨️',
  'Light sleet':               '🌧️',
  'Moderate or heavy sleet':   '🌧️',
}

function iconFor(desc: string): string {
  for (const [key, icon] of Object.entries(WEATHER_ICONS)) {
    if (desc.toLowerCase().includes(key.toLowerCase())) return icon
  }
  return '🌡️'
}

export async function getWeather(city: string): Promise<{ success: boolean; data?: string; error?: string }> {
  try {
    const encoded = encodeURIComponent(city)
    const res = await fetch(`https://wttr.in/${encoded}?format=j1&lang=ru`, {
      signal: AbortSignal.timeout(8_000),
      headers: { 'Accept': 'application/json', 'User-Agent': 'LiliAssistant/1.0' },
    })

    if (!res.ok) {
      if (res.status === 404) {
        return { success: false, error: `Город «${city}» не найден.` }
      }
      return { success: false, error: `Ошибка сервера: HTTP ${res.status}` }
    }

    const data = (await res.json()) as WttrResponse
    const cond = data.current_condition?.[0]
    if (!cond) return { success: false, error: 'Нет данных о погоде.' }

    const desc     = cond.weatherDesc?.[0]?.value ?? ''
    const icon     = iconFor(desc)
    const temp     = cond.temp_C
    const feels    = cond.FeelsLikeC
    const humidity = cond.humidity
    const wind     = cond.windspeedKmph

    // Describe temperature feel
    const tempNum = parseInt(temp)
    const tempFeel =
      tempNum >= 30 ? 'очень жарко' :
      tempNum >= 22 ? 'тепло' :
      tempNum >= 15 ? 'комфортно' :
      tempNum >= 8  ? 'прохладно' :
      tempNum >= 0  ? 'холодно' :
      'морозно'

    const result =
      `${icon} Сегодня в **${city}** — ${desc.toLowerCase()}, ${tempFeel}.\n\n` +
      `🌡️ Температура **${temp}°C**, ощущается как **${feels}°C**\n` +
      `💧 Влажность: ${humidity}%  ·  💨 Ветер: ${wind} км/ч`

    return { success: true, data: result }
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      return { success: false, error: 'Сервис погоды не отвечает. Проверь интернет-соединение.' }
    }
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
