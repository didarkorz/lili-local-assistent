import { Notification } from 'electron'

interface ScheduledReminder {
  timerId: ReturnType<typeof setTimeout>
  text: string
  fireAt: number
}

const reminders = new Map<string, ScheduledReminder>()

export function showNotification(title: string, body: string): void {
  new Notification({ title, body }).show()
}

export function scheduleReminder(id: string, text: string, delayMs: number): void {
  if (reminders.has(id)) cancelReminder(id)

  const timerId = setTimeout(() => {
    showNotification('Лили напоминает', text)
    reminders.delete(id)
  }, delayMs)

  reminders.set(id, { timerId, text, fireAt: Date.now() + delayMs })
}

export function cancelReminder(id: string): boolean {
  const r = reminders.get(id)
  if (!r) return false
  clearTimeout(r.timerId)
  reminders.delete(id)
  return true
}

export function listReminders(): Array<{ id: string; text: string; fireAt: number }> {
  return Array.from(reminders.entries()).map(([id, r]) => ({
    id,
    text: r.text,
    fireAt: r.fireAt,
  }))
}
