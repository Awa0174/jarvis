/**
 * His name, as a recogniser is likely to spell it.
 *
 * "Jarvis" is not in any dictation model's high-frequency vocabulary. An
 * English recogniser returns Travis, Jervis or Java's for a clear utterance; a
 * German one returns Jarwis, Javis or Jaris. Every one of those used to be
 * silently discarded, so the name "just didn't work" with no indication why.
 * Better a rare false wake than a name that does not answer.
 *
 * One list, shared by the wake word, the vocative stripper and the
 * confirmation phrases, so a spelling that wakes him also confirms for him.
 */
export const NAME =
  "(?:jarvis|jarvys|jervis|jarviss|jarv|travis|java's|jarwis|javis|javais|jaris|jarves|jarfis|charvis|dschawis)"

/** Casual prefixes that come before the name, in either language. */
export const PREFIX = '(?:hey|hi|ok|okay|yo|hallo|he|ey)?'
