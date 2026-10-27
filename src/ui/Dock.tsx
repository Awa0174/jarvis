import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useStore } from '../store'

/**
 * The command dock: the one part of the interface you can put your hands on.
 *
 * Voice is the primary way in, but it is not the only one. A field to type
 * into, a microphone button, and a row of the things people ask for most —
 * so JARVIS works when the room is loud, when the microphone is off, and for
 * anyone who would rather click. Everything here ends in the same place a
 * spoken sentence does.
 */

const QUICK: Array<{ label: string; text?: string; action?: 'standby' }> = [
  { label: 'Briefing', text: 'Gib mir mein Morgen-Briefing.' },
  { label: 'Termine', text: 'Was steht heute in meinem Kalender?' },
  { label: 'Wetter', text: 'Wie wird das Wetter heute?' },
  { label: 'Mails', text: 'Gibt es neue Mails?' },
  { label: 'Bildschirm', text: 'Was ist gerade auf meinem Bildschirm?' },
  { label: 'PC-Status', text: 'Wie ausgelastet ist mein PC?' },
  { label: 'Kunden', text: 'Wo stehen wir im Vertrieb, und was ist heute fällig?' },
  { label: 'Standby', action: 'standby' },
]

export function Dock() {
  const phase = useStore((s) => s.phase)
  const onSubmit = useStore((s) => s.onSubmit)
  const onMic = useStore((s) => s.onMic)
  const onStandby = useStore((s) => s.onStandby)
  const confirm = useStore((s) => s.confirm)
  const [text, setText] = useState('')
  const input = useRef<HTMLInputElement>(null)

  // Slash focuses the field from anywhere, like every modern app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
        e.preventDefault()
        input.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (phase === 'offline' || phase === 'boot') return null

  const listening = phase === 'listening' || phase === 'waking'
  const busy = phase === 'thinking' || phase === 'tooling' || phase === 'speaking'

  const send = (t: string) => {
    const clean = t.trim()
    if (!clean || !onSubmit) return
    onSubmit(clean)
    setText('')
  }

  return (
    <motion.div
      className="dock"
      // Framer owns `transform` on an animated element, so the horizontal
      // centring lives here (x: -50%) and not in the stylesheet.
      initial={{ opacity: 0, x: '-50%', y: 16 }}
      animate={{ opacity: 1, x: '-50%', y: 0 }}
      transition={{ type: 'spring', stiffness: 260, damping: 28 }}
    >
      <div className="dock-chips">
        <AnimatePresence initial={false}>
          {QUICK.map((c) => (
            <motion.button
              key={c.label}
              type="button"
              className={`chip${c.action === 'standby' ? ' chip-dim' : ''}`}
              whileTap={{ scale: 0.95 }}
              onClick={() => (c.action === 'standby' ? onStandby?.() : send(c.text ?? ''))}
              disabled={Boolean(confirm)}
            >
              {c.label}
            </motion.button>
          ))}
        </AnimatePresence>
      </div>

      <form
        className="dock-bar"
        onSubmit={(e) => {
          e.preventDefault()
          send(text)
        }}
      >
        <button
          type="button"
          className={`mic${listening ? ' mic-live' : ''}${busy ? ' mic-busy' : ''}`}
          title={busy ? 'Unterbrechen und zuhören' : listening ? 'Hört zu' : 'Zuhören (Leertaste)'}
          onClick={() => onMic?.()}
          aria-label="Mikrofon"
        >
          <span className="mic-ring" />
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
              fill="currentColor"
              d="M12 15a3.5 3.5 0 0 0 3.5-3.5v-6a3.5 3.5 0 0 0-7 0v6A3.5 3.5 0 0 0 12 15Zm6-3.5a6 6 0 0 1-12 0H4a8 8 0 0 0 7 7.94V22h2v-2.56A8 8 0 0 0 20 11.5h-2Z"
            />
          </svg>
        </button>
        <input
          ref={input}
          className="dock-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') (e.target as HTMLInputElement).blur()
          }}
          placeholder={
            busy ? 'Jarvis arbeitet … tippen unterbricht ihn' : 'Schreib Jarvis, oder sag „Hey Jarvis“'
          }
          autoComplete="off"
          spellCheck={false}
          disabled={Boolean(confirm)}
        />
        <button type="submit" className="send" disabled={!text.trim() || Boolean(confirm)} aria-label="Senden">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path fill="currentColor" d="M3 11.5 21 3l-8.5 18-2.3-7.2L3 11.5Z" />
          </svg>
        </button>
        <span className="dock-hint">
          <kbd>/</kbd> tippen · <kbd>Leertaste</kbd> reden
        </span>
      </form>
    </motion.div>
  )
}
