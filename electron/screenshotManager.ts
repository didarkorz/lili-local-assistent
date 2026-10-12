/**
 * screenshotManager.ts
 *
 * Captures the primary screen via PowerShell + System.Drawing and saves a PNG
 * to userData/screenshots/lili-YYYY-MM-DD-HH-mm-ss.png
 */

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app, shell } from 'electron'

function screenshotsDir(): string {
  return join(app.getPath('userData'), 'screenshots')
}

function timestamp(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  )
}

export interface ScreenshotResult {
  success: boolean
  path?: string
  error?: string
}

export async function takeScreenshot(): Promise<ScreenshotResult> {
  const dir = screenshotsDir()
  await fs.mkdir(dir, { recursive: true })

  const outPath = join(dir, `lili-${timestamp()}.png`)
  // Escape backslashes for PowerShell string
  const psPath = outPath.replace(/\\/g, '\\\\')

  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp    = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g      = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save("${psPath}")
$g.Dispose()
$bmp.Dispose()
Write-Output "OK"
`

  const tmpFile = join(tmpdir(), `lili-screenshot-${Date.now()}.ps1`)
  await fs.writeFile(tmpFile, '\ufeff' + script, 'utf-8')

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''

    const proc = spawn('powershell', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
      '-ExecutionPolicy', 'Bypass', '-File', tmpFile,
    ], { windowsHide: true })

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    proc.on('error', (e) => {
      fs.unlink(tmpFile).catch(() => {})
      resolve({ success: false, error: e.message })
    })

    proc.on('close', (code) => {
      fs.unlink(tmpFile).catch(() => {})
      if (code === 0 && stdout.includes('OK')) {
        resolve({ success: true, path: outPath })
      } else {
        resolve({ success: false, error: stderr.trim() || `exit ${code}` })
      }
    })
  })
}

export async function openScreenshotsFolder(): Promise<void> {
  const dir = screenshotsDir()
  await fs.mkdir(dir, { recursive: true })
  await shell.openPath(dir)
}
