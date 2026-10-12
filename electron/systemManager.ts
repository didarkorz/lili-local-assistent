/**
 * systemManager.ts
 * Volume: Core Audio COM API (no keybd_event, direct OS call)
 * Media:  keybd_event via SendInput
 */

import { spawn }          from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir }         from 'node:os'
import { join }           from 'node:path'

// ── Run a temp .ps1 file ──────────────────────────────────────────────────────

async function runPSFile(script: string): Promise<string> {
  const file = join(tmpdir(), `lili-sys-${Date.now()}.ps1`)
  // UTF-8 with BOM so PowerShell reads it correctly
  await fs.writeFile(file, '\ufeff' + script, 'utf-8')
  return new Promise((resolve, reject) => {
    const proc = spawn('powershell', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
      '-ExecutionPolicy', 'Bypass', '-File', file,
    ], { windowsHide: true })
    let out = '', err = ''
    proc.stdout.on('data', (d: Buffer) => { out += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { err += d.toString() })
    proc.on('error', (e) => { fs.unlink(file).catch(() => {}); reject(e) })
    proc.on('close', (code) => {
      fs.unlink(file).catch(() => {})
      if (code === 0) resolve(out.trim())
      else {
        console.error(`[System] PS error (exit ${code}):\n${err}`)
        reject(new Error(err.trim() || `PS exit ${code}`))
      }
    })
  })
}

// ── Core Audio COM script (shared) ───────────────────────────────────────────

const AUDIO_TYPE = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDevEnum {}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int _1();
    [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice dev);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int ctx, IntPtr p,
        [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
}

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
    int _1();  // RegisterControlChangeNotify
    int _2();  // UnregisterControlChangeNotify
    int _3();  // GetChannelCount
    int _4();  // SetMasterVolumeLevel (dB) — NOT the scalar one
    [PreserveSig] int SetMasterVolumeLevelScalar(float level, Guid ctx);  // slot 4
    int _5();  // GetMasterVolumeLevel (dB)
    [PreserveSig] int GetMasterVolumeLevelScalar(out float level);  // slot 6
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid ctx);  // slot 7
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);  // slot 8
}

public class WinVol {
    static IAudioEndpointVolume EP() {
        var e = (IMMDeviceEnumerator) new MMDevEnum();
        IMMDevice d; e.GetDefaultAudioEndpoint(0, 1, out d);
        var g = typeof(IAudioEndpointVolume).GUID;
        object o; d.Activate(ref g, 23, IntPtr.Zero, out o);
        return (IAudioEndpointVolume) o;
    }
    public static int  Get()      { float v; EP().GetMasterVolumeLevelScalar(out v); return (int)Math.Round(v*100); }
    public static void Set(int p) { EP().SetMasterVolumeLevelScalar(Math.Max(0,Math.Min(100,p))/100f, Guid.Empty); }
    public static bool Muted()    { bool m; EP().GetMute(out m); return m; }
    public static void Mute(bool m){ EP().SetMute(m, Guid.Empty); }
}
"@
`

// ── Media key via SendInput ───────────────────────────────────────────────────

const VK_MEDIA_PREV  = 0xB1
const VK_MEDIA_PLAY  = 0xB3
const VK_MEDIA_NEXT  = 0xB0
const VK_MEDIA_STOP  = 0xB2

const SENDINPUT_TYPE = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class MediaKey {
    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint   dwFlags;
        public uint   time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT {
        public uint type;
        public KEYBDINPUT ki;
        public long _pad;
    }

    [DllImport("user32.dll")]
    static extern uint SendInput(uint n, INPUT[] inputs, int size);

    public static void Send(ushort vk) {
        var dn = new INPUT { type=1, ki=new KEYBDINPUT{ wVk=vk, dwFlags=0 } };
        var up = new INPUT { type=1, ki=new KEYBDINPUT{ wVk=vk, dwFlags=2 } };
        SendInput(1, new INPUT[]{dn}, System.Runtime.InteropServices.Marshal.SizeOf(dn));
        System.Threading.Thread.Sleep(50);
        SendInput(1, new INPUT[]{up}, System.Runtime.InteropServices.Marshal.SizeOf(up));
    }
}
"@
`

// ── Public API ────────────────────────────────────────────────────────────────

export async function getVolume(): Promise<number> {
  try {
    const out = await runPSFile(`${AUDIO_TYPE}\n[WinVol]::Get()`)
    return Math.max(0, Math.min(100, parseInt(out) || 0))
  } catch (e) {
    console.error('[Vol] get:', e)
    return -1
  }
}

export async function setVolume(pct: number): Promise<void> {
  const n = Math.max(0, Math.min(100, Math.round(pct)))
  await runPSFile(`${AUDIO_TYPE}\n[WinVol]::Set(${n})`)
}

export async function adjustVolume(delta: number): Promise<number> {
  try {
    // Get current → add delta → set new value (no keybd_event needed)
    const cur = await getVolume()
    const next = Math.max(0, Math.min(100, (cur < 0 ? 50 : cur) + delta))
    await runPSFile(`${AUDIO_TYPE}\n[WinVol]::Set(${next})`)
    return next
  } catch (e) {
    console.error('[Vol] adjust:', e)
    return -1
  }
}

export async function toggleMute(): Promise<boolean> {
  try {
    const muted = await runPSFile(`${AUDIO_TYPE}\n[WinVol]::Muted()`)
    const nowMuted = muted.trim().toLowerCase() !== 'true'
    await runPSFile(`${AUDIO_TYPE}\n[WinVol]::Mute($${nowMuted})`)
    return nowMuted
  } catch (e) {
    console.error('[Vol] mute:', e)
    return false
  }
}

export async function setMute(mute: boolean): Promise<void> {
  await runPSFile(`${AUDIO_TYPE}\n[WinVol]::Mute($${mute})`)
}

// ── Brightness (WMI) ─────────────────────────────────────────────────────────

export async function getBrightness(): Promise<number> {
  try {
    const out = await runPSFile(`(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction Stop).CurrentBrightness`)
    return Math.max(0, Math.min(100, parseInt(out) || -1))
  } catch {
    return -1
  }
}

export async function setBrightness(pct: number): Promise<number> {
  const n = Math.max(0, Math.min(100, Math.round(pct)))
  try {
    const out = await runPSFile(`
$methods = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop
if (-not $methods) { throw "Brightness control is not available for this display." }
foreach ($m in $methods) {
  Invoke-CimMethod -InputObject $m -MethodName WmiSetBrightness -Arguments @{ Timeout = 1; Brightness = ${n} } -ErrorAction Stop | Out-Null
}
Start-Sleep -Milliseconds 300
$levels = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction Stop
if (-not $levels) { throw "Brightness level could not be read after setting." }
($levels | Select-Object -First 1).CurrentBrightness
`)
    const actual = Math.max(0, Math.min(100, parseInt(out) || -1))
    if (actual < 0) return -1
    return Math.abs(actual - n) <= 2 ? actual : -1
  } catch (e) {
    console.error('[Brightness] set:', e)
    return -1
  }
}

export async function adjustBrightness(delta: number): Promise<number> {
  const cur = await getBrightness()
  const next = Math.max(0, Math.min(100, (cur < 0 ? 50 : cur) + delta))
  return setBrightness(next)
}

// ── Window management ─────────────────────────────────────────────────────────

const WIN_SHELL_PS = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Text;

public class WinCtrl {
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    public static bool FocusByProcessName(string name) {
        bool found = false;
        EnumWindows((hWnd, lp) => {
            if (!IsWindowVisible(hWnd)) return true;
            uint pid; GetWindowThreadProcessId(hWnd, out pid);
            try {
                var proc = Process.GetProcessById((int)pid);
                if (proc.ProcessName.ToLower().Contains(name.ToLower())) {
                    ShowWindow(hWnd, 9); // SW_RESTORE
                    SetForegroundWindow(hWnd);
                    found = true; return false;
                }
            } catch {}
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
"@
`

export async function windowMinimizeAll(): Promise<void> {
  await runPSFile(`(New-Object -ComObject Shell.Application).MinimizeAll()`)
}

export async function windowRestoreAll(): Promise<void> {
  await runPSFile(`(New-Object -ComObject Shell.Application).UndoMinimizeAll()`)
}

export async function windowFocus(processName: string): Promise<boolean> {
  try {
    const out = await runPSFile(`${WIN_SHELL_PS}\n[WinCtrl]::FocusByProcessName("${processName.replace(/"/g, '')}")`)
    return out.trim().toLowerCase() === 'true'
  } catch {
    return false
  }
}

export async function windowClose(processName: string): Promise<void> {
  const safe = processName.replace(/[^a-zA-Zа-яА-Я0-9]/g, '')
  await runPSFile(`Get-Process -Name "*${safe}*" -ErrorAction SilentlyContinue | Stop-Process -Force`)
}

export type MediaAction = 'playpause' | 'next' | 'prev' | 'stop'

export async function mediaControl(action: MediaAction): Promise<void> {
  const map: Record<MediaAction, number> = {
    playpause: VK_MEDIA_PLAY,
    next:      VK_MEDIA_NEXT,
    prev:      VK_MEDIA_PREV,
    stop:      VK_MEDIA_STOP,
  }
  const vk = map[action]
  await runPSFile(`${SENDINPUT_TYPE}\n[MediaKey]::Send(${vk})`)
}

// ── Play in YouTube Music window ──────────────────────────────────────────────
// Polls for Chrome/Edge window with "YouTube Music" in title (up to 8s),
// then sends WM_APPCOMMAND APPCOMMAND_MEDIA_PLAY_PAUSE to trigger playback.

export async function playInYoutubeMusicWindow(): Promise<boolean> {
  const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class AppCmd {
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);
}
"@

\$WM_APPCOMMAND = 0x0319
\$APPCOMMAND_MEDIA_PLAY_PAUSE = 14

for (\$i = 0; \$i -lt 16; \$i++) {
    \$procs = Get-Process -Name "chrome","msedge" -ErrorAction SilentlyContinue | Where-Object { \$_.MainWindowTitle -like "*YouTube Music*" }
    if (\$procs) {
        \$hWnd = (\$procs | Select-Object -First 1).MainWindowHandle
        [AppCmd]::PostMessage(\$hWnd, \$WM_APPCOMMAND, \$hWnd, [IntPtr](\$APPCOMMAND_MEDIA_PLAY_PAUSE -shl 16))
        Write-Output "true"
        exit
    }
    Start-Sleep -Milliseconds 500
}
Write-Output "false"
`
  try {
    const out = await runPSFile(script)
    return out.trim().toLowerCase() === 'true'
  } catch (e) {
    console.error('[Music] playInYoutubeMusicWindow:', e)
    return false
  }
}
