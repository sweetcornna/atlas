import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMcpConfigWatcher } from '../configWatcher.js'

const stops: Array<() => void> = []
const dirs: string[] = []

afterEach(async () => {
  while (stops.length) stops.pop()!()
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
})

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-watch-'))
  dirs.push(dir)
  return dir
}

/** The negative assertion must observe two stat ticks plus the debounce. */
function settleForNoChange(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 2600))
}

function changeSignal(): {
  readonly fired: () => void
  readonly observed: Promise<void>
} {
  let fired: () => void = () => {}
  const observed = new Promise<void>(resolve => {
    fired = resolve
  })
  return { fired, observed }
}

describe('startMcpConfigWatcher', () => {
  test('fires when a watched file is modified', async () => {
    const dir = await makeDir()
    const file = join(dir, '.mcp.json')
    await writeFile(file, '{"mcpServers":{}}')

    const changed = changeSignal()
    stops.push(startMcpConfigWatcher([file], changed.fired))

    await writeFile(file, '{"mcpServers":{"a":{"command":"x"}}}')
    await changed.observed
  })

  test('fires when a watched file is deleted — the case that leaked processes', async () => {
    const dir = await makeDir()
    const file = join(dir, '.mcp.json')
    await writeFile(file, '{"mcpServers":{"a":{"command":"x"}}}')

    const changed = changeSignal()
    stops.push(startMcpConfigWatcher([file], changed.fired))

    await unlink(file)
    await changed.observed
  })

  test('fires when a watched file appears for the first time', async () => {
    // Watching a not-yet-existing path is why this uses watchFile rather than
    // a directory watcher: `.mcp.json` usually does not exist at startup.
    const dir = await makeDir()
    const file = join(dir, '.mcp.json')

    const changed = changeSignal()
    stops.push(startMcpConfigWatcher([file], changed.fired))

    await writeFile(file, '{"mcpServers":{}}')
    await changed.observed
  })

  test('stop() silences the watcher', async () => {
    const dir = await makeDir()
    const file = join(dir, '.mcp.json')
    await writeFile(file, '{}')

    let fired = 0
    const stop = startMcpConfigWatcher([file], () => void fired++)
    stop()
    stop() // idempotent

    await writeFile(file, '{"mcpServers":{"a":{"command":"x"}}}')
    await settleForNoChange()

    expect(fired).toBe(0)
  })
})
