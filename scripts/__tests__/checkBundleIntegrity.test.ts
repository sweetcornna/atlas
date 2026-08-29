import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scriptPath = join(import.meta.dir, '..', 'check-bundle-integrity.ts')
let root: string | null = null

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = null
})

async function createDist(files: Record<string, string>): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'occ-bundle-integrity-'))
  for (const [path, content] of Object.entries(files)) {
    const filePath = join(root, path)
    await mkdir(join(filePath, '..'), { recursive: true })
    await writeFile(filePath, content)
  }
  return root
}

function runCheck(distDir: string) {
  return spawnSync('bun', [scriptPath, distDir], {
    encoding: 'utf8',
  })
}

// `ws` must stay external, so every fixture that is supposed to *pass* has to
// carry the bare import a real bundle carries — see the `ws` block in
// check-bundle-integrity.ts for why the check exists.
const WS_BARE_IMPORT = 'import WebSocket from "ws"\n'

describe('check-bundle-integrity nested chunks', () => {
  test('accepts valid imports between nested Vite chunks', async () => {
    const distDir = await createDist({
      'cli.js': 'import "./chunks/entry.js"\n',
      'chunks/entry.js': 'import "./shared.js"\n',
      'chunks/shared.js': `export const value = 1\n${WS_BARE_IMPORT}`,
    })

    const result = runCheck(distDir)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('找到 3 个 JS 文件')
  })

  test('rejects a missing import from a nested chunk', async () => {
    const distDir = await createDist({
      'cli.js': 'import "./chunks/entry.js"\n',
      'chunks/entry.js': 'import "./missing.js"\n',
    })

    const result = runCheck(distDir)

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('chunks/entry.js:1 → ./missing.js')
  })

  test('scans nested chunks for unresolved runtime dependencies', async () => {
    const distDir = await createDist({
      'cli.js': 'import "./chunks/entry.js"\n',
      'chunks/entry.js': '__require("missing-production-package")\n',
    })

    const result = runCheck(distDir)

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('missing-production-package')
    expect(result.stdout).toContain('chunks/entry.js:1')
  })
})

describe('check-bundle-integrity ws externalisation', () => {
  // npm 的纯 JS ws 混进产物 = 这份产物在 Bun 下每次握手都失败。样本用
  // ws 自己的错误码表，和真产物里出现的是同一批串。
  const INLINED_WS =
    'const codes={WS_ERR_UNEXPECTED_RSV_1:1002,WS_ERR_INVALID_OPCODE:1002,' +
    'WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH:1009};' +
    'throw new Error("Invalid Sec-WebSocket-Accept header")\n'

  test('rejects a bundle that inlined the npm ws package', async () => {
    const distDir = await createDist({
      'cli.js': 'import "./chunks/entry.js"\n',
      'chunks/entry.js': INLINED_WS,
    })

    const result = runCheck(distDir)

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('npm 的纯 JS `ws` 包被内联进了产物')
    expect(result.stdout).toContain('chunks/entry.js')
  })

  test('rejects a bundle where the bare ws import disappeared', async () => {
    const distDir = await createDist({
      'cli.js': 'import "./chunks/entry.js"\n',
      'chunks/entry.js': 'export const value = 1\n',
    })

    const result = runCheck(distDir)

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('产物里找不到裸 `import ... from "ws"`')
  })

  // 那个 GUID 是 WebSocket 协议本身的 magic string —— undici 内置的
  // WebSocket 实现同样带着它。拿它当判据会在 undici 合法入包时误杀，
  // 所以判据只认 ws 自己的错误码表。
  test('does not fire on another WebSocket implementation', async () => {
    const distDir = await createDist({
      'cli.js': 'import "./chunks/entry.js"\n',
      'chunks/entry.js':
        'const uid="258EAFA5-E914-47DA-95CA-C5AB0DC85B11";' +
        'function createFastMessageEvent(){}' +
        'const sentCloseFrameState=0;' +
        'const h="Sec-WebSocket-Extensions";' +
        `export{uid,h,createFastMessageEvent,sentCloseFrameState}\n${WS_BARE_IMPORT}`,
    })

    const result = runCheck(distDir)

    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain('被内联进了产物')
  })
})
