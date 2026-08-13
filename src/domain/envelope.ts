/**
 * The wire value one session sends to another.
 *
 * Pure: construction takes its id and timestamp as inputs rather than reading a
 * clock or a random source, so a test pins an exact envelope and the transport
 * layer owns non-determinism.
 */

import { PeerError } from './errors.ts'

/** Wire format version. Bumped only for a breaking envelope change. */
export const PROTOCOL_VERSION = 1

/** Largest accepted body, in UTF-16 code units. */
export const MAX_BODY_CHARS = 8_192

/**
 * How the receiving agent should take delivery.
 *
 * The three values are the agent inbox boundaries the harness already exposes;
 * the sender chooses urgency rather than the receiver guessing it.
 */
export type DeliveryMode =
  /** Nearest step boundary — interrupts work in progress. `Agent.steer()`. */
  | 'steer'
  /** Its own later turn — the ordinary handoff. `Agent.followup()`. */
  | 'followup'
  /** Model-facing context with no wake. `Agent.inject()`. */
  | 'context'

/** Every {@link DeliveryMode}, in ascending order of intrusiveness. */
export const DELIVERY_MODES: readonly DeliveryMode[] = ['context', 'followup', 'steer']

/** Who sent an envelope, as the receiver should see them. */
export interface PeerIdentity {
  /** The sender's session id — the authoritative identity. */
  readonly sessionId: string
  /** The sender's display name at send time. Presentation only. */
  readonly name: string
  /** The sender's working directory, when it has one. */
  readonly cwd?: string
}

/** One message addressed from one session to another. */
export interface Envelope {
  readonly protocol: typeof PROTOCOL_VERSION
  /** Unique message identity, used for reply correlation and de-duplication. */
  readonly id: string
  /** Unix epoch milliseconds at which the sender created this envelope. */
  readonly sentAt: number
  readonly from: PeerIdentity
  /** The recipient's session id. Names are resolved before the envelope exists. */
  readonly to: string
  readonly mode: DeliveryMode
  /** The message text. Never conversation history, never files. */
  readonly body: string
  /** The {@link Envelope.id} this message answers, when it answers one. */
  readonly replyTo?: string
}

/** Inputs for {@link createEnvelope}; identity and time are supplied, not read. */
export interface EnvelopeDraft {
  readonly id: string
  readonly sentAt: number
  readonly from: PeerIdentity
  readonly to: string
  readonly mode: DeliveryMode
  readonly body: string
  readonly replyTo?: string
}

/**
 * Validate a draft and freeze it into an {@link Envelope}.
 * @param draft - complete message facts, including caller-supplied identity and time.
 * @returns the frozen envelope.
 * @throws {PeerError} `invalid-body` when the body is blank or over {@link MAX_BODY_CHARS}.
 * @throws {PeerError} `peer-self` when the sender addressed itself.
 */
export function createEnvelope(draft: EnvelopeDraft): Envelope {
  const body = draft.body.trim()
  if (body.length === 0) {
    throw new PeerError('invalid-body', 'Message body is empty.')
  }
  if (body.length > MAX_BODY_CHARS) {
    throw new PeerError(
      'invalid-body',
      `Message body is ${body.length} characters; the limit is ${MAX_BODY_CHARS}. Send a summary instead.`,
    )
  }
  if (draft.to === draft.from.sessionId) {
    throw new PeerError('peer-self', 'A session cannot message itself.')
  }

  return Object.freeze({
    protocol: PROTOCOL_VERSION,
    id: draft.id,
    sentAt: draft.sentAt,
    from: Object.freeze({ ...draft.from }),
    to: draft.to,
    mode: draft.mode,
    body,
    ...(draft.replyTo === undefined ? {} : { replyTo: draft.replyTo }),
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new PeerError('invalid-envelope', `Envelope field "${key}" must be a non-empty string.`)
  }
  return value
}

function readOptionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new PeerError('invalid-envelope', `Envelope field "${key}" must be a non-empty string when present.`)
  }
  return value
}

function isDeliveryMode(value: unknown): value is DeliveryMode {
  return typeof value === 'string' && (DELIVERY_MODES as readonly string[]).includes(value)
}

/**
 * Parse an untrusted wire value into an {@link Envelope}.
 *
 * Everything crossing the socket is hostile until proven otherwise: an
 * unrecognized protocol version, a missing field, or a wrong type is rejected
 * here rather than reaching an agent inbox.
 * @param value - a parsed JSON value received from the transport.
 * @returns the validated, frozen envelope.
 * @throws {PeerError} `invalid-envelope` when the value is not a supported envelope.
 */
export function parseEnvelope(value: unknown): Envelope {
  if (!isRecord(value)) {
    throw new PeerError('invalid-envelope', 'Envelope must be a JSON object.')
  }
  if (value['protocol'] !== PROTOCOL_VERSION) {
    throw new PeerError(
      'invalid-envelope',
      `Unsupported envelope protocol ${String(value['protocol'])}; this peer speaks ${PROTOCOL_VERSION}.`,
    )
  }
  const sentAt = value['sentAt']
  if (typeof sentAt !== 'number' || !Number.isSafeInteger(sentAt) || sentAt < 0) {
    throw new PeerError('invalid-envelope', 'Envelope field "sentAt" must be a non-negative safe integer.')
  }
  const mode = value['mode']
  if (!isDeliveryMode(mode)) {
    throw new PeerError('invalid-envelope', `Envelope field "mode" must be one of ${DELIVERY_MODES.join(', ')}.`)
  }
  const from = value['from']
  if (!isRecord(from)) {
    throw new PeerError('invalid-envelope', 'Envelope field "from" must be an object.')
  }
  const fromCwd = readOptionalString(from, 'cwd')

  // Reuse createEnvelope so wire input and local input meet the same bounds.
  return createEnvelope({
    id: readString(value, 'id'),
    sentAt,
    from: {
      sessionId: readString(from, 'sessionId'),
      name: readString(from, 'name'),
      ...(fromCwd === undefined ? {} : { cwd: fromCwd }),
    },
    to: readString(value, 'to'),
    mode,
    body: readString(value, 'body'),
    ...(readOptionalString(value, 'replyTo') === undefined
      ? {}
      : { replyTo: readOptionalString(value, 'replyTo') as string }),
  })
}
