/**
 * JARVIS's memory across sessions.
 *
 * One plain text file, one fact per line, in the user's home directory and
 * nowhere near the repository. It is read into the system prompt when a
 * session opens, so everything he knows is in front of him from the first
 * word, and it grows through three tools: `remember` appends a fact, `forget`
 * removes the lines that match a phrase, `recall` reads it back.
 *
 * Plain text on purpose: the user can open the file, read every line and
 * delete what he does not want known, with nothing more than Notepad.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const MEMORY_FILE =
  process.env.JARVIS_MEMORY_FILE ?? join(homedir(), '.jarvis', 'memory.md')

/** Lines that hold a fact: "- [2026-10-22] …". Headings and blanks are skipped. */
const FACT = /^- \[(\d{4}-\d{2}-\d{2})\] (.+)$/

function readLines() {
  if (!existsSync(MEMORY_FILE)) return []
  return readFileSync(MEMORY_FILE, 'utf8')
    .split(/\r?\n/)
    .filter((l) => FACT.test(l))
}

function writeLines(lines) {
  mkdirSync(dirname(MEMORY_FILE), { recursive: true })
  const body =
    '# Was JARVIS über dich weiß\n' +
    '# Eine Zeile pro Fakt. Zeilen löschen ist erlaubt; er merkt es beim nächsten Start.\n\n' +
    lines.join('\n') +
    (lines.length ? '\n' : '')
  writeFileSync(MEMORY_FILE, body, 'utf8')
}

const today = () => new Date().toISOString().slice(0, 10)
const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim()

/** The block appended to the system prompt when a session opens. */
export function memoryPrompt() {
  const lines = readLines()
  const facts = lines.length
    ? lines.map((l) => l.replace(FACT, '- $2 (seit $1)')).join('\n')
    : '- Noch nichts. Du lernst ihn gerade kennen.'
  return `

Gedächtnis:
- Du hast ein dauerhaftes Gedächtnis über Sitzungen hinweg; was du über den
  Nutzer weißt, steht unten. Nutze es stillschweigend. Zähle es nicht auf,
  außer er fragt, was du über ihn weißt — dann mit recall.
- Sagt er etwas über sich, seine Projekte, Server, Geräte, Vorlieben,
  Gewohnheiten, Namen oder Termine, das später wichtig sein könnte, speichere
  es sofort mit remember, als einen knappen Satz, ohne nachzufragen. Danach
  genau ein Wort: „Notiert.“ Keine Belanglosigkeiten, nichts doppelt.
- Sagt er „merk dir …“, speichere genau das. Sagt er „vergiss …“, benutze
  forget. Beides braucht keine Bestätigung; das Gedächtnis gehört ihm.

Bekannt über den Nutzer (Stand ${today()}):
${facts}`
}

export function memoryServer() {
  return createSdkMcpServer({
    name: 'jarvis_memory',
    version: '1.0.0',
    instructions:
      'Dauerhaftes Gedächtnis über den Nutzer. remember speichert einen Fakt, ' +
      'forget löscht passende Fakten, recall liest sie.',
    alwaysLoad: true,
    tools: [
      tool(
        'remember',
        'Speichere einen Fakt über den Nutzer dauerhaft: etwas über ihn, seine ' +
          'Projekte, Server, Geräte, Vorlieben, Gewohnheiten, Namen oder Termine. ' +
          'Ein knapper deutscher Satz pro Aufruf, in der dritten Person ' +
          '("Sein Hauptprojekt ist …"). Nichts Belangloses, nichts doppelt.',
        { fact: z.string().describe('Der Fakt, ein Satz.') },
        async ({ fact }) => {
          const clean = String(fact ?? '').replace(/\s+/g, ' ').trim()
          if (!clean) return { content: [{ type: 'text', text: 'Nichts zu speichern.' }] }
          const lines = readLines()
          if (lines.some((l) => norm(l.replace(FACT, '$2')) === norm(clean))) {
            return { content: [{ type: 'text', text: 'Das ist bereits gespeichert.' }] }
          }
          lines.push(`- [${today()}] ${clean}`)
          writeLines(lines)
          console.log(`[memory] + ${clean}`)
          return { content: [{ type: 'text', text: `Gespeichert: ${clean}` }] }
        },
      ),
      tool(
        'forget',
        'Lösche gespeicherte Fakten, die eine Formulierung enthalten. Nur auf ' +
          'Wunsch des Nutzers, oder wenn ein Fakt durch einen neuen ersetzt wird.',
        { match: z.string().describe('Ein Wort oder Satzteil, das im Fakt vorkommt.') },
        async ({ match }) => {
          const needle = norm(String(match ?? ''))
          if (!needle) return { content: [{ type: 'text', text: 'Nichts angegeben.' }] }
          const lines = readLines()
          const kept = lines.filter((l) => !norm(l).includes(needle))
          const gone = lines.length - kept.length
          if (gone) {
            writeLines(kept)
            console.log(`[memory] - ${gone} × "${match}"`)
          }
          return {
            content: [
              { type: 'text', text: gone ? `${gone} Eintrag/Einträge gelöscht.` : 'Dazu ist nichts gespeichert.' },
            ],
          }
        },
      ),
      tool(
        'recall',
        'Lies das Gedächtnis: alles, oder nur Fakten, die eine Formulierung enthalten.',
        { match: z.string().optional().describe('Optional: ein Wort, nach dem gefiltert wird.') },
        async ({ match }) => {
          const needle = norm(String(match ?? ''))
          const lines = readLines().filter((l) => !needle || norm(l).includes(needle))
          return {
            content: [
              {
                type: 'text',
                text: lines.length ? lines.join('\n') : 'Dazu ist nichts gespeichert.',
              },
            ],
          }
        },
      ),
    ],
  })
}
