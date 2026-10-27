/**
 * The model router: which Claude answers which question.
 *
 * Every request is placed in one of four tiers before it reaches the agent.
 * Fixed rules go first and cost nothing — the time, the date, "open X", a
 * greeting. Everything else is put to a small, fast model that answers with
 * one word, and the agent session is switched to that tier for the turn.
 * "Jarvis, denk gründlich nach" skips the vote and takes the strongest model.
 *
 * The classifier is its own agent session, kept warm for the life of the
 * bridge: spawning one per question would cost five seconds, keeping it open
 * costs about a second per vote. It has no tools and a prompt that allows one
 * word, and it is recycled every so often so its own transcript stays short.
 *
 * Model ids live in .env (JARVIS_MODEL_HAIKU and friends), so a new
 * generation is a one-line change rather than a code edit.
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import { homedir } from 'node:os'

const valid = (t) => (['haiku', 'sonnet', 'opus', 'fable'].includes(t) ? t : null)

export const TIERS = {
  haiku: process.env.JARVIS_MODEL_HAIKU ?? 'claude-haiku-5-5',
  sonnet: process.env.JARVIS_MODEL_SONNET ?? 'claude-sonnet-5-5',
  opus: process.env.JARVIS_MODEL_OPUS ?? 'claude-opus-5-5',
  fable: process.env.JARVIS_MODEL_FABLE ?? 'claude-fable-5-1',
}
/** The model that votes. Haiku: the vote has to be quicker than the answer. */
export const ROUTER_MODEL = process.env.JARVIS_MODEL_ROUTER ?? TIERS.haiku
/** Where a question lands when the vote fails or times out. */
export const DEFAULT_TIER = valid((process.env.JARVIS_DEFAULT_TIER ?? '').toLowerCase()) ?? 'sonnet'
/** JARVIS_ROUTER=0 pins every turn to JARVIS_MODEL, as before. */
export const ROUTER_ENABLED = process.env.JARVIS_ROUTER !== '0'
/**
 * JARVIS_ROUTER_VOTE=1 asks the voter model for the tier of anything the
 * rules do not settle. Off by default: measured on this machine, one
 * round trip through the Agent SDK costs three to four seconds even for a
 * one-word answer from Haiku with no tools at all, and that sat in front of
 * every answer. The keyword estimate below is instant and lands the same
 * tier for the questions seen so far.
 */
export const VOTE_ENABLED = process.env.JARVIS_ROUTER_VOTE === '1'
/** A vote slower than this is not worth waiting for. */
const VOTE_TIMEOUT_MS = Number(process.env.JARVIS_ROUTER_TIMEOUT_MS ?? 4000)
/** Recycle the classifier session after this many votes. */
const VOTES_PER_SESSION = 40

// ---------------------------------------------------------------------------
// Fixed rules
// ---------------------------------------------------------------------------

const NAME = "(?:hey|hi|ok|okay|hallo)?\\s*(?:jarvis|jarwis|javis)?[\\s,.:!?-]*"

/** "Jarvis, denk gründlich nach: …" — the manual override, stripped off. */
const THINK_HARD = new RegExp(
  `^\\s*${NAME}(?:denk|denke|überleg|überlege|think)\\s+(?:bitte\\s+)?(?:mal\\s+)?` +
    '(?:gründlich|genau|tief|lange|intensiv|scharf|richtig|ordentlich|gut|hard|carefully|deeply)' +
    '(?:\\s+(?:nach|darüber\\s+nach|about\\s+it))?[\\s,.:!?-]*',
  'i',
)

const TIME = /\b(wie spät|wieviel uhr|wie viel uhr|uhrzeit|what time is it|what's the time)\b/i
const DATE = /\b(welcher tag ist|welches datum|datum (ist )?heute|der wievielte|welcher wochentag|what('s| is) the date|what day is it)\b/i
const OPEN_APP = /^\s*(öffne|öffnen|starte|start|open|launch|mach\b.*\bauf)\b/i
const SMALL_TALK = /^\s*(hallo|hi|hey|guten (morgen|tag|abend)|danke|dankeschön|vielen dank|gute nacht|tschüss|bis später|wie geht'?s|alles klar)\b/i

const words = (s) => s.trim().split(/\s+/).filter(Boolean).length

const de = (d) =>
  d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

/** Said by the bridge itself, in the persona's register, with no model at all. */
function localAnswer(text) {
  if (words(text) > 9) return null
  const now = new Date()
  if (TIME.test(text)) {
    const h = now.getHours()
    const m = now.getMinutes()
    return `Es ist ${h} Uhr${m ? ` ${m}` : ''}, Sir.`
  }
  if (DATE.test(text)) return `Heute ist ${de(now)}, Sir.`
  return null
}

/**
 * The rules, in order. Returns null when none applies and the vote decides.
 * @returns {{ tier: string, reason: string, text: string, local?: string } | null}
 */
function byRule(text) {
  const local = localAnswer(text)
  if (local) return { tier: 'local', reason: 'rule:local', text, local }

  const hard = THINK_HARD.exec(text)
  if (hard) {
    const rest = text.slice(hard[0].length).trim()
    // "Denk gründlich nach" with nothing after it still has to say something.
    return { tier: 'fable', reason: 'override', text: rest || text }
  }

  // "Starte Spotify" is an app; "starte den Dienst neu" or anything with a
  // server in it is not, and deserves the vote.
  if (OPEN_APP.test(text) && words(text) <= 8 && !/\b(neu|server|dienst|service|container)\b/i.test(text)) {
    return { tier: 'haiku', reason: 'rule:open', text }
  }
  if (SMALL_TALK.test(text) && words(text) <= 6) return { tier: 'haiku', reason: 'rule:smalltalk', text }
  // A short question with none of the heavy words is haiku's without a vote:
  // the vote cost more than a second on exactly the turns that should feel
  // instant, and haiku answers "wie wird das Wetter" as well as anything.
  if (words(text) <= 7 && !HEAVY.test(text)) return { tier: 'haiku', reason: 'rule:short', text }
  return null
}

/** Words that mean a short question still deserves more than haiku. */
const HEAVY =
  /\b(code|skript|script|programm(ier)?|lua|python|javascript|java|docker|ssh|server|log|logs|fehler|error|bug|absturz|crash|architektur|analys|plan|strategie|vergleich|erklär|warum|beweis|komplex|server-?wächter)\w*/i

/** The opus tier: code, servers, failures, anything with many moving parts. */
const OPUS_WORDS =
  /\b(code|skript|script|programm(ier)?|lua|python|javascript|typescript|java|docker|ssh|server|log|logs|fehler|error|bug|absturz|crash|exception|traceback|stack|debug|konfig|config|datenbank|sql|api|deploy|install)\w*/i
/** The fable tier: the genuinely hard, open-ended ones. */
const FABLE_WORDS =
  /\b(architektur|strategie|konzept|roadmap|entwurf|design|abwäg|entscheid|komplex|gründlich|ausführlich|tiefgehend|beweis|forschung|analysiere? (?:das|den|die) ganze)\w*/i

/**
 * The tier a question gets when no rule applied and the voter is off:
 * sonnet by default, opus for the technical, fable for the hard and the
 * long. Instant, and tuned on the questions that actually came through.
 */
function guessTier(text) {
  const n = words(text)
  if (FABLE_WORDS.test(text) && (n > 12 || OPUS_WORDS.test(text))) return 'fable'
  if (OPUS_WORDS.test(text) || n > 45) return 'opus'
  return DEFAULT_TIER
}

// ---------------------------------------------------------------------------
// The vote
// ---------------------------------------------------------------------------

const CLASSIFIER_PROMPT = `Du bist ein Verteiler für einen Sprachassistenten. Du bekommst eine
gesprochene Anfrage und antwortest mit genau einem Wort: welches Modell sie
bearbeiten soll.

HAIKU: kurze, einfache Befehle und Fragen. Smalltalk, einzelne Fakten,
einfache Rechnungen, Erinnerungen setzen, Programme öffnen, Lautstärke, Musik.
SONNET: normale Gespräche und die meisten Aufgaben. Recherche, Zusammenfassen,
Mails, Kalender, Webseiten lesen, Erklärungen, Übersetzungen, Texte schreiben.
OPUS: Programmcode, Fehlersuche, Server- und Systemprobleme, Logs auswerten,
Aufgaben mit viel Kontext oder mehreren abhängigen Schritten.
FABLE: sehr komplexe Aufgaben. Schwierige Architektur- oder Analysefragen,
mehrstufige Planung, heikle Entscheidungen, Probleme, an denen andere Modelle
scheitern würden.

Im Zweifel SONNET. Antworte nur mit HAIKU, SONNET, OPUS oder FABLE. Kein
anderes Wort, keine Erklärung, keine Satzzeichen.`

let session = null
let deliver = null
const inbox = []
let pending = null
let votes = 0
/** Votes are serialised: one open question at a time per classifier. */
let queue = Promise.resolve()

async function* questions() {
  for (;;) {
    const text =
      inbox.shift() ??
      (await new Promise((resolve) => {
        deliver = resolve
      }))
    if (text == null) return
    yield {
      type: 'user',
      // Framed as a thing to classify, never as a request: without the
      // wrapper a question about the calendar is a question about the
      // calendar, and the voter tried to answer it.
      message: { role: 'user', content: `Einordnen, nicht beantworten. Anfrage: «${text}»\nAntwort (ein Wort):` },
      parent_tool_use_id: null,
    }
  }
}

function closeSession() {
  const s = session
  session = null
  deliver?.(null)
  deliver = null
  try {
    s?.close?.()
  } catch {
    /* already gone */
  }
}

function openSession() {
  votes = 0
  const s = query({
    prompt: questions(),
    options: {
      model: ROUTER_MODEL,
      systemPrompt: CLASSIFIER_PROMPT,
      // No tools, no servers, no settings: the vote is one word of text.
      // The claude.ai connectors (Gmail, Calendar) arrive regardless of the
      // empty server map — measured: the voter once answered the question
      // about the calendar instead of voting — so every MCP tool is barred
      // by name as well.
      tools: [],
      disallowedTools: ['mcp__*'],
      mcpServers: {},
      // And no other MCP source either — the claude.ai connectors were being
      // dialled on every classifier turn, which tripled the vote's latency.
      strictMcpConfig: true,
      settingSources: [],
      effort: 'low',
      cwd: homedir(),
      permissionMode: 'default',
      includePartialMessages: false,
    },
  })
  session = s
  ;(async () => {
    try {
      for await (const msg of s) {
        if (msg.type !== 'result') continue
        if (msg.subtype !== 'success') {
          console.warn(`[router] classifier turn ended with ${msg.subtype}: ${JSON.stringify(msg.errors ?? '').slice(0, 200)}`)
        }
        const text = msg.subtype === 'success' ? String(msg.result ?? '') : ''
        pending?.resolve(text)
        pending = null
      }
    } catch (err) {
      console.warn(`[router] classifier session failed: ${err?.message ?? err}`)
      pending?.resolve('')
      pending = null
    } finally {
      if (session === s) session = null
    }
  })()
}

/** Ask the classifier. Resolves to a tier, or null when it could not say. */
function vote(text) {
  const run = () =>
    new Promise((resolve) => {
      if (!session || votes >= VOTES_PER_SESSION) {
        closeSession()
        openSession()
      }
      votes++
      const timer = setTimeout(() => {
        if (pending?.resolve === done) {
          pending = null
          resolve(null)
        }
      }, VOTE_TIMEOUT_MS)
      const done = (answer) => {
        clearTimeout(timer)
        const word = /\b(HAIKU|SONNET|OPUS|FABLE)\b/i.exec(answer)?.[1]?.toLowerCase()
        if (!word) console.warn(`[router] vote gave no tier: ${JSON.stringify(String(answer).slice(0, 160))}`)
        resolve(word ?? null)
      }
      pending = { resolve: done }
      if (deliver) {
        const d = deliver
        deliver = null
        d(text)
      } else {
        inbox.push(text)
      }
    })
  const next = queue.then(run, run)
  queue = next.catch(() => {})
  return next
}

// ---------------------------------------------------------------------------

/**
 * Decide where a question goes.
 *
 * @returns {Promise<{ tier: string, model: string, reason: string, text: string, ms: number, local?: string }>}
 */
export async function route(text) {
  const t0 = Date.now()
  const rule = byRule(text)
  if (rule) {
    return { ...rule, model: rule.local ? 'bridge' : TIERS[rule.tier], ms: Date.now() - t0 }
  }
  if (!VOTE_ENABLED) {
    const tier = guessTier(text)
    return { tier, model: TIERS[tier], reason: tier === DEFAULT_TIER ? 'rule:default' : 'rule:heavy', text, ms: Date.now() - t0 }
  }
  const voted = await vote(text)
  const tier = voted ?? guessTier(text)
  return {
    tier,
    model: TIERS[tier],
    reason: voted ? 'vote' : 'vote-failed',
    text,
    ms: Date.now() - t0,
  }
}

/**
 * Open the classifier at boot and put one throwaway question to it, so the
 * first real vote does not pay for the process start and the model's first
 * turn — measured at just over the four-second timeout, which sent the
 * first question of every session to the default tier.
 */
export function warmRouter() {
  if (!ROUTER_ENABLED || !VOTE_ENABLED) return
  if (!session) openSession()
  const t0 = Date.now()
  void vote('Wie spät ist es?').then((tier) => {
    console.log(`[router] warm: first vote took ${Date.now() - t0}ms → ${tier ?? 'no tier'}`)
  })
}

export function closeRouter() {
  closeSession()
}
