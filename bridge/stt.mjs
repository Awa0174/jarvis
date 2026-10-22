/**
 * Speech recognition in the bridge: whisper.cpp, on the GPU, no key.
 *
 * The browser's own SpeechRecognition is what made JARVIS seem slow-witted:
 * it mishears German freely ("Hey Jarvis" came back as "Hi Jobbis"), it
 * finalises late, and it mangles his own playback so badly that the echo
 * filter could not recognise the sentence it had just spoken. Whisper hears
 * German properly, which fixes both at once — a correct transcript of the
 * user, and a correct transcript of the echo, which then matches and is
 * dropped.
 *
 * One `whisper-server` process stays up for the life of the bridge. The page
 * sends each spoken segment as 16 kHz WAV (see vad.ts) to /stt, the bridge
 * forwards it to the server's /inference and returns the text. CUDA build
 * first; if the GPU build cannot start, the CPU build in the same folder
 * layout works the same, only slower.
 *
 * `scripts/setup-whisper.mjs` fetches the binaries and the model into
 * tools/whisper (git-ignored, ~1.3GB). Without them /health reports no
 * bridge transcriber and the page keeps the browser engine.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const WHISPER_DIR = process.env.JARVIS_WHISPER_DIR ?? join(HERE, '..', 'tools', 'whisper')
/** large-v3-turbo is the best German per second on this class of GPU; the
 *  q5_0 quantisation keeps it under 600MB with no audible loss. */
export const WHISPER_MODEL = process.env.JARVIS_WHISPER_MODEL ?? 'ggml-large-v3-turbo-q5_0.bin'
export const WHISPER_LANG = process.env.JARVIS_WHISPER_LANG ?? 'de'
const WHISPER_PORT = Number(process.env.JARVIS_WHISPER_PORT ?? 8178)
const THREADS = Number(process.env.JARVIS_WHISPER_THREADS ?? 8)
/**
 * The encoder's audio context. Whisper pads every clip to thirty seconds
 * (1500 frames) and encodes all of it, which made a four-second command cost
 * two seconds flat. 768 frames is about fifteen seconds of audio — longer
 * than any one spoken segment (vad.ts cuts at fifteen) — and measured the
 * same transcript at half the time; 512 (ten seconds) is quicker still.
 */
const AUDIO_CTX = Number(process.env.JARVIS_WHISPER_AUDIO_CTX ?? 768)
/** Anything else to hand whisper-server, space separated. */
const EXTRA_ARGS = (process.env.JARVIS_WHISPER_ARGS ?? '').split(/\s+/).filter(Boolean)
/**
 * Nudges the spelling of his name. Whisper wrote "Hai Javis" for "Hey
 * Jarvis" without it, "Hai Jarvis" with it; the wake word is the one word
 * that must come out right every time.
 */
const PROMPT = process.env.JARVIS_WHISPER_PROMPT ?? 'Hey Jarvis.'

const exe = join(WHISPER_DIR, process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server')
const model = join(WHISPER_DIR, 'models', WHISPER_MODEL)
const base = `http://127.0.0.1:${WHISPER_PORT}`

export function whisperInstalled() {
  return existsSync(exe) && existsSync(model)
}

let proc = null
let ready = false

/** Start the server and wait until it answers. Resolves true when usable. */
export async function whisperStart() {
  if (!whisperInstalled()) return false
  if (proc) return ready
  proc = spawn(
    exe,
    [
      '-m', model,
      '-l', WHISPER_LANG,
      '--host', '127.0.0.1',
      '--port', String(WHISPER_PORT),
      '-t', String(THREADS),
      // Greedy decoding without the temperature fallback: measured the same
      // transcript as beam search on short utterances, and it never re-runs
      // the decoder on a low-confidence guess. A spoken command is one
      // segment of a few seconds, which is exactly where greedy is enough.
      '-bs', '1',
      '-nf',
      ...(AUDIO_CTX > 0 ? ['-ac', String(AUDIO_CTX)] : []),
      ...EXTRA_ARGS,
    ],
    { cwd: WHISPER_DIR, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  )
  proc.stdout.on('data', () => {})
  proc.stderr.on('data', (d) => {
    const s = String(d).trim()
    // The server logs every request on stderr; only the first lines and
    // anything that looks like trouble are worth the console.
    if (!ready || /error|fail|cannot|unable/i.test(s)) console.warn(`[stt] whisper: ${s.slice(0, 200)}`)
  })
  proc.on('exit', (code) => {
    console.warn(`[stt] whisper-server exited (${code})`)
    proc = null
    ready = false
  })

  // The model load takes a few seconds; poll the root until it serves.
  const deadline = Date.now() + 60_000
  let up = false
  while (Date.now() < deadline && proc) {
    try {
      const res = await fetch(base, { signal: AbortSignal.timeout(1500) })
      if (res.ok || res.status === 404) {
        up = true
        break
      }
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  if (!up) return false

  // The first inference on the GPU compiles its kernels — measured at over
  // thirty seconds. Pay that here, on a second of silence, not on the user's
  // first sentence. `ready` stays false until it is done, so /health keeps
  // the page on the browser engine in the meantime.
  const t0 = Date.now()
  try {
    ready = true
    await whisperTranscribe(silentWav(1), 'audio/wav')
    console.log(`[stt] whisper warmed up in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  } catch (err) {
    console.warn(`[stt] warm-up failed: ${err?.message ?? err}`)
    ready = false
  }
  return ready
}

/** A WAV of silence, `seconds` long, 16 kHz mono 16-bit. */
function silentWav(seconds) {
  const n = 16000 * seconds
  const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + n * 2, 4)
  b.write('WAVE', 8)
  b.write('fmt ', 12)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22)
  b.writeUInt32LE(16000, 24)
  b.writeUInt32LE(32000, 28)
  b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36)
  b.writeUInt32LE(n * 2, 40)
  return b
}

export function whisperReady() {
  return ready && proc !== null
}

/**
 * Transcribe one WAV segment. Resolves to the text, trimmed; empty when the
 * segment held nothing intelligible.
 */
export async function whisperTranscribe(wav, contentType = 'audio/wav') {
  if (!whisperReady()) throw new Error('whisper is not running')
  const form = new FormData()
  form.append('file', new Blob([wav], { type: contentType }), 'speech.wav')
  form.append('response_format', 'json')
  form.append('language', WHISPER_LANG)
  form.append('temperature', '0.0')
  if (PROMPT) form.append('prompt', PROMPT)
  const res = await fetch(`${base}/inference`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`whisper ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const out = await res.json()
  return cleanTranscript(String(out?.text ?? ''))
}

/**
 * Whisper's habits on near-silence: "[Musik]", "Untertitel von …", a lone
 * dot. None of it was said by anyone.
 */
function cleanTranscript(text) {
  const t = text
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ' ')
    .replace(/untertitel(ung)?\s+(von|der|des|im auftrag)[^.]*\.?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (/^[\s.,!?…-]*$/.test(t)) return ''
  // What Whisper says when nobody said anything: the closing lines of the
  // videos it was trained on, in whatever language the noise suggested.
  // Seen on this machine for room noise and a television in the background.
  if (HALLUCINATIONS.test(t)) {
    console.log(`[stt] dropped as noise: "${t.slice(0, 60)}"`)
    return ''
  }
  return t
}

const HALLUCINATIONS =
  /like,? share|subscribe|abonnier|thanks? for watching|^thank you\.?$|^thanks\.?$|danke f[üu]rs? zuschauen|bis zum n[äa]chsten (mal|video)|ciao a tutti|a presto|sous-?titr|sottotitol|amara\.org|copyright|www\.|\.com\b|untertitel|transcri(pt|b)|^(mhm|hm+|äh+|ähm|oh|ah|puh|tja)[.!?]*$/i

export function whisperStop() {
  try {
    proc?.kill()
  } catch {
    /* already gone */
  }
  proc = null
  ready = false
}
