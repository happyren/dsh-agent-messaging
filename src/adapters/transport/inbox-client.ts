/**
 * Dials another host's inbox socket and waits for its receipt.
 *
 * Every call is a fresh short-lived connection. Pooling would trade a real
 * complexity cost — liveness, reconnection, back-pressure — for a saving that
 * does not matter at the rate agents message each other.
 */

import { connect, type Socket } from 'node:net'

import { PeerError } from '../../domain/errors.ts'
import type { DeliveryReceipt, DeliveryStatus } from '../../ports/index.ts'
import { encodeFrame, FrameDecoder } from './framing.ts'

const DELIVERY_STATUSES: readonly DeliveryStatus[] = [
  'delivered',
  'held',
  'refused',
  'dropped',
  'spooled',
]

/** Sends one envelope to a host inbox and reads the receipt it returns. */
export class InboxClient {
  readonly #timeoutMs: number

  constructor(options: { timeoutMs: number }) {
    this.#timeoutMs = options.timeoutMs
  }

  /**
   * Deliver one payload and resolve with the receiving host's receipt.
   * @param socketPath - the target host's inbox socket.
   * @param payload - the envelope to send.
   * @param signal - optional caller cancellation.
   * @returns the receipt reported by the receiving host.
   * @throws {PeerError} `transport-failed` on connection failure, timeout, or cancellation.
   */
  async send(socketPath: string, payload: unknown, signal?: AbortSignal): Promise<DeliveryReceipt> {
    return new Promise<DeliveryReceipt>((resolve, reject) => {
      const socket = connect(socketPath)
      const decoder = new FrameDecoder()
      let settled = false

      const finish = (outcome: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        socket.destroy()
        outcome()
      }

      const failWith = (message: string): void => {
        finish(() => reject(new PeerError('transport-failed', message)))
      }

      const timer = setTimeout(() => {
        failWith(`Peer host did not answer within ${this.#timeoutMs}ms.`)
      }, this.#timeoutMs)
      // A pending delivery must not keep the host process alive at shutdown.
      timer.unref?.()

      const onAbort = (): void => failWith('Delivery was cancelled.')
      signal?.addEventListener('abort', onAbort, { once: true })

      socket.setEncoding('utf8')
      socket.on('connect', () => socket.write(encodeFrame(payload)))
      socket.on('data', (chunk: string) => {
        let frames: unknown[]
        try {
          frames = decoder.push(chunk)
        } catch {
          failWith('Peer host returned a malformed receipt.')
          return
        }
        const [first] = frames
        if (first === undefined) return
        const receipt = toReceipt(first)
        if (receipt) finish(() => resolve(receipt))
        else failWith('Peer host returned an unrecognized receipt.')
      })
      socket.on('error', (error) => failWith(`Peer host unreachable: ${error.message}`))
      socket.on('close', () => failWith('Peer host closed the connection without a receipt.'))
    })
  }

  /**
   * Whether something is currently listening on a socket path.
   *
   * Used to tell a crashed host's leftover socket file from a live one.
   * @param socketPath - the path to probe.
   * @returns whether a listener accepted the connection.
   */
  static isListening(socketPath: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const socket: Socket = connect(socketPath, () => done(true))
      const done = (answer: boolean): void => {
        socket.destroy()
        resolve(answer)
      }
      socket.on('error', () => done(false))
      // Treat an unresponsive path as dead rather than hanging startup on it.
      socket.setTimeout(250, () => done(false))
    })
  }
}

function toReceipt(value: unknown): DeliveryReceipt | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const status = record['status']
  if (typeof status !== 'string' || !(DELIVERY_STATUSES as readonly string[]).includes(status)) {
    return undefined
  }
  const detail = record['detail']
  return {
    status: status as DeliveryStatus,
    ...(typeof detail === 'string' ? { detail } : {}),
  }
}
