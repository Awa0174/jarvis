/**
 * Server work: the user's machines, as tools.
 *
 *   server_list     which servers are configured
 *   server_status   load, memory, disk, services, containers — read-only
 *   server_logs     the tail of a log, for the model to summarise — read-only
 *   server_run      one command on a server — behind the confirmation card
 *   server_restart  restart one service or container — behind the card
 *
 * Reading is free; anything that changes a server goes through the card
 * like every other write, with the exact command on it. That is the policy
 * the user set for his servers in so many words: status and logs on demand,
 * restarts and changes only after his yes.
 *
 * Servers are described in ~/.jarvis/servers.json (see servers.example.json
 * in the repository), outside git. Two kinds:
 *
 *   ssh    — reached with the system OpenSSH client and a key. BatchMode, so
 *            a missing key fails fast instead of hanging on a password prompt.
 *   local  — this machine, through PowerShell.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const run = promisify(execFile)

export const SERVERS_FILE =
  process.env.JARVIS_SERVERS_FILE ?? join(homedir(), '.jarvis', 'servers.json')

const expandHome = (p) => String(p ?? '').replace(/^~(?=$|[\\/])/, homedir())

/** Read the list fresh on every call, so an edit to the file needs no restart. */
export function loadServers() {
  if (!existsSync(SERVERS_FILE)) return []
  try {
    const cfg = JSON.parse(readFileSync(SERVERS_FILE, 'utf8'))
    const list = Array.isArray(cfg) ? cfg : (cfg?.servers ?? [])
    return list.filter(
      (s) => s?.name && (s.kind === 'ssh' ? s.host : s.kind === 'pterodactyl' ? s.server : true),
    )
  } catch (err) {
    console.warn(`[servers] ${SERVERS_FILE} is not valid JSON: ${err?.message ?? err}`)
    return []
  }
}

const findServer = (name) => {
  const q = String(name ?? '').trim().toLowerCase()
  const list = loadServers()
  return list.find((s) => s.name.toLowerCase() === q) ?? list.find((s) => s.name.toLowerCase().includes(q))
}

const text = (t) => ({ content: [{ type: 'text', text: t }] })
const cap = (s, n = 12_000) => (s.length > n ? `${s.slice(0, n)}\n… (gekürzt)` : s)

// ---------------------------------------------------------------------------
// Running things
// ---------------------------------------------------------------------------

async function ssh(server, command, timeoutMs = 25_000) {
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'LogLevel=ERROR',
  ]
  if (server.port) args.push('-p', String(server.port))
  if (server.key) args.push('-i', expandHome(server.key))
  args.push(`${server.user ?? 'root'}@${server.host}`, command)
  try {
    const { stdout, stderr } = await run('ssh', args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
    return `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`.trim()
  } catch (err) {
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim()
    throw new Error(out || err?.message || String(err))
  }
}

async function local(command, timeoutMs = 25_000) {
  const encoded = Buffer.from(command, 'utf16le').toString('base64')
  try {
    const { stdout, stderr } = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    )
    return `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`.trim()
  } catch (err) {
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim()
    throw new Error(out || err?.message || String(err))
  }
}

const exec = (server, command, timeoutMs) =>
  server.kind === 'local' ? local(command, timeoutMs) : ssh(server, command, timeoutMs)

/** Shell-quote for the remote POSIX shell. */
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

// ---------------------------------------------------------------------------
// Pterodactyl panels (game-server hosting), through the client API
// ---------------------------------------------------------------------------

/**
 * A server behind a Pterodactyl panel has no SSH; the panel's client API is
 * the way in. The key is a *client* key made in the panel under Account →
 * API Credentials, and it lives in .env (JARVIS_PTERO_KEY, or the name the
 * server entry gives in `keyEnv`), never in the server list.
 */
function pteroAuth(server) {
  const panel = (server.panel ?? process.env.JARVIS_PTERO_URL ?? '').replace(/\/+$/, '')
  const key = process.env[server.keyEnv ?? 'JARVIS_PTERO_KEY']
  if (!panel) throw new Error('kein Panel: `panel` im Servereintrag oder JARVIS_PTERO_URL in .env fehlt')
  if (!key) throw new Error(`kein API-Schlüssel: ${server.keyEnv ?? 'JARVIS_PTERO_KEY'} in .env fehlt`)
  if (!server.server) throw new Error('`server` (die Kennung aus der Panel-URL) fehlt im Servereintrag')
  return { panel, key, id: server.server }
}

async function ptero(server, path, init = {}) {
  const { panel, key, id } = pteroAuth(server)
  const res = await fetch(`${panel}/api/client/servers/${id}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(20_000),
  })
  if (res.status === 204) return null
  const body = await res.text()
  if (!res.ok) {
    let detail = body.slice(0, 300)
    try {
      detail = JSON.parse(body)?.errors?.map((e) => e.detail).join('; ') ?? detail
    } catch {
      /* plain text */
    }
    throw new Error(`Panel antwortet ${res.status}: ${detail}`)
  }
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

const mb = (bytes) => `${Math.round((Number(bytes) || 0) / 1024 / 1024)} MB`
const dur = (ms) => {
  const s = Math.floor((Number(ms) || 0) / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h} h ${m} min` : `${m} min`
}

async function pteroStatus(server) {
  const [info, res] = await Promise.all([ptero(server, ''), ptero(server, '/resources')])
  const a = info?.attributes ?? {}
  const r = res?.attributes ?? {}
  const u = r.resources ?? {}
  const lim = a.limits ?? {}
  const lines = [
    `Server: ${a.name ?? server.name}${a.description ? ` — ${a.description}` : ''} (${a.node ?? 'Node ?'})`,
    `Zustand: ${r.current_state ?? 'unbekannt'}${r.is_suspended ? ' · GESPERRT' : ''}${u.uptime ? ` · läuft seit ${dur(u.uptime)}` : ''}`,
    `CPU: ${Math.round(Number(u.cpu_absolute) || 0)} %${lim.cpu ? ` von ${lim.cpu} %` : ''}`,
    `RAM: ${mb(u.memory_bytes)}${lim.memory ? ` von ${lim.memory} MB` : ''}`,
    `Platz: ${mb(u.disk_bytes)}${lim.disk ? ` von ${lim.disk} MB` : ''}`,
    `Netz: ${mb(u.network_rx_bytes)} empfangen, ${mb(u.network_tx_bytes)} gesendet`,
  ]
  const alloc = a.relationships?.allocations?.data?.find((x) => x.attributes?.is_default)?.attributes
  if (alloc) lines.push(`Adresse: ${alloc.ip_alias ?? alloc.ip}:${alloc.port}`)
  if (a.invocation) lines.push(`Start: ${String(a.invocation).slice(0, 160)}`)
  return lines.join('\n')
}

async function pteroLogs(server, source, lines, grep) {
  const file = String(source).startsWith('/') ? String(source) : `/${source}`
  const text = await ptero(server, `/files/contents?file=${encodeURIComponent(file)}`)
  const all = String(text).split(/\r?\n/)
  let picked = all.slice(-Math.max(10, Math.min(2000, lines)))
  if (grep) {
    const g = String(grep).toLowerCase()
    picked = picked.filter((l) => l.toLowerCase().includes(g))
  }
  return picked.join('\n')
}

async function pteroCommand(server, command) {
  await ptero(server, '/command', { method: 'POST', body: JSON.stringify({ command: String(command) }) })
  return `An die Konsole geschickt: ${command}`
}

async function pteroPower(server, signal) {
  const s = ['start', 'stop', 'restart', 'kill'].includes(signal) ? signal : 'restart'
  await ptero(server, '/power', { method: 'POST', body: JSON.stringify({ signal: s }) })
  await new Promise((r) => setTimeout(r, 2500))
  const res = await ptero(server, '/resources')
  return `Signal "${s}" gesendet. Zustand jetzt: ${res?.attributes?.current_state ?? 'unbekannt'}`
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function statusCommand(server) {
  if (server.kind === 'local') {
    const services = (server.services ?? []).map((s) => `'${s.replace(/'/g, "''")}'`).join(',')
    return `
$os = Get-CimInstance Win32_OperatingSystem
$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$up = (Get-Date) - $os.LastBootUpTime
"Laufzeit: $([int]$up.TotalHours) h $($up.Minutes) min · CPU $cpu % · RAM $([math]::Round(($os.TotalVisibleMemorySize-$os.FreePhysicalMemory)/1MB,1)) / $([math]::Round($os.TotalVisibleMemorySize/1MB,1)) GB"
Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null } | ForEach-Object { "Laufwerk $($_.Name): $([math]::Round($_.Free/1GB,0)) GB frei von $([math]::Round(($_.Used+$_.Free)/1GB,0)) GB" }
${services ? `foreach ($n in @(${services})) { $s = Get-Service -Name $n -ErrorAction SilentlyContinue; if ($s) { "Dienst $($n): $($s.Status)" } else { $p = Get-Process -Name $n -ErrorAction SilentlyContinue; if ($p) { "Prozess $($n): läuft ($($p.Count)x)" } else { "Dienst/Prozess $($n): nicht gefunden / nicht aktiv" } } }` : ''}
"Aktivste Prozesse: " + ((Get-Process | Sort-Object CPU -Descending | Select-Object -First 5 | ForEach-Object { "$($_.ProcessName) $([math]::Round($_.WorkingSet64/1MB,0)) MB" }) -join ', ')
`
  }
  const services = (server.services ?? []).map((s) => `echo "Dienst ${s}: $(systemctl is-active ${q(s)} 2>/dev/null || echo unbekannt)"`).join('; ')
  return [
    'echo "Host: $(hostname) · $(uptime -p 2>/dev/null || uptime)"',
    'echo "Last: $(cut -d" " -f1-3 /proc/loadavg) ($(nproc) CPUs)"',
    'free -m | awk \'/Mem:/ {printf "RAM: %d / %d MB belegt\\n", $3, $2}\'',
    'df -h / 2>/dev/null | awk \'NR==2 {printf "Platz /: %s frei von %s (%s belegt)\\n", $4, $2, $5}\'',
    services,
    server.docker ? 'command -v docker >/dev/null 2>&1 && docker ps --format "Container {{.Names}}: {{.Status}}" 2>/dev/null' : '',
    'echo "Top: $(ps -eo comm,%cpu,%mem --sort=-%cpu 2>/dev/null | head -6 | tail -5 | awk \'{printf "%s %s%%cpu %s%%mem; ", $1, $2, $3}\')"',
  ]
    .filter(Boolean)
    .join('; ')
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

/**
 * A log source as configured: "journal:<unit>", "docker:<container>",
 * "eventlog:<Application|System>" (local), or a file path.
 */
function logCommand(server, source, lines, grep) {
  const n = Math.max(10, Math.min(2000, lines))
  const src = String(source)
  if (server.kind === 'local') {
    const m = /^eventlog:(\w+)$/i.exec(src)
    if (m) {
      return `Get-WinEvent -LogName '${m[1]}' -MaxEvents ${n} -ErrorAction SilentlyContinue | Where-Object { $_.LevelDisplayName -in 'Fehler','Error','Warnung','Warning','Kritisch','Critical' ${grep ? `-and $_.Message -match '${grep.replace(/'/g, "''")}'` : ''} } | Select-Object -First ${Math.min(n, 200)} | ForEach-Object { "$($_.TimeCreated.ToString('dd.MM. HH:mm')) [$($_.LevelDisplayName)] $($_.ProviderName): $($_.Message -replace '\\s+',' ' | ForEach-Object { $_.Substring(0, [Math]::Min(220, $_.Length)) })" }`
    }
    const file = expandHome(src).replace(/'/g, "''")
    return `Get-Content -LiteralPath '${file}' -Tail ${n} -ErrorAction Stop ${grep ? `| Select-String -Pattern '${grep.replace(/'/g, "''")}' | ForEach-Object { $_.Line }` : ''}`
  }
  const g = grep ? ` | grep -i -- ${q(grep)}` : ''
  let m
  if ((m = /^journal:(.+)$/.exec(src))) return `journalctl -u ${q(m[1])} -n ${n} --no-pager -o short-iso 2>&1${g}`
  if ((m = /^docker:(.+)$/.exec(src))) return `docker logs --tail ${n} ${q(m[1])} 2>&1${g}`
  return `tail -n ${n} ${q(src)} 2>&1${g}`
}

// ---------------------------------------------------------------------------

export function serversServer() {
  return createSdkMcpServer({
    name: 'jarvis_servers',
    version: '1.0.0',
    instructions:
      'Die Server des Nutzers. server_status und server_logs lesen nur; ' +
      'server_run und server_restart verändern etwas und werden vom Interface ' +
      'bestätigt. Namen aus server_list.',
    alwaysLoad: true,
    tools: [
      tool(
        'server_list',
        'Welche Server eingerichtet sind, mit Art, Diensten und bekannten Logs.',
        {},
        async () => {
          const list = loadServers()
          if (!list.length) {
            return text(`Keine Server eingerichtet. Die Liste gehört nach ${SERVERS_FILE} (Vorlage: servers.example.json im Projekt).`)
          }
          return text(
            list
              .map((s) => {
                const where =
                  s.kind === 'local'
                    ? 'dieser PC'
                    : s.kind === 'pterodactyl'
                      ? `Panel ${(s.panel ?? process.env.JARVIS_PTERO_URL ?? '?').replace(/^https?:\/\//, '')}, Server ${s.server}`
                      : `${s.user ?? 'root'}@${s.host}${s.port ? `:${s.port}` : ''}`
                const svc = (s.services ?? []).join(', ') || '–'
                const logs = Object.keys(s.logs ?? {}).join(', ') || '–'
                return `${s.name} (${s.kind}, ${where}) · Dienste: ${svc} · Logs: ${logs}${s.note ? ` · ${s.note}` : ''}`
              })
              .join('\n'),
          )
        },
      ),

      tool(
        'server_status',
        'Zustand eines Servers: Laufzeit, Last, Arbeitsspeicher, Platz, die ' +
          'eingerichteten Dienste und Container, die aktivsten Prozesse. Nur lesend.',
        { name: z.string().describe('Der Servername aus server_list.') },
        async ({ name }) => {
          const s = findServer(name)
          if (!s) return text(`Kein Server namens "${name}". server_list zeigt die Namen.`)
          try {
            const out = s.kind === 'pterodactyl' ? await pteroStatus(s) : await exec(s, statusCommand(s))
            console.log(`[servers] status ${s.name}`)
            return text(cap(out || '(keine Ausgabe)'))
          } catch (err) {
            return text(`${s.name} nicht erreichbar: ${String(err?.message ?? err).slice(0, 400)}`)
          }
        },
      ),

      tool(
        'server_logs',
        'Das Ende eines Logs, um es zusammenzufassen. `log` ist ein Name aus der ' +
          'Serverliste (z. B. "gmod"), oder direkt journal:<unit>, docker:<container>, ' +
          'eventlog:System (nur lokal) oder ein Dateipfad. Nur lesend.',
        {
          name: z.string().describe('Der Servername.'),
          log: z.string().optional().describe('Welches Log. Fehlt es, das erste eingerichtete.'),
          lines: z.union([z.number(), z.string()]).optional().catch(undefined).describe('Wie viele Zeilen vom Ende, Standard 150.'),
          grep: z.string().optional().describe('Optional: nur Zeilen mit diesem Text (z. B. "error").'),
        },
        async ({ name, log, lines, grep }) => {
          const s = findServer(name)
          if (!s) return text(`Kein Server namens "${name}".`)
          const known = s.logs ?? {}
          const key = String(log ?? '').trim()
          const source = key ? (known[key] ?? known[Object.keys(known).find((k) => k.toLowerCase() === key.toLowerCase()) ?? ''] ?? key) : Object.values(known)[0]
          if (!source) return text(`Für ${s.name} ist kein Log eingerichtet; nenne journal:<unit>, docker:<container> oder einen Pfad.`)
          try {
            const n = Number(lines) || 150
            const g = grep ? String(grep) : ''
            const out =
              s.kind === 'pterodactyl'
                ? await pteroLogs(s, source, n, g)
                : await exec(s, logCommand(s, source, n, g), 40_000)
            console.log(`[servers] logs ${s.name} ${source}`)
            return text(cap(out || '(leer)'))
          } catch (err) {
            return text(`Log nicht lesbar: ${String(err?.message ?? err).slice(0, 400)}`)
          }
        },
      ),

      tool(
        'server_run',
        'Führe EINEN Befehl auf einem Server aus. Verändert etwas und wird deshalb ' +
          'vom Interface bestätigt; erkläre vorher, was der Befehl tut, warum, und ' +
          'was schiefgehen kann. Für reine Abfragen server_status oder server_logs nehmen.',
        {
          name: z.string().describe('Der Servername.'),
          command: z.string().describe('Der Befehl, wörtlich.'),
        },
        async ({ name, command }) => {
          const s = findServer(name)
          if (!s) return text(`Kein Server namens "${name}".`)
          try {
            const out =
              s.kind === 'pterodactyl' ? await pteroCommand(s, command) : await exec(s, String(command), 60_000)
            console.log(`[servers] run ${s.name}: ${String(command).slice(0, 120)}`)
            return text(cap(out || '(keine Ausgabe, Befehl beendet)'))
          } catch (err) {
            return text(`Fehlgeschlagen: ${String(err?.message ?? err).slice(0, 600)}`)
          }
        },
      ),

      tool(
        'server_restart',
        'Starte einen Dienst (systemd) oder Container (docker) auf einem Server neu; ' +
          'bei einem Panel-Server (pterodactyl) den Spielserver selbst, mit service = ' +
          'restart, start, stop oder kill. Wird vom Interface bestätigt; erkläre vorher, ' +
          'was neu startet und wen das trifft (Spieler fliegen raus).',
        {
          name: z.string().describe('Der Servername.'),
          service: z.string().describe('Dienstname, docker:<container>, oder bei Panel-Servern restart/start/stop/kill.'),
        },
        async ({ name, service }) => {
          const s = findServer(name)
          if (!s) return text(`Kein Server namens "${name}".`)
          const svc = String(service)
          if (s.kind === 'pterodactyl') {
            // On a panel the "service" is the game server itself; the word
            // names the power signal: restart (default), start, stop, kill.
            try {
              const out = await pteroPower(s, svc.toLowerCase())
              console.log(`[servers] power ${s.name} ${svc}`)
              return text(out)
            } catch (err) {
              return text(`Fehlgeschlagen: ${String(err?.message ?? err).slice(0, 600)}`)
            }
          }
          const m = /^docker:(.+)$/.exec(svc)
          const command =
            s.kind === 'local'
              ? `Restart-Service -Name '${svc.replace(/'/g, "''")}' -ErrorAction Stop; (Get-Service -Name '${svc.replace(/'/g, "''")}').Status`
              : m
                ? `docker restart ${q(m[1])} && docker ps --filter name=${q(m[1])} --format '{{.Names}}: {{.Status}}'`
                : `sudo -n systemctl restart ${q(svc)} 2>&1 || systemctl restart ${q(svc)} 2>&1; sleep 1; systemctl is-active ${q(svc)}`
          try {
            const out = await exec(s, command, 60_000)
            console.log(`[servers] restart ${s.name} ${svc}`)
            return text(cap(out || '(neu gestartet)'))
          } catch (err) {
            return text(`Neustart fehlgeschlagen: ${String(err?.message ?? err).slice(0, 600)}`)
          }
        },
      ),
    ],
  })
}
