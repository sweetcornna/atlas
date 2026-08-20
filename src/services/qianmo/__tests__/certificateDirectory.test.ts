// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * `CertificateDirectory` end to end: a real offline CA (P12.1), a real
 * `@qianmo/registry` HTTP server, real certificates, real revocation lists.
 *
 * Zero mocks — `refresh()` makes real `fetch()` calls against a real server
 * bound to `127.0.0.1:0` (port 0, so tests never collide), exactly the
 * discipline `ca.test.ts` and `packages/registry/test/http.test.ts` already
 * use. The four negative cases the DoD asks for each get their own
 * `describe` block so a reviewer can find them without reading the whole file.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  generateNodeKeyPair,
  signBytes,
  type NodeKeyPair,
} from '@qianmo/capability'
import {
  InMemoryRegistry,
  startRegistryServer,
  type RegistryServerHandle,
} from '@qianmo/registry'
import {
  initCa,
  issueCertificate,
  refreshRevocationList,
  type CaInitResult,
} from '../ca/operations.js'
import { opensslVersion, runOpenssl } from '../ca/openssl.js'
import { popMessage } from '../ca/pop.js'
import {
  CertificateDirectory,
  assertOwnCertificateMatchesIdentity,
} from '../certificateDirectory.js'

const OPENSSL = opensslVersion()
const itNeedsOpenssl = OPENSSL === null ? test.skip : test
if (OPENSSL === null) {
  console.error(
    '[certificate directory] skipping: no usable openssl on PATH — these ' +
      'tests need real certificates, the same requirement `ca.test.ts` has.',
  )
}

/** One issued node: its Ed25519 identity, its certificate, its fingerprint. */
interface IssuedNode {
  readonly node: string
  readonly keys: NodeKeyPair
  readonly certificatePem: string
  readonly fingerprint256: string
}

function issueNode(
  caDir: string,
  node: string,
  hosts: readonly string[],
  root: string,
): IssuedNode {
  const keys = generateNodeKeyPair()
  const tlsKeyPath = join(root, `${node}.tls.key`)
  writeFileSync(
    tlsKeyPath,
    runOpenssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout']),
    { mode: 0o600 },
  )
  const csrPem = runOpenssl([
    'req',
    '-new',
    '-key',
    tlsKeyPath,
    '-subj',
    `/CN=${node}`,
  ])
  const issued = issueCertificate({
    directory: caDir,
    node,
    publicKey: keys.publicKey,
    csrPem,
    popSignature: signBytes(keys, popMessage(node, csrPem)),
    hosts: [...hosts],
  })
  return {
    node,
    keys,
    certificatePem: issued.certificatePem,
    fingerprint256: issued.fingerprint256,
  }
}

let root: string
let caDir: string
let ca: CaInitResult
let server: RegistryServerHandle
let registry: InMemoryRegistry

beforeAll(() => {
  if (OPENSSL === null) return
  root = mkdtempSync(join(tmpdir(), 'qianmo-cert-directory-'))
  caDir = join(root, 'ca')
  ca = initCa({ directory: caDir })
})

afterAll(() => {
  if (OPENSSL === null) return
  rmSync(root, { recursive: true, force: true })
})

// A fresh registry (agents *and* revocation list) per test: `clear()` only
// resets the agent table, and a revocation list published by one test must
// not leak into the next one's "no RL has ever been published" assumption.
beforeEach(() => {
  if (OPENSSL === null) return
  registry = new InMemoryRegistry()
  server = startRegistryServer(0, { registry })
})

afterEach(async () => {
  if (OPENSSL !== null) await server.stop()
})

async function registerIssued(
  issued: IssuedNode,
  endpointHost: string,
): Promise<void> {
  const result = registry.register(
    `qianmo://${issued.node}/agent`,
    `wss://${endpointHost}/agent`,
    { publicKey: issued.keys.publicKey, certificate: issued.certificatePem },
  )
  if (!result.ok) throw new Error(`setup: ${result.code} ${result.message}`)
}

async function publishRl(options: {
  readonly revoke?: readonly { node: string; fingerprint256: string }[]
  readonly now: number
  readonly validMs: number
}): Promise<void> {
  const result = refreshRevocationList({
    directory: caDir,
    revoke: options.revoke ?? [],
    now: options.now,
    validMs: options.validMs,
  })
  const signed: unknown = JSON.parse(readFileSync(result.path, 'utf8'))
  const put = await fetch(`${server.url}/v0/revocation-list`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(signed),
  })
  if (put.status !== 200)
    throw new Error(`setup: publishing RL failed ${put.status}`)
}

describe('CertificateDirectory — happy path (§8.1)', () => {
  itNeedsOpenssl(
    'resolves a peer published with a valid, fresh certificate',
    async () => {
      const a = issueNode(caDir, 'node-a', ['node-a.example.com'], root)
      await registerIssued(a, 'node-a.example.com')
      await publishRl({ now: Date.now(), validMs: 30 * 24 * 60 * 60 * 1000 })

      const directory = new CertificateDirectory({
        caCertificatePem: readFileSync(join(caDir, 'ca.crt'), 'utf8'),
        registryUrl: server.url,
      })
      await directory.refresh()

      expect(directory.publicKeyOf('node-a')).toBe(a.keys.publicKey)
      expect(directory.publicKeyOf('node-nobody')).toBeNull()
      expect(directory.revocationListFresh).toBe(true)
    },
  )

  itNeedsOpenssl(
    'publicKeyOf never awaits — it only reads the last refresh',
    async () => {
      const a = issueNode(caDir, 'node-a', ['node-a.example.com'], root)
      await registerIssued(a, 'node-a.example.com')
      await publishRl({ now: Date.now(), validMs: 30 * 24 * 60 * 60 * 1000 })

      const directory = new CertificateDirectory({
        caCertificatePem: readFileSync(join(caDir, 'ca.crt'), 'utf8'),
        registryUrl: server.url,
      })
      // Before the first refresh: no network call has happened, yet the call
      // returns synchronously with the honest answer (nothing known yet).
      expect(directory.publicKeyOf('node-a')).toBeNull()
      await directory.refresh()
      expect(directory.publicKeyOf('node-a')).toBe(a.keys.publicKey)
    },
  )

  itNeedsOpenssl(
    'explicit --trust always overrides the CA-derived key, and is audited on conflict',
    async () => {
      const a = issueNode(caDir, 'node-a', ['node-a.example.com'], root)
      await registerIssued(a, 'node-a.example.com')
      await publishRl({ now: Date.now(), validMs: 30 * 24 * 60 * 60 * 1000 })

      const overridingKey = generateNodeKeyPair().publicKey
      const audits: { node: string; reason: string }[] = []
      const directory = new CertificateDirectory({
        caCertificatePem: readFileSync(join(caDir, 'ca.crt'), 'utf8'),
        registryUrl: server.url,
        trusted: [['node-a', overridingKey]],
        onAudit: event => audits.push(event),
      })
      await directory.refresh()

      expect(directory.publicKeyOf('node-a')).toBe(overridingKey)
      expect(audits).toHaveLength(1)
      expect(audits[0]?.node).toBe('node-a')
    },
  )

  itNeedsOpenssl(
    'put()/delete() work with no registry configured at all',
    async () => {
      const directory = new CertificateDirectory({
        caCertificatePem: readFileSync(join(caDir, 'ca.crt'), 'utf8'),
      })
      expect(directory.publicKeyOf('node-x')).toBeNull()
      directory.put('node-x', generateNodeKeyPair().publicKey)
      expect(directory.publicKeyOf('node-x')).not.toBeNull()
      directory.delete('node-x')
      expect(directory.publicKeyOf('node-x')).toBeNull()
      // No registryUrl → refresh() is a no-op, not an error.
      await directory.refresh()
    },
  )
})

describe('CertificateDirectory — fail-closed to --trust (§6.4)', () => {
  itNeedsOpenssl(
    'no RL has ever been published: CA-derived keys stay dark',
    async () => {
      const a = issueNode(caDir, 'node-a', ['node-a.example.com'], root)
      await registerIssued(a, 'node-a.example.com')
      // Deliberately no publishRl() call.

      const directory = new CertificateDirectory({
        caCertificatePem: readFileSync(join(caDir, 'ca.crt'), 'utf8'),
        registryUrl: server.url,
        trusted: [['node-fallback', generateNodeKeyPair().publicKey]],
      })
      await directory.refresh()

      expect(directory.revocationListFresh).toBe(false)
      expect(directory.publicKeyOf('node-a')).toBeNull()
      expect(directory.publicKeyOf('node-fallback')).not.toBeNull()
    },
  )

  itNeedsOpenssl(
    'a stale RL (past nextUpdate) degrades the same way, not to full-open or full-closed',
    async () => {
      const a = issueNode(caDir, 'node-a', ['node-a.example.com'], root)
      await registerIssued(a, 'node-a.example.com')
      const t0 = Date.now()
      await publishRl({ now: t0, validMs: 1_000 }) // nextUpdate = t0 + 1s

      const trustedKey = generateNodeKeyPair().publicKey
      const directory = new CertificateDirectory({
        caCertificatePem: readFileSync(join(caDir, 'ca.crt'), 'utf8'),
        registryUrl: server.url,
        trusted: [['node-fallback', trustedKey]],
        now: () => t0 + 2_000, // past nextUpdate
      })
      await directory.refresh()

      expect(directory.revocationListFresh).toBe(false)
      // Full-closed would also hide the explicit entry; it must not.
      expect(directory.publicKeyOf('node-fallback')).toBe(trustedKey)
      // Full-open would still resolve node-a from the (now-untrusted) cache.
      expect(directory.publicKeyOf('node-a')).toBeNull()
    },
  )

  itNeedsOpenssl(
    'recovers the moment a fresh RL is published again',
    async () => {
      const a = issueNode(caDir, 'node-a', ['node-a.example.com'], root)
      await registerIssued(a, 'node-a.example.com')

      const directory = new CertificateDirectory({
        caCertificatePem: readFileSync(join(caDir, 'ca.crt'), 'utf8'),
        registryUrl: server.url,
      })
      await directory.refresh()
      expect(directory.publicKeyOf('node-a')).toBeNull()

      await publishRl({ now: Date.now(), validMs: 30 * 24 * 60 * 60 * 1000 })
      await directory.refresh()
      expect(directory.publicKeyOf('node-a')).toBe(a.keys.publicKey)
    },
  )
})

describe('CertificateDirectory — four negative cases (DoD #5)', () => {
  itNeedsOpenssl(
    'a forged certificate (signed by a different CA) is rejected',
    async () => {
      const otherCaDir = join(root, 'other-ca')
      initCa({ directory: otherCaDir })
      const forged = issueNode(
        otherCaDir,
        'node-forger',
        ['node-forger.example.com'],
        root,
      )
      await registerIssued(forged, 'node-forger.example.com')
      const legit = issueNode(
        caDir,
        'node-legit',
        ['node-legit.example.com'],
        root,
      )
      await registerIssued(legit, 'node-legit.example.com')
      await publishRl({ now: Date.now(), validMs: 30 * 24 * 60 * 60 * 1000 })

      const directory = new CertificateDirectory({
        caCertificatePem: readFileSync(join(caDir, 'ca.crt'), 'utf8'),
        registryUrl: server.url,
      })
      await directory.refresh()

      expect(directory.publicKeyOf('node-forger')).toBeNull()
      expect(directory.publicKeyOf('node-legit')).toBe(legit.keys.publicKey)
    },
  )

  itNeedsOpenssl('an expired certificate is rejected', async () => {
    const t0 = Date.now()
    const a = issueNode(caDir, 'node-a', ['node-a.example.com'], root)
    await registerIssued(a, 'node-a.example.com')
    // RL stays fresh well past the certificate's 90-day life, so this is
    // unambiguously the expiry check firing, not fail-closed masking it.
    await publishRl({ now: t0, validMs: 200 * 24 * 60 * 60 * 1000 })

    const directory = new CertificateDirectory({
      caCertificatePem: readFileSync(join(caDir, 'ca.crt'), 'utf8'),
      registryUrl: server.url,
      now: () => t0 + 91 * 24 * 60 * 60 * 1000, // past the 90-day validTo
    })
    await directory.refresh()

    expect(directory.revocationListFresh).toBe(true)
    expect(directory.publicKeyOf('node-a')).toBeNull()
  })

  itNeedsOpenssl('a node on the revocation list is rejected', async () => {
    const a = issueNode(caDir, 'node-a', ['node-a.example.com'], root)
    const b = issueNode(caDir, 'node-b', ['node-b.example.com'], root)
    await registerIssued(a, 'node-a.example.com')
    await registerIssued(b, 'node-b.example.com')
    await publishRl({
      now: Date.now(),
      validMs: 30 * 24 * 60 * 60 * 1000,
      revoke: [{ node: 'node-a', fingerprint256: a.fingerprint256 }],
    })

    const directory = new CertificateDirectory({
      caCertificatePem: readFileSync(join(caDir, 'ca.crt'), 'utf8'),
      registryUrl: server.url,
    })
    await directory.refresh()

    expect(directory.publicKeyOf('node-a')).toBeNull()
    expect(directory.publicKeyOf('node-b')).toBe(b.keys.publicKey)
  })

  itNeedsOpenssl(
    "a node's own certificate not matching its own identity is rejected at startup (K-2)",
    () => {
      const a = issueNode(caDir, 'node-a', ['node-a.example.com'], root)
      const someoneElse = generateNodeKeyPair()

      expect(
        assertOwnCertificateMatchesIdentity(
          a.certificatePem,
          'node-a',
          a.keys.publicKey,
        ).node,
      ).toBe('node-a')

      expect(() =>
        assertOwnCertificateMatchesIdentity(
          a.certificatePem,
          'node-a',
          someoneElse.publicKey,
        ),
      ).toThrow(/nodekey does not match identity/)

      expect(() =>
        assertOwnCertificateMatchesIdentity(
          a.certificatePem,
          'node-b',
          a.keys.publicKey,
        ),
      ).toThrow(/names node node-a, but this node is node-b/)

      expect(() =>
        assertOwnCertificateMatchesIdentity(
          'not a certificate',
          'node-a',
          a.keys.publicKey,
        ),
      ).toThrow(/does not parse as a certificate/)
    },
  )
})
