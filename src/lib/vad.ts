import { getMic } from './audio'

/**
 * Voice-activity detection and segment capture.
 *
 * This is the piece that makes the assistant reliable, and it exists because
 * the browser's SpeechRecognition does not. That API dies silently under
 * always-on use — Chrome throttles it, it stops firing events, and nothing you
 * can catch tells you it has gone deaf. Detecting that a human is speaking is
 * not a language problem, though; it is an energy problem, and energy on the
 * microphone signal is something we can measure ourselves, every frame, with no
 * black box that can quietly stop answering.
 *
 * So: a running-mean noise floor, a threshold above it, and a hysteresis gate.
 * When the signal crosses the threshold a fresh recorder starts; when it falls
 * quiet for long enough the recorder stops and hands back one self-contained
 * audio blob for the bridge to transcribe. The detection is instant and local
 * — that is what makes barge-in feel natural — and the words come back a moment
 * later from a real transcriber that cannot silently fail the way the browser
 * one did.
 *
 * Hearing himself is the one hard part. The microphone picks up JARVIS's own
 * voice through the speakers, and raw energy cannot tell that from the user.
 * Two things handle it: getUserMedia is asked for echo cancellation, which
 * removes most of the playback, and while he is speaking the trigger threshold
 * is raised so the residue that leaks through does not cross it. A text check
 * after transcription is the final backstop, in voice.ts.
 */

export type VadHandlers = {
  /** The signal crossed into speech. Instant; this is the barge-in trigger. */
  onStart: () => void
  /** Speech ended. The blob is one complete, decodable audio file. */
  onEnd: (audio: Blob, ms: number) => void
  /** 0..1 smoothed input level, for the caption/orb while capturing. */
  onLevel: (v: number) => void
  /** Capture is impossible — no microphone, or no MediaRecorder support. */
  onError: (message: string) => void
}

export type Vad = {
  stop: () => void
  /** Raise the trigger bar while JARVIS speaks, so his own playback leaking
   *  past echo cancellation does not register as the user talking. */
  setGuard: (on: boolean) => void
  live: () => boolean
  /** Live internals, for the diagnostics panel. */
  meter: () => { energy: number; floor: number; threshold: number; speaking: boolean }
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** How far above the noise floor the signal must rise to count as speech.
 *  The floor tracks the room, so this is a ratio, not an absolute level. */
const TRIGGER_OVER_FLOOR = 2.6
/** While he is speaking, demand this much more, so residual echo is ignored. */
const GUARD_BOOST = 2.4
/** Falling back below trigger×this ends the segment. Hysteresis stops a single
 *  dip mid-word from cutting a sentence in half. */
const RELEASE_RATIO = 0.6

/** Sustained energy for this long confirms speech rather than a knock or click. */
const START_MS = 110
/**
 * Quiet for this long ends the SEGMENT — which is no longer the same thing as
 * ending the turn.
 *
 * It used to be both, which is why this number was impossible to set: long
 * enough not to clip someone thinking mid-sentence meant every completed
 * question also sat waiting for nothing. Deciding whether the thought is
 * actually finished now happens a layer up, on the words rather than the
 * energy (see makeAssembler in voice.ts), so this can go back to being what it
 * should always have been — a cheap "have they stopped making noise" — and the
 * shorter window gets the transcript moving sooner.
 */
const SILENCE_MS = 650
/** Nobody speaks one segment for this long; cut it and transcribe what we
 *  have. Fifteen, because the local transcriber's audio window is sized to
 *  fifteen seconds (see bridge/stt.mjs) and a longer clip would lose its end. */
const MAX_MS = 15000

/** The floor adapts slowly upward (a fan spinning up) and quickly downward (a
 *  door closing), so it settles to genuine ambient noise without chasing speech. */
const FLOOR_UP = 0.0008
const FLOOR_DOWN = 0.02

/**
 * Segments leave as 16 kHz mono WAV, built here from the raw samples.
 *
 * MediaRecorder used to hand back Opus in WebM, which the cloud transcriber
 * accepted as-is. A local transcriber wants PCM, and decoding Opus in the
 * bridge means shipping a decoder and paying for it on every segment. Taking
 * the samples straight off the graph costs nothing, needs no codec on either
 * side, and the file is small enough: a five-second segment is 160 KB.
 */
const TARGET_RATE = 16000
/** Samples kept from before the gate opened, so the first phoneme is in. */
const PREROLL_MS = 300

function downsample(chunks: Float32Array[], from: number, to: number): Float32Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const input = new Float32Array(total)
  let at = 0
  for (const c of chunks) {
    input.set(c, at)
    at += c.length
  }
  if (from === to) return input
  const ratio = from / to
  const out = new Float32Array(Math.floor(total / ratio))
  for (let i = 0; i < out.length; i++) {
    // Average the source samples that map onto this one: a cheap low-pass
    // that keeps speech clean enough for a transcriber.
    const start = Math.floor(i * ratio)
    const end = Math.min(total, Math.floor((i + 1) * ratio))
    let sum = 0
    for (let j = start; j < end; j++) sum += input[j]
    out[i] = end > start ? sum / (end - start) : 0
  }
  return out
}

function toWav(samples: Float32Array, rate: number): Blob {
  const bytes = new ArrayBuffer(44 + samples.length * 2)
  const v = new DataView(bytes)
  const str = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i))
  }
  str(0, 'RIFF')
  v.setUint32(4, 36 + samples.length * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, samples.length * 2, true)
  let at = 44
  for (let i = 0; i < samples.length; i++, at += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    v.setInt16(at, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Blob([bytes], { type: 'audio/wav' })
}

export async function startVad(h: VadHandlers): Promise<Vad> {
  let stream: MediaStream
  try {
    stream = await getMic()
  } catch (err) {
    h.onError(
      err instanceof DOMException && err.name === 'NotAllowedError'
        ? 'Microphone access denied — voice input is unavailable.'
        : 'No microphone available.',
    )
    return { stop: () => {}, setGuard: () => {}, live: () => false, meter: () => ({ energy: 0, floor: 0, threshold: 0, speaking: false }) }
  }

  const ctx = new AudioContext()
  // Some browsers start an AudioContext suspended even after a gesture; resume
  // is a no-op when it is already running.
  void ctx.resume()
  const source = ctx.createMediaStreamSource(stream)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 1024
  analyser.smoothingTimeConstant = 0.35
  source.connect(analyser)
  const buf = new Float32Array(analyser.fftSize)

  // The sample tap. A ScriptProcessor rather than an AudioWorklet: it runs on
  // the main thread, which is fine for copying 4096 samples ten times a
  // second, and it needs no separate module file served next to the page.
  const tap = ctx.createScriptProcessor(4096, 1, 1)
  const preroll: Float32Array[] = []
  const prerollMax = Math.ceil((PREROLL_MS / 1000) * ctx.sampleRate)
  let capturing = false
  let captured: Float32Array[] = []
  tap.onaudioprocess = (e) => {
    const chunk = new Float32Array(e.inputBuffer.getChannelData(0))
    if (capturing) {
      captured.push(chunk)
      return
    }
    preroll.push(chunk)
    let kept = preroll.reduce((n, c) => n + c.length, 0)
    while (kept > prerollMax && preroll.length > 1) kept -= preroll.shift()!.length
  }
  source.connect(tap)
  // A ScriptProcessor only runs while it is wired to the destination; the
  // gain at zero keeps the microphone out of the speakers.
  const sink = ctx.createGain()
  sink.gain.value = 0
  tap.connect(sink)
  sink.connect(ctx.destination)

  let stopped = false
  let guard = false
  let floor = 0.01
  let smoothEnergy = 0
  let threshold = 0

  // Segment state.
  let armedAt = 0 // energy first rose; capture may be pre-rolling
  let speaking = false
  let speechStartedAt = 0
  let lastLoud = 0
  let raf = 0

  const rms = (): number => {
    analyser.getFloatTimeDomainData(buf)
    let sum = 0
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
    return Math.sqrt(sum / buf.length)
  }

  const startRecorder = () => {
    // Start from the pre-roll, so the onset that tripped the gate is inside.
    captured = preroll.splice(0, preroll.length)
    capturing = true
  }

  const discardRecorder = () => {
    capturing = false
    captured = []
  }

  const endSegment = () => {
    const startedAt = speechStartedAt
    speaking = false
    speechStartedAt = 0
    if (!capturing) return
    capturing = false
    const chunks = captured
    captured = []
    const ms = startedAt ? performance.now() - startedAt : 0
    const samples = downsample(chunks, ctx.sampleRate, TARGET_RATE)
    h.onEnd(toWav(samples, TARGET_RATE), ms)
  }

  const tick = () => {
    if (stopped) return
    raf = requestAnimationFrame(tick)

    const energy = rms()
    smoothEnergy += (energy - smoothEnergy) * 0.5
    h.onLevel(Math.min(1, smoothEnergy * 12))

    // Adapt the floor only when we are confident this is not speech.
    if (!speaking && armedAt === 0) {
      const rate = smoothEnergy > floor ? FLOOR_UP : FLOOR_DOWN
      floor += (smoothEnergy - floor) * rate
      floor = Math.max(floor, 0.0015)
    }

    threshold = floor * TRIGGER_OVER_FLOOR * (guard ? GUARD_BOOST : 1)
    const release = threshold * RELEASE_RATIO
    const now = performance.now()

    if (!speaking) {
      if (smoothEnergy > threshold) {
        if (armedAt === 0) {
          // Onset: start recording immediately so the first phoneme is captured,
          // before we have even confirmed this is speech. If it turns out to be
          // a blip, the recorder is discarded and nothing was lost.
          armedAt = now
          startRecorder()
        } else if (now - armedAt >= START_MS) {
          // Confirmed. This is the moment barge-in fires.
          speaking = true
          speechStartedAt = armedAt
          lastLoud = now
          h.onStart()
        }
      } else if (armedAt !== 0) {
        // Rose and fell without confirming — a knock, a click, a lip smack.
        armedAt = 0
        discardRecorder()
      }
    } else {
      if (smoothEnergy > release) lastLoud = now
      const quietFor = now - lastLoud
      const runFor = now - speechStartedAt
      if (quietFor >= SILENCE_MS || runFor >= MAX_MS) {
        armedAt = 0
        endSegment()
      }
    }
  }

  tick()

  return {
    stop: () => {
      stopped = true
      cancelAnimationFrame(raf)
      discardRecorder()
      try {
        tap.onaudioprocess = null
        tap.disconnect()
        sink.disconnect()
        source.disconnect()
        void ctx.close()
      } catch {
        /* noop */
      }
    },
    setGuard: (on) => {
      guard = on
    },
    live: () => !stopped,
    meter: () => ({ energy: smoothEnergy, floor, threshold, speaking }),
  }
}
