/**
 * Newline-delimited JSON framing for the inbox socket.
 *
 * A stream socket delivers bytes, not messages, so the decoder buffers partial
 * input and yields whole frames. The buffer is bounded: a peer that never sends
 * a newline must not be able to grow this process's memory without limit.
 */

import { PeerError } from '../../domain/errors.ts'

/** Largest accepted frame, in bytes. Comfortably above the body bound. */
export const MAX_FRAME_BYTES = 64 * 1024

/**
 * Encode one value as a wire frame.
 * @param value - a JSON-serializable payload.
 * @returns the frame, newline-terminated.
 */
export function encodeFrame(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

/** Accumulates socket chunks and yields complete JSON frames. */
export class FrameDecoder {
  #buffer = ''
  readonly #maxBytes: number

  constructor(maxBytes: number = MAX_FRAME_BYTES) {
    this.#maxBytes = maxBytes
  }

  /**
   * Add one chunk and take every frame it completed.
   * @param chunk - decoded text from the socket.
   * @returns the parsed values for each frame completed by this chunk.
   * @throws {PeerError} `invalid-envelope` when a frame is oversized or not JSON.
   */
  push(chunk: string): unknown[] {
    this.#buffer += chunk

    if (this.#buffer.length > this.#maxBytes) {
      // Drop the buffer before throwing so a caller that keeps the decoder
      // alive does not retain the oversized text.
      this.#buffer = ''
      throw new PeerError('invalid-envelope', `Frame exceeded ${this.#maxBytes} bytes.`)
    }

    const frames: unknown[] = []
    let newline = this.#buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline).trim()
      this.#buffer = this.#buffer.slice(newline + 1)
      if (line) frames.push(parseFrame(line))
      newline = this.#buffer.indexOf('\n')
    }
    return frames
  }
}

function parseFrame(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    throw new PeerError('invalid-envelope', 'Frame was not valid JSON.')
  }
}
