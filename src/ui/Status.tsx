import { motion } from 'framer-motion'
import { useStore, type Phase } from '../store'
import { caps } from '../lib/capabilities'

/**
 * The status cluster: what he is doing right now, drawn rather than written.
 *
 * A word alone ("PROCESSING") is a label; a thing that moves is a state. So
 * the pill carries a small live figure for each phase — a breathing dot in
 * standby, sonar while he listens, orbiting points while he thinks, bars
 * that follow his voice while he speaks — and under it a row of chips for
 * the engines behind him, so a slow turn can be read as "that went to the
 * big model" and a deaf one as "the browser is listening, not whisper".
 */

const LABEL: Record<Phase, string> = {
  offline: 'Offline',
  boot: 'Startet',
  dormant: 'Standby',
  waking: 'Online',
  listening: 'Hört zu',
  thinking: 'Denkt nach',
  tooling: 'Arbeitet',
  speaking: 'Spricht',
}

const TIER_CLASS: Record<string, string> = {
  haiku: 'tier-haiku',
  sonnet: 'tier-sonnet',
  opus: 'tier-opus',
  fable: 'tier-fable',
  local: 'tier-local',
}

function Figure({ phase, level }: { phase: Phase; level: number }) {
  if (phase === 'speaking') {
    // Five bars, the middle ones leaning on the live level, the outer ones
    // trailing it — a voice, not a VU meter.
    const heights = [0.35, 0.7, 1, 0.75, 0.4].map((k) => 0.2 + Math.min(1, level * 1.6) * k)
    return (
      <span className="fig fig-bars" aria-hidden="true">
        {heights.map((h, i) => (
          <i key={i} style={{ transform: `scaleY(${h.toFixed(2)})` }} />
        ))}
      </span>
    )
  }
  if (phase === 'listening' || phase === 'waking') {
    return (
      <span className="fig fig-sonar" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    )
  }
  if (phase === 'thinking' || phase === 'tooling') {
    return (
      <span className="fig fig-orbit" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    )
  }
  return (
    <span className="fig fig-dot" aria-hidden="true">
      <i />
    </span>
  )
}

export function Status() {
  const phase = useStore((s) => s.phase)
  const level = useStore((s) => s.level)
  const model = useStore((s) => s.model)
  const voice = useStore((s) => s.voice)
  const c = caps()

  return (
    <div className="status-cluster">
      <motion.div
        key={phase}
        className={`pill pill-${phase}`}
        initial={{ opacity: 0.4, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
      >
        <Figure phase={phase} level={level} />
        <span className="pill-label">{LABEL[phase]}</span>
      </motion.div>

      <div className="engines">
        <span className={`eng${c.stt ? ' eng-on' : ''}`} title={c.stt ? 'Lokale Erkennung (Whisper)' : 'Browser-Erkennung'}>
          {c.stt ? 'whisper' : 'browser'}
        </span>
        {voice && (
          <span className="eng" title="Stimme (V wechselt)">
            {voice.replace(/\(.*?\)/g, '').replace(/microsoft|online|natural|multilingual|-/gi, '').trim().split(' ')[0].toLowerCase() || 'stimme'}
          </span>
        )}
        {model && (
          <span className={`eng ${TIER_CLASS[model] ?? ''}`} title="Modellstufe der letzten Antwort">
            {model}
          </span>
        )}
      </div>
    </div>
  )
}
