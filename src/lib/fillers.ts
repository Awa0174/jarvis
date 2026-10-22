/**
 * Filler speech.
 *
 * A tool call can take ten seconds, and silence that long reads as a crash. So
 * JARVIS says something the instant work starts — then goes quiet until he has
 * an answer. One acknowledgement, no progress chatter.
 *
 * German, like the rest of what he says. The phrasing follows the character's
 * grammar rather than generic assistant-speak, which matters more than it
 * sounds:
 *
 *   - Working lines are subjectless and clipped: "Wird geprüft.", "Suche."
 *     Not "Ich schaue jetzt nach" and never "Lassen Sie mich".
 *   - No snap-to compliance formula. "Sofort" and "Auf der Stelle" are not in
 *     his vocabulary; acknowledgement is deferential, not eager.
 *   - No filler words, no enthusiasm, no apology, no exclamation marks.
 *   - "Sir" fronted means urgency; final means routine. These are all routine,
 *     so it goes at the end, and only sometimes.
 */

/** Said as soon as the first tool fires, before any answer exists. */
const WORKING = [
  'Einen Moment, Sir.',
  'Wird geprüft.',
  'Rufe die Daten ab.',
  'Greife auf das Archiv zu.',
  'Gleiche ab.',
  'Die Abfrage läuft.',
  'Suche.',
  'In Arbeit.',
]

/** Acknowledging an order where no tool is involved. */
const ACKNOWLEDGE = [
  'Wie Sie wünschen, Sir.',
  'Sehr wohl, Sir.',
  'Selbstverständlich.',
  'Verstanden.',
  'Wird erledigt.',
  'Umgehend, Sir.',
]

/** Answering to his name, before the user has said what they want. */
const ATTENTION = [
  'Ja, Sir?',
  'Sir?',
  'Zu Diensten, Sir.',
  'Bereit.',
  'Ich höre, Sir.',
]

/**
 * Avoids repeating the same phrase twice running, which is what makes canned
 * lines sound canned. Keeps one slot of history per pool.
 */
function makePicker(pool: string[]) {
  let last = -1
  return () => {
    if (pool.length < 2) return pool[0] ?? ''
    let i = last
    while (i === last) i = Math.floor(Math.random() * pool.length)
    last = i
    return pool[i]
  }
}

export const working = makePicker(WORKING)
export const acknowledge = makePicker(ACKNOWLEDGE)
export const attention = makePicker(ATTENTION)

/**
 * Naming the task is warmer than a generic acknowledgement and shows the
 * integration off on camera. Still clipped, still under five words.
 *
 * MCP tool names are `mcp__<server>__<tool>`, and the two halves say different
 * things: the server is who is being asked, the tool is what is being asked
 * for. Matching one flat substring against the whole string gets both wrong —
 * `mcp__playwright__browser_click` announced a web search because "browse"
 * appeared earlier in the table than "browser", `Get-Report` looked like a code
 * repository, `Get-Events` like a calendar entry, and "highlight" like a lamp.
 *
 * So: split the name, match the halves separately, order the table so the
 * specific beats the general, and put word boundaries on the short words that
 * hide inside longer ones. Either half matching is enough — the server is the
 * better signal when a name gives one, but plenty of them don't.
 */
type Rule = {
  /** Matched against the server segment, if there is one. */
  server?: RegExp
  /** Matched against the tool segment, or the whole name for a built-in. */
  tool?: RegExp
  lines: string[]
}

const FOOTAGE = ['Schneide das Material.', 'Rendere die Sequenz.']

const BY_TOOL: Rule[] = [
  // The machine itself. Tool halves arrive prettified ("open app"), hence the
  // optional space in the patterns.
  { server: /^jarvis_pc$/, tool: /open[ _](app|path)/, lines: ['Wird geöffnet.', 'Einen Moment.'] },
  { server: /^jarvis_pc$/, tool: /find[ _]files|list[ _]apps/, lines: ['Suche.', 'Durchsuche die Dateien.'] },
  { server: /^jarvis_pc$/, tool: /see[ _]screen/, lines: ['Sehe nach.', 'Einen Blick, Sir.'] },
  { server: /^jarvis_pc$/, tool: /system[ _]status/, lines: ['Prüfe das System.'] },
  { server: /^jarvis_memory$/, lines: ['Notiere.', 'Einen Moment.'] },
  { server: /^jarvis_servers$/, tool: /server[ _]logs/, lines: ['Lese das Protokoll.', 'Gehe die Logs durch.'] },
  { server: /^jarvis_servers$/, tool: /server[ _](run|restart)/, lines: ['Wird ausgeführt.', 'Führe aus.'] },
  { server: /^jarvis_servers$/, lines: ['Frage den Server ab.', 'Prüfe den Server.'] },
  // Video sits above image because higgsfield and palmier both do either, so
  // the verb in the tool name is the only thing separating them — a rule on the
  // server alone would send every generate_video to "Rendere."
  { tool: /video|footage|\bclip\b|\breel\b|talking_head/, lines: FOOTAGE },
  {
    server: /higgsfield|openrouter-image|dalle|flux|midjourney/,
    tool: /image|photo|thumbnail|render|upscale|seedream/,
    lines: ['Rendere.', 'Wird komponiert.'],
  },
  // The editors, once the two rules that read the verb have had their turn.
  { server: /palmier|heygen|runway|descript/, lines: FOOTAGE },
  {
    server: /playwright|puppeteer|browserbase|chrome/,
    tool: /\bbrowser\b|navigate/,
    lines: ['Öffne den Browser.', 'Navigiere.'],
  },
  {
    server: /android|\badb\b|simulator/,
    tool: /\bdevice\b|\bapk\b|\bphone\b/,
    lines: ['Verbinde mit dem Gerät.', 'Greife auf Ihr Telefon zu.'],
  },
  {
    server: /gmail|\bmail\b/,
    tool: /gmail|\bmail\b|email|inbox/,
    lines: ['Prüfe Ihre Mails.', 'Lese den Posteingang.'],
  },
  // Calendar keys off "calendar" alone. "event" used to live here, which is how
  // a Mixpanel event query came out as "Checking your calendar."
  {
    tool: /calendar|\bdiary\b|\bmeeting\b/,
    lines: ['Prüfe Ihren Kalender.', 'Sehe im Terminplan nach.'],
  },
  {
    server: /elevenlabs|openai-tts/,
    tool: /speech|\bvoice\b|\btts\b|text_to_sound/,
    lines: ['Synthetisiere.', 'Einen Moment, Sir.'],
  },
  {
    server: /spotify|sonos/,
    tool: /\bplay\b|\bmusic\b|playlist|\btrack\b/,
    lines: ['Stelle es in die Warteschlange.', 'Lege es auf.'],
  },
  {
    server: /^home|homeassistant|\bhue\b|\bhass\b/,
    tool: /\blights?\b|thermostat|\bdimmer\b/,
    lines: ['Wird eingestellt.', 'Kümmere mich darum, Sir.'],
  },
  {
    server: /github|linear|jira|sentry/,
    tool: /\brepo\b|repository|\bissues?\b|pull_request|\bcommit\b/,
    lines: ['Prüfe das Repository.', 'Sehe im Tracker nach.'],
  },
  // Also where the anonymously named analytics servers land — theirs are bare
  // UUIDs, so only the tool half says anything: Get-Report, Get-Events,
  // Run-Query. "report" is safe from the repository rule above because that one
  // is bounded.
  {
    server: /mixpanel|clarity|posthog|amplitude/,
    tool: /analytic|\bmetrics?\b|\breports?\b|\bevents?\b|cohort|funnel|dashboard|\bquery\b/,
    lines: ['Führe die Abfrage aus.', 'Ziehe die Zahlen.'],
  },
  {
    server: /\bexa\b|serper|serpapi|perplexity|tavily|brave/,
    tool: /search|\bweb\b|\bfetch\b|crawl|research/,
    lines: ['Suche.', 'Sehe in den Aufzeichnungen nach.'],
  },
]

const pickers = BY_TOOL.map((r) => ({ ...r, pick: makePicker(r.lines) }))

/**
 * `mcp__<server>__<tool>`, split on the first separator so tool names keep
 * their own underscores (`browser_click`, `text_to_speech`). A built-in like
 * WebSearch or Bash has no server half.
 *
 * The second form matters more than it looks: the bridge client prettifies
 * names for the HUD badge before handing them on, so what actually arrives
 * here is `higgsfield · generate image`. Parsing only the raw form meant every
 * rule below silently missed and every tool got the generic line.
 */
function split(toolName: string): { server: string; tool: string } {
  const raw = /^mcp__(.+?)__(.+)$/.exec(toolName)
  if (raw) return { server: raw[1].toLowerCase(), tool: raw[2].toLowerCase() }

  const pretty = toolName.split(' · ')
  if (pretty.length === 2) {
    return { server: pretty[0].toLowerCase(), tool: pretty[1].toLowerCase() }
  }

  return { server: '', tool: toolName.toLowerCase() }
}

/** A phrase suited to the tool that just fired. */
export function forTool(toolName: string): string {
  const { server, tool } = split(toolName)
  for (const r of pickers) {
    const hit =
      (r.server !== undefined && server !== '' && r.server.test(server)) ||
      (r.tool !== undefined && r.tool.test(tool))
    if (hit) return r.pick()
  }
  // Read, Bash, Grep and anything unrecognised: better a neutral line than a
  // confident wrong one.
  return working()
}
