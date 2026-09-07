#!/usr/bin/env node
/**
 * IMAP connector, spoken as an MCP server over stdio.
 *
 * An MCP server rather than a CLI on purpose. The Gateway's `CliAdapter` spawns
 * a fresh process per call, which for IMAP means a TCP connect, a TLS handshake
 * and a LOGIN every single time. `McpPassthroughAdapter` connects once and
 * reuses the client, so a widget polling every couple of minutes costs one
 * round trip instead of a full reconnect.
 *
 * Configuration arrives the way the Gateway supplies it:
 *   IMAP_HOST / IMAP_PORT / IMAP_USER   from the manifest's `env`
 *   ARMS_CREDENTIAL                     the app password, decrypted from the
 *                                       vault at the moment of the call and
 *                                       never placed on a command line
 *
 * Deliberately no IDLE: the Gateway is a request/response system, and a
 * push-based source would need a whole second shape. Polling a bounded recent
 * view is cheap enough.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { ImapFlow } from 'imapflow'

const HOST = process.env.IMAP_HOST
const PORT = Number(process.env.IMAP_PORT ?? 993)
const USER = process.env.IMAP_USER
const PASSWORD = process.env.ARMS_CREDENTIAL
const MAILBOX = process.env.IMAP_MAILBOX ?? 'INBOX'

/** Headers only, and never the whole mailbox: a widget wants a glance. */
const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50

/**
 * Google shows an app password as four groups of four and people paste it
 * exactly as displayed. The spaces are presentational. Anything not of that
 * shape is left alone, because another provider's password may contain spaces.
 */
export function normalisePassword(password) {
  return /^\w{4}(\s\w{4}){3}$/.test((password ?? '').trim())
    ? password.replace(/\s+/g, '')
    : (password ?? '')
}

/** One address, rendered for a list row. */
export function formatAddress(address) {
  if (!address) return ''
  const [first] = Array.isArray(address) ? address : [address]
  if (!first) return ''
  return first.name ? `${first.name} <${first.address ?? ''}>` : (first.address ?? '')
}

/** Shape one fetched message into the row a widget renders. */
export function toSummary(message) {
  const envelope = message.envelope ?? {}
  return {
    uid: message.uid,
    from: formatAddress(envelope.from),
    subject: envelope.subject ?? '(no subject)',
    date: envelope.date instanceof Date ? envelope.date.toISOString() : (envelope.date ?? null),
    seen: Boolean(message.flags?.has?.('\\Seen'))
  }
}

export function clampLimit(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(Math.floor(n), MAX_LIMIT)
}

const TOOLS = [
  {
    name: 'list_unread',
    description: 'Unread count plus the most recent unread message headers',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: `how many headers, max ${MAX_LIMIT}` },
        mailbox: { type: 'string' }
      }
    }
  },
  {
    name: 'search',
    description: 'Search message headers by subject or sender',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
        mailbox: { type: 'string' }
      }
    }
  },
  {
    name: 'mark_read',
    description: 'Mark one message as read. Reversible.',
    inputSchema: {
      type: 'object',
      required: ['uid'],
      properties: { uid: { type: 'number' }, mailbox: { type: 'string' } }
    }
  }
]

function assertConfigured() {
  const missing = []
  if (!HOST) missing.push('IMAP_HOST')
  if (!USER) missing.push('IMAP_USER')
  if (!PASSWORD) missing.push('ARMS_CREDENTIAL (the vault credential)')
  if (missing.length > 0) {
    throw new Error(`email connector is not configured: missing ${missing.join(', ')}`)
  }
}

let client
let connecting

/** Connect once and reuse. A dropped connection is rebuilt on the next call. */
async function connect() {
  if (client?.usable) return client
  connecting ??= (async () => {
    const next = new ImapFlow({
      host: HOST,
      port: PORT,
      secure: PORT === 993,
      auth: { user: USER, pass: normalisePassword(PASSWORD) },
      logger: false
    })
    await next.connect()
    return next
  })().catch((err) => {
    connecting = undefined
    throw err
  })

  client = await connecting
  connecting = undefined
  return client
}

async function withMailbox(mailbox, fn) {
  const c = await connect()
  const lock = await c.getMailboxLock(mailbox ?? MAILBOX)
  try {
    return await fn(c)
  } finally {
    lock.release()
  }
}

async function listUnread(args) {
  const limit = clampLimit(args.limit)
  return withMailbox(args.mailbox, async (c) => {
    const uids = await c.search({ seen: false })
    // Newest first, and only the tail: an inbox with 5000 unread must cost the
    // same as one with five.
    const recent = uids.slice(-limit).reverse()

    const messages = []
    for (const uid of recent) {
      const message = await c.fetchOne(String(uid), { envelope: true, flags: true }, { uid: true })
      if (message) messages.push(toSummary(message))
    }
    return { unread: uids.length, messages }
  })
}

async function search(args) {
  const limit = clampLimit(args.limit)
  const query = String(args.query ?? '').trim()
  if (!query) throw new Error('search needs a query')

  return withMailbox(args.mailbox, async (c) => {
    const uids = await c.search({ or: [{ subject: query }, { from: query }] })
    const recent = uids.slice(-limit).reverse()

    const messages = []
    for (const uid of recent) {
      const message = await c.fetchOne(String(uid), { envelope: true, flags: true }, { uid: true })
      if (message) messages.push(toSummary(message))
    }
    return { matched: uids.length, messages }
  })
}

async function markRead(args) {
  const uid = Number(args.uid)
  if (!Number.isInteger(uid)) throw new Error('mark_read needs a numeric uid')
  return withMailbox(args.mailbox, async (c) => {
    const ok = await c.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true })
    return { uid, marked: ok }
  })
}

const HANDLERS = { list_unread: listUnread, search, mark_read: markRead }

async function main() {
  const server = new Server(
    { name: 'arms-email-imap', version: '0.1.0' },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const handler = HANDLERS[request.params.name]
    if (!handler) {
      return {
        content: [{ type: 'text', text: `unknown tool: ${request.params.name}` }],
        isError: true
      }
    }
    try {
      assertConfigured()
      const result = await handler(request.params.arguments ?? {})
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    } catch (err) {
      // A failure is reported as a tool error so the Gateway records it and the
      // caller can read why, rather than the connector dying silently.
      return { content: [{ type: 'text', text: err.message }], isError: true }
    }
  })

  await server.connect(new StdioServerTransport())
}

// Importable for tests; only starts a server when run as the connector.
if (process.env.ARMS_EMAIL_IMPORT_ONLY !== '1') {
  main().catch((err) => {
    process.stderr.write(`${err.stack ?? err.message}\n`)
    process.exit(1)
  })
}
