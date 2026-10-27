/**
 * Customer acquisition: the business profile, a knowledge base, a small CRM,
 * tasks, drafts, and the weekly figures — the "Marketing-Jarvis" concept,
 * stage one, on the existing bridge.
 *
 * Everything lives under ~/.jarvis/business, outside the repository:
 *
 *   profil.md        the ten fields of the business profile, filled in by
 *                    conversation (profile_set) or by hand
 *   wissen/          the knowledge base: plain .md/.txt files, searched by
 *                    keyword, every hit cited with its file and date
 *   kunden.sqlite    contacts, activities, tasks (node:sqlite, no native dep)
 *   entwuerfe/       drafts — posts, replies, offers — waiting for a human
 *
 * Rules the tools enforce rather than the prompt alone:
 *   - a company is created once; a second add with the same name or website
 *     returns the existing record instead of a duplicate
 *   - "researched" and "may be contacted" are separate fields; consent is
 *     per channel and carries its basis
 *   - a blocked contact stays blocked: its open tasks are cancelled and
 *     lead_list marks it, so no follow-up is scheduled by accident
 *   - a score is a work priority capped per criterion, never a probability
 *
 * None of this sends anything. Sending, posting and publishing happen in
 * the Gmail connector or elsewhere and go through the confirmation card.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const BUSINESS_DIR = process.env.JARVIS_BUSINESS_DIR ?? join(homedir(), '.jarvis', 'business')
const PROFILE = join(BUSINESS_DIR, 'profil.md')
const KNOWLEDGE = join(BUSINESS_DIR, 'wissen')
const DRAFTS = join(BUSINESS_DIR, 'entwuerfe')
const DB_FILE = join(BUSINESS_DIR, 'kunden.sqlite')

const text = (t) => ({ content: [{ type: 'text', text: t }] })
const now = () => new Date().toISOString()
const today = () => new Date().toISOString().slice(0, 10)
const fmt = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
}
const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/https?:\/\/(www\.)?/g, '')
    .replace(/\b(gmbh|ag|ug|kg|ohg|e\.?k\.?|inc|ltd|llc|co)\b\.?/g, ' ')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

const PROFILE_FIELDS = ['Angebot', 'Zielgruppe', 'Problem', 'Ergebnis', 'Preis', 'Nachweise', 'Gebiet', 'Ton', 'Grenzen', 'Kapazität']

function readProfile() {
  mkdirSync(BUSINESS_DIR, { recursive: true })
  const raw = existsSync(PROFILE) ? readFileSync(PROFILE, 'utf8') : ''
  const out = {}
  for (const f of PROFILE_FIELDS) {
    const m = new RegExp(`^${f}:\\s*(.*)$`, 'mi').exec(raw)
    out[f] = (m?.[1] ?? '').trim()
  }
  return out
}

function writeProfile(p) {
  const body =
    '# Geschäftsprofil\n\nJarvis füllt diese Datei im Gespräch („Jarvis, lass uns mein Angebot festlegen“).\n' +
    'Du kannst sie auch selbst bearbeiten; eine Zeile je Punkt, hinter dem Doppelpunkt.\n\n' +
    PROFILE_FIELDS.map((f) => `${f}: ${p[f] ?? ''}`).join('\n') +
    '\n'
  writeFileSync(PROFILE, body, 'utf8')
}

/** The profile as a prompt block: what is known, and what is still missing. */
export function profilePrompt() {
  const p = readProfile()
  const known = PROFILE_FIELDS.filter((f) => p[f])
  const missing = PROFILE_FIELDS.filter((f) => !p[f])
  if (!known.length) return '\nGeschäftsprofil: noch leer. Biete an, es im Gespräch festzulegen (profile_set), Punkt für Punkt.'
  return (
    '\nGeschäftsprofil (aus profil.md):\n' +
    known.map((f) => `- ${f}: ${p[f]}`).join('\n') +
    (missing.length ? `\nNoch offen: ${missing.join(', ')}.` : '')
  )
}

// ---------------------------------------------------------------------------
// Knowledge base
// ---------------------------------------------------------------------------

function knowledgeFiles() {
  mkdirSync(KNOWLEDGE, { recursive: true })
  return readdirSync(KNOWLEDGE)
    .filter((f) => /\.(md|txt)$/i.test(f) && !/^liesmich/i.test(f))
    .map((f) => join(KNOWLEDGE, f))
}

function knowledgeSearch(query, max) {
  const words = norm(query).split(' ').filter((w) => w.length > 2)
  if (!words.length) return []
  const hits = []
  for (const file of knowledgeFiles()) {
    const mtime = statSync(file).mtime
    const paras = readFileSync(file, 'utf8').split(/\n\s*\n/)
    for (const para of paras) {
      const p = norm(para)
      if (!p) continue
      let score = 0
      for (const w of words) if (p.includes(w)) score += 1 + (p.split(w).length - 1) * 0.2
      if (score > 0) hits.push({ file, mtime, score, para: para.trim() })
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, max)
}

// ---------------------------------------------------------------------------
// CRM
// ---------------------------------------------------------------------------

export const STATUSES = ['neu', 'geprüft', 'anfrage', 'kontakt_zulässig', 'gespräch', 'angebot', 'gewonnen', 'verloren']

let db = null
function open() {
  if (db) return db
  mkdirSync(BUSINESS_DIR, { recursive: true })
  db = new DatabaseSync(DB_FILE)
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company TEXT NOT NULL, contact TEXT, email TEXT, phone TEXT, website TEXT,
      industry TEXT, region TEXT, source TEXT, source_date TEXT,
      need TEXT, evidence TEXT, gaps TEXT,
      score INTEGER, score_notes TEXT,
      status TEXT NOT NULL DEFAULT 'neu',
      consent_email INTEGER NOT NULL DEFAULT 0, consent_phone INTEGER NOT NULL DEFAULT 0, consent_basis TEXT,
      blocked INTEGER NOT NULL DEFAULT 0, blocked_reason TEXT,
      value REAL, outcome TEXT, lost_reason TEXT,
      next_step TEXT, next_step_at TEXT, last_activity TEXT,
      created TEXT NOT NULL, updated TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER, text TEXT NOT NULL, due TEXT, done INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL
    );
  `)
  return db
}

const COLUMNS = [
  'company', 'contact', 'email', 'phone', 'website', 'industry', 'region', 'source', 'source_date',
  'need', 'evidence', 'gaps', 'status', 'consent_email', 'consent_phone', 'consent_basis',
  'blocked', 'blocked_reason', 'value', 'outcome', 'lost_reason', 'next_step', 'next_step_at',
]

function findContact(ref) {
  const d = open()
  const r = String(ref ?? '').trim()
  if (!r) return null
  if (/^\d+$/.test(r)) {
    const byId = d.prepare('SELECT * FROM contacts WHERE id = ?').get(Number(r))
    if (byId) return byId
  }
  const n = norm(r)
  const all = d.prepare('SELECT * FROM contacts').all()
  return (
    all.find((c) => norm(c.company) === n) ??
    all.find((c) => norm(c.website) === n || (c.contact && norm(c.contact) === n)) ??
    all.find((c) => norm(c.company).includes(n)) ??
    null
  )
}

function duplicateOf(company, website) {
  const d = open()
  const nc = norm(company)
  const nw = norm(website)
  for (const c of d.prepare('SELECT * FROM contacts').all()) {
    if (nc && norm(c.company) === nc) return c
    if (nw && c.website && norm(c.website) === nw) return c
  }
  return null
}

function log(contactId, kind, what) {
  const d = open()
  const at = now()
  d.prepare('INSERT INTO activities (contact_id, at, kind, text) VALUES (?, ?, ?, ?)').run(contactId, at, kind, what)
  d.prepare('UPDATE contacts SET last_activity = ?, updated = ? WHERE id = ?').run(at, at, contactId)
}

function line(c) {
  const flags = [
    c.blocked ? 'GESPERRT' : '',
    c.consent_email ? 'Mail ok' : '',
    c.consent_phone ? 'Tel ok' : '',
    c.score != null ? `${c.score} P` : '',
  ]
    .filter(Boolean)
    .join(', ')
  const next = c.next_step ? ` · nächster Schritt: ${c.next_step}${c.next_step_at ? ` (${fmt(c.next_step_at)})` : ''}` : ''
  return `[${c.id}] ${c.company}${c.contact ? ` / ${c.contact}` : ''} · ${c.status}${flags ? ` · ${flags}` : ''}${next}`
}

function detail(c) {
  const d = open()
  const acts = d.prepare('SELECT * FROM activities WHERE contact_id = ? ORDER BY at DESC LIMIT 8').all(c.id)
  const tasks = d.prepare('SELECT * FROM tasks WHERE contact_id = ? AND done = 0 ORDER BY due').all(c.id)
  const rows = [
    `[${c.id}] ${c.company}`,
    c.contact ? `Ansprechpartner: ${c.contact}` : '',
    c.email ? `E-Mail: ${c.email}` : '',
    c.phone ? `Telefon: ${c.phone}` : '',
    c.website ? `Website: ${c.website}` : '',
    c.industry || c.region ? `Branche/Region: ${[c.industry, c.region].filter(Boolean).join(' / ')}` : '',
    c.source ? `Quelle: ${c.source}${c.source_date ? ` (${fmt(c.source_date)})` : ''}` : '',
    c.need ? `Bedarf: ${c.need}` : '',
    c.evidence ? `Belege: ${c.evidence}` : '',
    c.gaps ? `Offen/unsicher: ${c.gaps}` : '',
    c.score != null ? `Priorität: ${c.score} Punkte${c.score_notes ? ` — ${c.score_notes}` : ''}` : '',
    `Status: ${c.status}`,
    `Kontakt zulässig: Mail ${c.consent_email ? 'ja' : 'nein'}, Telefon ${c.consent_phone ? 'ja' : 'nein'}${c.consent_basis ? ` (Grundlage: ${c.consent_basis})` : ''}`,
    c.blocked ? `GESPERRT: ${c.blocked_reason ?? ''}` : '',
    c.value != null ? `Angebotswert: ${c.value} €` : '',
    c.outcome ? `Ergebnis: ${c.outcome}${c.lost_reason ? ` (${c.lost_reason})` : ''}` : '',
    c.next_step ? `Nächster Schritt: ${c.next_step}${c.next_step_at ? ` bis ${fmt(c.next_step_at)}` : ''}` : '',
    tasks.length ? `Offene Aufgaben:\n${tasks.map((t) => `  - [${t.id}] ${t.text}${t.due ? ` (${fmt(t.due)})` : ''}`).join('\n')}` : '',
    acts.length ? `Verlauf:\n${acts.map((a) => `  - ${fmt(a.at)} ${a.kind}: ${a.text}`).join('\n')}` : 'Verlauf: noch nichts.',
  ]
  return rows.filter(Boolean).join('\n')
}

/** Due today or overdue — for the morning briefing. */
export function dueSalesItems() {
  if (!existsSync(DB_FILE)) return ''
  const d = open()
  const t = today()
  const tasks = d
    .prepare(
      `SELECT t.*, c.company FROM tasks t LEFT JOIN contacts c ON c.id = t.contact_id
       WHERE t.done = 0 AND t.due IS NOT NULL AND substr(t.due, 1, 10) <= ? ORDER BY t.due`,
    )
    .all(t)
  const steps = d
    .prepare(`SELECT * FROM contacts WHERE blocked = 0 AND next_step_at IS NOT NULL AND substr(next_step_at, 1, 10) <= ? ORDER BY next_step_at`)
    .all(t)
  if (!tasks.length && !steps.length) return ''
  const lines = []
  for (const x of tasks) lines.push(`${fmt(x.due)}: ${x.text}${x.company ? ` (${x.company})` : ''}`)
  for (const c of steps) lines.push(`${fmt(c.next_step_at)}: ${c.next_step} (${c.company})`)
  return `Vertrieb heute (fällig oder überfällig):\n${lines.join('\n')}`
}

// ---------------------------------------------------------------------------

const ref = z.string().describe('Kennung in eckigen Klammern oder Firmenname.')
const opt = (d) => z.string().optional().describe(d)

export function salesServer() {
  return createSdkMcpServer({
    name: 'jarvis_sales',
    version: '1.0.0',
    instructions:
      'Kundengewinnung: Geschäftsprofil, Wissensbasis mit Quellen, Kontakte mit Status, ' +
      'Kontaktberechtigung und nächstem Schritt, Aufgaben, Entwürfe, Kennzahlen. Nichts hier sendet.',
    alwaysLoad: true,
    tools: [
      // --- profile ---
      tool('profile_get', 'Das Geschäftsprofil: was festgelegt ist und was noch fehlt.', {}, async () => {
        const p = readProfile()
        return text(PROFILE_FIELDS.map((f) => `${f}: ${p[f] || '(offen)'}`).join('\n'))
      }),
      tool(
        'profile_set',
        'Einen Punkt des Geschäftsprofils festlegen. Felder: ' + PROFILE_FIELDS.join(', ') + '.',
        { field: z.string().describe('Das Feld.'), value: z.string().describe('Der Inhalt, ein bis drei Sätze.') },
        async ({ field, value }) => {
          const f = PROFILE_FIELDS.find((x) => x.toLowerCase() === String(field).trim().toLowerCase())
          if (!f) return text(`Unbekanntes Feld. Erlaubt: ${PROFILE_FIELDS.join(', ')}.`)
          const p = readProfile()
          p[f] = String(value).replace(/\s+/g, ' ').trim()
          writeProfile(p)
          console.log(`[sales] profile ${f} gesetzt`)
          const missing = PROFILE_FIELDS.filter((x) => !p[x])
          return text(`${f} gespeichert.${missing.length ? ` Noch offen: ${missing.join(', ')}.` : ' Das Profil ist vollständig.'}`)
        },
      ),

      // --- knowledge ---
      tool(
        'knowledge_search',
        'Die eigene Wissensbasis durchsuchen (Leistungen, Preise, Referenzen, Vorlagen, Einwände). ' +
          'Jeder Treffer nennt Datei und Datum; nur das Gefundene gilt als belegt.',
        { query: z.string().describe('Suchbegriffe.'), max: z.union([z.number(), z.string()]).optional().catch(undefined) },
        async ({ query, max }) => {
          const hits = knowledgeSearch(String(query), Math.max(1, Math.min(12, Number(max) || 6)))
          if (!hits.length) {
            return text(knowledgeFiles().length ? 'Nichts dazu in der Wissensbasis — gilt als fehlende Angabe.' : 'Die Wissensbasis ist leer (Ordner wissen/).')
          }
          return text(hits.map((h) => `— ${h.para.slice(0, 700)}\n  [Quelle: ${h.file.split(/[\\/]/).pop()}, Stand ${fmt(h.mtime)}]`).join('\n\n'))
        },
      ),
      tool(
        'knowledge_add',
        'Etwas in die Wissensbasis schreiben, das der Nutzer dir gesagt hat: eine Preisregel, eine Referenz, eine Antwort auf einen Einwand.',
        { title: z.string().describe('Kurzer Titel.'), content: z.string().describe('Der Inhalt.') },
        async ({ title, content }) => {
          mkdirSync(KNOWLEDGE, { recursive: true })
          const slug = norm(title).replace(/ /g, '-').slice(0, 50) || 'notiz'
          const file = join(KNOWLEDGE, `${today()}-${slug}.md`)
          writeFileSync(file, `# ${title}\n\n${content}\n\n(vom Nutzer, ${fmt(now())})\n`, 'utf8')
          return text(`Gespeichert als ${file.split(/[\\/]/).pop()}.`)
        },
      ),

      // --- leads ---
      tool(
        'lead_add',
        'Ein Unternehmen oder einen Kontakt anlegen. Doppelte werden erkannt und nicht angelegt. ' +
          'Recherchiertes gehört in Bedarf/Belege mit Quelle und Datum; Kontaktberechtigung ist davon getrennt.',
        {
          company: z.string().describe('Firmenname.'),
          contact: opt('Ansprechpartner.'),
          email: opt('E-Mail.'),
          phone: opt('Telefon.'),
          website: opt('Website.'),
          industry: opt('Branche.'),
          region: opt('Region/Ort.'),
          source: opt('Woher: Website, Liste, Empfehlung, Anfrage per Mail …'),
          need: opt('Möglicher Bedarf, mit Begründung.'),
          evidence: opt('Belege: was wo gesehen wurde, mit Adresse und Datum.'),
          gaps: opt('Unsicherheiten und fehlende Angaben.'),
          status: opt('Status; Standard neu. Erlaubt: ' + STATUSES.join(', ')),
        },
        async (a) => {
          const dup = duplicateOf(a.company, a.website)
          if (dup) return text(`Gibt es schon: ${line(dup)}. Nichts angelegt; mit lead_update ergänzen.`)
          const d = open()
          const st = STATUSES.includes(a.status) ? a.status : 'neu'
          const t = now()
          const r = d
            .prepare(
              `INSERT INTO contacts (company, contact, email, phone, website, industry, region, source, source_date, need, evidence, gaps, status, created, updated)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(a.company, a.contact ?? null, a.email ?? null, a.phone ?? null, a.website ?? null, a.industry ?? null, a.region ?? null, a.source ?? null, a.source ? t : null, a.need ?? null, a.evidence ?? null, a.gaps ?? null, st, t, t)
          const id = Number(r.lastInsertRowid)
          log(id, 'angelegt', a.source ? `Quelle: ${a.source}` : 'ohne Quelle')
          console.log(`[sales] lead + [${id}] ${a.company}`)
          return text(`Angelegt: ${line(findContact(String(id)))}`)
        },
      ),
      tool(
        'lead_update',
        'Felder eines Kontakts ändern: Status, Bedarf, Belege, Kontaktberechtigung (consent_email/consent_phone 0 oder 1 mit consent_basis), Angebotswert, Ergebnis, nächster Schritt mit Datum.',
        {
          ref,
          fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).describe('Feld → Wert. Felder: ' + COLUMNS.join(', ')),
        },
        async ({ ref: r, fields }) => {
          const c = findContact(r)
          if (!c) return text(`Kein Kontakt „${r}“.`)
          const d = open()
          const changes = []
          for (const [k, v] of Object.entries(fields ?? {})) {
            if (!COLUMNS.includes(k)) continue
            if (k === 'status' && !STATUSES.includes(String(v))) return text(`Ungültiger Status. Erlaubt: ${STATUSES.join(', ')}.`)
            let val = v
            if (k === 'consent_email' || k === 'consent_phone' || k === 'blocked') val = v === true || v === 1 || v === '1' || v === 'ja' ? 1 : 0
            if (k === 'value') val = v == null || v === '' ? null : Number(String(v).replace(',', '.'))
            d.prepare(`UPDATE contacts SET ${k} = ?, updated = ? WHERE id = ?`).run(val, now(), c.id)
            changes.push(`${k}=${val}`)
          }
          if (!changes.length) return text('Nichts geändert: keine gültigen Felder.')
          log(c.id, 'geändert', changes.join(', '))
          return text(`Geändert: ${line(findContact(String(c.id)))}`)
        },
      ),
      tool('lead_get', 'Alles zu einem Kontakt, mit Verlauf und offenen Aufgaben — die Vorbereitung vor einem Gespräch.', { ref }, async ({ ref: r }) => {
        const c = findContact(r)
        return text(c ? detail(c) : `Kein Kontakt „${r}“.`)
      }),
      tool(
        'lead_list',
        'Kontakte auflisten, optional nach Status oder Suchwort, höchste Priorität zuerst.',
        { status: opt('Nur dieser Status.'), query: opt('Suchwort in Firma, Branche, Region, Bedarf.'), max: z.union([z.number(), z.string()]).optional().catch(undefined) },
        async ({ status, query, max }) => {
          const d = open()
          let rows = d.prepare('SELECT * FROM contacts ORDER BY blocked, (score IS NULL), score DESC, updated DESC').all()
          if (status) rows = rows.filter((c) => c.status === status)
          if (query) {
            const q = norm(query)
            rows = rows.filter((c) => norm([c.company, c.contact, c.industry, c.region, c.need].join(' ')).includes(q))
          }
          rows = rows.slice(0, Math.max(1, Math.min(60, Number(max) || 25)))
          return text(rows.length ? rows.map(line).join('\n') : 'Keine Kontakte.')
        },
      ),
      tool(
        'lead_note',
        'Eine Aktivität festhalten: Gesprächsnotiz, Mail erhalten, Angebot verschickt, Absage.',
        { ref, kind: z.string().describe('Art: gespräch, mail, telefon, notiz, angebot, absage …'), note: z.string().describe('Der Inhalt.') },
        async ({ ref: r, kind, note }) => {
          const c = findContact(r)
          if (!c) return text(`Kein Kontakt „${r}“.`)
          log(c.id, String(kind), String(note))
          return text(`Notiert bei ${c.company}.`)
        },
      ),
      tool(
        'lead_score',
        'Arbeitspriorität vergeben, 0–100, mit Begründung. Höchstpunkte: Zielgruppe 30, erkennbarer Bedarf 30, ' +
          'Angebot passt 20, Region/Größe 10, Informationen aktuell 10. Unbekanntes Budget bleibt unbekannt; das ist keine Kaufwahrscheinlichkeit.',
        {
          ref,
          fit: z.number().describe('0–30 passt zur Zielgruppe'),
          need: z.number().describe('0–30 konkreter Bedarf erkennbar'),
          offer: z.number().describe('0–20 Angebot passt zum Bedarf'),
          region: z.number().describe('0–10 Region und Größe passen'),
          freshness: z.number().describe('0–10 Informationen aktuell und ausreichend'),
          notes: z.string().describe('Begründung in zwei Sätzen.'),
        },
        async ({ ref: r, fit, need, offer, region, freshness, notes }) => {
          const c = findContact(r)
          if (!c) return text(`Kein Kontakt „${r}“.`)
          const clamp = (v, m) => Math.max(0, Math.min(m, Math.round(Number(v) || 0)))
          const score = clamp(fit, 30) + clamp(need, 30) + clamp(offer, 20) + clamp(region, 10) + clamp(freshness, 10)
          open().prepare('UPDATE contacts SET score = ?, score_notes = ?, updated = ? WHERE id = ?').run(score, String(notes), now(), c.id)
          log(c.id, 'bewertet', `${score} Punkte: ${notes}`)
          return text(`${c.company}: ${score} Punkte Priorität.`)
        },
      ),
      tool(
        'lead_block',
        'Kontakt sperren: Widerspruch, Absage, „nicht mehr melden“. Offene Aufgaben dazu werden gestrichen; die Sperre bleibt.',
        { ref, reason: z.string().describe('Grund und Datum.') },
        async ({ ref: r, reason }) => {
          const c = findContact(r)
          if (!c) return text(`Kein Kontakt „${r}“.`)
          const d = open()
          d.prepare('UPDATE contacts SET blocked = 1, blocked_reason = ?, next_step = NULL, next_step_at = NULL, updated = ? WHERE id = ?').run(String(reason), now(), c.id)
          d.prepare('UPDATE tasks SET done = 1 WHERE contact_id = ? AND done = 0').run(c.id)
          log(c.id, 'gesperrt', String(reason))
          return text(`${c.company} ist gesperrt. Keine weitere Ansprache.`)
        },
      ),

      // --- tasks ---
      tool(
        'task_add',
        'Eine Aufgabe mit Datum anlegen, meist zu einem Kontakt: antworten, nachfassen, Angebot schreiben.',
        { text: z.string().describe('Die Aufgabe.'), due: z.string().describe('Fällig, als JJJJ-MM-TT.'), ref: opt('Kontakt, falls zugehörig.') },
        async ({ text: what, due, ref: r }) => {
          const c = r ? findContact(r) : null
          if (r && !c) return text(`Kein Kontakt „${r}“.`)
          if (c?.blocked) return text(`${c.company} ist gesperrt; keine Aufgabe angelegt.`)
          const d = open()
          const res = d.prepare('INSERT INTO tasks (contact_id, text, due, created) VALUES (?, ?, ?, ?)').run(c?.id ?? null, String(what), String(due).slice(0, 10), now())
          if (c) {
            d.prepare('UPDATE contacts SET next_step = ?, next_step_at = ?, updated = ? WHERE id = ?').run(String(what), String(due).slice(0, 10), now(), c.id)
          }
          return text(`Aufgabe [${res.lastInsertRowid}] für ${fmt(due)}${c ? ` bei ${c.company}` : ''}: ${what}`)
        },
      ),
      tool('task_done', 'Eine Aufgabe abhaken.', { id: z.union([z.number(), z.string()]).describe('Die Aufgabenkennung.') }, async ({ id }) => {
        const d = open()
        const t = d.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(id))
        if (!t) return text('Keine solche Aufgabe.')
        d.prepare('UPDATE tasks SET done = 1 WHERE id = ?').run(t.id)
        if (t.contact_id) {
          d.prepare('UPDATE contacts SET next_step = NULL, next_step_at = NULL, updated = ? WHERE id = ? AND next_step = ?').run(now(), t.contact_id, t.text)
          log(t.contact_id, 'erledigt', t.text)
        }
        return text(`Erledigt: ${t.text}`)
      }),
      tool(
        'task_list',
        'Offene Aufgaben: heute fällig und überfällig, oder alle offenen.',
        { scope: z.enum(['heute', 'alle']).optional().catch(undefined) },
        async ({ scope }) => {
          const d = open()
          const t = today()
          const rows =
            scope === 'alle'
              ? d.prepare('SELECT t.*, c.company FROM tasks t LEFT JOIN contacts c ON c.id = t.contact_id WHERE t.done = 0 ORDER BY (t.due IS NULL), t.due').all()
              : d.prepare('SELECT t.*, c.company FROM tasks t LEFT JOIN contacts c ON c.id = t.contact_id WHERE t.done = 0 AND t.due IS NOT NULL AND substr(t.due,1,10) <= ? ORDER BY t.due').all(t)
          if (!rows.length) return text(scope === 'alle' ? 'Keine offenen Aufgaben.' : 'Heute nichts fällig.')
          return text(rows.map((x) => `[${x.id}] ${x.due ? fmt(x.due) : 'ohne Datum'}: ${x.text}${x.company ? ` (${x.company})` : ''}${x.due && x.due.slice(0, 10) < t ? ' — überfällig' : ''}`).join('\n'))
        },
      ),

      // --- drafts ---
      tool(
        'draft_save',
        'Einen Entwurf ablegen, zur Prüfung durch den Nutzer: Beitrag, Antwort, Angebot, Fallbeispiel. Entwürfe werden nie von selbst verschickt oder veröffentlicht.',
        { kind: z.string().describe('beitrag, antwort, angebot, seite, newsletter, fallbeispiel …'), title: z.string().describe('Titel.'), content: z.string().describe('Der Text.'), ref: opt('Kontakt, falls zugehörig.') },
        async ({ kind, title, content, ref: r }) => {
          mkdirSync(DRAFTS, { recursive: true })
          const c = r ? findContact(r) : null
          const slug = norm(title).replace(/ /g, '-').slice(0, 40) || 'entwurf'
          const file = join(DRAFTS, `${today()}-${norm(kind).replace(/ /g, '-')}-${slug}.md`)
          writeFileSync(file, `---\nart: ${kind}\ntitel: ${title}\nkontakt: ${c ? `[${c.id}] ${c.company}` : ''}\nstatus: entwurf\nerstellt: ${now()}\n---\n\n${content}\n`, 'utf8')
          if (c) log(c.id, 'entwurf', `${kind}: ${title}`)
          return text(`Entwurf gespeichert: ${file.split(/[\\/]/).pop()}. Wartet auf Prüfung.`)
        },
      ),
      tool('draft_list', 'Die abgelegten Entwürfe, neueste zuerst.', {}, async () => {
        mkdirSync(DRAFTS, { recursive: true })
        const files = readdirSync(DRAFTS).filter((f) => f.endsWith('.md')).sort().reverse().slice(0, 30)
        if (!files.length) return text('Keine Entwürfe.')
        return text(
          files
            .map((f) => {
              const head = readFileSync(join(DRAFTS, f), 'utf8').slice(0, 400)
              const st = /status:\s*(.*)/.exec(head)?.[1] ?? '?'
              const t = /titel:\s*(.*)/.exec(head)?.[1] ?? f
              return `${f} · ${st} · ${t}`
            })
            .join('\n'),
        )
      }),
      tool('draft_get', 'Einen Entwurf lesen.', { file: z.string().describe('Dateiname aus draft_list.') }, async ({ file }) => {
        const p = join(DRAFTS, String(file).replace(/[\\/]/g, ''))
        return text(existsSync(p) ? readFileSync(p, 'utf8').slice(0, 8000) : 'Kein solcher Entwurf.')
      }),

      // --- figures ---
      tool('pipeline', 'Die Übersicht: Kontakte je Status, fällige Schritte, Angebotswerte, Ergebnisse der letzten dreißig Tage.', {}, async () => {
        const d = open()
        const t = today()
        const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
        const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]))
        for (const r of d.prepare('SELECT status, COUNT(*) n FROM contacts WHERE blocked = 0 GROUP BY status').all()) counts[r.status] = r.n
        const blocked = d.prepare('SELECT COUNT(*) n FROM contacts WHERE blocked = 1').get().n
        const value = d.prepare("SELECT COALESCE(SUM(value),0) v FROM contacts WHERE status IN ('angebot','gespräch') AND blocked = 0").get().v
        const won = d.prepare("SELECT COUNT(*) n, COALESCE(SUM(value),0) v FROM contacts WHERE status = 'gewonnen' AND updated >= ?").get(since)
        const lost = d.prepare("SELECT COUNT(*) n FROM contacts WHERE status = 'verloren' AND updated >= ?").get(since)
        const lostWhy = d.prepare("SELECT lost_reason, COUNT(*) n FROM contacts WHERE status = 'verloren' AND lost_reason IS NOT NULL GROUP BY lost_reason ORDER BY n DESC LIMIT 5").all()
        const dueN = d.prepare('SELECT COUNT(*) n FROM tasks WHERE done = 0 AND due IS NOT NULL AND substr(due,1,10) <= ?').get(t).n
        const newWeek = d.prepare('SELECT COUNT(*) n FROM contacts WHERE created >= ?').get(new Date(Date.now() - 7 * 86_400_000).toISOString()).n
        const acts = d.prepare('SELECT kind, COUNT(*) n FROM activities WHERE at >= ? GROUP BY kind ORDER BY n DESC').all(new Date(Date.now() - 7 * 86_400_000).toISOString())
        return text(
          [
            `Status: ${STATUSES.map((s) => `${s} ${counts[s]}`).join(' · ')}${blocked ? ` · gesperrt ${blocked}` : ''}`,
            `Neu in 7 Tagen: ${newWeek} Kontakte · Aktivitäten: ${acts.map((a) => `${a.kind} ${a.n}`).join(', ') || 'keine'}`,
            `Fällig/überfällig: ${dueN} Aufgaben`,
            `Offener Angebotswert (Gespräch + Angebot): ${Math.round(value)} €`,
            `Letzte 30 Tage: ${won.n} gewonnen (${Math.round(won.v)} €), ${lost.n} verloren${lostWhy.length ? ` — Gründe: ${lostWhy.map((x) => `${x.lost_reason} (${x.n})`).join(', ')}` : ''}`,
          ].join('\n'),
        )
      }),
    ],
  })
}
