/**
 * Everyday life: the calendar, reminders, the weather, and a morning briefing.
 *
 *   calendar_today / calendar_upcoming   read-only, from iCal subscriptions
 *   reminder_add / reminder_list / reminder_remove
 *   weather                              Open-Meteo, no key
 *   briefing                             the bundle the morning briefing is spoken from
 *
 * The calendar is read through private iCal addresses (Google: calendar
 * settings → "Secret address in iCal format"; Outlook: "publish calendar";
 * Apple: a public or shared calendar link). They go in .env as
 * JARVIS_CALENDAR_ICS, comma separated, and never anywhere else. Reading is
 * all this does: an event is created in the calendar app, not by voice.
 *
 * Reminders live in ~/.jarvis/reminders.json. The bridge keeps its own
 * clock: a due reminder is pushed to the interface as a `remind` frame and
 * spoken there without a model turn. A reminder that comes due while no
 * interface is connected waits for the next one, up to twelve hours.
 *
 * The morning briefing is a nudge: at JARVIS_BRIEFING_AT the bridge asks the
 * interface to ask him, once a day, only while an interface is connected.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import ical from 'node-ical'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const DIR = join(homedir(), '.jarvis')
const REMINDERS_FILE = process.env.JARVIS_REMINDERS_FILE ?? join(DIR, 'reminders.json')
const STATE_FILE = join(DIR, 'state.json')

const ICS_SOURCES = (process.env.JARVIS_CALENDAR_ICS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
export const LOCATION = process.env.JARVIS_LOCATION ?? ''
export const BRIEFING_AT = process.env.JARVIS_BRIEFING_AT ?? '08:00'
/** How long after BRIEFING_AT a late start still gets the briefing. */
const BRIEFING_WINDOW_H = Number(process.env.JARVIS_BRIEFING_WINDOW_H ?? 4)

const text = (t) => ({ content: [{ type: 'text', text: t }] })

const readJson = (file, fallback) => {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback
  } catch {
    return fallback
  }
}
const writeJson = (file, data) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

const fmtDate = (d) => d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' })
const fmtTime = (d) => d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
const fmtWhen = (d) => `${fmtDate(d)}, ${fmtTime(d)}`
const sameDay = (a, b) => a.toDateString() === b.toDateString()

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

let icsCache = { at: 0, events: [] }
const ICS_CACHE_MS = 5 * 60 * 1000

/** Every event instance between `from` and `to`, recurrences expanded. */
async function calendarEvents(from, to) {
  if (!ICS_SOURCES.length) return null
  if (Date.now() - icsCache.at > ICS_CACHE_MS) {
    const all = []
    for (const src of ICS_SOURCES) {
      try {
        const data = /^https?:\/\//i.test(src)
          ? await ical.async.fromURL(src)
          : await ical.async.parseFile(src.replace(/^~(?=$|[\\/])/, homedir()))
        for (const ev of Object.values(data)) {
          if (ev?.type === 'VEVENT') all.push(ev)
        }
      } catch (err) {
        console.warn(`[daily] calendar ${src.slice(0, 60)}…: ${err?.message ?? err}`)
      }
    }
    icsCache = { at: Date.now(), events: all }
  }

  const out = []
  for (const ev of icsCache.events) {
    const allDay = ev.datetype === 'date'
    const length = ev.end && ev.start ? ev.end.getTime() - ev.start.getTime() : allDay ? 86_400_000 : 3_600_000
    const push = (start) => {
      const end = new Date(start.getTime() + length)
      if (end < from || start > to) return
      out.push({ title: ev.summary ?? '(ohne Titel)', start, end, allDay, location: ev.location ?? '', description: ev.description ?? '' })
    }
    if (ev.rrule) {
      let dates = []
      try {
        dates = ev.rrule.between(new Date(from.getTime() - length), to, true)
      } catch {
        dates = []
      }
      const exdates = new Set(Object.values(ev.exdate ?? {}).map((d) => new Date(d).toISOString().slice(0, 10)))
      for (const d of dates) {
        const key = d.toISOString().slice(0, 10)
        if (exdates.has(key)) continue
        const override = ev.recurrences?.[key]
        if (override?.start) push(new Date(override.start))
        else push(new Date(d))
      }
      // Modified instances outside the rrule result still count.
      for (const [key, r] of Object.entries(ev.recurrences ?? {})) {
        if (r?.start && !dates.some((d) => d.toISOString().slice(0, 10) === key)) push(new Date(r.start))
      }
    } else if (ev.start) {
      push(new Date(ev.start))
    }
  }
  out.sort((a, b) => a.start - b.start)
  return out
}

function listEvents(events, { withDate }) {
  if (!events.length) return 'Keine Termine.'
  return events
    .map((e) => {
      const when = e.allDay
        ? withDate
          ? `${fmtDate(e.start)} (ganztägig)`
          : 'ganztägig'
        : withDate
          ? `${fmtWhen(e.start)}–${fmtTime(e.end)}`
          : `${fmtTime(e.start)}–${fmtTime(e.end)}`
      return `${when}: ${e.title}${e.location ? ` @ ${e.location}` : ''}`
    })
    .join('\n')
}

const NO_CALENDAR =
  'Kein Kalender eingerichtet. In .env JARVIS_CALENDAR_ICS auf die private iCal-Adresse des Kalenders setzen (Google: Kalendereinstellungen → „Privatadresse im iCal-Format“).'

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

const loadReminders = () => readJson(REMINDERS_FILE, [])
const saveReminders = (list) => writeJson(REMINDERS_FILE, list)

function parseWhen(at) {
  // ISO from the model ("2026-10-23T09:00") — local time when no zone is given.
  const d = new Date(String(at))
  return Number.isNaN(d.getTime()) ? null : d
}

// ---------------------------------------------------------------------------
// Weather (Open-Meteo, free, no key)
// ---------------------------------------------------------------------------

const WMO = {
  0: 'klar', 1: 'überwiegend klar', 2: 'teils bewölkt', 3: 'bedeckt', 45: 'Nebel', 48: 'Reifnebel',
  51: 'leichter Nieselregen', 53: 'Nieselregen', 55: 'starker Nieselregen', 56: 'gefrierender Nieselregen', 57: 'gefrierender Nieselregen',
  61: 'leichter Regen', 63: 'Regen', 65: 'starker Regen', 66: 'gefrierender Regen', 67: 'gefrierender Regen',
  71: 'leichter Schneefall', 73: 'Schneefall', 75: 'starker Schneefall', 77: 'Schneegriesel',
  80: 'leichte Schauer', 81: 'Schauer', 82: 'heftige Schauer', 85: 'Schneeschauer', 86: 'starke Schneeschauer',
  95: 'Gewitter', 96: 'Gewitter mit Hagel', 99: 'Gewitter mit Hagel',
}
const wmo = (c) => WMO[Number(c)] ?? 'wechselhaft'

const geoCache = new Map()
async function geocode(place) {
  const key = place.toLowerCase()
  if (geoCache.has(key)) return geoCache.get(key)
  const res = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=de&format=json`,
    { signal: AbortSignal.timeout(8000) },
  )
  const data = await res.json()
  const hit = data?.results?.[0]
  if (!hit) throw new Error(`Ort nicht gefunden: ${place}`)
  const out = { name: hit.name, admin: hit.admin1 ?? '', country: hit.country ?? '', lat: hit.latitude, lon: hit.longitude }
  geoCache.set(key, out)
  return out
}

async function weatherFor(place) {
  const g = await geocode(place)
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${g.lat}&longitude=${g.lon}` +
    '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation' +
    '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code,sunrise,sunset' +
    '&timezone=auto&forecast_days=3'
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
  const w = await res.json()
  const c = w.current ?? {}
  const d = w.daily ?? {}
  const day = (i) =>
    `${i === 0 ? 'Heute' : i === 1 ? 'Morgen' : 'Übermorgen'}: ${wmo(d.weather_code?.[i])}, ${Math.round(d.temperature_2m_min?.[i])} bis ${Math.round(d.temperature_2m_max?.[i])} °C, Regenwahrscheinlichkeit ${d.precipitation_probability_max?.[i] ?? '?'} %`
  return [
    `Wetter in ${g.name}${g.admin ? ` (${g.admin})` : ''}:`,
    `Jetzt: ${wmo(c.weather_code)}, ${Math.round(c.temperature_2m)} °C, gefühlt ${Math.round(c.apparent_temperature)} °C, Wind ${Math.round(c.wind_speed_10m)} km/h`,
    day(0),
    day(1),
    day(2),
    d.sunrise?.[0] ? `Sonne: auf ${String(d.sunrise[0]).slice(11, 16)}, unter ${String(d.sunset[0]).slice(11, 16)}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

// ---------------------------------------------------------------------------
// The bundle the briefing is spoken from
// ---------------------------------------------------------------------------

export async function briefingBundle() {
  const now = new Date()
  const parts = [`Datum: ${fmtDate(now)}, ${fmtTime(now)} Uhr`]
  if (LOCATION) {
    try {
      parts.push(await weatherFor(LOCATION))
    } catch (err) {
      parts.push(`Wetter: nicht verfügbar (${err?.message ?? err})`)
    }
  } else {
    parts.push('Wetter: kein Ort eingerichtet (JARVIS_LOCATION in .env).')
  }
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  const events = await calendarEvents(start, end)
  parts.push(events === null ? 'Termine: kein Kalender eingerichtet.' : `Termine heute:\n${listEvents(events, { withDate: false })}`)
  const tomorrow = await calendarEvents(end, new Date(end.getTime() + 86_400_000))
  if (tomorrow?.length) parts.push(`Termine morgen:\n${listEvents(tomorrow, { withDate: false })}`)
  const rem = loadReminders().filter((r) => sameDay(new Date(r.at), now) || new Date(r.at) < now)
  parts.push(
    rem.length
      ? `Erinnerungen heute:\n${rem.map((r) => `${fmtTime(new Date(r.at))}: ${r.text}`).join('\n')}`
      : 'Erinnerungen heute: keine.',
  )
  return parts.join('\n\n')
}

// ---------------------------------------------------------------------------
// Scheduling: due reminders and the morning nudge, pushed to the interface
// ---------------------------------------------------------------------------

let broadcast = null
let clientCount = () => 0

/** The bridge hands over how to reach every connected interface. */
export function setDailyTransport({ send, count }) {
  broadcast = send
  clientCount = count
}

function fireDueReminders() {
  if (!broadcast || clientCount() === 0) return
  const now = Date.now()
  const list = loadReminders()
  let changed = false
  const keep = []
  for (const r of list) {
    const at = new Date(r.at).getTime()
    if (at > now) {
      keep.push(r)
      continue
    }
    if (now - at > 12 * 3600_000) {
      console.log(`[daily] reminder dropped, twelve hours overdue: ${r.text}`)
      changed = true
      continue
    }
    broadcast({ type: 'remind', id: r.id, text: r.text, at: r.at })
    console.log(`[daily] reminder fired: ${r.text}`)
    changed = true
  }
  if (changed) saveReminders(keep)
}

function maybeBriefing() {
  if (!broadcast || clientCount() === 0) return
  const now = new Date()
  const [h, m] = BRIEFING_AT.split(':').map(Number)
  const at = new Date(now)
  at.setHours(h || 0, m || 0, 0, 0)
  const until = new Date(at.getTime() + BRIEFING_WINDOW_H * 3600_000)
  if (now < at || now > until) return
  const state = readJson(STATE_FILE, {})
  const today = now.toISOString().slice(0, 10)
  if (state.lastBriefing === today) return
  writeJson(STATE_FILE, { ...state, lastBriefing: today })
  broadcast({ type: 'nudge', text: 'Gib mir mein Morgen-Briefing.' })
  console.log('[daily] morning briefing nudged')
}

let timer = null
export function startDaily() {
  if (timer) return
  timer = setInterval(() => {
    fireDueReminders()
    maybeBriefing()
  }, 15_000)
}

/** Called when an interface connects, so a briefing or a reminder that was
 *  waiting for one does not sit until the next tick. */
export function onClientConnected() {
  setTimeout(() => {
    fireDueReminders()
    maybeBriefing()
  }, 4000)
}

// ---------------------------------------------------------------------------

export function dailyServer() {
  return createSdkMcpServer({
    name: 'jarvis_daily',
    version: '1.0.0',
    instructions:
      'Alltag: Kalender (nur lesen), Erinnerungen (anlegen, auflisten, löschen), Wetter, ' +
      'und das Bündel für das Morgen-Briefing.',
    alwaysLoad: true,
    tools: [
      // The iCal path only when a feed is configured: with the Google
      // Calendar connector present, an empty fallback was one more thing to
      // report as missing.
      ...(ICS_SOURCES.length ? [
        tool(
          'calendar_today',
          'Die Termine von heute, oder eines bestimmten Tages. Nur lesend.',
          { date: z.string().optional().describe('Optional: ein Datum als JJJJ-MM-TT. Fehlt es, heute.') },
          async ({ date }) => {
            const day = date ? new Date(`${date}T00:00:00`) : new Date()
            if (Number.isNaN(day.getTime())) return text('Datum nicht verstanden.')
            day.setHours(0, 0, 0, 0)
            const next = new Date(day.getTime() + 86_400_000)
            const events = await calendarEvents(day, next)
            if (events === null) return text(NO_CALENDAR)
            return text(`${fmtDate(day)}:\n${listEvents(events, { withDate: false })}`)
          },
        ),
        tool(
          'calendar_upcoming',
          'Die nächsten Termine, über mehrere Tage. Nur lesend.',
          { days: z.union([z.number(), z.string()]).optional().catch(undefined).describe('Wie viele Tage voraus, Standard 7.') },
          async ({ days }) => {
            const n = Math.max(1, Math.min(60, Number(days) || 7))
            const from = new Date()
            const to = new Date(from.getTime() + n * 86_400_000)
            const events = await calendarEvents(from, to)
            if (events === null) return text(NO_CALENDAR)
            return text(`Nächste ${n} Tage:\n${listEvents(events.slice(0, 40), { withDate: true })}`)
          },
        ),
  
        ] : []),
      tool(
        'reminder_add',
        'Lege eine Erinnerung an. Rechne „in zehn Minuten“ oder „morgen um neun“ selbst in ' +
          'eine Uhrzeit um und übergib sie als ISO-Zeit in Ortszeit (JJJJ-MM-TTTHH:MM). ' +
          'Die Erinnerung wird vom Interface angesagt, auch ohne dass jemand fragt.',
        {
          text: z.string().describe('Woran erinnert werden soll, als kurzer Satz.'),
          at: z.string().describe('Wann, als ISO-Zeit in Ortszeit, z. B. 2026-10-23T09:00.'),
        },
        async ({ text: what, at }) => {
          const when = parseWhen(at)
          if (!when) return text(`Zeit nicht verstanden: ${at}`)
          if (when.getTime() < Date.now() - 60_000) return text(`Das liegt in der Vergangenheit: ${fmtWhen(when)}`)
          const list = loadReminders()
          const id = `r${Date.now().toString(36)}`
          list.push({ id, text: String(what).trim(), at: when.toISOString(), created: new Date().toISOString() })
          list.sort((a, b) => new Date(a.at) - new Date(b.at))
          saveReminders(list)
          console.log(`[daily] reminder + ${fmtWhen(when)}: ${what}`)
          return text(`Erinnerung gesetzt für ${fmtWhen(when)}: ${what}`)
        },
      ),
      tool(
        'reminder_list',
        'Alle anstehenden Erinnerungen.',
        {},
        async () => {
          const list = loadReminders()
          if (!list.length) return text('Keine Erinnerungen.')
          return text(list.map((r) => `[${r.id}] ${fmtWhen(new Date(r.at))}: ${r.text}`).join('\n'))
        },
      ),
      tool(
        'reminder_remove',
        'Lösche eine Erinnerung, über ihre Kennung aus reminder_list oder ein Wort aus dem Text.',
        { match: z.string().describe('Kennung oder Textteil.') },
        async ({ match }) => {
          const q = String(match).trim().toLowerCase()
          const list = loadReminders()
          const keep = list.filter((r) => r.id !== q && !r.text.toLowerCase().includes(q))
          const gone = list.length - keep.length
          if (gone) saveReminders(keep)
          return text(gone ? `${gone} Erinnerung(en) gelöscht.` : 'Keine passende Erinnerung.')
        },
      ),

      tool(
        'weather',
        'Das Wetter jetzt und für die nächsten drei Tage, für einen Ort oder den eingestellten Heimatort.',
        { place: z.string().optional().describe('Ort. Fehlt er, der Heimatort aus der Einstellung.') },
        async ({ place }) => {
          const where = String(place ?? '').trim() || LOCATION
          if (!where) return text('Kein Ort angegeben und kein Heimatort eingerichtet (JARVIS_LOCATION in .env).')
          try {
            return text(await weatherFor(where))
          } catch (err) {
            return text(`Wetter nicht verfügbar: ${err?.message ?? err}`)
          }
        },
      ),

      tool(
        'briefing',
        'Das Bündel für das Morgen-Briefing: Datum, Wetter, Termine heute und morgen, ' +
          'Erinnerungen. Daraus sprichst du das Briefing: vier bis sechs Sätze, das ' +
          'Wichtigste zuerst, keine Aufzählung, nichts vorlesen, was nicht da ist.',
        {},
        async () => text(await briefingBundle()),
      ),
    ],
  })
}
