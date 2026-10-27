/**
 * Research: finding businesses in an area, and looking at their websites.
 *
 *   businesses_nearby   named businesses in a town or district, from
 *                       OpenStreetMap — a public source under the ODbL, which
 *                       is why every result carries its attribution
 *   website_check       what is objectively there on a site: reachable, on
 *                       https, mobile viewport, contact form, phone, mail,
 *                       Impressum, copyright year, the system it runs on
 *
 * Both are reads. Neither contacts anyone. What they return are
 * observations with an address and a date — the "Belege" a lead needs —
 * and never a judgement; the judgement is the model's, and it has to say
 * which of the two it is giving.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { fetchText } from './net.mjs'

const UA = 'jarvis-local-research/1.0 (private, non-commercial use)'
const text = (t) => ({ content: [{ type: 'text', text: t }] })
const today = () => new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })

// ---------------------------------------------------------------------------
// OpenStreetMap
// ---------------------------------------------------------------------------

const areaCache = new Map()

/** The OSM area id for a place name, via Nominatim. */
async function areaId(place) {
  const key = place.toLowerCase()
  if (areaCache.has(key)) return areaCache.get(key)
  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(place)}&format=json&limit=3&countrycodes=de`,
    { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(15_000) },
  )
  const list = await res.json()
  const hit = (Array.isArray(list) ? list : []).find((x) => x.osm_type === 'relation') ?? list?.[0]
  if (!hit) throw new Error(`Ort nicht gefunden: ${place}`)
  // Overpass area ids: relation + 3600000000, way + 2400000000.
  const base = hit.osm_type === 'relation' ? 3600000000 : hit.osm_type === 'way' ? 2400000000 : 0
  if (!base) throw new Error(`${place} ist kein Gebiet, sondern ein Punkt; nimm die Stadt oder den Kreis.`)
  const out = { id: base + Number(hit.osm_id), name: hit.display_name.split(',')[0] }
  areaCache.set(key, out)
  return out
}

/** What people call trades, mapped onto OSM's tags. */
const KINDS = {
  handwerk: 'craft',
  handwerker: 'craft',
  laden: 'shop',
  geschäft: 'shop',
  einzelhandel: 'shop',
  büro: 'office',
  dienstleister: 'office',
  gastro: 'amenity~"^(restaurant|cafe|bar|pub|fast_food|biergarten|ice_cream)$"',
  gastronomie: 'amenity~"^(restaurant|cafe|bar|pub|fast_food|biergarten|ice_cream)$"',
  restaurant: 'amenity~"^(restaurant|cafe|bar|pub|fast_food|biergarten)$"',
  praxis: 'amenity~"^(doctors|dentist|clinic|veterinary|pharmacy)$"',
  arzt: 'amenity~"^(doctors|dentist|clinic)$"',
  friseur: 'shop=hairdresser',
  autowerkstatt: 'shop=car_repair',
  werkstatt: 'shop=car_repair',
  bäckerei: 'shop=bakery',
  fitness: 'leisure=fitness_centre',
  hotel: 'tourism~"^(hotel|guest_house|apartment)$"',
  landwirtschaft: 'shop=farm',
  alle: 'ALL',
}

function kindFilters(kind) {
  const k = String(kind ?? 'alle').trim().toLowerCase()
  const spec = KINDS[k] ?? (k ? `craft=${k}` : 'ALL')
  if (spec === 'ALL') return ['["craft"]', '["shop"]', '["office"]', '["amenity"~"^(restaurant|cafe|doctors|dentist|pharmacy|veterinary)$"]', '["leisure"="fitness_centre"]', '["tourism"~"^(hotel|guest_house)$"]']
  if (spec.includes('~')) {
    const [key, re] = spec.split('~')
    return [`["${key}"~${re}]`]
  }
  if (spec.includes('=')) {
    const [key, val] = spec.split('=')
    return [`["${key}"="${val}"]`]
  }
  return [`["${spec}"]`]
}

async function overpass(areaIdNum, filters, max) {
  const union = filters.map((f) => `nwr["name"]${f}(area.a);`).join('')
  const q = `[out:json][timeout:40];area(${areaIdNum})->.a;(${union});out center tags ${Math.min(400, max * 4)};`
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'user-agent': UA, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(q)}`,
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`Overpass antwortet ${res.status}`)
  const data = await res.json()
  return Array.isArray(data?.elements) ? data.elements : []
}

function describe(el) {
  const t = el.tags ?? {}
  const kind = t.craft ?? t.shop ?? t.office ?? t.amenity ?? t.leisure ?? t.tourism ?? ''
  const addr = [t['addr:street'] && `${t['addr:street']} ${t['addr:housenumber'] ?? ''}`.trim(), t['addr:postcode'], t['addr:city']].filter(Boolean).join(', ')
  const site = t.website ?? t['contact:website'] ?? t.url ?? ''
  const phone = t.phone ?? t['contact:phone'] ?? ''
  const mail = t.email ?? t['contact:email'] ?? ''
  return { name: t.name, kind, addr, site, phone, mail, brand: t.brand ?? '', id: `${el.type}/${el.id}` }
}

// ---------------------------------------------------------------------------
// Website check
// ---------------------------------------------------------------------------

function normalizeUrl(raw) {
  let u = String(raw ?? '').trim()
  if (!u) throw new Error('keine Adresse')
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`
  return u
}

async function checkSite(raw) {
  const first = normalizeUrl(raw)
  const t0 = Date.now()
  let page
  let tried = first
  try {
    page = await fetchText(first, { maxBytes: 2_500_000, timeoutMs: 15_000 })
  } catch (err) {
    // Many small-business sites still live on http only.
    if (/^https:/i.test(first)) {
      tried = first.replace(/^https:/i, 'http:')
      try {
        page = await fetchText(tried, { maxBytes: 2_500_000, timeoutMs: 15_000 })
      } catch (err2) {
        return { ok: false, url: first, error: String(err2?.message ?? err2) }
      }
    } else {
      return { ok: false, url: first, error: String(err?.message ?? err) }
    }
  }
  const ms = Date.now() - t0
  const html = page.text
  const lower = html.toLowerCase()
  const pick = (re) => re.exec(html)?.[1]?.replace(/\s+/g, ' ').trim() ?? ''
  const title = pick(/<title[^>]*>([^<]{0,200})<\/title>/i)
  const desc = pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{0,300})/i) || pick(/<meta[^>]+content=["']([^"']{0,300})["'][^>]+name=["']description["']/i)
  const viewport = /<meta[^>]+name=["']viewport["']/i.test(html)
  const generator = pick(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']{0,80})/i)
  const system =
    generator ||
    (lower.includes('wp-content') ? 'WordPress' : '') ||
    (lower.includes('jimdo') ? 'Jimdo' : '') ||
    (lower.includes('wixstatic') || lower.includes('wix.com') ? 'Wix' : '') ||
    (lower.includes('squarespace') ? 'Squarespace' : '') ||
    (lower.includes('joomla') ? 'Joomla' : '') ||
    (lower.includes('typo3') ? 'TYPO3' : '') ||
    (lower.includes('1und1') || lower.includes('ionos') ? 'IONOS-Baukasten?' : '') ||
    ''
  const tel = (html.match(/href=["']tel:[^"']+/gi) ?? []).length
  const phoneText = /(\+49|0)[\s\d/().-]{7,}\d/.test(html.replace(/<[^>]+>/g, ' '))
  const mailto = (html.match(/href=["']mailto:[^"']+/gi) ?? []).length
  const form = /<form[\s\S]{0,2500}?(type=["']email["']|<textarea|name=["'][^"']*(nachricht|message|email|mail)[^"']*["'])/i.test(html)
  const kontakt = /href=["'][^"']*kontakt[^"']*["']|>\s*kontakt\s*</i.test(html)
  const impressum = /impressum/i.test(html)
  const datenschutz = /datenschutz/i.test(html)
  const years = [...html.matchAll(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(20\d{2})/gi)].map((m) => Number(m[1]))
  const copyright = years.length ? Math.max(...years) : null
  const lastMod = page.headers?.['last-modified'] ?? ''
  const images = (html.match(/<img\b/gi) ?? []).length
  const flash = /\.swf\b|application\/x-shockwave-flash/i.test(html)
  const tables = (html.match(/<table\b/gi) ?? []).length
  const social = ['facebook.com', 'instagram.com', 'linkedin.com', 'tiktok.com', 'youtube.com'].filter((s) => lower.includes(s))
  const lang = pick(/<html[^>]+lang=["']([a-z-]{2,6})/i)
  const insecure = page.url.startsWith('http:')
  return {
    ok: true,
    url: page.url,
    redirected: page.url.replace(/\/$/, '') !== tried.replace(/\/$/, ''),
    ms,
    bytes: page.bytes,
    insecure,
    title,
    desc,
    viewport,
    system,
    contact: { tel, phoneText, mailto, form, kontakt },
    legal: { impressum, datenschutz },
    copyright,
    lastMod,
    images,
    flash,
    tables,
    social,
    lang,
  }
}

function report(r) {
  const d = today()
  if (!r.ok) return `Nicht erreichbar: ${r.url} — ${r.error}. [geprüft am ${d}]`
  const yes = (b) => (b ? 'ja' : 'nein')
  const lines = [
    `Website: ${r.url}${r.redirected ? ' (weitergeleitet)' : ''} — erreichbar in ${r.ms} ms, ${Math.round(r.bytes / 1024)} KB`,
    `Verschlüsselt (https): ${yes(!r.insecure)}`,
    `Mobil (Viewport-Angabe): ${yes(r.viewport)}`,
    `Titel: ${r.title || '(leer)'}`,
    `Beschreibung für Suchmaschinen: ${r.desc ? `vorhanden (${r.desc.length} Zeichen)` : 'fehlt'}`,
    `System: ${r.system || 'nicht erkennbar'}`,
    `Kontakt: Formular ${yes(r.contact.form)} · Telefon-Link ${r.contact.tel} · Telefonnummer im Text ${yes(r.contact.phoneText)} · Mail-Link ${r.contact.mailto} · Kontaktseite verlinkt ${yes(r.contact.kontakt)}`,
    `Impressum ${yes(r.legal.impressum)} · Datenschutz ${yes(r.legal.datenschutz)}`,
    `Copyright-Jahr: ${r.copyright ?? 'keins'}${r.lastMod ? ` · Server-Änderungsdatum: ${r.lastMod}` : ''}`,
    `Bilder: ${r.images} · Tabellen-Layout: ${r.tables > 3 ? 'wahrscheinlich (' + r.tables + ' Tabellen)' : 'nein'} · Flash: ${yes(r.flash)} · Sprache: ${r.lang || '?'}`,
    r.social.length ? `Soziale Netzwerke verlinkt: ${r.social.join(', ')}` : 'Soziale Netzwerke verlinkt: keine',
    `[Quelle: ${r.url}, geprüft am ${d}. Beobachtungen, keine Bewertung.]`,
  ]
  return lines.join('\n')
}

// ---------------------------------------------------------------------------

export function researchServer() {
  return createSdkMcpServer({
    name: 'jarvis_research',
    version: '1.0.0',
    instructions:
      'Recherche: Betriebe in einem Ort oder Kreis aus OpenStreetMap, und eine objektive Prüfung ' +
      'einer Website. Beides liefert Beobachtungen mit Quelle und Datum, keine Urteile.',
    alwaysLoad: true,
    tools: [
      tool(
        'businesses_nearby',
        'Betriebe mit Namen in einem Ort oder Kreis, aus OpenStreetMap (öffentliche Quelle, ODbL). ' +
          'Mit Art (z. B. handwerk, laden, gastro, praxis, friseur, autowerkstatt, oder ein OSM-Handwerk wie ' +
          'roofer, electrician, plumber, carpenter, painter) oder "alle". Liefert Name, Art, Adresse und, ' +
          'falls eingetragen, Website, Telefon und Mail. Ohne Website-Eintrag heißt nur: in OSM keine; ' +
          'das ist noch kein Beleg, dass der Betrieb keine hat.',
        {
          place: z.string().describe('Ort, Stadt oder Kreis, z. B. "Barntrup" oder "Kreis Lippe".'),
          kind: z.string().optional().describe('Art des Betriebs, Standard "alle".'),
          max: z.union([z.number(), z.string()]).optional().catch(undefined).describe('Höchstens so viele, Standard 40.'),
          without_website: z.boolean().optional().catch(undefined).describe('true = nur Betriebe ohne eingetragene Website.'),
        },
        async ({ place, kind, max, without_website }) => {
          const n = Math.max(1, Math.min(150, Number(max) || 40))
          try {
            const area = await areaId(String(place))
            const els = await overpass(area.id, kindFilters(kind), n)
            let items = els.map(describe).filter((x) => x.name && !x.brand)
            if (without_website) items = items.filter((x) => !x.site)
            // Chains and big brands are not the target; names that repeat are.
            const seen = new Set()
            items = items.filter((x) => {
              const k = x.name.toLowerCase()
              if (seen.has(k)) return false
              seen.add(k)
              return true
            })
            items = items.slice(0, n)
            console.log(`[research] ${area.name} / ${kind ?? 'alle'} → ${items.length} Betriebe`)
            if (!items.length) return text(`Keine Einträge für ${area.name} (${kind ?? 'alle'}) in OpenStreetMap.`)
            return text(
              `${items.length} Betriebe in ${area.name} (${kind ?? 'alle'}), Quelle OpenStreetMap (ODbL), Stand ${today()}:\n` +
                items
                  .map((x) => `- ${x.name} · ${x.kind || '?'}${x.addr ? ` · ${x.addr}` : ''}${x.site ? ` · Website: ${x.site}` : ' · keine Website in OSM'}${x.phone ? ` · Tel ${x.phone}` : ''}${x.mail ? ` · Mail vorhanden` : ''}`)
                  .join('\n'),
            )
          } catch (err) {
            return text(`Recherche fehlgeschlagen: ${err?.message ?? err}`)
          }
        },
      ),
      tool(
        'website_check',
        'Eine Website objektiv prüfen: erreichbar, verschlüsselt, mobil, Kontaktmöglichkeiten, Impressum, ' +
          'Copyright-Jahr, System, Umfang. Liefert nur Beobachtungen mit Adresse und Datum; die Einordnung ' +
          '(„veraltet“, „ohne Kontaktweg“) triffst du und nennst sie als deine.',
        { url: z.string().describe('Die Adresse der Website.') },
        async ({ url }) => {
          try {
            const r = await checkSite(url)
            console.log(`[research] website_check ${r.url} → ${r.ok ? 'ok' : 'nicht erreichbar'}`)
            return text(report(r))
          } catch (err) {
            return text(`Prüfung fehlgeschlagen: ${err?.message ?? err}`)
          }
        },
      ),
    ],
  })
}
