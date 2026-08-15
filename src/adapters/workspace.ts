/**
 * What the filesystem can say about a session's working directory.
 *
 * Read once per directory and cached for the process: a project root and a
 * README headline do not change on the timescale of a peer listing, and a
 * listing that stats the tree for every peer on every call is a listing nobody
 * will call.
 */

import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { WorkspaceFacts } from '../domain/derived-card.ts'

/** Documents that describe a directory, in the order they are believed. */
const HEADLINE_FILES = ['AGENTS.md', 'README.md'] as const

/** Markers that identify a project root, in the order they are believed. */
const ROOT_MARKERS = ['.git', 'package.json'] as const

/** How far up the tree a root is looked for. */
const MAX_ASCENT = 12

/** Bytes read from a description document; a headline is on the first line. */
const HEADLINE_BYTES = 4_096

/** Reads the workspace facts a derived capability card is built from. */
export class WorkspaceReader {
  readonly #cache = new Map<string, Omit<WorkspaceFacts, 'sessionId'>>()

  /**
   * Read what this directory says about itself.
   * @param cwd - the session's working directory.
   * @returns the root and headline, each absent when not found.
   */
  async read(cwd: string): Promise<Omit<WorkspaceFacts, 'sessionId'>> {
    const cached = this.#cache.get(cwd)
    if (cached !== undefined) return cached

    const [root, headline] = await Promise.all([this.#findRoot(cwd), this.#readHeadline(cwd)])
    const facts = {
      cwd,
      ...(root === undefined ? {} : { root }),
      ...(headline === undefined ? {} : { headline }),
    }
    this.#cache.set(cwd, facts)
    return facts
  }

  /** Walk up for the nearest project marker. @param from - starting directory. @returns the root, when found. */
  async #findRoot(from: string): Promise<string | undefined> {
    let directory = from
    for (let depth = 0; depth < MAX_ASCENT; depth += 1) {
      for (const marker of ROOT_MARKERS) {
        try {
          await stat(join(directory, marker))
          return directory
        } catch {
          // Not this level; keep climbing.
        }
      }
      const parent = dirname(directory)
      if (parent === directory) return undefined
      directory = parent
    }
    return undefined
  }

  /**
   * Read the first meaningful line of a directory's own description.
   * @param directory - the directory to describe.
   * @returns the headline, when one of the known documents has one.
   */
  async #readHeadline(directory: string): Promise<string | undefined> {
    for (const name of HEADLINE_FILES) {
      let text: string
      try {
        text = (await readFile(join(directory, name), 'utf8')).slice(0, HEADLINE_BYTES)
      } catch {
        continue
      }
      // The first non-blank, non-frontmatter line: a title if the document has
      // one, otherwise its opening sentence.
      const line = text
        .split('\n')
        .map((entry) => entry.trim())
        .find((entry) => entry.length > 0 && entry !== '---' && !entry.startsWith('<!--'))
      if (line !== undefined) return line
    }
    return undefined
  }
}
