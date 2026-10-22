import { AnimatePresence, motion } from 'framer-motion'
import { useStore } from '../store'
import { settleConfirm } from '../lib/confirm'

/**
 * The permission card.
 *
 * Up while the bridge is holding an action that changes something, and the
 * only thing on the interface that takes a click. It shows three things, in
 * order of what the user needs to judge: what JARVIS said he would do and why,
 * which tool is about to run, and the literal command or arguments — so the
 * approval is of the real call, not of the description of it.
 *
 * Answered by the buttons, by Enter and Escape (App.tsx), or by the spoken
 * phrase; the bridge takes it down itself on a timeout or a barge-in.
 */
export function Confirm() {
  const confirm = useStore((s) => s.confirm)

  return (
    <AnimatePresence>
      {confirm && (
        <motion.div
          className="confirm"
          role="alertdialog"
          aria-label="Bestätigung erforderlich"
          // Centred by framer, not the stylesheet: it owns `transform` here.
          initial={{ opacity: 0, x: '-50%', y: -10, filter: 'blur(6px)' }}
          animate={{ opacity: 1, x: '-50%', y: 0, filter: 'blur(0px)' }}
          exit={{ opacity: 0, x: '-50%', y: -10, filter: 'blur(6px)' }}
          transition={{ type: 'spring', stiffness: 300, damping: 26 }}
        >
          <div className="confirm-kicker">
            <span className="confirm-dot" />
            Bestätigung erforderlich
          </div>
          <div className="confirm-tool">{confirm.label}</div>
          {confirm.explanation && (
            <p className="confirm-why">{confirm.explanation}</p>
          )}
          {confirm.detail && <pre className="confirm-detail">{confirm.detail}</pre>}
          <div className="confirm-actions">
            <button
              type="button"
              className="confirm-yes"
              onClick={() => settleConfirm(true, 'click')}
            >
              Ausführen
            </button>
            <button
              type="button"
              className="confirm-no"
              onClick={() => settleConfirm(false, 'click')}
            >
              Abbrechen
            </button>
          </div>
          <div className="confirm-hint">
            oder sag <b>„Jarvis, ausführen“</b> · <b>„Jarvis, abbrechen“</b> ·{' '}
            <kbd>Enter</kbd> / <kbd>Esc</kbd>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
