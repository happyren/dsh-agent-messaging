/**
 * Reading this plugin's own messages back out of a durable transcript.
 *
 * The browser sees a logged message as opaque JSON. It crossed a wire, it may
 * have been written by an older version of this plugin, and most of the time it
 * is not ours at all — so every field is checked rather than assumed, and
 * anything unreadable declines instead of guessing. Declining is safe: the
 * harness's own relay presentation still renders the message.
 *
 * Pure by contract, and free of any browser or Node dependency, so the same
 * reader runs under the test suite.
 */

import type { PeerAuthority } from '../domain/authority.ts'
import type { DeliveryMode } from '../domain/envelope.ts'
import { PLUGIN_NAME } from '../plugin-name.ts'

/** Opening tag of the data region {@link renderInbound} writes. */
const OPEN_TAG = '<peer-message>'
/** Closing tag of the data region. */
const CLOSE_TAG = '</peer-message>'

/**
 * One arriving peer message, as a transcript can attribute it.
 *
 * Only the sending session's id is required. Everything else was added to the
 * record after the first release, so a message logged by an older version
 * presents with fewer facts rather than a card full of invented ones.
 */
export interface PeerMessage {
  /** The sending session's id — the authoritative identity. */
  readonly sessionId: string
  /** The sender's display name at send time, when it recorded one. */
  readonly name?: string
  /** Which inbox boundary took delivery. */
  readonly mode?: DeliveryMode
  /** What the receiving model was told it may do with this message. */
  readonly authority?: PeerAuthority
  /** Envelope identity. */
  readonly messageId?: string
  /** Unix epoch milliseconds the sender stamped. */
  readonly sentAt?: number
  /** The message this one answers. */
  readonly replyTo?: string
  /** Whether the sender reached this session from outside, over A2A. */
  readonly external: boolean
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function readMode(value: unknown): DeliveryMode | undefined {
  return value === 'steer' || value === 'followup' || value === 'context' ? value : undefined
}

function readAuthority(value: unknown): PeerAuthority | undefined {
  return value === 'inform' || value === 'act' ? value : undefined
}

function readTime(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * Recognize one durable message source as a peer message this plugin delivered.
 * @param source - the logged `user/message` source, exactly as recorded.
 * @returns the attribution, or null when the record is not a peer message this
 * version can present.
 */
export function readPeerMessage(source: unknown): PeerMessage | null {
  const record = asRecord(source)
  if (record === null) return null
  if (record['kind'] !== 'plugin' || record['plugin'] !== PLUGIN_NAME) return null
  if (record['form'] !== 'relay') return null

  // The sender's id is the one fact a card cannot be honest without: it is the
  // identity a reply is addressed to, and every other field is decoration.
  const sessionId = readString(record, 'senderSessionId')
  if (sessionId === undefined) return null

  return {
    sessionId,
    ...(readString(record, 'senderName') === undefined
      ? {}
      : { name: readString(record, 'senderName') as string }),
    ...(readMode(record['mode']) === undefined ? {} : { mode: readMode(record['mode']) as DeliveryMode }),
    ...(readAuthority(record['authority']) === undefined
      ? {}
      : { authority: readAuthority(record['authority']) as PeerAuthority }),
    ...(readString(record, 'messageId') === undefined
      ? {}
      : { messageId: readString(record, 'messageId') as string }),
    ...(readTime(record['sentAt']) === undefined ? {} : { sentAt: readTime(record['sentAt']) as number }),
    ...(readString(record, 'replyTo') === undefined
      ? {}
      : { replyTo: readString(record, 'replyTo') as string }),
    external: record['external'] === true,
  }
}

/**
 * Recover what the peer actually wrote from the text the model was shown.
 *
 * The logged content is the framed form: a fixed untrusted-content notice, a
 * tag-delimited JSON region, and a reply hint. A card shows the message, not
 * the framing — but only the framing is durable, so the body is read back out
 * of it here. Any deviation from the expected shape declines, and the caller
 * shows the text as logged rather than a confidently wrong excerpt.
 * @param text - the model-facing text of one delivered peer message.
 * @returns the sender's own words, or null when the framing is unreadable.
 */
export function readPeerBody(text: string): string | null {
  const open = text.indexOf(OPEN_TAG)
  if (open === -1) return null
  const start = open + OPEN_TAG.length
  const close = text.indexOf(CLOSE_TAG, start)
  if (close === -1) return null

  try {
    const payload: unknown = JSON.parse(text.slice(start, close))
    const record = asRecord(payload)
    if (record === null) return null
    const body = record['body']
    return typeof body === 'string' && body !== '' ? body : null
  } catch {
    return null
  }
}
