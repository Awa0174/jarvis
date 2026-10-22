import { answerConfirm, type ConfirmVia } from './brain'
import { useStore } from '../store'
import * as sfx from './sfx'

/**
 * One place that answers a held action, whichever way the answer arrived —
 * the card's buttons, a key, or the spoken phrase. It clears the card and
 * tells the bridge; the bridge is what actually lets the tool run or not.
 *
 * Returns false when nothing was waiting, so a caller can tell "approved"
 * from "there was nothing to approve".
 */
export function settleConfirm(approved: boolean, via: ConfirmVia): boolean {
  const s = useStore.getState()
  const c = s.confirm
  if (!c) return false
  answerConfirm(c.id, approved, via)
  s.setConfirm(null)
  sfx.play(approved ? 'tool' : 'done')
  return true
}

/**
 * The only spoken words that approve or decline a gated action.
 *
 * Deliberately not "yes" or "no": a confirmation that any word of assent can
 * trigger is one that a television, a visitor, or a half-heard sentence can
 * trigger too. His name plus a verb nobody says by accident. Both the German
 * and the English form are accepted while the recogniser still runs in
 * English; the same mishearings of his name as the wake word are allowed.
 */
const NAME = "(?:jarvis|jarvys|jervis|travis|jarviss|java's|jarv)"
export const CONFIRM_PHRASE = new RegExp(
  `\\b${NAME}\\b[\\s,.:!?-]*(?:ausführen|ausfuehren|execute)\\b`,
  'i',
)
export const DECLINE_PHRASE = new RegExp(
  `\\b${NAME}\\b[\\s,.:!?-]*(?:abbrechen|abbruch|cancel|stop)\\b`,
  'i',
)
