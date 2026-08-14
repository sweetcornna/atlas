import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('Qianmo resident host boundary', () => {
  test('derives every persistent path through occConfigPath', () => {
    const source = readFileSync(
      join(import.meta.dir, '..', 'resident.ts'),
      'utf8',
    )

    expect(source).toContain("occConfigPath('resident', 'sessions.json')")
    expect(source).toContain(
      "occConfigPath('resident', agent, 'admission.ndjson')",
    )
    expect(source).not.toMatch(/homedir\(|\.qianmo['"`]/)
  })

  test('spawns ACP with the Qianmo identity and no daemon credential surface', () => {
    const source = readFileSync(
      join(import.meta.dir, '..', 'resident.ts'),
      'utf8',
    )

    expect(source).toContain("OCC_IDENTITY: 'qianmo'")
    expect(source).not.toMatch(/DAEMON_TOKEN|destroySandbox|execCommand/)
  })
})
