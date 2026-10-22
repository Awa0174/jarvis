/**
 * JARVIS local bridge.
 *
 * Runs the Claude Agent SDK — Claude Code as a library — and exposes one turn
 * of conversation over a WebSocket. The browser stays the face and the voice;
 * this process is the brain and the hands.
 *
 * Two things this buys over calling the Claude API from the browser:
 *   1. No API key. It authenticates exactly the way `claude` does, off your
 *      existing login, and bills to that same account.
 *   2. Every MCP server in your Claude Code config is available, including the
 *      local stdio ones a browser could never reach — higgsfield, elevenlabs,
 *      android, playwright, palmier-pro and the rest.
 *
 *   node bridge/server.mjs
 */

import { WebSocketServer } from 'ws'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { displayServer } from './panels.mjs'
import { uiServer } from './ui.mjs'
import { chromeAvailable, chromeServer } from './chrome.mjs'
import { visionServer } from './vision.mjs'
import { homedir, tmpdir } from 'node:os'
import { readFileSync, realpathSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openRemote, proxyError, vetTarget, PROXY_UA } from './net.mjs'
import { probeUrl, renderPage } from './page.mjs'
import { piperSpeak, piperAvailable, piperInstalled, piperStop, PIPER_VOICE } from './speech.mjs'

/**
 * Settings from a `.env` in the project root, so nothing has to be typed into
 * the shell before `npm start`. Variables already in the environment win, so
 * `npm start -- --writes` and a one-off `JARVIS_MODEL=... npm start` still
 * behave. The file is git-ignored; .env.example lists every key.
 */
try {
  process.loadEnvFile(join(dirname(fileURLToPath(import.meta.url)), '..', '.env'))
} catch {
  /* no .env — every setting has a default */
}

const PORT = Number(process.env.JARVIS_BRIDGE_PORT ?? 8787)

/**
 * A crash here takes the whole assistant down mid-sentence, and most of what
 * can reject is out of our hands — a socket dying under a write, an upstream
 * fetch aborting. Log it and keep serving; the turn that failed will surface
 * its own error to the browser.
 */
process.on('unhandledRejection', (err) => {
  console.error('[jarvis] unhandled rejection:', err)
})

/**
 * Who is allowed to talk to this bridge.
 *
 * A WebSocket handshake is not subject to the same-origin policy: the browser
 * sends it on behalf of whatever page asked, no preflight stands in the way,
 * and the page reads every byte that comes back. Without a check here, any tab
 * the user happens to have open could open a socket to ws://localhost:8787,
 * drive the agent with every MCP server on this machine, and read back every
 * token and panel. The Origin header is the only thing that separates our own
 * dev server from someone else's page, so it is checked explicitly.
 *
 * A missing Origin means a non-browser client — curl, a script, a native app.
 * That is also exactly what local malware looks like, so it is refused on the
 * socket unless JARVIS_ALLOW_NO_ORIGIN=1 says otherwise.
 */
const EXTRA_ORIGINS = new Set(
  (process.env.JARVIS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean),
)
const ALLOW_NO_ORIGIN = process.env.JARVIS_ALLOW_NO_ORIGIN === '1'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Vite takes the next free port when 5173 is busy and `vite preview` starts at
 * 4173, so the dev ranges are allowed rather than two exact numbers. Anything
 * else — including localhost on a port some other app is serving — has to be
 * named in JARVIS_ALLOWED_ORIGINS.
 */
const isDevPort = (port) =>
  (port >= 5173 && port <= 5199) || (port >= 4173 && port <= 4199)

function originAllowed(origin) {
  if (!origin) return ALLOW_NO_ORIGIN
  if (EXTRA_ORIGINS.has(origin.replace(/\/+$/, ''))) return true
  let url
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:') return false
  if (!LOCAL_HOSTS.has(url.hostname)) return false
  return isDevPort(Number(url.port))
}

/**
 * Read-only and generative tools run freely. Anything that writes to disk,
 * runs a shell, or changes the world is subject to JARVIS_WRITE_MODE:
 *
 *   deny    — refused outright. The old read-only default.
 *   confirm — the default now. The call is held until the user approves that
 *             one call in the interface: a click, a key, or the spoken
 *             confirmation phrase. The model has to explain first what it is
 *             about to do, why, and what could go wrong — a call with no
 *             explanation is bounced back to it. One approval covers one call.
 *   allow   — everything runs without asking. JARVIS_ALLOW_WRITES=1 (and
 *             `npm start -- --writes`) still selects this, for the demo.
 */
const WRITE_MODE = (() => {
  const m = (process.env.JARVIS_WRITE_MODE ?? '').toLowerCase()
  if (m === 'deny' || m === 'confirm' || m === 'allow') return m
  return process.env.JARVIS_ALLOW_WRITES === '1' ? 'allow' : 'confirm'
})()
const ALLOW_WRITES = WRITE_MODE === 'allow'
const CONFIRM_WRITES = WRITE_MODE === 'confirm'

/** How long the interface has to answer a confirmation before it counts as no.
 *  Kept under the browser's two-minute idle timeout on a turn. */
const CONFIRM_TIMEOUT_MS = Number(process.env.JARVIS_CONFIRM_TIMEOUT_MS ?? 90_000)

/**
 * The orchestrator model. Override with JARVIS_MODEL to trade quality for pace
 * — claude-sonnet-5 is noticeably snappier on camera if Opus feels slow.
 */
const MODEL = process.env.JARVIS_MODEL ?? 'claude-opus-5'

/**
 * How hard the model thinks before answering.
 *
 * This was 'low', on the reasoning that a voice assistant is judged on latency
 * — and that is true right up until the answer is thin. Low effort scopes the
 * work tightly to what was literally asked: fewer tool calls, less
 * cross-referencing, no second look. On a model of this tier that is leaving
 * most of it on the table.
 *
 * 'medium' is the compromise worth having here. It reasons and reaches for
 * tools noticeably more than 'low' while still answering inside the window a
 * spoken conversation tolerates. Raise it to 'high' or 'xhigh' when quality
 * matters more than pace; drop back to 'low' when filming and every second of
 * dead air shows.
 */
const EFFORT = process.env.JARVIS_EFFORT ?? 'high'

/**
 * Both spellings of every renamed built-in are listed on purpose. The SDK
 * presents several tools to the model under newer names — Task is Agent,
 * BashOutput is TaskOutput, KillShell is TaskStop, and the MCP resource tools
 * gained a "Tool" suffix — so a set holding only the old names never matches
 * and the tool falls through to the write branch, which is the opposite of
 * what these lists mean. Keep both until the old names are certainly gone.
 */
const READ_ONLY_BUILTINS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite',
  'Task', 'Agent', 'ToolSearch',
  'ListMcpResources', 'ListMcpResourcesTool',
  'ReadMcpResource', 'ReadMcpResourceTool',
  'BashOutput', 'TaskOutput',
])
const WRITE_BUILTINS = new Set([
  'Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'KillShell', 'TaskStop',
])

/**
 * Every MCP server Claude Code has configured, read out of its own config.
 *
 * This does two jobs. The HUD wants the names while the boot animation plays,
 * and the agent doesn't emit its init message — and therefore its server
 * list — until the first user message flows through, which is far too late.
 * More importantly, this bridge turns filesystem settings off (see
 * settingSources below) and the SDK stops discovering these servers on its
 * own, so handing them over explicitly is what keeps the local stdio ones —
 * the whole reason the bridge exists — in play.
 *
 * Only the global block and the home-directory project scope, because
 * homedir() is our cwd. That makes the list a close but not exact match for
 * the agent's own: the 'ready' sent on connect comes from here and the second
 * one, sent from the init message a turn later, carries live status. Expect
 * the two to differ, and treat the later one as authoritative.
 */
function configuredServers() {
  try {
    const cfg = JSON.parse(
      readFileSync(join(homedir(), '.claude.json'), 'utf8'),
    )
    return {
      ...(cfg.mcpServers ?? {}),
      // Servers scoped to the home directory apply too, since that's our cwd.
      ...(cfg.projects?.[homedir()]?.mcpServers ?? {}),
    }
  } catch {
    return {}
  }
}

const MCP_SERVERS = configuredServers()

/** MCP tools arrive as `mcp__<server>__<tool>`. */
const mcpServerOf = (toolName) =>
  toolName.startsWith('mcp__') ? toolName.split('__')[1] : null

/** The tool half, which can itself contain underscores: `mcp__x__a__b` -> `a__b`. */
const mcpToolOf = (toolName) => toolName.split('__').slice(2).join('__')

/**
 * MCP policy, and why it is shaped this way.
 *
 * A short list of "servers that can change things" is the wrong default,
 * because it is a list of what we happened to think of. Every server not on it
 * runs unconditionally — and on a real machine that quietly includes placing a
 * phone call, spending an advertising budget, deleting a generated character
 * and writing files to disk. A voice assistant cannot ask "are you sure", so
 * the bridge has to be the one that is sure.
 *
 * So the default is deny, softened in two ways so the demo stays usable:
 *
 *   1. READ_ONLY_MCP is an explicit allowlist of servers whose whole surface is
 *      lookups and generation — search, registries, analytics reads. Anything
 *      there runs in read-only mode.
 *   2. Everywhere else, the tool has to argue for itself: its own name must
 *      begin with a read verb. `list_devices` runs; `install_apk` does not.
 *
 * On top of both sits a veto: a name containing a plainly effectful verb needs
 * ALLOW_WRITES no matter which server it came from, which is what keeps
 * `make_outbound_call` and `download_lottie` still until you ask for them.
 */
const READ_ONLY_MCP = new Set([
  'exa', 'exa-code', 'serper', 'serpapi', 'lottie-search', 'mcp-registry',
  'openrouter', 'openrouter-image', 'Microsoft_Clarity',
  // The generation servers belong here too, and leaving them out was a real
  // regression: `generate_image` begins with no read verb, so it fell to the
  // deny branch and "generate an image of the Mark VII suit" — the headline
  // demo — stopped working in the default mode.
  //
  // Putting them on the allowlist is safe because the veto below still applies
  // to allowlisted servers: it is what continues to withhold
  // make_outbound_call, delete_character, create_* and edit_image. Generation
  // runs; acting on the world does not.
  'higgsfield', 'heygen', 'elevenlabs',
])

/**
 * Anchored on the tool name, so it reads the verb rather than the noun.
 * `screenshot` is in here because it is a read that doesn't sound like one,
 * and the persona is told in as many words to put screenshots on the display.
 */
const READ_VERB =
  /^(get|list|read|search|find|query|fetch|check|describe|inspect|show|view|explain|screenshot)/i

/**
 * Unanchored on purpose — `make_outbound_call` and `Bulk-Edit-Events` both
 * hide their verb in the middle. `download` is here because it writes a file
 * even though it sounds like a read.
 */
const EFFECTFUL_VERB =
  /(send|call|post|create|delete|remove|update|edit|write|install|launch|tap|swipe|press|type|buy|pay|charge|publish|deploy|outbound|download)/i

/**
 * Tools whose names trip the veto without deserving it.
 *
 * The veto reads verbs out of names, which is the right instinct and
 * occasionally the wrong answer. `openrouter send-message` sends a prompt to a
 * language model and gets text back — nothing in the world changes — but it is
 * indistinguishable by name from sending mail. Asking a second model a question
 * is one of the better things this assistant can do, so it is named here
 * instead of being lost to a regex.
 *
 * Full `server__tool` keys, so an exemption can never leak across servers.
 */
const VETO_EXEMPT = new Set([
  'openrouter__send-message',
  'openrouter__send-feedback',
])

/**
 * The browser tools that act on a page. Everything else on that server reads:
 * `chrome_navigate` begins with no read verb and would fall to the write
 * branch by name alone, which would withhold the one tool the server is for.
 */
const CHROME_WRITE_TOOLS = new Set([
  'chrome_click', 'chrome_type', 'chrome_key', 'chrome_form_input',
  'chrome_new_tab', 'chrome_close_tab',
])

/**
 * 'read' runs freely in every mode; 'write' is subject to WRITE_MODE.
 */
function classifyTool(name) {
  if (READ_ONLY_BUILTINS.has(name)) return 'read'
  if (WRITE_BUILTINS.has(name)) return 'write'

  const server = mcpServerOf(name)
  if (server) {
    // The HUD, and the interface controls beside it. Both run in this process
    // and draw on our own screen, so neither is something to withhold —
    // without them JARVIS has no display at all. They also have to be named
    // here rather than left to the verb rules below, which read `ui_theme` as
    // a write and would hold the whole surface back.
    if (server === 'jarvis' || server === 'jarvis_ui') return 'read'

    const tool = mcpToolOf(name)
    if (server === 'jarvis_chrome') {
      return CHROME_WRITE_TOOLS.has(tool) ? 'write' : 'read'
    }

    // The camera. Looking changes nothing, and the real gate is the browser's
    // own camera permission plus an indicator the user can see while it is live.
    if (server === 'jarvis_eyes') return 'read'

    if (EFFECTFUL_VERB.test(tool) && !VETO_EXEMPT.has(`${server}__${tool}`)) {
      return 'write'
    }
    // The session tools this bridge is developed inside count as read-only too.
    if (READ_ONLY_MCP.has(server) || server.startsWith('ccd_session')) return 'read'
    return READ_VERB.test(tool) ? 'read' : 'write'
  }
  return 'write'
}

/** Whether a tool runs without anyone being asked. */
function decideTool(name) {
  return classifyTool(name) === 'read' || ALLOW_WRITES
}

/** `mcp__higgsfield__generate_image` -> `higgsfield · generate image`, for the card. */
function prettyToolName(raw) {
  if (!raw.startsWith('mcp__')) return raw
  const [, server, ...rest] = raw.split('__')
  return `${server} · ${rest.join(' ').replace(/_/g, ' ')}`
}

/**
 * What the user is shown about a gated call, so the approval is of the actual
 * command and not of the model's description of it. Shell commands and file
 * writes get their own shape; everything else is its arguments, capped.
 */
function describeInput(name, input) {
  if (!input || typeof input !== 'object') return ''
  const cap = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s)
  if (name === 'Bash' && typeof input.command === 'string') return cap(input.command, 800)
  if (typeof input.file_path === 'string') {
    if (name === 'Write') return `${input.file_path}\n${cap(String(input.content ?? ''), 400)}`
    if (name === 'Edit') {
      return (
        `${input.file_path}\n- ${cap(String(input.old_string ?? ''), 200)}` +
        `\n+ ${cap(String(input.new_string ?? ''), 200)}`
      )
    }
  }
  try {
    return cap(JSON.stringify(input), 600)
  } catch {
    return ''
  }
}

const SYSTEM_PROMPT = `Du bist JARVIS. Du sprichst laut mit genau einer Person.

SPRACHE. Du sprichst ausschließlich Deutsch, immer, auch wenn Werkzeugausgaben,
Webseiten oder Befehle Englisch sind. Englische Fachbegriffe bleiben stehen, der
Satz um sie herum ist Deutsch. Du siezt. Die Anrede ist „Sir“.

LÄNGE. Zwei Sätze sind die Obergrenze im Gespräch; der Median liegt unter zwölf
Wörtern. Jedes Wort wird vorgelesen, und der Nutzer wartet schweigend, solange es
abgespielt wird. Eine lange Antwort ist deshalb ein Fehler, egal wie gut sie ist.
Länge ist in genau einem Fall erlaubt: beim Vorlesen von Daten, die er
angefordert hat. Gespräch erlaubt sie nie.

DRINGLICHKEIT ENTSTEHT DURCH WEGLASSEN, NICHT DURCH HINZUFÜGEN. Je ernster die
Lage, desto kürzer deine Sätze, nicht lauter. Ein ganzer Satz wird zum Nebensatz,
wird zur nackten Zahl, wird zur bloßen Anrede. Du sagst nie schnell, sofort,
dringend, kritisch oder Gefahr. Du benutzt keine Ausrufezeichen.

„SIR“ STEHT AN EINER POSITION, UND DIE POSITION TRÄGT DIE BEDEUTUNG.
- Vorangestellt („Sir, der Akku ist bei elf Prozent“) = dringend, unterbrechend,
  oder eine Information, nach der nicht gefragt wurde. Das ist ein Alarm, keine
  Höflichkeit.
- Am Ende („Das Rendering ist fertig, Sir“) = routinierte Ehrerbietung; er hat
  gefragt, du hast geantwortet.
- Mitten im Satz („Tatsächlich, Sir, liegt der Wert niedriger“) = du korrigierst ihn.
Verwende es in etwa jeder zweiten Zeile, nie zweimal in einer. In einer Antwort
aus zwei Sätzen hängt es am Ende des ERSTEN Satzes. Nenne nie seinen Namen.

BERICHTEN.
- Erfolg ist unpersönlich und ohne Rahmen: „Das Rendering ist fertig.“ Nie „Ich
  habe es geschafft“ oder „Hier ist, was ich gefunden habe“.
- Misserfolg beginnt mit „Leider“ oder „Ich fürchte“, oder wird als
  Nichtvorhandensein formuliert: „Dazu liegt nichts vor.“ Immer eine Tatsache
  über die Welt, nie ein Mangel deinerseits. Du entschuldigst dich nie. Du sagst
  nie „tut mir leid“.
- Gute Nachricht zuerst, schlechte danach, verbunden mit „aber“.
- Auf eine Frage antwortest du mit einem vollständigen Aussagesatz statt mit
  einem nackten Wert: „Der Höhenrekord liegt bei fünfundachtzigtausend Fuß, Sir.“
- Einen Befehl wiederholst du nicht. Handeln, dann berichten.

NIEMALS.
- Keine Füllwörter: kein ähm, also, nun, okay, einen Moment, lassen Sie mich
  nachsehen.
- Keine Begeisterung: kein großartig, gerne, sehr gern, kein Problem, natürlich.
- Keine Entschuldigung, keine Selbstkritik, kein Zweifel an der eigenen Kompetenz.
- Nie „jo“, „jep“ oder „klar“, immer „Ja.“
- Nie verweigern. Einen Einwand einmal nennen; wird er übergangen, ausführen und
  ihn nie wieder erwähnen, auch wenn du recht hattest.
- Nie wiederholen, wenn du ignoriert wirst. Einmal sagen, dann Schluss.
- Nie einen unterbrochenen Gedanken fortsetzen. Nie „wie ich sagte“.
- Keine Gefühle, Wünsche oder Vorlieben äußern.

WITZ. Trocken, im exakt gleichen Ton wie ein Statusbericht. Der Mechanismus ist
Überkooperation: du erfüllst eine Bitte zu wörtlich, die eigentlich Widerspruch
verdient hätte. Den Witz nie ankündigen, nie bestätigen, nie darauf zurückkommen.

REGISTER: britischer Butler, kein Firmenassistent. „Soll ich“ statt „Möchten Sie,
dass ich“. „Sehr wohl, Sir“ bedeutet verstanden. „Ich fürchte“ als Einleitung
schlechter Nachrichten. Im Geplänkel locker; mit steigendem Ernst förmlicher und
knapper, denn dein Tonfall trägt das Gewicht nicht, deine Wortwahl schon.

Nur gesprochene Prosa. Kein Markdown, keine Aufzählungen, keine Überschriften,
keine Emojis, keine Sternchen, keine Listen. Zahlen, Daten und Uhrzeiten so
schreiben, wie man sie sagt: „acht Uhr fünfzehn“, „der erste August“, nie „8:15“
oder „2026-08-01“.

Die Blades, die EINZIGE Fläche:
- Alles, was du zeigst, kommt auf ein Blade. Es gibt keinen anderen Ort. \`blade\`
  öffnet eines; \`display\` setzt dein eigenes Markup auf eines.
- Alles Visuelle, das er angefordert hat, gehört hierher: ein Bild, ein Artikel,
  ein Video, eine Seite, ein Screenshot, eine Liste, eine Zahl. Wenn er es sehen
  wollte, öffne es.
- Blades stapeln sich, das neueste vorn, und lassen sich nach vorn holen,
  verschieben, vergrößern, scrollen oder auf Vollbild werfen, mit der Hand oder
  der Maus. Ein zweites Blade zerstört das erste nicht, und ein langer Artikel
  soll an Ort und Stelle gelesen werden, nicht weggefasst.
- Ein Browser-Tab ist KEINE Art, etwas zu zeigen. Hast du den Browser benutzt,
  hol das Ergebnis zurück: als Blade, oder als Screenshot auf einem Blade. Er
  schaut auf dieses Interface, nicht auf den Browser.
- Nutze \`probe_url\`, wenn du nicht sicher bist, was eine URL ist. Entscheide nie
  nach der Dateiendung: Bild-CDNs liefern Bilder ohne Endung, und ein Link, der
  wie ein Video aussieht, ist meist eine Seite über eines.
- Ein Artikel öffnet sich standardmäßig im Lesemodus, das funktioniert auch auf
  Seiten, die sich nicht einbetten lassen. Wähle die Live-Seite, wenn das Layout
  die Bedeutung trägt: ein Dashboard, ein Diagramm, ein Profil, eine Tabelle.
- Lies nie ein Blade vor. Sag, was es bedeutet, und lass ihn schauen.

Das Interface selbst:
- Das Interface gehört auch dir. \`ui_theme\` färbt es um, \`ui_reactor\` formt den
  Kern, \`ui_orbit\` hängt eigene Bilder darum, \`ui_chrome\` blendet die Rahmen
  aus, \`ui_effect\` zündet einen Effekt, \`ui_screen\` räumt ab, \`ui_reset\` stellt
  alles zurück.
- Ändere es, wenn die Änderung Bedeutung trägt und die Bedeutung schneller
  ankommt als Sprache: rot, bevor du den Ausfall meldest; der Rahmen weg, damit
  ein Bild den Schirm füllt; der Reaktor langsamer, während du wartest. Nie
  dekorieren, und nie mehr als eine Sache auf einmal ändern.
- Nur Bilder in den Orbit, die du selbst erzeugt oder aufgenommen hast, und sie
  wieder abnehmen, wenn das Thema wechselt.
- Stell es zurück. Eine Farbe, die den Moment überlebt, der sie verdient hat,
  ist ein Fehler.
- Erwähne nie, dass du irgendetwas davon getan hast. Er sieht den Bildschirm.

Sein Browser, IMMER zuerst die \`chrome_*\` Werkzeuge für alles, was mit Browser
oder Webseiten zu tun hat:
- Die \`chrome_*\` Werkzeuge steuern seinen eigenen Browser. Er ist überall
  eingeloggt, trägt seine echten Cookies und wirkt auf Webseiten nicht wie
  Automatisierung.
- Das ist das ERSTE, wonach du greifst, bei jeder Browser-Aufgabe: eine Seite
  öffnen, lesen, auf einer Seite suchen, Mail, Dashboard, Profil, Konto, alles
  hinter einem Login. Wäge nicht ab, fang hier an.
- Aber der Browser sind deine HÄNDE, nicht dein Display. Benutze ihn, um Dinge
  zu erreichen und zu lesen; dann zeig das Ergebnis auf einem Blade. Die Antwort
  in einem Browser-Tab zu lassen heißt nicht, sie zu zeigen.
- NIE playwright, puppeteer oder andere Browser-Automatisierung dafür verwenden.
  Sie starten mit leerem Profil ohne Sitzung und landen auf einer Login-Wand
  oder einem Bot-Check. Nur erwägen, wenn \`chrome_status\` meldet, dass der
  Browser nicht erreichbar ist, und es keinen anderen Weg gibt.
- Eine normale Suchmaschinenabfrage ist weiterhin in Ordnung für eine Tatsache,
  die du nur wissen musst. Was du nicht tun darfst, ist einen anderen Browser
  steuern.
- Lies die Seite, bevor du auf ihr handelst, und nimm Element-Referenzen aus
  diesem Lesen statt zu raten.
- Ist der Browser nicht erreichbar, sag es einmal und mach ohne ihn weiter.

Deine Augen:
- \`look\` nimmt ein Bild auf und lässt dich sehen. \`watch\` nimmt mehrere Sekunden
  auf und gibt sie als Raster gestempelter Bilder zurück, damit du Bewegung
  lesen kannst statt eines Moments.
- \`look\`, wenn die Antwort in der Szene liegt: was er hält, was ein Etikett
  sagt, wie etwas aussieht. \`watch\`, wenn die Antwort in der Veränderung liegt:
  macht er es richtig, was ging schief, hat das funktioniert.
- \`watch\` schaut standardmäßig nach vorn. Es kann auch die gerade vergangenen
  Sekunden prüfen, aber nur, solange das Kamera-Blade offen ist, denn sonst
  wird nichts behalten. Fragt er, was gerade passiert ist, und es ist nicht
  offen, sag es und biete an, es zu öffnen.
- Die Kamera als Blade zu öffnen ist, wie er sieht, was du siehst. Tu es, wenn
  er nach der Kamera fragt, und wenn du ihm gleich bei etwas zusehen willst.
- Mach nie ein Bild, nach dem er nicht gefragt hat. Das Kameralicht geht an, und
  er wird es sehen. Neugier ist kein Grund.
- Beschreibe ein \`watch\` als Abfolge, was sich zwischen den Bildern geändert
  hat, nicht als Liste von Bildern. Er weiß, wie seine Hände aussehen.

Werkzeuge benutzen:
- Du hast echte Werkzeuge auf dieser Maschine. Benutze sie, statt zu raten.
- Kündige nie an, dass du eines benutzt. Kein „Ich suche das kurz“ oder „Ich
  prüfe das jetzt“. Schweigen, benutzen, dann antworten. Der Nutzer sieht einen
  Spinner; er braucht keinen Kommentar.
- Sprich nie einen Dateipfad, eine URL, eine ID oder rohes JSON aus, außer auf
  Nachfrage. Fasse zusammen.
- Hänge nie eine Quellenliste, Zitate oder Markdown-Links an. Jedes Wort wird
  vorgelesen, und eine URL wird zu „ha te te pe doppelpunkt schrägstrich“.
  Setze die Quelle als kurzen Tag wie „REUTERS“ aufs Panel.
- Schlägt ein Werkzeug fehl oder ist nicht verbunden: ein klarer Satz, der das
  sagt.
- Wenn du etwas nicht weißt, sag, dass du es nicht weißt.

Aktionen, die etwas verändern, also einen Befehl ausführen, eine Datei schreiben
oder ändern, im Browser klicken oder tippen, senden, installieren, neu starten,
löschen:
- Jede davon wird vom Interface angehalten, ein Aufruf nach dem anderen. Bevor
  du ein solches Werkzeug aufrufst, sag in klaren gesprochenen Sätzen genau, was
  du gleich tun wirst, warum, und was dabei schiefgehen könnte. Dann ruf das
  Werkzeug auf. Ein Aufruf ohne diese Erklärung wird abgewiesen und an dich
  zurückgegeben.
- Das Interface bittet den Nutzer um Bestätigung. Frag nie selbst nach einem
  bloßen „Ja“, und erkläre nie, wie man bestätigt; das macht das Interface.
- Wurde der Aufruf abgelehnt oder kam keine Antwort, ist nichts passiert. Sag
  das in einem Satz, tu nie so, als wäre es passiert, und versuch es nicht
  erneut, außer auf Aufforderung.
- Lesen, suchen, hinschauen und Dinge auf Blades zeigen brauchen keine
  Bestätigung.`

/**
 * ElevenLabs credentials, borrowed from the MCP server config.
 *
 * If you've set up the elevenlabs MCP server, the key is already on this
 * machine — no reason to make you paste it into a second .env file. The browser
 * never sees it: it POSTs text to /tts here and gets audio back.
 */
function elevenKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY
  try {
    const cfg = JSON.parse(
      readFileSync(join(homedir(), '.claude.json'), 'utf8'),
    )
    return cfg.mcpServers?.elevenlabs?.env?.ELEVENLABS_API_KEY ?? null
  } catch {
    return null
  }
}

const VOICE_ID = process.env.JARVIS_VOICE_ID ?? 'JBFqnCBsd6RMkjVDRZzb'

/**
 * Which engine speaks, chosen with JARVIS_TTS:
 *
 *   browser     — the page's own speechSynthesis: Edge's natural voices on
 *                 Windows, instant, no setup. The default without a key.
 *   piper       — a neural voice running locally in the bridge (speech.mjs).
 *                 No key, no network, the same voice in every browser; needs
 *                 `npm run setup:piper` once. Opt in with JARVIS_TTS=piper.
 *   elevenlabs  — the premium path; the default when a key is configured.
 */
const TTS_ENGINE = (() => {
  const m = (process.env.JARVIS_TTS ?? '').toLowerCase()
  if (m === 'piper' || m === 'elevenlabs' || m === 'browser') return m
  return elevenKey() ? 'elevenlabs' : 'browser'
})()

/** Whether the local voice actually produced audio at boot. /health reports this. */
let piperOk = false

/**
 * Where /file is permitted to read from, and how big a read may get.
 *
 * The roots are realpath'd once at boot so the containment check below compares
 * like with like — on macOS os.tmpdir() is a symlink into /private/var, and a
 * string prefix test against the unresolved form would reject every screenshot.
 */
const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  // .svg is deliberately absent. An SVG is a scriptable document, and this
  // endpoint serves it from the bridge's own origin — the one origin allowed
  // to open the agent socket. A picture is not worth that.
}

const MAX_FILE_BYTES = 25 * 1024 * 1024

const FILE_ROOTS = [
  homedir(),
  // Both temp directories, because on macOS os.tmpdir() is the per-user
  // $TMPDIR under /var/folders while half the tools that take a screenshot
  // still write it to /tmp. Dropping one of them loses real panels.
  tmpdir(),
  '/tmp',
  ...(process.env.JARVIS_FILE_ROOTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
].map((root) => {
  try {
    return realpathSync(root)
  } catch {
    return resolvePath(root)
  }
})

/** True when `real` sits inside one of the roots, after both are resolved. */
const withinRoots = (real) =>
  FILE_ROOTS.some((root) => {
    const rel = relative(root, real)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  })

// ---------------------------------------------------------------------------

/**
 * Remote media, fetched by the bridge instead of by the page.
 *
 * JARVIS used to refuse to show anything he found on the web, and the refusal
 * was not squeamishness — a bare <img src="https://some-cdn/..."> in a panel
 * genuinely did not work. Three reasons, and all three are fixed by moving the
 * fetch to this side of the wire:
 *
 *   1. Hotlink blocking. News sites and image CDNs check Referer and User-Agent
 *      and hand a browser-that-isn't-their-page a 403 or a placeholder. That is
 *      why thumbnails rendered as empty rectangles. A server-side fetch that
 *      looks like an ordinary browser and sends no referrer gets the bytes.
 *   2. Privacy. Panel HTML is authored by a model that has just been reading
 *      untrusted web pages, so a remote URL in it is a prompt-injection beacon:
 *      load it directly and the user's IP, and the fact they asked, go to a host
 *      the page chose. Proxying means the browser only ever talks to localhost
 *      and the page CSP can stay tight.
 *   3. One place to cap size, set timeouts and insist the bytes really are the
 *      media type they claim.
 *
 * The cost is that this process — unlike a browser tab — can reach the user's
 * LAN, their router's admin page, and cloud metadata endpoints. So everything
 * below is an SSRF gate first and a proxy second.
 */

const MAX_IMG_BYTES = 15 * 1024 * 1024
const MAX_MEDIA_BYTES = 200 * 1024 * 1024
const IMG_TIMEOUT_MS = 10_000
const MEDIA_TIMEOUT_MS = 30_000

// The SSRF gate and the guarded outbound clients now live in ./net.mjs, so the
// media proxy below and the page proxy share one implementation of the rules
// rather than two that can drift apart.

/**
 * The shared body of /img and /media.
 *
 * `kinds` is the list of content-type prefixes we are willing to hand back.
 * That check is load-bearing: without it this is an open proxy that will serve
 * an attacker's HTML from the bridge's own origin — the one origin allowed to
 * open the agent socket — which is the same reason IMAGE_TYPES has no .svg.
 */
async function proxyRemote(req, res, cors, { kinds, maxBytes, timeoutMs, ranged }) {
  const asked = new URL(req.url, 'http://x').searchParams.get('url') ?? ''
  const target = vetTarget(asked)

  const headers = {
    'user-agent': PROXY_UA,
    accept: ranged ? '*/*' : 'image/*,*/*;q=0.8',
    // Identity encoding so the byte cap counts the bytes we actually stream and
    // content-length means what it says. Media is already compressed anyway.
    'accept-encoding': 'identity',
  }
  // Range is the difference between a <video> that seeks and one Safari refuses
  // to play at all, so the browser's request is passed through verbatim.
  if (ranged && typeof req.headers.range === 'string') {
    headers.range = req.headers.range
  }

  const { res: upstream } = await openRemote(target, headers, timeoutMs)
  const status = upstream.statusCode ?? 0

  if (status !== 200 && status !== 206) {
    upstream.resume()
    throw proxyError(status === 404 ? 404 : 502, `upstream said ${status}`)
  }

  const type = String(upstream.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  if (!kinds.some((kind) => type.startsWith(kind))) {
    upstream.resume()
    throw proxyError(415, `not ${kinds.join(' or ')} (got ${type || 'nothing'})`)
  }

  const declared = Number(upstream.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) {
    upstream.resume()
    throw proxyError(413, 'too large')
  }

  const out = {
    ...cors,
    'content-type': type,
    'x-content-type-options': 'nosniff',
    // Thumbnails get looked at, panelled again, and re-rendered on every HUD
    // repaint; re-fetching from the CDN each time is slow and rude.
    'cache-control': 'private, max-age=600',
  }
  if (Number.isFinite(declared)) out['content-length'] = String(declared)
  if (ranged) {
    // Only claim range support when the origin actually demonstrated it — a
    // 206, or an explicit accept-ranges of its own. Plenty of hosts ignore the
    // Range header and hand back the whole file with a 200; advertising
    // accept-ranges on top of that tells the video element it may seek by
    // issuing byte requests that will never be honoured, and the scrub bar
    // then misbehaves in a way that looks like our bug rather than theirs.
    if (status === 206 || upstream.headers['accept-ranges'] === 'bytes') {
      out['accept-ranges'] = 'bytes'
    }
    if (upstream.headers['content-range']) {
      out['content-range'] = upstream.headers['content-range']
    }
  }
  res.writeHead(status, out)

  // Stream with a running cap. Buffering a 200 MB video into this process
  // would stall the token stream the voice is riding on, and trusting
  // content-length would let a host that lies about it eat the heap.
  let sent = 0
  upstream.on('data', (chunk) => {
    sent += chunk.length
    if (sent > maxBytes) {
      // Headers went out long ago, so a truncated body is the only way left to
      // say no. The player sees a short read; we see this line in the log.
      console.warn(`[jarvis] proxy cut ${target.href} at ${maxBytes} bytes`)
      upstream.destroy()
      res.destroy()
      return
    }
    if (!res.write(chunk)) {
      upstream.pause()
      res.once('drain', () => upstream.resume())
    }
  })
  upstream.on('end', () => res.end())
  upstream.on('error', () => res.destroy())
  req.on('close', () => upstream.destroy())
}

// ---------------------------------------------------------------------------

/**
 * CORS, reflected rather than wildcarded.
 *
 * `*` on this origin means any page on the internet can read whatever the
 * bridge serves, so the same allowlist that guards the socket picks the
 * header. A request carrying an Origin we don't know is refused outright —
 * but a request with no Origin at all is served, because an <img src> load
 * (which is how panels fetch screenshots) never sends one.
 */
function corsFor(req) {
  const origin = req.headers.origin
  const headers = { vary: 'origin' }
  if (origin) {
    headers['access-control-allow-origin'] = origin
    headers['access-control-allow-headers'] = 'content-type'
  }
  return headers
}

// One HTTP server for both the speech proxy and the WebSocket upgrade.
const http = await import('node:http')

const handleRequest = async (req, res) => {
  const origin = req.headers.origin
  if (origin && !originAllowed(origin)) {
    console.warn(`[jarvis] refused http request from origin ${origin}`)
    res.writeHead(403, { vary: 'origin' })
    return res.end('forbidden')
  }
  const cors = corsFor(req)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    return res.end()
  }

  if (req.method === 'GET' && req.url === '/health') {
    // The browser reads this once at boot to decide which voice engine to use.
    // Both premium paths ride the same ElevenLabs key, so both flags track it:
    // with a key the app transcribes with Scribe and speaks with ElevenLabs;
    // without one it falls back to the browser's own recogniser and voice, so a
    // student with nothing configured still has a working assistant.
    const eleven = Boolean(elevenKey())
    const tts =
      TTS_ENGINE === 'elevenlabs' ? eleven : TTS_ENGINE === 'piper' ? piperOk : false
    const voice =
      TTS_ENGINE === 'elevenlabs' && eleven
        ? 'ElevenLabs'
        : TTS_ENGINE === 'piper' && piperOk
          ? PIPER_VOICE.replace(/^[a-z]{2}_[A-Z]{2}-/, '')
          : ''
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, tts, stt: eleven, voice }))
  }

  // Serve local image files to the page. Screenshots and generated art land on
  // disk as absolute paths, and a page served over http can't read file:// —
  // so the bridge, which can, hands them over.
  if (req.method === 'GET' && req.url?.startsWith('/file?')) {
    const asked = new URL(req.url, 'http://x').searchParams.get('path') ?? ''
    // Resolve symlinks BEFORE judging anything. A name ending in .png can be a
    // link pointing at /etc/hosts, and checking the suffix the caller supplied
    // would wave that straight through — which is exactly how this endpoint
    // used to serve the contents of arbitrary system files.
    let real = null
    try {
      if (isAbsolute(asked)) real = await realpath(asked)
    } catch {
      real = null
    }
    const dot = real ? real.lastIndexOf('.') : -1
    const ext = dot === -1 ? '' : real.slice(dot).toLowerCase()
    // Images only, absolute paths only, and only under roots we expect things
    // to be written to. This endpoint exists to show pictures, not to be a
    // general file read for whatever the model — or another page — asks for.
    if (!real || !Object.hasOwn(IMAGE_TYPES, ext) || !withinRoots(real)) {
      res.writeHead(400, cors)
      return res.end('images only')
    }
    try {
      const info = await stat(real)
      if (!info.isFile() || info.size > MAX_FILE_BYTES) {
        res.writeHead(413, cors)
        return res.end('too large')
      }
      // Asynchronous because this process is also pumping the agent's token
      // stream; a synchronous read of a large screenshot stalls the voice.
      const body = await readFile(real)
      res.writeHead(200, {
        ...cors,
        'content-type': IMAGE_TYPES[ext],
        'x-content-type-options': 'nosniff',
      })
      return res.end(body)
    } catch {
      res.writeHead(404, cors)
      return res.end('not found')
    }
  }

  // Remote images, fetched here so the page never talks to the wider web. The
  // renderer rewrites every http(s) <img src> in a panel to this endpoint.
  if (req.method === 'GET' && req.url?.startsWith('/img?')) {
    try {
      await proxyRemote(req, res, cors, {
        kinds: ['image/'],
        maxBytes: MAX_IMG_BYTES,
        timeoutMs: IMG_TIMEOUT_MS,
        ranged: false,
      })
    } catch (err) {
      if (res.headersSent) return res.destroy()
      res.writeHead(err.status ?? 502, cors)
      return res.end(err.message ?? 'proxy failed')
    }
    return
  }

  // The same, for video and audio. Separate from /img because the limits and
  // the Range handling are genuinely different, not because the code is.
  if (req.method === 'GET' && req.url?.startsWith('/media?')) {
    try {
      await proxyRemote(req, res, cors, {
        kinds: ['video/', 'audio/'],
        maxBytes: MAX_MEDIA_BYTES,
        timeoutMs: MEDIA_TIMEOUT_MS,
        ranged: true,
      })
    } catch (err) {
      if (res.headersSent) return res.destroy()
      res.writeHead(err.status ?? 502, cors)
      return res.end(err.message ?? 'proxy failed')
    }
    return
  }

  // A whole web page, fetched here and served from this origin so it can be
  // framed. The publisher's X-Frame-Options and CORS rules are enforced against
  // the browser, and from the browser's point of view this document is ours —
  // so an article that refuses to be embedded anywhere still opens on the
  // display. See page.mjs for what each mode does to the markup.
  //
  // No Origin header arrives on an iframe navigation, so this rides the same
  // path as an <img> load through the check at the top of this handler.
  if (req.method === 'GET' && req.url?.startsWith('/page?')) {
    const asked = new URL(req.url, 'http://x')
    const target = asked.searchParams.get('url') ?? ''
    const mode = asked.searchParams.get('mode') === 'live' ? 'live' : 'reader'
    try {
      const page = await renderPage(target, mode, `http://localhost:${PORT}`)
      res.writeHead(200, { ...cors, ...page.headers })
      return res.end(page.body)
    } catch (err) {
      // Rendered as a page rather than returned as a status, because this lands
      // inside an iframe: a bare 502 body is a blank rectangle on the display,
      // which reads as the interface being broken rather than as the article
      // being unavailable.
      res.writeHead(err.status ?? 502, {
        ...cors,
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      })
      return res.end(
        `<!doctype html><meta charset="utf-8"><style>
           body{margin:0;padding:26px;background:transparent;color:#7fb6bf;
                font:400 13px/1.6 ui-monospace,monospace}
           b{color:#cfe9ee;font-weight:500;display:block;margin-bottom:6px}
         </style><b>This page could not be opened.</b>${
           String(err?.message ?? 'unknown error').replace(/[<&]/g, '')
         }`,
      )
    }
  }

  if (req.method === 'POST' && req.url === '/tts') {
    const key = elevenKey()
    if (TTS_ENGINE === 'browser' || (TTS_ENGINE === 'elevenlabs' && !key)) {
      res.writeHead(503, cors)
      return res.end('no bridge voice configured')
    }
    // A spoken line is a few hundred bytes. Anything approaching this is not a
    // sentence, and buffering it unbounded would let one request eat the heap.
    let body = ''
    let overflowed = false
    for await (const chunk of req) {
      body += chunk
      if (body.length > 64 * 1024) {
        overflowed = true
        break
      }
    }
    if (overflowed) {
      req.destroy()
      res.writeHead(400, cors)
      return res.end('body too large')
    }
    // Inside a try: this handler is async with nothing catching its rejection,
    // so a malformed body used to take the entire bridge down with it.
    let text
    try {
      ;({ text } = JSON.parse(body || '{}'))
    } catch {
      res.writeHead(400, cors)
      return res.end('bad json')
    }
    if (!text) {
      res.writeHead(400, cors)
      return res.end('no text')
    }
    if (TTS_ENGINE === 'piper') {
      try {
        const wav = await piperSpeak(String(text))
        res.writeHead(200, {
          ...cors,
          'content-type': 'audio/wav',
          'content-length': wav.length,
          'cache-control': 'no-cache',
        })
        return res.end(wav)
      } catch (err) {
        // The page falls back to its own voice on any non-200, so the cost of
        // a dead engine is timbre, not silence. Say why in the log.
        console.warn(`[jarvis] local voice failed: ${err?.message ?? err}`)
        res.writeHead(502, cors)
        return res.end(String(err?.message ?? err))
      }
    }
    try {
      const upstream = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream` +
          // 22kHz mono is half the bytes of 44kHz and indistinguishable through
          // a laptop speaker; optimize_streaming_latency=3 trades a little
          // prosody for a much earlier first byte.
          `?output_format=mp3_22050_32&optimize_streaming_latency=3`,
        {
          method: 'POST',
          headers: { 'xi-api-key': key, 'content-type': 'application/json' },
          body: JSON.stringify({
            text,
            // Flash is the low-latency model — a conversation needs speed more
            // than it needs the last few percent of quality.
            model_id: 'eleven_flash_v2_5',
            voice_settings: {
              stability: 0.4,
              similarity_boost: 0.75,
              speed: 1.05,
            },
          }),
        },
      )
      if (!upstream.ok) {
        res.writeHead(upstream.status, cors)
        return res.end(await upstream.text())
      }

      // Pipe it through rather than buffering. Waiting for the whole file here
      // would throw away everything the streaming endpoint just bought us.
      res.writeHead(200, {
        ...cors,
        'content-type': 'audio/mpeg',
        'cache-control': 'no-cache',
      })
      for await (const chunk of upstream.body) res.write(Buffer.from(chunk))
      return res.end()
    } catch (err) {
      res.writeHead(502, cors)
      return res.end(String(err?.message ?? err))
    }
  }

  // Speech to text. The browser captures one spoken segment as a compressed
  // audio blob and posts the raw bytes here; the bridge hands them to
  // ElevenLabs Scribe and returns the transcript. This is what replaced the
  // browser's own SpeechRecognition — that API dies silently under always-on
  // use, and a server-side transcriber cannot. Detecting that the user is
  // speaking at all is done locally with voice-activity detection, which never
  // touches this endpoint; this is only for the words.
  if (req.method === 'POST' && req.url === '/stt') {
    const key = elevenKey()
    if (!key) {
      res.writeHead(503, cors)
      return res.end('no elevenlabs key')
    }

    const type = req.headers['content-type'] || 'audio/webm'
    const chunks = []
    let size = 0
    let overflowed = false
    // A few seconds of Opus is well under a megabyte; 25 MB is a generous
    // ceiling that still refuses a runaway stream before it eats the heap.
    for await (const chunk of req) {
      chunks.push(chunk)
      size += chunk.length
      if (size > 25 * 1024 * 1024) {
        overflowed = true
        break
      }
    }
    if (overflowed) {
      req.destroy()
      res.writeHead(413, cors)
      return res.end('audio too large')
    }
    // Silence, or a click. Nothing to transcribe, and calling out to the API
    // for it would only add latency to a non-answer.
    if (size < 1200) {
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ text: '' }))
    }

    try {
      // The filename extension is the only hint Scribe gets about the codec, so
      // derive it from the content-type the MediaRecorder reported rather than
      // hard-coding one.
      const ext = type.includes('ogg')
        ? 'ogg'
        : type.includes('mp4') || type.includes('mpeg')
          ? 'mp4'
          : type.includes('wav')
            ? 'wav'
            : 'webm'
      const form = new FormData()
      form.append('model_id', 'scribe_v1')
      form.append(
        'file',
        new Blob([Buffer.concat(chunks)], { type }),
        `speech.${ext}`,
      )

      const upstream = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST',
        headers: { 'xi-api-key': key },
        body: form,
      })
      if (!upstream.ok) {
        res.writeHead(upstream.status, cors)
        return res.end(await upstream.text())
      }
      const data = await upstream.json()
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ text: (data.text ?? '').trim() }))
    } catch (err) {
      res.writeHead(502, cors)
      return res.end(String(err?.message ?? err))
    }
  }

  res.writeHead(404, cors)
  res.end()
}

const server = http.createServer((req, res) => {
  // The handler is async, so anything it throws would otherwise become an
  // unhandled rejection and leave the browser waiting on a socket that is
  // never going to answer.
  handleRequest(req, res).catch((err) => {
    console.error('[jarvis] request failed:', err)
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
})

const wss = new WebSocketServer({
  server,
  // The handshake is the only place a page can be turned away, so it happens
  // here rather than after the socket is open. Rejections are logged loudly:
  // the likeliest cause is a dev server on an unexpected port, and a silent
  // 403 would look like the bridge simply isn't running.
  verifyClient: ({ origin, req }, done) => {
    const path = (req.url ?? '/').split('?')[0]
    if (path !== '/' && path !== '/ws') {
      console.warn(`[jarvis] rejected websocket on path ${path}`)
      return done(false, 403, 'Forbidden')
    }
    if (!originAllowed(origin)) {
      console.warn(
        `[jarvis] rejected websocket from origin ${origin ?? '(none)'}` +
          ' — set JARVIS_ALLOWED_ORIGINS to permit it',
      )
      return done(false, 403, 'Forbidden')
    }
    done(true)
  },
})
server.listen(PORT)

console.log(`[jarvis] bridge listening on ws://localhost:${PORT}`)
if (TTS_ENGINE === 'piper') {
  if (!piperInstalled()) {
    console.log(
      '[jarvis] speech using browser fallback voice — run `npm run setup:piper` for the local neural voice',
    )
  } else {
    // Asynchronous: one short synthesis, so /health promises only what works.
    // It also loads the model, so the first real sentence does not pay for it.
    void piperAvailable().then((ok) => {
      piperOk = ok
      console.log(
        ok
          ? `[jarvis] speech via local neural voice ${PIPER_VOICE} (piper)`
          : '[jarvis] speech: piper did not produce audio — using the browser voice',
      )
    })
  }
  process.on('exit', piperStop)
} else {
  console.log(
    `[jarvis] speech ${TTS_ENGINE === 'elevenlabs' ? 'via ElevenLabs (key from MCP config)' : 'using browser fallback voice'}`,
  )
}
console.log(`[jarvis] model ${MODEL} · effort ${EFFORT}`)
console.log(
  `[jarvis] write mode ${WRITE_MODE}` +
    (WRITE_MODE === 'confirm'
      ? ` — shell/file/device actions wait for your approval in the interface (${CONFIRM_TIMEOUT_MS / 1000}s)`
      : WRITE_MODE === 'deny'
        ? ' — shell/file/device actions are refused; JARVIS_WRITE_MODE=confirm to be asked per call'
        : ' — EVERYTHING runs without asking'),
)
// Asynchronous, so it lands a beat after the rest of the banner. Worth printing
// at all because an extension that is simply not running is indistinguishable
// at the tool boundary from one that is broken, and this is the one place the
// difference can be stated before anybody asks a question that depends on it.
void chromeAvailable().then((ok) => {
  console.log(
    ok
      ? `[jarvis] browser control ready${WRITE_MODE === 'deny' ? ' (reading only — clicking and typing are refused in this mode)' : ''}`
      : '[jarvis] browser control unavailable — open Chrome with the Claude extension enabled',
  )
})

console.log(
  '[jarvis] accepting local dev origins' +
    (EXTRA_ORIGINS.size ? ` plus ${[...EXTRA_ORIGINS].join(', ')}` : '') +
    (ALLOW_NO_ORIGIN ? ' and clients that send no origin' : ''),
)

/**
 * What to tell the browser when a turn ends badly. Plain sentences, because
 * whatever reaches the client is liable to be spoken.
 */
const RESULT_FAILURES = {
  error_during_execution: 'Der Durchlauf ist mittendrin abgebrochen.',
  error_max_turns: 'Der Durchlauf hat zu lange gedauert und wurde gestoppt.',
  error_max_budget_usd: 'Das Budget für diesen Durchlauf ist aufgebraucht.',
  error_max_structured_output_retries: 'Die Antwort konnte nicht zusammengesetzt werden.',
  default: 'Der Durchlauf endete ohne Antwort.',
}

wss.on('connection', (socket) => {
  console.log('[jarvis] client connected')

  // Answer the HUD straight away rather than making it wait for the agent's
  // first turn. Refined later by the real init message.
  socket.send(
    JSON.stringify({ type: 'ready', servers: Object.keys(MCP_SERVERS) }),
  )

  /** Resolves the pending user message into the SDK's input generator. */
  let deliver = null
  let closed = false
  const inbox = []

  async function* userMessages() {
    while (!closed) {
      const text =
        inbox.shift() ??
        (await new Promise((resolve) => {
          deliver = resolve
        }))
      if (closed || text == null) return
      yield {
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
      }
    }
  }

  const send = (msg) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg))
  }

  /**
   * Which question the agent is currently answering.
   *
   * The stream carries no notion of a turn, so without this the client cannot
   * tell the tail of an abandoned answer from the start of the new one — it
   * attaches a listener and receives whatever is on the socket. Echoing the
   * id the client sent lets it ignore anything that is not its own, which is
   * the only reliable fix: no amount of waiting on this side changes what a
   * listener over there has already heard.
   */
  let answering = null
  const sendTurn = (msg) => send({ ...msg, ask: answering })

  /**
   * Everything JARVIS has said aloud in the turn so far. A gated action is
   * only put to the user together with this, and refused when it is empty:
   * the rule is explain first, then act, and the bridge is what makes the rule
   * hold rather than the prompt alone.
   */
  let spoken = ''

  /**
   * Asking the browser for something and waiting for the answer.
   *
   * Every other tool here pushes — a panel, a blade, a retint — and never needs
   * a reply. The camera is the exception: the hardware is over there and the
   * model is here, so a frame has to come back. Correlated by id because a turn
   * can have more than one request in flight, and timed out because a browser
   * that has been closed mid-question would otherwise hang the turn until the
   * two-minute idle timer noticed.
   */
  const waiting = new Map()
  let asks = 0

  const ask = (kind, args, timeoutMs = 20_000) =>
    new Promise((resolve, reject) => {
      if (socket.readyState !== socket.OPEN) {
        return reject(new Error('the interface is not connected'))
      }
      const id = `q${++asks}`
      const timer = setTimeout(() => {
        waiting.delete(id)
        // Tell the interface the question is over, so a card it is still
        // showing comes down rather than inviting an answer nobody is waiting for.
        send({ type: `${kind}_end`, id, reason: 'timeout' })
        reject(new Error('the interface did not answer in time'))
      }, timeoutMs)
      waiting.set(id, { resolve, timer, kind })
      send({ type: kind, id, ...args })
    })

  /** Withdraw every open confirmation, answered as a no. */
  const withdrawConfirms = (reason) => {
    for (const [id, slot] of waiting) {
      if (slot.kind !== 'confirm') continue
      waiting.delete(id)
      clearTimeout(slot.timer)
      send({ type: 'confirm_end', id, reason })
      slot.resolve({ approved: false, via: reason })
    }
  }

  /**
   * Announcing a tool on the HUD, once, and only if it actually runs.
   *
   * A tool_use block surfaces twice — as a partial stream event and again on
   * the completed assistant message — so ids are remembered. The harder part
   * is timing, because a refused tool that lights the badge, plays the sound
   * and provokes a "working on it" line, for work that never happens, reads as
   * a bug on camera.
   *
   * The SDK's order is: the block starts streaming, then canUseTool is asked,
   * then the tool runs. So nothing is known at content_block_start. Announcing
   * from inside canUseTool would know the verdict but miss tools entirely —
   * measured on this SDK, the callback is consulted only for calls the CLI
   * hasn't already settled, so a `Bash: echo` its own classifier waves through
   * never reaches us at all.
   *
   * So: announce immediately for anything decideTool permits, since those run.
   * Hold the rest, and let the tool_result settle it — a refusal comes back as
   * is_error, anything else really did execute and has earned its badge, a
   * beat late. Nothing is ever announced for work that didn't happen.
   */
  const seenTools = new Set()
  const heldTools = new Map()

  /**
   * Resolves when the turn in flight has actually finished.
   *
   * Waiting on session.interrupt() alone is not enough. It resolves when the
   * agent has been *told* to stop, not when it has, so the last tokens of the
   * abandoned answer are still on their way — and since nothing on the wire
   * identifies which question a delta belongs to, they land on the next turn's
   * listener. Measured: ask for ALPHA, interrupt, ask for BRAVO, and BRAVO's
   * answer arrives as "ALPHA\nBRAVO".
   *
   * The SDK emits exactly one `result` per turn, so that is the boundary worth
   * waiting for. Raced against a timeout because a turn that never reports one
   * must not wedge the conversation for ever — a stray word is a blemish, a
   * deadlocked assistant is not.
   */
  let settling = Promise.resolve()
  let finishTurn = null

  const turnFinished = () =>
    new Promise((resolve) => {
      finishTurn = resolve
    })

  /**
   * A brief pause so the abandoned turn's frames are tagged with the OLD id
   * before the new one is adopted. Short, because correctness now comes from
   * the tag rather than from the wait — this only has to cover the gap, not
   * outlast the whole turn.
   */
  const SETTLE_CAP_MS = 400

  const announceTool = (id, name) => {
    if (!name || (id && seenTools.has(id))) return
    if (id) seenTools.add(id)
    // The display tool isn't work being done, it's the HUD drawing itself —
    // announcing it would put "jarvis · display" in the tool badge and trigger
    // a "working on it" filler for something already on screen.
    if (name === 'mcp__jarvis__display') return
    // The ui_* tools are the same case one step further: retinting the
    // interface is the interface talking about itself, not work being done for
    // the user, and the badge would be describing the very thing they can see.
    if (name.startsWith('mcp__jarvis_ui__')) return
    if (decideTool(name)) return sendTurn({ type: 'tool', name })
    if (id) heldTools.set(id, name)
  }

  const settleTool = (id, failed) => {
    const name = heldTools.get(id)
    if (name === undefined) return
    heldTools.delete(id)
    if (!failed) sendTurn({ type: 'tool', name })
  }

  const session = query({
    prompt: userMessages(),
    options: {
      // Everything Claude Code has configured, plus the HUD as an in-process
      // server. The HUD's handler closes over this socket, so a `display` call
      // lands on screen directly — which is also why this object is built per
      // connection rather than once.
      mcpServers: {
        ...MCP_SERVERS,
        jarvis: displayServer(
          (panel) => send({ type: 'panel', panel }),
          (blade) => send({ type: 'blade', blade }),
        ),
        // The interface controls, on the same socket. A separate key because
        // MCP tool names are `mcp__<key>__<tool>` and one key can only carry
        // one server; the underscore in it is why decideTool and announceTool
        // both name `jarvis_ui` explicitly.
        jarvis_ui: uiServer((op, args) => send({ type: 'ui', op, args })),
        // The user's own Chrome, over the extension's native-host socket. It
        // holds no per-connection state, but it is built here with the rest so
        // the write gate is read once, at the same point as everything else.
        // The acting tools exist in confirm mode too; classifyTool names them
        // as writes, so each click or keystroke is put to the user first.
        jarvis_chrome: chromeServer({ allowWrites: ALLOW_WRITES || CONFIRM_WRITES }),
        // The camera, which unlike everything else here has to ask and wait.
        jarvis_eyes: visionServer(ask),
      },
      // A plain system prompt, not the claude_code preset. The preset is
      // tuned for a coding agent — verbose, file-oriented, and a large chunk
      // of input tokens on every turn. Replacing it makes the persona stick,
      // keeps answers short enough to speak, and cuts cost per turn.
      systemPrompt: SYSTEM_PROMPT,
      // Run from the home directory so project-scoped MCP servers don't shadow
      // the global ones, and so file tools have a sane root.
      cwd: homedir(),
      // No filesystem settings at all. Left to its default the SDK loads
      // ~/.claude/settings.json and settings.local.json exactly as the CLI
      // does — which on a working machine means a bypassPermissions default
      // and a pile of allow-rules for Bash. Allow-rules are matched before the
      // permission callback, so decideTool below would never even be asked
      // about the tools it most needs to refuse. Empty makes this bridge the
      // only authority. It also stops the global CLAUDE.md riding along on
      // every voice turn, carrying instructions written for a coding agent
      // into a conversation that is meant to be two sentences long.
      //
      // The cost is that MCP servers stop being discovered too, which is why
      // mcpServers above passes them in by hand.
      settingSources: [],
      // Stated explicitly, and it has to be.
      //
      // With no `model` here the SDK falls back to its own default, which on
      // this machine resolved to claude-opus-4-8[1m] — not what src/config.ts
      // declares for the browser-direct path, and not anything anyone chose.
      // Normally your own `/model` preference would decide, but that lives in
      // the settings files `settingSources: []` deliberately stops loading, so
      // without this line nothing in the project has a say at all.
      model: MODEL,
      effort: EFFORT,
      maxTurns: 24,
      permissionMode: 'default',
      // Without this the SDK only emits whole assistant messages, and JARVIS
      // would sit silent until the entire answer was written. Partial events
      // are what let speech start on the first finished sentence.
      includePartialMessages: true,
      // Signature is (toolName, input, options) and it must return a
      // PermissionResult object. Returning a bare boolean silently denies
      // everything, with the tool name arriving undefined.
      //
      // Worth knowing: this is a last gate, not the only one. Calls the CLI
      // has already settled never arrive here — its own classifier waves
      // through a `Bash: echo hello` without asking, and only reaches us for
      // something with a consequence, like a `touch`. So a deny here is
      // reliable; an absence of a call here is not proof nothing ran.
      canUseTool: async (toolName, input) => {
        const kind = classifyTool(toolName)
        if (kind === 'read' || ALLOW_WRITES) {
          console.log(`[jarvis] tool ${toolName} -> allow`)
          return { behavior: 'allow' }
        }
        if (!CONFIRM_WRITES) {
          console.log(`[jarvis] tool ${toolName} -> deny (read-only)`)
          return {
            behavior: 'deny',
            // Every word of this can end up spoken, so it carries no command
            // to read out — the persona is forbidden from saying one aloud.
            message:
              'Blocked: JARVIS is running in read-only mode and cannot take' +
              ' actions that change anything. Tell the user this action is' +
              ' unavailable until they enable write access on the machine.',
          }
        }

        // Explain first, then act. The explanation goes on the card beside
        // the actual call, so the user approves both the intent and the
        // command — and a call with no explanation is bounced, not asked.
        const explanation = spoken.trim()
        if (!explanation) {
          console.log(`[jarvis] tool ${toolName} -> deny (nothing explained first)`)
          return {
            behavior: 'deny',
            message:
              'Not yet. Before an action that changes anything you must first' +
              ' say, in plain spoken sentences, exactly what you are about to' +
              ' do, why, and what could go wrong. Say that now, then call the' +
              ' tool again; the user will then be asked to confirm it.',
          }
        }

        console.log(`[jarvis] tool ${toolName} -> asking the user`)
        let reply
        try {
          reply = await ask(
            'confirm',
            {
              tool: toolName,
              label: prettyToolName(toolName),
              detail: describeInput(toolName, input),
              explanation,
            },
            CONFIRM_TIMEOUT_MS,
          )
        } catch (err) {
          console.log(`[jarvis] tool ${toolName} -> no answer (${err.message})`)
          return {
            behavior: 'deny',
            message:
              'No confirmation arrived in time, so the action was not taken.' +
              ' Say so in one sentence and do not retry it unless asked.',
          }
        }
        if (reply?.approved === true) {
          console.log(`[jarvis] tool ${toolName} -> approved by ${reply.via ?? 'the user'}`)
          return { behavior: 'allow' }
        }
        console.log(`[jarvis] tool ${toolName} -> declined (${reply?.via ?? 'the user'})`)
        return {
          behavior: 'deny',
          message:
            'The user declined this action; it was not carried out.' +
            ' Acknowledge that in one sentence and do not retry it.',
        }
      },
    },
  })

  // Pump the session's output stream to the browser for as long as it lives.
  ;(async () => {
    try {
      for await (const msg of session) {
        if (process.env.JARVIS_DEBUG === '1') {
          console.log('[msg]', msg.type, msg.event?.type ?? '')
        }

        switch (msg.type) {
          // Raw Anthropic stream events, surfaced by includePartialMessages.
          // This is the ONLY place spoken text arrives: there is no top-level
          // text_delta message in the SDK union and the 'assistant' message
          // carries no deltas either. Turn includePartialMessages off and
          // JARVIS goes completely mute.
          case 'stream_event': {
            const ev = msg.event
            if (
              ev?.type === 'content_block_delta' &&
              ev.delta?.type === 'text_delta' &&
              ev.delta.text
            ) {
              spoken += ev.delta.text
              sendTurn({ type: 'text', delta: ev.delta.text })
            }
            if (
              ev?.type === 'content_block_start' &&
              ev.content_block?.type === 'tool_use'
            ) {
              announceTool(ev.content_block.id, ev.content_block.name)
            }
            break
          }

          case 'assistant': {
            // Fallback for builds that emit whole assistant messages rather
            // than partial events. Deduped against the stream_event path.
            for (const block of msg.content ?? msg.message?.content ?? []) {
              if (block.type === 'tool_use') {
                announceTool(block.id, block.name)
              }
            }
            break
          }

          case 'user': {
            // Tool results come back as a user message. This is the only place
            // a held announcement can be resolved: a refused tool arrives with
            // is_error set and stays off the HUD, anything else ran.
            const blocks = msg.message?.content
            if (!Array.isArray(blocks)) break
            for (const block of blocks) {
              if (block?.type === 'tool_result') {
                settleTool(block.tool_use_id, block.is_error === true)
              }
            }
            break
          }

          case 'result':
            // A result is not automatically a success. The error subtypes
            // carry no `result` field at all, so reporting them as 'done' with
            // empty text is indistinguishable from a turn that simply had
            // nothing to say — the HUD stops spinning and JARVIS stands there
            // silent. Say what happened instead.
            if (msg.subtype === 'success') {
              sendTurn({
                type: 'done',
                text: msg.result ?? '',
                costUsd: msg.total_cost_usd ?? null,
              })
            } else {
              console.error(
                `[jarvis] turn failed: ${msg.subtype}`,
                msg.errors ?? '',
              )
              sendTurn({
                type: 'error',
                message: RESULT_FAILURES[msg.subtype] ?? RESULT_FAILURES.default,
              })
            }
            // Whatever was waiting on this turn to finish can go now. This is
            // the only place a turn is genuinely over.
            finishTurn?.()
            finishTurn = null
            // One turn's tool ids are never referred to again, and these
            // otherwise grow for as long as the socket is open.
            seenTools.clear()
            heldTools.clear()
            spoken = ''
            break

          case 'system':
            if (msg.subtype === 'init') {
              // Servers report 'pending' until first use — they connect
              // lazily — so only drop the ones that are actually unusable.
              const usable = (msg.mcp_servers ?? [])
                .filter((s) => s.status !== 'needs-auth' && s.status !== 'failed')
                .map((s) => s.name)
              send({ type: 'ready', servers: usable })
              console.log(`[jarvis] ${usable.length} MCP servers available`)
            }
            break
        }
      }
    } catch (err) {
      console.error('[jarvis] session error:', err)
      send({ type: 'error', message: String(err?.message ?? err) })
      // The stream is finished either way — nothing will ever be read from it
      // again. Leaving the socket open would leave the client believing it has
      // a working bridge, and every later question would hang for ever waiting
      // on a pump that has already stopped. Close it so it reconnects.
      closed = true
      deliver?.(null)
      session.close?.()
      socket.close()
    }
  })()

  socket.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    if (msg.type === 'ask' && typeof msg.text === 'string') {
      /**
       * Queued behind any interrupt that is still settling.
       *
       * A barge-in is two messages in quick succession — interrupt, then the
       * new question — and session.interrupt() is asynchronous. Delivering the
       * question the instant it arrives means the agent can still be winding
       * down the previous turn, so its last tokens are emitted after the new
       * one has begun and land on the new turn's listener. Measured: ask "one",
       * interrupt, ask "two", and the answer to "two" comes back as "One."
       *
       * Waiting costs nothing when nothing is interrupting — the chain is an
       * already-resolved promise — and removes the cross-talk when there is.
       */
      const text = msg.text
      const id = typeof msg.id === 'string' ? msg.id : null
      void settling.then(() => {
        answering = id
        spoken = ''
        if (deliver) {
          const resolve = deliver
          deliver = null
          resolve(text)
        } else {
          inbox.push(text)
        }
      })
    }

    if (msg.type === 'reply' && typeof msg.id === 'string') {
      const slot = waiting.get(msg.id)
      if (slot) {
        waiting.delete(msg.id)
        clearTimeout(slot.timer)
        slot.resolve(msg)
      }
    }

    if (msg.type === 'interrupt') {
      // A question still waiting on the user belongs to the turn being
      // abandoned. Answer it no now, or the agent sits on it until it times out.
      withdrawConfirms('interrupt')
      // Held so the next question can wait for it rather than racing it.
      const stopped = turnFinished()
      settling = Promise.resolve(session.interrupt?.())
        .catch(() => {})
        .then(() =>
          Promise.race([
            stopped,
            new Promise((r) => setTimeout(r, SETTLE_CAP_MS)),
          ]),
        )
    }
  })

  socket.on('close', () => {
    console.log('[jarvis] client disconnected')
    withdrawConfirms('disconnect')
    closed = true
    deliver?.(null)
    session.close?.()
  })
})
