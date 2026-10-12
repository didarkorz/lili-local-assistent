/**
 * telegramManager.ts
 *
 * Opens Telegram Desktop with a pre-filled message via tg:// deep link.
 * Optionally auto-sends by pressing Enter after Telegram focuses.
 *
 * Contacts: stored in userData/telegram-contacts.json
 *   { "иван": "ivanpetrov", "мама": "mamausername" }
 *
 * No API key required — uses official Telegram URL scheme:
 *   tg://resolve?domain=USERNAME&text=MESSAGE
 */

import { shell } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'

type Contacts = Record<string, string>  // displayName → telegram_username (no @)

function contactsPath(): string {
  return join(app.getPath('userData'), 'telegram-contacts.json')
}

export async function loadContacts(): Promise<Contacts> {
  try {
    const raw = await fs.readFile(contactsPath(), 'utf-8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

async function saveContacts(c: Contacts): Promise<void> {
  await fs.writeFile(contactsPath(), JSON.stringify(c, null, 2), 'utf-8')
}

export async function addContact(name: string, username: string): Promise<void> {
  const c = await loadContacts()
  // Store under lowercase name; strip @ from username
  c[name.toLowerCase().trim()] = username.replace(/^@/, '').trim()
  await saveContacts(c)
}

export async function removeContact(name: string): Promise<boolean> {
  const c = await loadContacts()
  const key = name.toLowerCase().trim()
  if (!c[key]) return false
  delete c[key]
  await saveContacts(c)
  return true
}

// ── Resolve recipient name → telegram username ────────────────────────────────

async function resolveUsername(to: string): Promise<{ username: string } | { error: string }> {
  const trimmed = to.trim()

  // Already a @username or plain username
  if (trimmed.startsWith('@')) return { username: trimmed.slice(1) }

  // Pure latin username without @ (e.g. "ivanpetrov")
  if (/^[a-zA-Z0-9_]{5,}$/.test(trimmed)) return { username: trimmed }

  // Look up in contacts
  const contacts = await loadContacts()
  const key = trimmed.toLowerCase()

  // Exact match
  if (contacts[key]) return { username: contacts[key] }

  // Partial match (e.g. "Ивану" → find key "иван")
  const partialKey = Object.keys(contacts).find(
    (k) => key.startsWith(k) || k.startsWith(key)
  )
  if (partialKey) return { username: contacts[partialKey] }

  return {
    error:
      `Контакт «${to}» не найден.\n` +
      `Добавь его командой: «добавь контакт ${to} @username»`,
  }
}

// ── Auto-send: wait for Telegram window → PostMessage(WM_KEYDOWN, VK_RETURN) ──
//
// PostMessage is more reliable than SendKeys because:
//   - doesn't require the window to have keyboard focus
//   - works even if another window steals focus in the meantime
//   - WM_KEYDOWN goes directly into the message queue of the target window
//
// We poll for up to 6 seconds (every 300 ms) waiting for Telegram's main window
// to appear (handles the case where Telegram was closed and needs to start up).

async function autoSendEnter(): Promise<void> {
  const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class TgSend {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int nCmd);
    [DllImport("user32.dll")] public static extern IntPtr PostMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWinProc cb, IntPtr lp);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    public delegate bool EnumWinProc(IntPtr h, IntPtr lp);

    const uint WM_KEYDOWN = 0x0100;
    const uint WM_KEYUP   = 0x0101;
    const int  VK_RETURN  = 0x0D;

    public static IntPtr FindTelegramWindow() {
        IntPtr found = IntPtr.Zero;
        EnumWindows((hWnd, lp) => {
            if (!IsWindowVisible(hWnd)) return true;
            uint pid; GetWindowThreadProcessId(hWnd, out pid);
            try {
                var p = System.Diagnostics.Process.GetProcessById((int)pid);
                if (p.ProcessName.Equals("Telegram", StringComparison.OrdinalIgnoreCase)) {
                    var sb = new StringBuilder(256);
                    GetWindowText(hWnd, sb, 256);
                    // Main window has a non-empty title (contact/chat name or "Telegram")
                    if (sb.Length > 0) { found = hWnd; return false; }
                }
            } catch {}
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static bool Send() {
        // Check if Telegram is already running before the deep link
        bool wasAlreadyOpen = FindTelegramWindow() != IntPtr.Zero;

        // If already open: deep link navigates the existing window (~500-800ms).
        // If closed: Telegram needs to start (2-5s), but our poll below handles that.
        // Either way wait at least 1.8s for the deep link to be fully processed
        // and the message text to be filled in the input box.
        System.Threading.Thread.Sleep(wasAlreadyOpen ? 1800 : 500);

        // Poll up to 8 s for the window to appear (handles cold start)
        IntPtr hWnd = IntPtr.Zero;
        for (int i = 0; i < 27; i++) {
            hWnd = FindTelegramWindow();
            if (hWnd != IntPtr.Zero) break;
            System.Threading.Thread.Sleep(300);
        }
        if (hWnd == IntPtr.Zero) return false;

        ShowWindow(hWnd, 9);           // SW_RESTORE
        SetForegroundWindow(hWnd);
        System.Threading.Thread.Sleep(300);

        // PostMessage goes directly into message queue — no focus required
        PostMessage(hWnd, WM_KEYDOWN, (IntPtr)VK_RETURN, (IntPtr)0x001C0001);
        System.Threading.Thread.Sleep(50);
        PostMessage(hWnd, WM_KEYUP,   (IntPtr)VK_RETURN, (IntPtr)0xC01C0001);
        return true;
    }
}
"@

[TgSend]::Send() | Out-Null
`

  const file = join(tmpdir(), `lili-tg-send-${Date.now()}.ps1`)
  await fs.writeFile(file, '\ufeff' + script, 'utf-8')

  await new Promise<void>((resolve) => {
    const proc = spawn('powershell', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
      '-ExecutionPolicy', 'Bypass', '-File', file,
    ], { windowsHide: true })
    proc.on('close', () => { fs.unlink(file).catch(() => {}); resolve() })
    proc.on('error', () => { fs.unlink(file).catch(() => {}); resolve() })
  })
}

// ── Main API ──────────────────────────────────────────────────────────────────

export interface TelegramSendResult {
  success: boolean
  username?: string
  error?: string
}

/**
 * Open Telegram with a pre-filled message.
 * @param to    recipient name, @username, or contact alias
 * @param text  message to pre-fill
 * @param autoSend  if true, presses Enter in Telegram after 2.5s (sends automatically)
 */
export async function sendTelegramMessage(
  to: string,
  text: string,
  autoSend: boolean,
): Promise<TelegramSendResult> {
  const resolved = await resolveUsername(to)
  if ('error' in resolved) return { success: false, error: resolved.error }

  const { username } = resolved
  const deepLink = `tg://resolve?domain=${encodeURIComponent(username)}&text=${encodeURIComponent(text)}`

  try {
    await shell.openExternal(deepLink)
  } catch (e) {
    return { success: false, error: `Не удалось открыть Telegram: ${e instanceof Error ? e.message : String(e)}` }
  }

  if (autoSend) {
    // Fire-and-forget — don't await, just schedule
    autoSendEnter().catch(() => {})
  }

  return { success: true, username }
}
