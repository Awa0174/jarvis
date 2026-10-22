/**
 * Speech synthesis in the bridge: Piper, a neural voice that runs locally.
 *
 * The browser's own speechSynthesis depends entirely on what the machine
 * ships, and on Windows that is a handful of flat SAPI voices. Piper is a
 * small open-source neural engine (rhasspy/piper) with a proper German male
 * voice, "Thorsten"; it runs on the CPU, needs no key and no network, and
 * sounds the same in every browser. The page posts a sentence to /tts and
 * gets a WAV back; the pipeline in tts.ts already generates one sentence
 * ahead, which hides most of the synthesis time.
 *
 * One piper process stays running for the life of the bridge, because loading
 * the model is the expensive part. It reads JSON lines on stdin, writes one
 * WAV per line into a scratch directory and prints the path when it is done —
 * which is the only reliable way to tell where one sentence's audio ends.
 *
 * `scripts/setup-piper.mjs` fetches the binary and the voices into tools/piper
 * (git-ignored, ~250MB). Without them /health reports no bridge voice and the
 * page falls back to its own, so a missing download costs timbre, not speech.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { readFile as readFileAsync, unlink as unlinkAsync } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PIPER_DIR = process.env.JARVIS_PIPER_DIR ?? join(HERE, '..', 'tools', 'piper')

/**
 * Which voice. de_DE-thorsten-high is the best German voice Piper has;
 * -medium is noticeably quicker on a slow CPU at a small cost in warmth.
 * Any other model dropped into tools/piper/voices can be named here.
 */
export const PIPER_VOICE = process.env.JARVIS_PIPER_VOICE ?? 'de_DE-thorsten-high'

/**
 * Pace. Piper's length_scale stretches phonemes: 1.0 is the voice's own
 * tempo, above it is slower. A touch slower than natural suits the character
 * and makes the synthetic voice easier to follow through a laptop speaker.
 */
const LENGTH_SCALE = process.env.JARVIS_PIPER_LENGTH ?? '1.05'

const exe = join(PIPER_DIR, process.platform === 'win32' ? 'piper.exe' : 'piper')
const model = join(PIPER_DIR, 'voices', `${PIPER_VOICE}.onnx`)

/** Whether the binary and the chosen voice are on disk at all. */
export function piperInstalled() {
  return existsSync(exe) && existsSync(model) && existsSync(`${model}.json`)
}

let proc = null
let outDir = null
/** Resolvers for sentences in flight, in the order they were sent. Piper
 *  answers strictly in order, so a queue is enough to match them up. */
let waiters = []
let stdoutBuf = ''

function start() {
  if (proc) return proc
  outDir = mkdtempSync(join(tmpdir(), 'jarvis-piper-'))
  const p = spawn(
    exe,
    [
      '--model', model,
      '--json-input',
      '--output_dir', outDir,
      '--espeak_data', join(PIPER_DIR, 'espeak-ng-data'),
      '--length_scale', LENGTH_SCALE,
      '--sentence_silence', '0.15',
      '--quiet',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  )
  p.stdout.on('data', (d) => {
    stdoutBuf += d
    let i
    while ((i = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, i).trim()
      stdoutBuf = stdoutBuf.slice(i + 1)
      if (line) waiters.shift()?.resolve(line)
    }
  })
  p.stderr.on('data', (d) => {
    const s = String(d).trim()
    if (s) console.warn(`[jarvis] piper: ${s}`)
  })
  p.on('exit', (code) => {
    console.warn(`[jarvis] piper exited (${code})`)
    for (const w of waiters) w.reject(new Error('piper exited'))
    waiters = []
    proc = null
    try {
      rmSync(outDir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  })
  proc = p
  return p
}

let seq = 0

/**
 * Synthesise one sentence. Resolves to a WAV buffer, or rejects when the
 * engine is missing or died — the caller falls back to the browser voice.
 */
export async function piperSpeak(text) {
  if (!piperInstalled()) throw new Error('piper is not installed (run scripts/setup-piper.mjs)')
  const p = start()
  const file = join(outDir, `s${++seq}.wav`)
  const done = new Promise((resolve, reject) => {
    waiters.push({ resolve, reject })
    setTimeout(() => {
      const i = waiters.findIndex((w) => w.resolve === resolve)
      if (i >= 0) {
        waiters.splice(i, 1)
        reject(new Error('piper timed out'))
      }
    }, 20_000)
  })
  // One line per sentence: a newline inside the text would be read as a
  // second request and desynchronise the queue.
  p.stdin.write(JSON.stringify({ text: text.replace(/\s*\n+\s*/g, ' '), output_file: file }) + '\n')
  await done
  const wav = await readFileAsync(file)
  void unlinkAsync(file).catch(() => {})
  return wav
}

/** A one-word synthesis at boot, so /health can promise what it delivers. */
export async function piperAvailable() {
  if (!piperInstalled()) return false
  try {
    const wav = await piperSpeak('Bereit.')
    return wav.length > 44
  } catch (err) {
    console.warn(`[jarvis] piper failed to start: ${err?.message ?? err}`)
    return false
  }
}

export function piperStop() {
  try {
    proc?.kill()
  } catch {
    /* already gone */
  }
}
