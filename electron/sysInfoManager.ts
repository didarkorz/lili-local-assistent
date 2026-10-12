/**
 * sysInfoManager.ts — Windows system information via PowerShell
 */

import { spawn }          from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir }         from 'node:os'
import { join }           from 'node:path'

async function runPS(script: string): Promise<string> {
  const file = join(tmpdir(), `lili-si-${Date.now()}.ps1`)
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
      else reject(new Error(err.trim() || `PS exit ${code}`))
    })
  })
}

export interface SystemInfo {
  ram: { totalGb: number; usedGb: number; freeGb: number; usedPct: number }
  cpu: { usage: number; tempC: number | null }
  battery: { percent: number; charging: boolean } | null
  disk: { usedGb: number; totalGb: number; freePct: number } | null
}

export async function getSystemInfo(): Promise<SystemInfo> {
  const script = `
$os  = Get-CimInstance Win32_OperatingSystem
$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$bat = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue
$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'" -ErrorAction SilentlyContinue

# RAM
$totalMb = [math]::Round($os.TotalVisibleMemorySize / 1024, 1)
$freeMb  = [math]::Round($os.FreePhysicalMemory  / 1024, 1)
$usedMb  = [math]::Round($totalMb - $freeMb, 1)

# CPU temp (may require admin on some systems)
$tempC = "null"
try {
  $tz = Get-CimInstance -Namespace "root/wmi" -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop
  $raw = ($tz | Select-Object -First 1).CurrentTemperature
  $tempC = [math]::Round($raw / 10 - 273.15, 1)
} catch {}

# Battery
$batPct     = if ($bat) { $bat.EstimatedChargeRemaining } else { "null" }
$batStatus  = if ($bat) { $bat.BatteryStatus } else { "null" }

# Disk C:
$diskFreeGb  = if ($disk) { [math]::Round($disk.FreeSpace  / 1GB, 1) } else { "null" }
$diskTotalGb = if ($disk) { [math]::Round($disk.Size       / 1GB, 1) } else { "null" }

Write-Output "$totalMb|$usedMb|$freeMb|$cpu|$tempC|$batPct|$batStatus|$diskFreeGb|$diskTotalGb"
`

  const raw = await runPS(script)
  const [totalMb, usedMb, freeMb, cpuLoad, tempC, batPct, batStatus, diskFree, diskTotal] = raw.split('|')

  const toGb = (mb: string) => Math.round(parseFloat(mb) / 10.24) / 100  // MB → GB (1 decimal)

  const ramTotal = parseFloat(totalMb) / 1024
  const ramUsed  = parseFloat(usedMb)  / 1024
  const ramFree  = parseFloat(freeMb)  / 1024

  return {
    ram: {
      totalGb:  Math.round(ramTotal * 10) / 10,
      usedGb:   Math.round(ramUsed  * 10) / 10,
      freeGb:   Math.round(ramFree  * 10) / 10,
      usedPct:  Math.round((ramUsed / ramTotal) * 100),
    },
    cpu: {
      usage:  Math.round(parseFloat(cpuLoad) || 0),
      tempC:  tempC === 'null' ? null : parseFloat(tempC),
    },
    battery: batPct === 'null' ? null : {
      percent:  parseInt(batPct),
      // BatteryStatus: 1=discharging, 2=AC/charging, 3=fully charged
      charging: parseInt(batStatus) >= 2,
    },
    disk: diskFree === 'null' ? null : {
      usedGb:   Math.round((parseFloat(diskTotal) - parseFloat(diskFree)) * 10) / 10,
      totalGb:  parseFloat(diskTotal),
      freePct:  Math.round((parseFloat(diskFree) / parseFloat(diskTotal)) * 100),
    },
  }
  void toGb
}

function formatInfo(info: SystemInfo): string {
  const lines: string[] = []

  lines.push(`🖥️ **Система**`)

  const { ram } = info
  lines.push(`💾 RAM: **${ram.usedGb} / ${ram.totalGb} ГБ** (${ram.usedPct}% занято)`)

  const { cpu } = info
  const tempStr = cpu.tempC != null ? `, ${cpu.tempC}°C` : ''
  lines.push(`⚙️ CPU: **${cpu.usage}%**${tempStr}`)

  if (info.battery) {
    const b = info.battery
    const icon = b.charging ? '🔌' : b.percent > 20 ? '🔋' : '🪫'
    lines.push(`${icon} Батарея: **${b.percent}%** ${b.charging ? '(заряжается)' : ''}`)
  }

  if (info.disk) {
    const d = info.disk
    lines.push(`💿 Диск C: **${d.usedGb} / ${d.totalGb} ГБ** (${d.freePct}% свободно)`)
  }

  return lines.join('\n')
}

export async function getSystemInfoFormatted(): Promise<string> {
  try {
    const info = await getSystemInfo()
    return formatInfo(info)
  } catch (e) {
    console.error('[SysInfo]', e)
    return 'Не удалось получить системную информацию.'
  }
}
