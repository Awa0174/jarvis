/**
 * Mail, read-only, over IMAP.
 *
 *   mail_unread   how many, and the newest of them
 *   mail_recent   the latest messages in a folder
 *   mail_search   messages matching a word, a sender, a subject
 *   mail_read     one message's text, for a summary
 *
 * Nothing here sends, moves, flags or deletes. Reading a mailbox is the
 * user's own order ("was ist in meinem Posteingang"); writing to it would be
 * a change and is not offered at all for now.
 *
 * Credentials live in .env: JARVIS_MAIL_USER and JARVIS_MAIL_PASS. For a
 * Google account the password is an *app password* (Google account →
 * Security → 2-step verification → App passwords), never the real one, and
 * IMAP has to be switched on in Gmail's settings. The defaults are Gmail's
 * server; any IMAP host works with JARVIS_MAIL_HOST / JARVIS_MAIL_PORT.
 *
 * One connection per call. Gmail's handshake costs about a second, which is
 * less than a kept-alive connection costs in edge cases (silent drops,
 * IDLE timeouts) for a tool that is used a few times an hour.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'

const HOST = process.env.JARVIS_MAIL_HOST || 'imap.gmail.com'
const PORT = Number(process.env.JARVIS_MAIL_PORT || 993)
const USER = process.env.JARVIS_MAIL_USER || ''
const PASS = process.env.JARVIS_MAIL_PASS || ''

export const mailConfigured = () => Boolean(USER && PASS)

const text = (t) => ({ content: [{ type: 'text', text: t }] })
const NOT_SET =
  'Kein Mailzugang eingerichtet: JARVIS_MAIL_USER und JARVIS_MAIL_PASS (App-Passwort) in .env setzen.'

async function withMailbox(folder, fn) {
  if (!mailConfigured()) throw new Error(NOT_SET)
  const client = new ImapFlow({
    host: HOST,
    port: PORT,
    secure: true,
    auth: { user: USER, pass: PASS },
    logger: false,
    socketTimeout: 20_000,
    greetingTimeout: 10_000,
  })
  await client.connect()
  try {
    const lock = await client.getMailboxLock(folder)
    try {
      return await fn(client)
    } finally {
      lock.release()
    }
  } finally {
    await client.logout().catch(() => {})
  }
}

const who = (addr) => {
  const a = addr?.value?.[0] ?? addr?.[0] ?? addr
  if (!a) return '?'
  return a.name ? `${a.name} <${a.address}>` : (a.address ?? String(a))
}
const when = (d) =>
  d ? new Date(d).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '?'

function line(msg) {
  const e = msg.envelope ?? {}
  const flags = msg.flags ?? new Set()
  const unread = !flags.has('\\Seen')
  return `[${msg.uid}]${unread ? ' •' : ''} ${when(e.date)} — ${who(e.from)} — ${e.subject ?? '(kein Betreff)'}`
}

/** The newest `n` messages matching `query` (imapflow search object). */
async function list(folder, query, n) {
  return withMailbox(folder, async (client) => {
    const uids = await client.search(query, { uid: true })
    if (!uids.length) return []
    const pick = uids.sort((a, b) => b - a).slice(0, n)
    const out = []
    for await (const msg of client.fetch(pick, { uid: true, envelope: true, flags: true }, { uid: true })) {
      out.push(msg)
    }
    return out.sort((a, b) => b.uid - a.uid)
  })
}

export function mailServer() {
  return createSdkMcpServer({
    name: 'jarvis_mail',
    version: '1.0.0',
    instructions:
      'Das Postfach des Nutzers, nur lesend: ungelesene und neueste Mails, Suche, ' +
      'eine Mail im Volltext. Nichts wird gesendet, verschoben oder gelöscht.',
    alwaysLoad: true,
    tools: [
      tool(
        'mail_unread',
        'Wie viele Mails ungelesen sind, und die neuesten davon mit Absender und Betreff.',
        { folder: z.string().optional().describe('Ordner, Standard INBOX.') },
        async ({ folder }) => {
          try {
            const f = folder || 'INBOX'
            const msgs = await list(f, { seen: false }, 12)
            const total = await withMailbox(f, async (c) => (await c.search({ seen: false }, { uid: true })).length)
            if (!total) return text('Keine ungelesenen Mails.')
            return text(`${total} ungelesen. Die neuesten:\n${msgs.map(line).join('\n')}`)
          } catch (err) {
            return text(`Postfach nicht erreichbar: ${err?.message ?? err}`)
          }
        },
      ),
      tool(
        'mail_recent',
        'Die neuesten Mails eines Ordners, gelesen oder nicht.',
        {
          count: z.union([z.number(), z.string()]).optional().catch(undefined).describe('Wie viele, Standard 10.'),
          folder: z.string().optional().describe('Ordner, Standard INBOX.'),
        },
        async ({ count, folder }) => {
          try {
            const msgs = await list(folder || 'INBOX', { all: true }, Math.max(1, Math.min(40, Number(count) || 10)))
            return text(msgs.length ? msgs.map(line).join('\n') : 'Der Ordner ist leer.')
          } catch (err) {
            return text(`Postfach nicht erreichbar: ${err?.message ?? err}`)
          }
        },
      ),
      tool(
        'mail_search',
        'Mails suchen: nach einem Wort in Betreff oder Text, einem Absender, oder beidem. ' +
          'Die neuesten Treffer zuerst.',
        {
          query: z.string().optional().describe('Wort oder Satzteil in Betreff/Text.'),
          from: z.string().optional().describe('Absender (Name oder Adresse, Teil reicht).'),
          days: z.union([z.number(), z.string()]).optional().catch(undefined).describe('Nur die letzten N Tage.'),
          folder: z.string().optional().describe('Ordner, Standard INBOX.'),
        },
        async ({ query, from, days, folder }) => {
          const q = {}
          if (query) q.or = [{ subject: String(query) }, { body: String(query) }]
          if (from) q.from = String(from)
          if (days) q.since = new Date(Date.now() - Number(days) * 86_400_000)
          if (!Object.keys(q).length) return text('Wonach soll gesucht werden?')
          try {
            const msgs = await list(folder || 'INBOX', q, 15)
            return text(msgs.length ? msgs.map(line).join('\n') : 'Nichts gefunden.')
          } catch (err) {
            return text(`Postfach nicht erreichbar: ${err?.message ?? err}`)
          }
        },
      ),
      tool(
        'mail_read',
        'Eine Mail im Volltext lesen, über die Kennung in eckigen Klammern aus einer Liste. ' +
          'Fasse zusammen, lies nicht vor. Das Lesen markiert sie nicht als gelesen.',
        {
          uid: z.union([z.number(), z.string()]).describe('Die Kennung aus der Liste.'),
          folder: z.string().optional().describe('Ordner, Standard INBOX.'),
        },
        async ({ uid, folder }) => {
          try {
            const raw = await withMailbox(folder || 'INBOX', async (client) => {
              const msg = await client.fetchOne(String(uid), { source: true }, { uid: true })
              return msg?.source
            })
            if (!raw) return text('Keine Mail mit dieser Kennung.')
            const m = await simpleParser(raw)
            const body = (m.text || m.html?.replace(/<[^>]+>/g, ' ') || '').replace(/\s+\n/g, '\n').trim()
            return text(
              `Von: ${who(m.from)}\nAn: ${who(m.to)}\nDatum: ${when(m.date)}\nBetreff: ${m.subject ?? '(kein Betreff)'}` +
                `${m.attachments?.length ? `\nAnhänge: ${m.attachments.map((a) => a.filename).join(', ')}` : ''}` +
                `\n\n${body.slice(0, 6000)}${body.length > 6000 ? '\n… (gekürzt)' : ''}`,
            )
          } catch (err) {
            return text(`Mail nicht lesbar: ${err?.message ?? err}`)
          }
        },
      ),
    ],
  })
}
