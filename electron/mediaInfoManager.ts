/**
 * mediaInfoManager.ts
 * Gets currently playing track via Windows SMTC (System Media Transport Controls).
 * Works with Spotify, YouTube (browser), VLC, Windows Media Player, etc.
 */

import { spawn }          from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir }         from 'node:os'
import { join }           from 'node:path'

async function runPS(script: string): Promise<string> {
  const file = join(tmpdir(), `lili-mi-${Date.now()}.ps1`)
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
    proc.on('close', () => {
      fs.unlink(file).catch(() => {})
      resolve(out.trim())  // don't reject on non-zero — media might just be stopped
    })
  })
}

// ── SMTC via WinRT ────────────────────────────────────────────────────────────

const SMTC_SCRIPT = `
# Load WinRT support
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSession, Windows.Media.Control, ContentType=WindowsRuntime]

Add-Type -AssemblyName System.Runtime.WindowsRuntime

# Helper: convert WinRT IAsyncOperation to Task result
function AwaitTask([object]$asyncOp) {
    $t = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeSystemExtensions]::AsTask($asyncOp)
    $t.Wait(3000) | Out-Null
    if ($t.IsCompleted) { return $t.Result }
    return $null
}

try {
    $mgrTask = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()
    $mgr = AwaitTask $mgrTask
    if (-not $mgr) { Write-Output "none"; exit }

    $session = $mgr.GetCurrentSession()
    if (-not $session) { Write-Output "none"; exit }

    $propsTask = $session.TryGetMediaPropertiesAsync()
    $props = AwaitTask $propsTask
    if (-not $props) { Write-Output "none"; exit }

    $title  = if ($props.Title)  { $props.Title }  else { "" }
    $artist = if ($props.Artist) { $props.Artist } else { "" }
    $album  = if ($props.AlbumTitle) { $props.AlbumTitle } else { "" }

    # Playback status
    $pb = $session.GetPlaybackInfo()
    $status = if ($pb -and $pb.PlaybackStatus) { $pb.PlaybackStatus.ToString() } else { "Unknown" }

    Write-Output "$title|$artist|$album|$status"
} catch {
    # Fallback: check Spotify process window title
    $sp = Get-Process -Name "Spotify" -ErrorAction SilentlyContinue |
          Where-Object { $_.MainWindowTitle -ne "" -and $_.MainWindowTitle -ne "Spotify" } |
          Select-Object -First 1
    if ($sp) {
        Write-Output "$($sp.MainWindowTitle)||playing|spotify"
    } else {
        Write-Output "none"
    }
}
`

export interface TrackInfo {
  title:  string
  artist: string
  album:  string
  status: 'Playing' | 'Paused' | 'Stopped' | 'Unknown'
}

export async function getCurrentTrack(): Promise<TrackInfo | null> {
  try {
    const raw = await runPS(SMTC_SCRIPT)
    if (!raw || raw === 'none') return null

    const [title, artist, album, status] = raw.split('|')
    if (!title && !artist) return null

    return {
      title:  title  ?? '',
      artist: artist ?? '',
      album:  album  ?? '',
      status: (status ?? 'Unknown') as TrackInfo['status'],
    }
  } catch {
    return null
  }
}

export async function getCurrentTrackFormatted(): Promise<string> {
  const track = await getCurrentTrack()
  if (!track) return 'Сейчас ничего не играет.'

  const statusIcon =
    track.status === 'Playing' ? '▶️' :
    track.status === 'Paused'  ? '⏸️' : '⏹️'

  const lines: string[] = [`${statusIcon} **${track.title || 'Неизвестный трек'}**`]
  if (track.artist) lines.push(`🎤 ${track.artist}`)
  if (track.album)  lines.push(`💿 ${track.album}`)

  return lines.join('\n')
}
