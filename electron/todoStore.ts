import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export interface Task {
  id: string
  text: string
  done: boolean
  createdAt: number
  doneAt?: number
}

function getTasksPath(): string {
  return join(app.getPath('userData'), 'tasks.json')
}

export async function loadTasks(): Promise<Task[]> {
  try {
    const raw = await fs.readFile(getTasksPath(), 'utf-8')
    return JSON.parse(raw) as Task[]
  } catch {
    return []
  }
}

async function saveTasks(tasks: Task[]): Promise<void> {
  await fs.writeFile(getTasksPath(), JSON.stringify(tasks, null, 2), 'utf-8')
}

export async function addTask(text: string): Promise<Task> {
  const tasks = await loadTasks()
  const task: Task = {
    id: Math.random().toString(36).slice(2) + Date.now().toString(36),
    text: text.trim(),
    done: false,
    createdAt: Date.now(),
  }
  tasks.push(task)
  await saveTasks(tasks)
  return task
}

export async function completeTask(query: string): Promise<Task | null> {
  const tasks = await loadTasks()
  const q = query.toLowerCase().trim()
  // Match by number ("1", "2") or by text
  const byNum = /^\d+$/.test(q)
  const idx = byNum
    ? parseInt(q) - 1
    : tasks.findIndex((t) => !t.done && t.text.toLowerCase().includes(q))
  if (idx < 0 || idx >= tasks.length) return null
  tasks[idx].done = true
  tasks[idx].doneAt = Date.now()
  await saveTasks(tasks)
  return tasks[idx]
}

export async function deleteTask(query: string): Promise<boolean> {
  const tasks = await loadTasks()
  const q = query.toLowerCase().trim()
  const byNum = /^\d+$/.test(q)
  const idx = byNum
    ? parseInt(q) - 1
    : tasks.findIndex((t) => t.text.toLowerCase().includes(q))
  if (idx < 0 || idx >= tasks.length) return false
  tasks.splice(idx, 1)
  await saveTasks(tasks)
  return true
}

export async function clearDoneTasks(): Promise<number> {
  const tasks = await loadTasks()
  const active = tasks.filter((t) => !t.done)
  const removed = tasks.length - active.length
  await saveTasks(active)
  return removed
}
