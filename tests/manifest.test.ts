import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { Config } from '../src/config.ts'
import { SKILL_NAME } from '../src/skill.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

interface Manifest {
  readonly name: string
  readonly summary: string
  readonly tools: readonly { readonly name: string }[]
  readonly skills: readonly { readonly name: string }[]
  readonly capabilities: readonly { readonly key: string }[]
  readonly config: Readonly<Record<string, unknown>>
  readonly commands: readonly { readonly name: string }[]
}

const manifest = JSON.parse(await readFile(join(root, 'dsh-plugin.json'), 'utf8')) as Manifest
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
  name: string
  description: string
  bin: Record<string, string>
}

/** Every tool name the source actually registers. */
async function registeredToolNames(): Promise<string[]> {
  const dir = join(root, 'src', 'tools')
  const names: string[] = []
  for (const file of await readdir(dir)) {
    if (!file.endsWith('.ts')) continue
    const source = await readFile(join(dir, file), 'utf8')
    for (const match of source.matchAll(/^\s*name: '(peer_[a-z_]+)',$/gm)) {
      names.push(match[1] as string)
    }
  }
  return names.sort()
}

describe('dsh-plugin.json', () => {
  it('lists exactly the tools the source registers', async () => {
    // A catalog entry is written once and read by six registries; the failure
    // mode is a tool added or renamed here and nowhere else.
    const declared = manifest.tools.map((tool) => tool.name).sort()
    expect(declared).toEqual(await registeredToolNames())
  })

  it('names the skill the plugin contributes', () => {
    expect(manifest.skills.map((skill) => skill.name)).toEqual([SKILL_NAME])
  })

  it('declares every capability flag the config accepts', () => {
    const defaults = Config(undefined as never) as { capabilities: Record<string, boolean> }
    expect(manifest.capabilities.map((entry) => entry.key).sort()).toEqual(
      Object.keys(defaults.capabilities).sort(),
    )
  })

  it('describes only config keys that exist', () => {
    // Against the schema, not a parsed value: an optional key with no default
    // is absent from the value and still perfectly real.
    const known = new Set(Object.keys((Config as unknown as { dict: Record<string, unknown> }).dict))
    for (const key of Object.keys(manifest.config)) {
      expect(known.has(key), `manifest documents unknown config key "${key}"`).toBe(true)
    }
  })

  it('agrees with package.json on identity and commands', () => {
    expect(manifest.name).toBe(packageJson.name)
    expect(manifest.summary).toBe(packageJson.description)
    expect(Object.keys(packageJson.bin)).toEqual([packageJson.name])
    expect(manifest.commands.map((command) => command.name).sort()).toEqual(['doctor', 'report'])
  })
})
