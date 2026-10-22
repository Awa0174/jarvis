/**
 * PC help: the machine JARVIS runs on, as tools.
 *
 *   open_app       start an installed program by name
 *   open_path      open a file or folder with its default program
 *   find_files     search files by name, through the Windows search index
 *   see_screen     take a picture of the screen and look at it
 *   system_status  load, memory, disks, battery, uptime
 *   list_apps      what is installed, for "which programs do I have"
 *
 * None of these is put behind the confirmation card. The policy the user set
 * is "read-only by default; a change only on my direct order or after my
 * yes", and every tool here is one or the other: opening a program the user
 * just named is the order itself, and the rest only look. Nothing here
 * deletes, writes, installs or sends. open_path refuses executables, so
 * "open the file on my desktop" can never become "run that script".
 *
 * Windows only. Programs come from Get-StartApps, which lists both classic
 * desktop programs and Store apps with the id Explorer launches them by; the
 * list is cached and refreshed every ten minutes.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir, tmpdir, platform } from 'node:os'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'

const run = promisify(execFile)
const PORT = Number(process.env.JARVIS_BRIDGE_PORT ?? 8787)

/**
 * Run a PowerShell script and return its stdout. Encoded, so quoting is never
 * a problem, and with the execution policy bypassed for this one process —
 * the user's machine refuses .ps1 files, but an inline command is fine.
 */
async function ps(script, timeoutMs = 20_000) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const { stdout } = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
  )
  return stdout
}

const text = (t) => ({ content: [{ type: 'text', text: t }] })

// ---------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------

/** What people call things, mapped to what the Start menu calls them. */
const ALIASES = {
  chrome: 'google chrome',
  browser: 'microsoft edge',
  edge: 'microsoft edge',
  explorer: 'explorer',
  dateien: 'explorer',
  'datei explorer': 'explorer',
  notepad: 'editor',
  editor: 'editor',
  rechner: 'rechner',
  taschenrechner: 'rechner',
  calculator: 'rechner',
  einstellungen: 'einstellungen',
  settings: 'einstellungen',
  terminal: 'terminal',
  konsole: 'terminal',
  taskmanager: 'task-manager',
  'task manager': 'task-manager',
  code: 'visual studio code',
  vscode: 'visual studio code',
  'vs code': 'visual studio code',
  gmod: "garry's mod",
  garrysmod: "garry's mod",
  'garrys mod': "garry's mod",
  word: 'word',
  excel: 'excel',
  powerpoint: 'powerpoint',
  outlook: 'outlook',
  paint: 'paint',
}

/** Classic programs that may be absent from the Start menu but always run. */
const BUILTIN = {
  editor: 'notepad.exe',
  notepad: 'notepad.exe',
  rechner: 'calc.exe',
  paint: 'mspaint.exe',
  'task-manager': 'taskmgr.exe',
  terminal: 'wt.exe',
  cmd: 'cmd.exe',
  powershell: 'powershell.exe',
  explorer: 'explorer.exe',
  einstellungen: 'ms-settings:',
}

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

let appCache = { at: 0, apps: [] }
const APP_CACHE_MS = 10 * 60 * 1000

async function apps() {
  if (Date.now() - appCache.at < APP_CACHE_MS && appCache.apps.length) return appCache.apps
  try {
    const out = await ps('Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress')
    const list = JSON.parse(out || '[]')
    appCache = {
      at: Date.now(),
      apps: (Array.isArray(list) ? list : [list])
        .filter((a) => a?.Name && a?.AppID)
        .map((a) => ({ name: String(a.Name), id: String(a.AppID), key: norm(a.Name) })),
    }
  } catch (err) {
    console.warn(`[pc] Get-StartApps failed: ${err?.message ?? err}`)
  }
  return appCache.apps
}

/** Best matches for a spoken name, best first. */
function matchApps(list, wanted) {
  const q = norm(ALIASES[norm(wanted)] ?? wanted)
  if (!q) return []
  const exact = list.filter((a) => a.key === q)
  if (exact.length) return exact
  const starts = list.filter((a) => a.key.startsWith(q))
  if (starts.length) return starts
  const contains = list.filter((a) => a.key.includes(q))
  if (contains.length) return contains
  // Every word of the request somewhere in the name: "visual code" -> VS Code.
  const words = q.split(' ')
  return list.filter((a) => words.every((w) => a.key.includes(w)))
}

function launchDetached(file, args) {
  const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.on('error', (err) => console.warn(`[pc] launch failed: ${err?.message ?? err}`))
  child.unref()
}

function launchApp(app) {
  // Entries that are links (steam://…, http://…) open as the link itself.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(app.id)) {
    launchDetached('cmd.exe', ['/c', 'start', '', app.id])
    return
  }
  launchDetached('explorer.exe', [`shell:AppsFolder\\${app.id}`])
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** Opening one of these "with its default program" means running it. */
const EXECUTABLE = new Set([
  '.exe', '.msi', '.bat', '.cmd', '.ps1', '.vbs', '.js', '.jse', '.wsf', '.wsh',
  '.scr', '.com', '.pif', '.reg', '.lnk', '.url', '.hta', '.msc', '.cpl', '.jar',
  '.py', '.pyw', '.sh', '.appx', '.appxbundle', '.msix', '.dll',
])

const expandHome = (p) => String(p ?? '').replace(/^~(?=$|[\\/])/, homedir())

const SKIP_DIRS = new Set(['node_modules', '.git', 'appdata', '$recycle.bin', 'windows', 'program files', 'program files (x86)'])

/** The fallback when the search index is unavailable: a bounded walk. */
function walkFind(root, needle, max, budgetMs) {
  const hits = []
  const deadline = Date.now() + budgetMs
  const q = needle.toLowerCase()
  const stack = [{ dir: root, depth: 0 }]
  while (stack.length && hits.length < max && Date.now() < deadline) {
    const { dir, depth } = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (depth < 6 && !SKIP_DIRS.has(e.name.toLowerCase())) stack.push({ dir: full, depth: depth + 1 })
        continue
      }
      if (e.name.toLowerCase().includes(q)) {
        try {
          const st = statSync(full)
          hits.push({ path: full, size: st.size, modified: st.mtime.toISOString() })
        } catch {
          /* vanished */
        }
        if (hits.length >= max) break
      }
    }
  }
  return hits
}

/** Windows Search, through its OLE DB provider: instant, and it knows the
 *  user's folders, mail attachments and OneDrive without walking anything. */
async function indexFind(scope, needle, max) {
  const q = needle.replace(/'/g, "''").replace(/[%_\[\]]/g, ' ').trim()
  const script = `
$c = New-Object -ComObject ADODB.Connection
$r = New-Object -ComObject ADODB.Recordset
$c.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';")
$sql = "SELECT TOP ${max} System.ItemPathDisplay, System.Size, System.DateModified FROM SYSTEMINDEX WHERE System.FileName LIKE '%${q}%' AND SCOPE='file:${scope.replace(/'/g, "''")}' ORDER BY System.DateModified DESC"
$r.Open($sql, $c)
$out = @()
while (-not $r.EOF) {
  $out += [pscustomobject]@{ path = $r.Fields.Item('System.ItemPathDisplay').Value; size = $r.Fields.Item('System.Size').Value; modified = $r.Fields.Item('System.DateModified').Value }
  $r.MoveNext()
}
$r.Close(); $c.Close()
ConvertTo-Json -Compress -InputObject @($out)
`
  const out = await ps(script, 15_000)
  const list = JSON.parse(out || '[]')
  return (Array.isArray(list) ? list : [list]).filter((h) => h?.path)
}

const fmtSize = (n) => {
  const b = Number(n) || 0
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`
}
const fmtDate = (d) => {
  const t = new Date(d)
  return Number.isNaN(t.getTime()) ? '' : t.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

async function captureScreen(which, maxWidth) {
  const file = join(tmpdir(), `jarvis-screen-${Date.now()}.png`)
  const script = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class DpiFix { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[void][DpiFix]::SetProcessDPIAware()
$b = ${which === 'all' ? '[System.Windows.Forms.SystemInformation]::VirtualScreen' : '[System.Windows.Forms.Screen]::PrimaryScreen.Bounds'}
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$g.Dispose()
$scale = [Math]::Min(1.0, ${maxWidth} / $bmp.Width)
if ($scale -lt 1) {
  $w = [int]($bmp.Width * $scale); $h = [int]($bmp.Height * $scale)
  $small = New-Object System.Drawing.Bitmap $w, $h
  $g2 = [System.Drawing.Graphics]::FromImage($small)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($bmp, 0, 0, $w, $h); $g2.Dispose(); $bmp.Dispose(); $bmp = $small
}
$bmp.Save('${file.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
"$($b.Width)x$($b.Height)"
`
  const dims = (await ps(script, 20_000)).trim()
  return { file, dims }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const STATUS_SCRIPT = `
$os = Get-CimInstance Win32_OperatingSystem
$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$up = (Get-Date) - $os.LastBootUpTime
$disks = Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null } | ForEach-Object { "$($_.Name): $([math]::Round($_.Free/1GB,0)) GB frei von $([math]::Round(($_.Used+$_.Free)/1GB,0)) GB" }
$bat = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
$top = Get-Process | Sort-Object CPU -Descending | Select-Object -First 5 | ForEach-Object { "$($_.ProcessName) ($([math]::Round($_.WorkingSet64/1MB,0)) MB)" }
"CPU: $cpu %"
"RAM: $([math]::Round(($os.TotalVisibleMemorySize-$os.FreePhysicalMemory)/1MB,1)) GB belegt von $([math]::Round($os.TotalVisibleMemorySize/1MB,1)) GB"
"Laufwerke: " + ($disks -join '; ')
if ($bat) { "Akku: $($bat.EstimatedChargeRemaining) %" + $(if ($bat.BatteryStatus -eq 2) { ' (lädt)' } else { '' }) } else { "Akku: keiner (Desktop)" }
"Laufzeit: $([int]$up.TotalHours) h $($up.Minutes) min"
"Aktivste Prozesse: " + ($top -join ', ')
`

// ---------------------------------------------------------------------------

export function pcServer() {
  const windows = platform() === 'win32'
  return createSdkMcpServer({
    name: 'jarvis_pc',
    version: '1.0.0',
    instructions:
      'Der Rechner, auf dem JARVIS läuft: Programme öffnen, Dateien finden, den ' +
      'Bildschirm ansehen, den Systemzustand prüfen. Keines dieser Werkzeuge ' +
      'verändert oder löscht etwas.',
    alwaysLoad: true,
    tools: [
      tool(
        'open_app',
        'Öffne ein installiertes Programm, so wie der Nutzer es nennt: "Chrome", ' +
          '"Spotify", "Rechner", "Einstellungen", "Garry\'s Mod". Findet den Eintrag ' +
          'im Startmenü oder unter den Store-Apps und startet ihn. Bei mehreren ' +
          'Treffern wird nichts gestartet, sondern die Kandidaten zurückgegeben.',
        { name: z.string().describe('Der Programmname, wie gesprochen.') },
        async ({ name }) => {
          if (!windows) return text('Nur unter Windows verfügbar.')
          const list = await apps()
          const hits = matchApps(list, name)
          if (hits.length === 1) {
            launchApp(hits[0])
            console.log(`[pc] open_app "${name}" → ${hits[0].name}`)
            return text(`Gestartet: ${hits[0].name}`)
          }
          if (hits.length > 1) {
            const names = hits.slice(0, 6).map((h) => h.name)
            // Several with the same name usually are the same thing twice.
            if (new Set(names.map(norm)).size === 1) {
              launchApp(hits[0])
              return text(`Gestartet: ${hits[0].name}`)
            }
            return text(`Mehrdeutig, bitte den Nutzer wählen lassen: ${names.join(' | ')}`)
          }
          const builtin = BUILTIN[norm(ALIASES[norm(name)] ?? name)]
          if (builtin) {
            launchDetached('cmd.exe', ['/c', 'start', '', builtin])
            console.log(`[pc] open_app "${name}" → ${builtin}`)
            return text(`Gestartet: ${builtin}`)
          }
          return text(`Kein installiertes Programm passt zu "${name}". list_apps zeigt, was es gibt.`)
        },
      ),

      tool(
        'list_apps',
        'Welche Programme installiert sind. Optional gefiltert nach einem Wort.',
        { filter: z.string().optional().describe('Optional: ein Teil des Namens.') },
        async ({ filter }) => {
          const list = await apps()
          const q = norm(filter)
          const names = list
            .filter((a) => !q || a.key.includes(q))
            .map((a) => a.name)
            .sort((a, b) => a.localeCompare(b, 'de'))
          if (!names.length) return text('Nichts gefunden.')
          return text(`${names.length} Programme: ${names.slice(0, 80).join(', ')}${names.length > 80 ? ' …' : ''}`)
        },
      ),

      tool(
        'open_path',
        'Öffne eine Datei mit ihrem Standardprogramm oder einen Ordner im Explorer. ' +
          'Absoluter Pfad, zum Beispiel aus einem find_files-Ergebnis. Programme und ' +
          'Skripte werden nicht gestartet.',
        { path: z.string().describe('Absoluter Pfad zu Datei oder Ordner.') },
        async ({ path }) => {
          const p = resolve(expandHome(path))
          if (!isAbsolute(p) || !existsSync(p)) return text(`Gibt es nicht: ${p}`)
          const st = statSync(p)
          if (st.isDirectory()) {
            launchDetached('explorer.exe', [p])
            return text(`Ordner geöffnet: ${p}`)
          }
          if (EXECUTABLE.has(extname(p).toLowerCase())) {
            return text(`Nicht geöffnet: ${p} ist ein Programm oder Skript, und die laufen hier nicht per Zuruf.`)
          }
          launchDetached('cmd.exe', ['/c', 'start', '', p])
          console.log(`[pc] open_path ${p}`)
          return text(`Geöffnet: ${p}`)
        },
      ),

      tool(
        'find_files',
        'Suche Dateien nach einem Teil des Namens, über den Windows-Suchindex, ' +
          'neueste zuerst. Standardmäßig im Benutzerordner (Desktop, Dokumente, ' +
          'Downloads, Bilder, OneDrive …). Gibt Pfad, Größe und Änderungsdatum zurück.',
        {
          query: z.string().describe('Ein Teil des Dateinamens, z. B. "rechnung" oder ".pdf".'),
          folder: z.string().optional().describe('Optional: nur in diesem Ordner suchen.'),
          max: z.union([z.number(), z.string()]).optional().catch(undefined).describe('Höchstens so viele Treffer, Standard 15.'),
        },
        async ({ query, folder, max }) => {
          const q = String(query ?? '').trim()
          if (!q) return text('Wonach soll gesucht werden?')
          const limit = Math.max(1, Math.min(50, Number(max) || 15))
          const scope = resolve(expandHome(folder || homedir()))
          let hits = []
          let via = 'index'
          try {
            hits = await indexFind(scope, q, limit)
          } catch (err) {
            console.warn(`[pc] search index unavailable (${err?.message ?? err}); walking instead`)
          }
          if (!hits.length) {
            via = 'walk'
            hits = walkFind(scope, q, limit, 5000)
          }
          console.log(`[pc] find_files "${q}" in ${scope} → ${hits.length} (${via})`)
          if (!hits.length) return text(`Keine Datei mit "${q}" im Namen unter ${scope}.`)
          return text(
            hits.map((h) => `${h.path} — ${fmtSize(h.size)} — ${fmtDate(h.modified)}`).join('\n'),
          )
        },
      ),

      tool(
        'see_screen',
        'Nimm ein Bild vom Bildschirm auf und sieh es dir an. Nur wenn der Nutzer ' +
          'ausdrücklich wissen will, was auf dem Bildschirm ist, oder dich bittet ' +
          'hinzusehen. Gibt das Bild und eine Adresse zurück, unter der es als Blade ' +
          '(kind "image") gezeigt werden kann.',
        {
          screen: z.enum(['primary', 'all']).optional().catch(undefined).describe('primary = Hauptbildschirm (Standard), all = alle Bildschirme.'),
        },
        async ({ screen }) => {
          if (!windows) return text('Nur unter Windows verfügbar.')
          try {
            const { file, dims } = await captureScreen(screen === 'all' ? 'all' : 'primary', 1600)
            const data = readFileSync(file).toString('base64')
            const url = `http://localhost:${PORT}/file?path=${encodeURIComponent(file)}`
            console.log(`[pc] see_screen ${dims} → ${file}`)
            return {
              content: [
                { type: 'image', data, mimeType: 'image/png' },
                { type: 'text', text: `Bildschirm ${dims}. Als Blade zeigen mit url: ${url}` },
              ],
            }
          } catch (err) {
            return text(`Die Aufnahme ist fehlgeschlagen: ${err?.message ?? err}`)
          }
        },
      ),

      tool(
        'system_status',
        'Auslastung von CPU und Arbeitsspeicher, freier Platz auf den Laufwerken, ' +
          'Akku, Laufzeit seit dem Start und die aktivsten Programme.',
        {},
        async () => {
          if (!windows) return text('Nur unter Windows verfügbar.')
          try {
            return text((await ps(STATUS_SCRIPT, 20_000)).trim())
          } catch (err) {
            return text(`Status nicht lesbar: ${err?.message ?? err}`)
          }
        },
      ),
    ],
  })
}

/** Warm the program list at boot so the first "öffne …" does not wait on it. */
export function warmPc() {
  if (platform() === 'win32') void apps()
}
