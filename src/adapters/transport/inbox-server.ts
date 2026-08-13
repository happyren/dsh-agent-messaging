/**
 * The host's inbox socket: where other `dsh` processes deliver envelopes.
 *
 * One socket per host process rather than per session — a host holds many
 * agents, and a single accept loop keeps the file-descriptor cost flat as
 * sessions come and go.
 */

import { createServer, type Server, type Socket } from 'node:net'
import { chmod, mkdir, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

import { parseEnvelope } from '../../domain/envelope.ts'
import { isPeerError } from '../../domain/errors.ts'
import type { DeliveryReceipt, Logger } from '../../ports/index.ts'
import { encodeFrame, FrameDecoder } from './framing.ts'
import { InboxClient } from './inbox-client.ts'

/** Handles one admitted envelope and reports what happened to it. */
export type EnvelopeHandler = (envelope: unknown) => DeliveryReceipt | Promise<DeliveryReceipt>

/** Accepts envelopes from other host processes on a Unix domain socket. */
export class InboxServer {
  readonly #socketPath: string
  readonly #handle: EnvelopeHandler
  readonly #logger: Logger
  readonly #open = new Set<Socket>()
  #server: Server | undefined

  constructor(options: { socketPath: string; handle: EnvelopeHandler; logger: Logger }) {
    this.#socketPath = options.socketPath
    this.#handle = options.handle
    this.#logger = options.logger
  }

  /**
   * Bind the socket, replacing a dead one left by a crashed process.
   * @throws when the path is held by a live listener.
   */
  async listen(): Promise<void> {
    await mkdir(dirname(this.#socketPath), { recursive: true })
    await this.#clearStaleSocket()

    const server = createServer((socket) => this.#accept(socket))
    this.#server = server

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.#socketPath)
    })

    // Owner-only: on a shared machine another user must not reach this inbox.
    await chmod(this.#socketPath, 0o600)
    // The socket must never hold the process open on its own.
    server.unref()
  }

  /** Close the listener, drop open connections, and remove the socket file. */
  async close(): Promise<void> {
    for (const socket of this.#open) socket.destroy()
    this.#open.clear()

    const server = this.#server
    this.#server = undefined
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    }
    await rm(this.#socketPath, { force: true })
  }

  #accept(socket: Socket): void {
    this.#open.add(socket)
    socket.setEncoding('utf8')
    const decoder = new FrameDecoder()

    const fail = (detail: string): void => {
      socket.end(encodeFrame({ status: 'refused', detail } satisfies DeliveryReceipt))
    }

    socket.on('data', (chunk: string) => {
      let frames: unknown[]
      try {
        frames = decoder.push(chunk)
      } catch (error) {
        fail(isPeerError(error) ? error.message : 'Malformed frame.')
        return
      }

      for (const frame of frames) {
        void this.#dispatch(socket, frame)
      }
    })

    socket.on('error', (error) => {
      // A peer that vanishes mid-write is ordinary, not an error worth raising.
      this.#logger.warn(`inbox connection error: ${error.message}`)
    })
    socket.on('close', () => {
      this.#open.delete(socket)
    })
  }

  async #dispatch(socket: Socket, frame: unknown): Promise<void> {
    let receipt: DeliveryReceipt
    try {
      // Validate before the handler so a malformed payload never reaches policy.
      parseEnvelope(frame)
      receipt = await this.#handle(frame)
    } catch (error) {
      receipt = {
        status: 'refused',
        detail: isPeerError(error) ? error.message : 'Delivery failed on the receiving host.',
      }
    }
    if (!socket.destroyed) socket.write(encodeFrame(receipt))
  }

  /**
   * Remove a socket file whose listener is gone.
   *
   * A crashed host leaves the path behind; binding would fail with EADDRINUSE
   * even though nothing is listening. A path that still answers is left alone
   * so two live hosts never fight over one inbox.
   */
  async #clearStaleSocket(): Promise<void> {
    try {
      await stat(this.#socketPath)
    } catch {
      return
    }
    if (await InboxClient.isListening(this.#socketPath)) {
      throw new Error(`Inbox socket ${this.#socketPath} is already in use by a live host.`)
    }
    await rm(this.#socketPath, { force: true })
  }
}
