// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The CA end to end: build a root, sign a node certificate, then make the
 * certificate do the two jobs §4.2 gives it.
 *
 * Zero mocks on purpose. Every claim this package rests on came from a probe
 * against the real thing (`key-distribution.md` §2), and a mocked openssl or a
 * mocked TLS stack would assert against our belief about them rather than
 * against them. So: real openssl, a real `Bun.serve`, real `node:crypto`.
 *
 * These are the reproductions §13's P12.1 row asks for by name:
 *   F-1/F-3  the three SAN classes survive issuance and read back
 *   F-6      an EC leaf under an Ed25519 root is accepted by `Bun.serve`
 *   F-9      the DNS:/IP: SANs are what make the connection possible at all
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { X509Certificate } from 'node:crypto'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  generateNodeKeyPair,
  signBytes,
  type NodeKeyPair,
} from '@qianmo/capability'
import {
  NODE_KEY_URI_SCHEME,
  parseNodeCertificateBinding,
} from '@qianmo/protocol'
import {
  CA_ROOT_DAYS,
  NODE_CERT_DAYS,
  initCa,
  issueCertificate,
  refreshRevocationList,
  type CaInitResult,
} from '../operations.js'
import { opensslVersion, runOpenssl } from '../openssl.js'
import { caCertPath, caKeyPath, revocationListPath } from '../paths.js'
import { popMessage } from '../pop.js'
import { verifyRevocationList } from '../revocationList.js'

const OPENSSL = opensslVersion()
if (OPENSSL === null) {
  // Printed, not swallowed: a silently skipped suite is a suite that stops
  // covering anything the day the binary goes missing on CI.
  console.error(
    '[qianmo ca] skipping the openssl-backed CA tests: no usable openssl on ' +
      'PATH. Install it, or point QIANMO_OPENSSL_BIN at one — the CA tool is ' +
      'an openssl wrapper and there is nothing to test without it.',
  )
}

/** Skips with the reason above rather than failing on a machine without openssl. */
const itNeedsOpenssl = OPENSSL === null ? test.skip : test

let root: string
let caDir: string
let ca: CaInitResult
let nodeKeys: NodeKeyPair
let nodeTlsKeyPath: string
let csrPem: string

beforeAll(() => {
  if (OPENSSL === null) return
  root = mkdtempSync(join(tmpdir(), 'qianmo-ca-test-'))
  caDir = join(root, 'ca')
  ca = initCa({ directory: caDir })

  // What a node does for itself in P12.2 (`qm cert request`): an EC key that
  // never leaves it (F-5 forces EC), plus a CSR made from it.
  nodeKeys = generateNodeKeyPair()
  nodeTlsKeyPath = join(root, 'node-a.tls.key')
  writeFileSync(
    nodeTlsKeyPath,
    runOpenssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout']),
    { mode: 0o600 },
  )
  csrPem = runOpenssl([
    'req',
    '-new',
    '-key',
    nodeTlsKeyPath,
    '-subj',
    '/CN=node-a',
  ])
})

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
})

function issueForTest(overrides: Record<string, unknown> = {}) {
  const pop = signBytes(nodeKeys, popMessage('node-a', csrPem))
  return issueCertificate({
    directory: caDir,
    node: 'node-a',
    publicKey: nodeKeys.publicKey,
    csrPem,
    popSignature: pop,
    hosts: ['localhost', '127.0.0.1'],
    ...overrides,
  })
}

describe('qm ca init', () => {
  itNeedsOpenssl('makes an Ed25519 root with 0700/0600 permissions', () => {
    expect(statSync(caDir).mode & 0o777).toBe(0o700)
    expect(statSync(caKeyPath(caDir)).mode & 0o777).toBe(0o600)
    expect(ca.fingerprint256).toMatch(/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/)
    expect(ca.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const certificate = new X509Certificate(readFileSync(caCertPath(caDir)))
    // Self-signed, and the root lives for §6.2's ten years.
    expect(certificate.verify(certificate.publicKey)).toBe(true)
    const years =
      (Date.parse(certificate.validTo) - Date.parse(certificate.validFrom)) /
      (24 * 60 * 60 * 1000)
    expect(Math.round(years)).toBe(CA_ROOT_DAYS)
  })

  itNeedsOpenssl('never overwrites an existing CA private key (§3.3)', () => {
    expect(() => initCa({ directory: caDir })).toThrow(/never\s+overwritten/)
  })
})

describe('qm ca issue', () => {
  itNeedsOpenssl(
    'writes all three SAN classes and reads them back (F-1/F-3)',
    () => {
      const issued = issueForTest()
      const certificate = new X509Certificate(issued.certificatePem)

      // F-1: openssl signed a leaf carrying both URI SANs under an Ed25519 root.
      expect(certificate.subjectAltName).toContain('URI:qianmo://node-a')
      expect(certificate.subjectAltName).toContain(
        `URI:${NODE_KEY_URI_SCHEME}${nodeKeys.publicKey}`,
      )
      // F-9: the host SANs are there, and the two classes landed on the right
      // types — an IP written as a DNS name is a certificate nobody can dial.
      expect(certificate.subjectAltName).toContain('DNS:localhost')
      expect(certificate.subjectAltName).toContain('IP Address:127.0.0.1')

      // F-3: the key in the SAN is exactly the 43-character string the node
      // publishes as `AgentRecord.publicKey` — no second encoding.
      const binding = parseNodeCertificateBinding(certificate.subjectAltName)
      expect(binding).toEqual({
        node: 'node-a',
        publicKey: nodeKeys.publicKey,
        dnsNames: ['localhost'],
        ipAddresses: ['127.0.0.1'],
      })

      // F-2: a node can tell this is ours with zero dependencies.
      const rootCertificate = new X509Certificate(
        readFileSync(caCertPath(caDir)),
      )
      expect(certificate.verify(rootCertificate.publicKey)).toBe(true)

      const days =
        (Date.parse(certificate.validTo) - Date.parse(certificate.validFrom)) /
        (24 * 60 * 60 * 1000)
      expect(Math.round(days)).toBe(NODE_CERT_DAYS)
    },
  )

  itNeedsOpenssl('the EC leaf is accepted by Bun.serve (F-6)', async () => {
    const issued = issueForTest()
    const server = Bun.serve({
      port: 0,
      tls: {
        cert: issued.certificatePem,
        key: readFileSync(nodeTlsKeyPath, 'utf8'),
      },
      fetch: () => new Response('ok'),
    })
    try {
      const caPem = readFileSync(caCertPath(caDir), 'utf8')
      // Both spellings of the same node, because both are in the SANs and
      // Bun checks the dialed name against them (F-9).
      const byIp = await fetch(`https://127.0.0.1:${server.port}/`, {
        tls: { ca: caPem },
      })
      expect(byIp.status).toBe(200)
      expect(await byIp.text()).toBe('ok')
      const byName = await fetch(`https://localhost:${server.port}/`, {
        tls: { ca: caPem },
      })
      expect(byName.status).toBe(200)
    } finally {
      server.stop(true)
    }
  })

  itNeedsOpenssl(
    'a certificate missing the dialed host is refused by the client (F-9)',
    async () => {
      // The mistake §4.2 says is easiest to make, reproduced: SANs that do not
      // cover the address peers dial. `--host` is required precisely because
      // this failure surfaces on somebody else's machine, months later.
      const issued = issueForTest({
        hosts: ['elsewhere.example'],
        outPath: join(root, 'wrong-host.crt'),
      })
      const server = Bun.serve({
        port: 0,
        tls: {
          cert: issued.certificatePem,
          key: readFileSync(nodeTlsKeyPath, 'utf8'),
        },
        fetch: () => new Response('ok'),
      })
      try {
        const attempt = fetch(`https://127.0.0.1:${server.port}/`, {
          tls: { ca: readFileSync(caCertPath(caDir), 'utf8') },
        })
        await expect(attempt).rejects.toThrow()
      } finally {
        server.stop(true)
      }
    },
  )

  itNeedsOpenssl('refuses a request whose proof of possession fails', () => {
    const impostor = generateNodeKeyPair()
    expect(() =>
      issueForTest({
        popSignature: signBytes(impostor, popMessage('node-a', csrPem)),
      }),
    ).toThrow(/proof of possession failed/)

    // And the shape that matters: claiming somebody else's public key while
    // holding a valid proof for your own.
    expect(() =>
      issueCertificate({
        directory: caDir,
        node: 'node-a',
        publicKey: impostor.publicKey,
        csrPem,
        popSignature: signBytes(nodeKeys, popMessage('node-a', csrPem)),
        hosts: ['localhost'],
      }),
    ).toThrow(/proof of possession failed/)
  })

  itNeedsOpenssl('refuses an Ed25519 leaf before signing it (F-5)', () => {
    const edKeyPath = join(root, 'ed.key')
    writeFileSync(edKeyPath, runOpenssl(['genpkey', '-algorithm', 'ed25519']), {
      mode: 0o600,
    })
    const edCsr = runOpenssl([
      'req',
      '-new',
      '-key',
      edKeyPath,
      '-subj',
      '/CN=node-a',
    ])
    expect(() =>
      issueCertificate({
        directory: caDir,
        node: 'node-a',
        publicKey: nodeKeys.publicKey,
        csrPem: edCsr,
        popSignature: signBytes(nodeKeys, popMessage('node-a', edCsr)),
        hosts: ['localhost'],
      }),
    ).toThrow(/must be\s+EC/)
  })

  itNeedsOpenssl('refuses a request with no host at all (F-9)', () => {
    expect(() => issueForTest({ hosts: [] })).toThrow(/--host is required/)
  })

  itNeedsOpenssl(
    'refuses a malformed CSR as a CSR, not as a failed proof',
    () => {
      expect(() =>
        issueCertificate({
          directory: caDir,
          node: 'node-a',
          publicKey: nodeKeys.publicKey,
          csrPem:
            '-----BEGIN CERTIFICATE REQUEST-----\nAAAA\n-----END CERTIFICATE REQUEST-----\n',
          popSignature: 'A'.repeat(86),
          hosts: ['localhost'],
        }),
      ).toThrow(/openssl/)
    },
  )
})

describe('qm ca refresh-rl', () => {
  itNeedsOpenssl('signs a list the CA certificate verifies', () => {
    const issued = issueForTest()
    const first = refreshRevocationList({
      directory: caDir,
      revoke: [
        {
          node: 'node-a',
          fingerprint256: issued.fingerprint256,
          reason: 'drill',
        },
      ],
    })
    expect(first.added).toBe(1)
    expect(first.path).toBe(revocationListPath(caDir))

    const published: unknown = JSON.parse(readFileSync(first.path, 'utf8'))
    const verified = verifyRevocationList(ca.publicKey, published)
    expect(verified?.revoked).toEqual([
      {
        node: 'node-a',
        fingerprint256: issued.fingerprint256,
        reason: 'drill',
        at: expect.any(Number),
      },
    ])
    expect((verified?.nextUpdate ?? 0) - (verified?.issuedAt ?? 0)).toBe(
      30 * 24 * 60 * 60 * 1000,
    )
  })

  itNeedsOpenssl('re-adding a known fingerprint is a no-op', () => {
    const current = verifyRevocationList(
      ca.publicKey,
      JSON.parse(readFileSync(revocationListPath(caDir), 'utf8')),
    )
    const known = current?.revoked[0]?.fingerprint256 ?? ''
    const again = refreshRevocationList({
      directory: caDir,
      // The same fingerprint, typed the way the other tool prints it: lower
      // case, no colons. A revocation that silently fails to match is the one
      // typo this command must not have.
      revoke: [
        {
          node: 'node-a',
          fingerprint256: known.replace(/:/g, '').toLowerCase(),
        },
      ],
    })
    expect(again.added).toBe(0)
    expect(again.list.revoked).toHaveLength(current?.revoked.length ?? 0)
  })

  itNeedsOpenssl('a plain re-sign moves the dates and nothing else', () => {
    const before = JSON.parse(
      readFileSync(revocationListPath(caDir), 'utf8'),
    ) as { payload: string }
    const previous = verifyRevocationList(ca.publicKey, before)
    // `now` is passed rather than read, because a re-sign inside the same
    // millisecond would produce identical bytes and prove nothing.
    const result = refreshRevocationList({
      directory: caDir,
      now: Date.now() + 60_000,
    })
    const after = JSON.parse(readFileSync(result.path, 'utf8')) as {
      payload: string
    }
    expect(result.added).toBe(0)
    expect(after.payload).not.toBe(before.payload)
    expect(result.list.revoked).toEqual(previous?.revoked ?? [])
  })

  itNeedsOpenssl('refuses to run without a CA', () => {
    expect(() =>
      refreshRevocationList({ directory: join(root, 'nothing-here') }),
    ).toThrow(/no CA at/)
  })
})
