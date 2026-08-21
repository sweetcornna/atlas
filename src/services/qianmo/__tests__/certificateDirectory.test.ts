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
  TransportClient,
  startTransportServer,
  type TransportServerHandle,
} from '@qianmo/transport'
import {
  initCa,
  issueCertificate,
  refreshRevocationList,
  type CaInitResult,
} from '../ca/operations.js'
import { caKeyPairFromPem } from '../ca/caKeys.js'
import { opensslVersion, runOpenssl } from '../ca/openssl.js'
import { popMessage } from '../ca/pop.js'
import { signRevocationList } from '../ca/revocationList.js'
import {
  CERTIFICATE_CREDENTIAL_SOURCE,
  EXPLICIT_CREDENTIAL_SOURCE,
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
  keys: NodeKeyPair = generateNodeKeyPair(),
): IssuedNode {
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

async function publishExactRl(options: {
  readonly issuedAt: number
  readonly revoked?: readonly { node: string; fingerprint256: string }[]
}): Promise<void> {
  const caKeys = caKeyPairFromPem(readFileSync(join(caDir, 'ca.key'), 'utf8'))
  const signed = signRevocationList(caKeys, {
    version: 1,
    issuedAt: options.issuedAt,
    nextUpdate: options.issuedAt + 30 * 24 * 60 * 60 * 1000,
    revoked: (options.revoked ?? []).map(entry => ({
      ...entry,
      reason: 'review fixture',
      at: options.issuedAt,
    })),
  })
  const put = await fetch(`${server.url}/v0/revocation-list`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(signed),
  })
  if (put.status !== 200)
    throw new Error(`setup: publishing exact RL failed ${put.status}`)
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

describe('CertificateDirectory — cached certificates are revalidated', () => {
  itNeedsOpenssl(
    'a fresh RL revokes a cached peer even when the agents endpoint is down',
    async () => {
      const a = issueNode(caDir, 'node-a', ['node-a.example.com'], root)
      await registerIssued(a, 'node-a.example.com')
      await publishRl({ now: Date.now(), validMs: 30 * 24 * 60 * 60 * 1000 })

      let agentsAvailable = true
      const directory = new CertificateDirectory({
        caCertificatePem: readFileSync(join(caDir, 'ca.crt'), 'utf8'),
        registryUrl: server.url,
        fetch: async (input, init) =>
          new URL(input).pathname === '/v0/agents' && !agentsAvailable
            ? new Response(null, { status: 503 })
            : await fetch(input, init),
      })
      await directory.refresh()
      expect(directory.publicKeyOf(a.node)).toBe(a.keys.publicKey)

      await publishRl({
        now: Date.now(),
        validMs: 30 * 24 * 60 * 60 * 1000,
        revoke: [{ node: a.node, fingerprint256: a.fingerprint256 }],
      })
      agentsAvailable = false
      const refreshed = await directory.refresh()

      expect(directory.publicKeyOf(a.node)).toBeNull()
      expect(refreshed.directoryRemoved).toEqual([a.node])
      expect(refreshed.permanentlyInvalidated).toEqual([a.node])
    },
  )

  itNeedsOpenssl(
    'an expired cached certificate is dropped even when the agents endpoint is down',
    async () => {
      const a = issueNode(caDir, 'node-a', ['node-a.example.com'], root)
      await registerIssued(a, 'node-a.example.com')
      // OpenSSL serializes validity timestamps to seconds. Establish this
      // deterministic clock after issuance so a test that happens to start in
      // the last millisecond of a second cannot ask for a certificate before
      // its own `notBefore`.
      const t0 = Date.now()
      await publishRl({ now: t0, validMs: 200 * 24 * 60 * 60 * 1000 })

      let now = t0
      let agentsAvailable = true
      const directory = new CertificateDirectory({
        caCertificatePem: readFileSync(join(caDir, 'ca.crt'), 'utf8'),
        registryUrl: server.url,
        now: () => now,
        fetch: async (input, init) =>
          new URL(input).pathname === '/v0/agents' && !agentsAvailable
            ? new Response(null, { status: 503 })
            : await fetch(input, init),
      })
      await directory.refresh()
      expect(directory.publicKeyOf(a.node)).toBe(a.keys.publicKey)

      now = t0 + 91 * 24 * 60 * 60 * 1000
      agentsAvailable = false
      const refreshed = await directory.refresh()

      expect(directory.revocationListFresh).toBe(true)
      expect(directory.publicKeyOf(a.node)).toBeNull()
      expect(refreshed.directoryRemoved).toEqual([a.node])
      expect(refreshed.permanentlyInvalidated).toEqual([a.node])
    },
  )
})

describe('CertificateDirectory — directory churn is not revocation', () => {
  itNeedsOpenssl(
    'an empty agents response removes discovery only and recovers on the next snapshot',
    async () => {
      const a = issueNode(caDir, 'node-a', ['node-a.example.com'], root)
      await registerIssued(a, 'node-a.example.com')
      await publishRl({ now: Date.now(), validMs: 30 * 24 * 60 * 60 * 1000 })

      const directory = new CertificateDirectory({
        caCertificatePem: readFileSync(join(caDir, 'ca.crt'), 'utf8'),
        registryUrl: server.url,
      })
      await directory.refresh()
      expect(directory.publicKeyOf(a.node)).toBe(a.keys.publicKey)

      registry.clear()
      const absent = await directory.refresh()
      expect(directory.publicKeyOf(a.node)).toBeNull()
      expect(absent.directoryRemoved).toEqual([a.node])
      expect(absent.permanentlyInvalidated).toEqual([])

      await registerIssued(a, 'node-a.example.com')
      const restored = await directory.refresh()
      expect(directory.publicKeyOf(a.node)).toBe(a.keys.publicKey)
      expect(restored.directoryRemoved).toEqual([])
      expect(restored.permanentlyInvalidated).toEqual([])
    },
  )
})

describe('CertificateDirectory — refresh observers are contained', () => {
  itNeedsOpenssl(
    'retries a permanent close after a throwing sink without unhandled rejections',
    async () => {
      const a = issueNode(caDir, 'node-a', ['node-a.example.com'], root)
      await registerIssued(a, 'node-a.example.com')
      await publishRl({ now: Date.now(), validMs: 30 * 24 * 60 * 60 * 1000 })

      const errors: string[] = []
      const seenPermanent: string[][] = []
      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown) => unhandled.push(reason)
      process.on('unhandledRejection', onUnhandled)
      try {
        const directory = new CertificateDirectory({
          caCertificatePem: readFileSync(join(caDir, 'ca.crt'), 'utf8'),
          registryUrl: server.url,
          onError: event => errors.push(event.phase),
        })
        await directory.refresh()

        directory.setRefreshSink(result => {
          if (result.permanentlyInvalidated.length === 0) return
          seenPermanent.push([...result.permanentlyInvalidated])
          throw new Error('observer is temporarily unavailable')
        })

        await publishRl({
          now: Date.now(),
          validMs: 30 * 24 * 60 * 60 * 1000,
          revoke: [{ node: a.node, fingerprint256: a.fingerprint256 }],
        })
        const first = await directory.refresh()
        expect(first.permanentlyInvalidated).toEqual([a.node])
        expect(directory.publicKeyOf(a.node)).toBeNull()

        directory.startPolling(5)
        await Bun.sleep(80)
        directory.stopPolling()
        await Bun.sleep(10)

        expect(
          errors.filter(phase => phase === 'refresh_sink').length,
        ).toBeGreaterThan(2)
        expect(seenPermanent.length).toBeGreaterThan(2)
        expect(seenPermanent.every(nodes => nodes[0] === a.node)).toBe(true)
        expect(unhandled).toEqual([])
        expect(directory.publicKeyOf(a.node)).toBeNull()

        const delivered: string[][] = []
        directory.setRefreshSink(result => {
          delivered.push([...result.permanentlyInvalidated])
        })
        await directory.refresh()
        expect(delivered).toEqual([[a.node]])
        expect((await directory.refresh()).permanentlyInvalidated).toEqual([])
      } finally {
        process.off('unhandledRejection', onUnhandled)
      }
    },
  )

  itNeedsOpenssl(
    'delivers a second permanent invalidation when one node receives a new certificate',
    async () => {
      const first = issueNode(caDir, 'node-a', ['node-a.example.com'], root)
      await registerIssued(first, 'node-a.example.com')
      await publishRl({ now: Date.now(), validMs: 30 * 24 * 60 * 60 * 1000 })

      const deliveries: string[][] = []
      const directory = new CertificateDirectory({
        caCertificatePem: readFileSync(join(caDir, 'ca.crt'), 'utf8'),
        registryUrl: server.url,
      })
      directory.setRefreshSink(result => {
        if (result.permanentlyInvalidated.length > 0) {
          deliveries.push([...result.permanentlyInvalidated])
        }
      })
      await directory.refresh()

      await publishRl({
        now: Date.now(),
        validMs: 30 * 24 * 60 * 60 * 1000,
        revoke: [{ node: first.node, fingerprint256: first.fingerprint256 }],
      })
      expect((await directory.refresh()).permanentlyInvalidated).toEqual([
        first.node,
      ])

      // A renewed certificate is new revocation evidence even when the node
      // segment stays stable. Replacing a node-level delivered marker would
      // make the next line silently fail open for existing connections.
      const replacement = issueNode(
        caDir,
        'node-a',
        ['node-a.example.com'],
        root,
      )
      registry.clear()
      await registerIssued(replacement, 'node-a.example.com')
      await directory.refresh()
      expect(directory.publicKeyOf(replacement.node)).toBe(
        replacement.keys.publicKey,
      )

      await publishRl({
        now: Date.now(),
        validMs: 30 * 24 * 60 * 60 * 1000,
        revoke: [
          {
            node: replacement.node,
            fingerprint256: replacement.fingerprint256,
          },
        ],
      })
      expect((await directory.refresh()).permanentlyInvalidated).toEqual([
        replacement.node,
      ])
      expect(deliveries).toEqual([[first.node], [replacement.node]])
    },
  )
})

describe('CertificateDirectory — credential history and RL monotonicity', () => {
  itNeedsOpenssl(
    'rejects rollback, same-time forks, and removal from an accepted RL',
    async () => {
      const a = issueNode(caDir, 'node-a', ['node-a.example.com'], root)
      await registerIssued(a, 'node-a.example.com')
      const t0 = Date.now()
      const errors: string[] = []
      await publishExactRl({ issuedAt: t0 })
      const directory = new CertificateDirectory({
        caCertificatePem: readFileSync(join(caDir, 'ca.crt'), 'utf8'),
        registryUrl: server.url,
        onError: event => errors.push(`${event.phase}:${event.reason}`),
      })
      directory.setRefreshSink(() => {})
      await directory.refresh()

      await publishExactRl({
        issuedAt: t0 + 1,
        revoked: [{ node: a.node, fingerprint256: a.fingerprint256 }],
      })
      expect(
        (await directory.refresh()).permanentlyInvalidatedCredentials,
      ).toEqual([{ node: a.node, source: 'certificate', id: a.fingerprint256 }])
      expect(directory.publicKeyOf(a.node)).toBeNull()

      // A still-fresh signed pre-revocation snapshot is a replay, not an
      // instruction to resurrect the credential.
      await publishExactRl({ issuedAt: t0 })
      await directory.refresh()
      expect(directory.publicKeyOf(a.node)).toBeNull()

      await publishExactRl({ issuedAt: t0 + 1 })
      await directory.refresh()
      expect(directory.publicKeyOf(a.node)).toBeNull()

      await publishExactRl({ issuedAt: t0 + 2 })
      await directory.refresh()
      expect(directory.publicKeyOf(a.node)).toBeNull()
      expect(errors.some(error => error.includes('rollback'))).toBe(true)
      expect(errors.some(error => error.includes('conflicting'))).toBe(true)
      expect(errors.some(error => error.includes('removes prior'))).toBe(true)
    },
  )

  itNeedsOpenssl(
    'retains two fingerprints for one node and invalidates each exactly',
    async () => {
      const identity = generateNodeKeyPair()
      const first = issueNode(
        caDir,
        'node-a',
        ['node-a.example.com'],
        root,
        identity,
      )
      await registerIssued(first, 'node-a.example.com')
      const t0 = Date.now()
      await publishExactRl({ issuedAt: t0 })
      const directory = new CertificateDirectory({
        caCertificatePem: readFileSync(join(caDir, 'ca.crt'), 'utf8'),
        registryUrl: server.url,
      })
      await directory.refresh()

      const replacement = issueNode(
        caDir,
        'node-a',
        ['node-a.example.com'],
        root,
        identity,
      )
      registry.clear()
      await registerIssued(replacement, 'node-a.example.com')
      await directory.refresh()

      await publishExactRl({
        issuedAt: t0 + 1,
        revoked: [{ node: first.node, fingerprint256: first.fingerprint256 }],
      })
      const firstRevocation = await directory.refresh()
      expect(firstRevocation.permanentlyInvalidatedCredentials).toEqual([
        { node: first.node, source: 'certificate', id: first.fingerprint256 },
      ])
      expect(
        directory.handshakeCredentialOf(first.node, first.fingerprint256),
      ).toBeNull()
      expect(
        directory.handshakeCredentialOf(
          replacement.node,
          replacement.fingerprint256,
        )?.publicKey,
      ).toBe(identity.publicKey)
      expect(directory.publicKeyOf(replacement.node)).toBe(identity.publicKey)

      await publishExactRl({
        issuedAt: t0 + 2,
        revoked: [
          { node: first.node, fingerprint256: first.fingerprint256 },
          {
            node: replacement.node,
            fingerprint256: replacement.fingerprint256,
          },
        ],
      })
      const both = await directory.refresh()
      expect(both.permanentlyInvalidatedCredentials).toEqual([
        { node: first.node, source: 'certificate', id: first.fingerprint256 },
        {
          node: replacement.node,
          source: 'certificate',
          id: replacement.fingerprint256,
        },
      ])
    },
  )

  itNeedsOpenssl(
    'keeps an explicit override distinguishable from a revoked CA credential',
    async () => {
      const a = issueNode(caDir, 'node-a', ['node-a.example.com'], root)
      await registerIssued(a, 'node-a.example.com')
      const t0 = Date.now()
      await publishExactRl({ issuedAt: t0 })
      const explicit = generateNodeKeyPair()
      const directory = new CertificateDirectory({
        caCertificatePem: readFileSync(join(caDir, 'ca.crt'), 'utf8'),
        registryUrl: server.url,
        trusted: [[a.node, explicit.publicKey]],
      })
      await directory.refresh()
      await publishExactRl({
        issuedAt: t0 + 1,
        revoked: [{ node: a.node, fingerprint256: a.fingerprint256 }],
      })
      const result = await directory.refresh()
      expect(result.permanentlyInvalidatedCredentials).toEqual([
        { node: a.node, source: 'certificate', id: a.fingerprint256 },
      ])
      expect(directory.handshakeCredentialOf(a.node, undefined)).toEqual({
        publicKey: explicit.publicKey,
        source: 'explicit',
        id: a.node,
      })
      expect(directory.publicKeyOf(a.node)).toBe(explicit.publicKey)
    },
  )

  itNeedsOpenssl(
    'closes an F1 socket after same-identity F2 rotation without closing F2',
    async () => {
      const identity = generateNodeKeyPair()
      const listener = issueNode(caDir, 'node-b', ['node-b.example.com'], root)
      const first = issueNode(
        caDir,
        'node-a',
        ['node-a.example.com'],
        root,
        identity,
      )
      await registerIssued(first, 'node-a.example.com')
      await registerIssued(listener, 'node-b.example.com')
      const t0 = Date.now()
      await publishExactRl({ issuedAt: t0 })
      const directory = new CertificateDirectory({
        caCertificatePem: readFileSync(join(caDir, 'ca.crt'), 'utf8'),
        registryUrl: server.url,
      })
      await directory.refresh()

      let transport: TransportServerHandle | undefined
      const clients: TransportClient[] = []
      try {
        const socketPath = join(root, `rotation-${crypto.randomUUID()}.sock`)
        directory.setRefreshSink(({ permanentlyInvalidatedCredentials }) => {
          transport?.closePeerCredentials(permanentlyInvalidatedCredentials)
        })
        transport = startTransportServer({
          unix: socketPath,
          psk: 'certificate-rotation-review-psk',
          onMessage: () => {},
          signing: {
            node: listener.node,
            keys: listener.keys,
            directory,
            required: true,
            credentialProofRequired: true,
            credential: {
              selector: listener.fingerprint256,
              source: CERTIFICATE_CREDENTIAL_SOURCE,
              id: listener.fingerprint256,
            },
          },
        })
        const connect = async (
          credential: string,
        ): Promise<TransportClient> => {
          const client = new TransportClient({
            endpoint: { unix: socketPath },
            node: first.node,
            peerNode: listener.node,
            psk: 'certificate-rotation-review-psk',
            keepAliveIntervalMs: 0,
            signing: {
              keys: identity,
              directory,
              required: true,
              credentialProofRequired: true,
              credential: {
                selector: credential,
                source: CERTIFICATE_CREDENTIAL_SOURCE,
                id: credential,
              },
            },
          })
          clients.push(client)
          await client.connect(5_000)
          return client
        }
        const f1 = await connect(first.fingerprint256)

        const replacement = issueNode(
          caDir,
          first.node,
          ['node-a.example.com'],
          root,
          identity,
        )
        registry.clear()
        await registerIssued(replacement, 'node-a.example.com')
        await registerIssued(listener, 'node-b.example.com')
        await directory.refresh()
        const f2 = await connect(replacement.fingerprint256)

        await publishExactRl({
          issuedAt: t0 + 1,
          revoked: [{ node: first.node, fingerprint256: first.fingerprint256 }],
        })
        await directory.refresh()
        const deadline = Date.now() + 2_000
        while (!f1.isClosed() && Date.now() < deadline) await Bun.sleep(10)
        expect(f1.isClosed()).toBe(true)
        expect(f2.isReady()).toBe(true)
        expect(transport.connections).toBe(1)
        expect(transport.channels).toBe(1)

        const returning = new TransportClient({
          endpoint: { unix: socketPath },
          node: first.node,
          peerNode: listener.node,
          psk: 'certificate-rotation-review-psk',
          keepAliveIntervalMs: 0,
          signing: {
            keys: identity,
            directory,
            required: true,
            credentialProofRequired: true,
            credential: {
              selector: first.fingerprint256,
              source: CERTIFICATE_CREDENTIAL_SOURCE,
              id: first.fingerprint256,
            },
          },
        })
        clients.push(returning)
        await expect(returning.connect(5_000)).rejects.toThrow(/4003/)
        expect(f2.isReady()).toBe(true)
      } finally {
        for (const client of clients) await client.close()
        await transport?.stop()
      }
    },
  )

  itNeedsOpenssl(
    'does not close a real explicit-trust socket when the CA credential is revoked',
    async () => {
      const caPeer = issueNode(caDir, 'node-a', ['node-a.example.com'], root)
      const explicit = generateNodeKeyPair()
      const listener = issueNode(caDir, 'node-b', ['node-b.example.com'], root)
      await registerIssued(caPeer, 'node-a.example.com')
      await registerIssued(listener, 'node-b.example.com')
      const t0 = Date.now()
      await publishExactRl({ issuedAt: t0 })
      const directory = new CertificateDirectory({
        caCertificatePem: readFileSync(join(caDir, 'ca.crt'), 'utf8'),
        registryUrl: server.url,
        trusted: [[caPeer.node, explicit.publicKey]],
      })
      await directory.refresh()
      let transport: TransportServerHandle | undefined
      let client: TransportClient | undefined
      try {
        const socketPath = join(root, `explicit-${crypto.randomUUID()}.sock`)
        directory.setRefreshSink(({ permanentlyInvalidatedCredentials }) => {
          transport?.closePeerCredentials(permanentlyInvalidatedCredentials)
        })
        transport = startTransportServer({
          unix: socketPath,
          psk: 'explicit-override-review-psk',
          onMessage: () => {},
          signing: {
            node: listener.node,
            keys: listener.keys,
            directory,
            required: true,
            credentialProofRequired: true,
            credential: {
              selector: listener.fingerprint256,
              source: CERTIFICATE_CREDENTIAL_SOURCE,
              id: listener.fingerprint256,
            },
          },
        })
        client = new TransportClient({
          endpoint: { unix: socketPath },
          node: caPeer.node,
          peerNode: listener.node,
          psk: 'explicit-override-review-psk',
          keepAliveIntervalMs: 0,
          signing: {
            keys: explicit,
            directory,
            required: true,
            credentialProofRequired: true,
            credential: {
              selector: caPeer.node,
              source: EXPLICIT_CREDENTIAL_SOURCE,
              id: caPeer.node,
            },
          },
        })
        await client.connect(5_000)
        await publishExactRl({
          issuedAt: t0 + 1,
          revoked: [
            { node: caPeer.node, fingerprint256: caPeer.fingerprint256 },
          ],
        })
        await directory.refresh()
        await Bun.sleep(50)
        expect(client.isReady()).toBe(true)
        expect(client.isClosed()).toBe(false)
        expect(transport.connections).toBe(1)
      } finally {
        await client?.close()
        await transport?.stop()
      }
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

/**
 * §8.2 phase ①'s second half. The precedence half ("显式 `--trust` 覆盖 CA
 * 派生条目") already has coverage above; what is asserted here is that the
 * override is **on the record** — the design refuses both a silent overwrite
 * and a startup failure, which leaves exactly one option, and an option
 * nobody wired is an option that does not exist.
 */
describe('CertificateDirectory — the --trust override is audited (§8.2)', () => {
  itNeedsOpenssl(
    'a --trust entry that disagrees with the CA-derived key records one event',
    async () => {
      const a = issueNode(caDir, 'node-a', ['node-a.example.com'], root)
      await registerIssued(a, 'node-a.example.com')
      await publishRl({ now: Date.now(), validMs: 30 * 24 * 60 * 60 * 1000 })

      const operatorKey = generateNodeKeyPair().publicKey
      const events: { node: string; reason: string }[] = []
      const directory = new CertificateDirectory({
        caCertificatePem: readFileSync(join(caDir, 'ca.crt'), 'utf8'),
        registryUrl: server.url,
        trusted: [['node-a', operatorKey]],
        onAudit: event => events.push({ ...event }),
      })
      await directory.refresh()

      // Precedence: the operator's entry wins, and the node keeps running.
      expect(directory.publicKeyOf('node-a')).toBe(operatorKey)
      expect(directory.publicKeyOf('node-a')).not.toBe(a.keys.publicKey)
      // Record: exactly one, naming the node and pointing at the rule.
      expect(events).toHaveLength(1)
      expect(events[0]?.node).toBe('node-a')
      expect(events[0]?.reason).toContain('§8.2')
    },
  )

  itNeedsOpenssl(
    'agreement is not a conflict: the same key from both sides is silent',
    async () => {
      const a = issueNode(caDir, 'node-a', ['node-a.example.com'], root)
      await registerIssued(a, 'node-a.example.com')
      await publishRl({ now: Date.now(), validMs: 30 * 24 * 60 * 60 * 1000 })

      const events: unknown[] = []
      const directory = new CertificateDirectory({
        caCertificatePem: readFileSync(join(caDir, 'ca.crt'), 'utf8'),
        registryUrl: server.url,
        // §8.2 phase ② calls this one "多余的" — redundant, not conflicting.
        trusted: [['node-a', a.keys.publicKey]],
        onAudit: event => events.push(event),
      })
      await directory.refresh()

      expect(directory.publicKeyOf('node-a')).toBe(a.keys.publicKey)
      expect(events).toHaveLength(0)
    },
  )
})
