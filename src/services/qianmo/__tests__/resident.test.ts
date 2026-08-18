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

    // 钉源码而不是钉行为：这条路径会真的 spawn 一个子进程，测行为要起进程。
    // 钉的是「取自 identity.ts 的常量」而不是字面量——身份名只许在那一处拼写。
    expect(source).toContain('[IDENTITY_ENV_VAR]: NODE_IDENTITY_MODE')
    expect(source).toContain("from '../../constants/identity.js'")
    expect(source).not.toMatch(/DAEMON_TOKEN|destroySandbox|execCommand/)
  })
})
