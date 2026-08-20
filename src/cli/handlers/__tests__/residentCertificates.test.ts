// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * `resident`'s `--trust-ca` / `--cert` / `--key` (key-distribution.md §8.1,
 * P12.2 DoD #1). Parsing needs no openssl; the directory-wiring and
 * self-check tests below issue real certificates with a real offline CA
 * (P12.1) — zero mocks, same discipline as `certificateDirectory.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  generateNodeKeyPair,
  signBytes,
  type NodeKeyPair,
} from '@qianmo/capability'
import { CertificateDirectory } from '../../../services/qianmo/certificateDirectory.js'
import {
  initCa,
  issueCertificate,
} from '../../../services/qianmo/ca/operations.js'
import {
  opensslVersion,
  runOpenssl,
} from '../../../services/qianmo/ca/openssl.js'
import { popMessage } from '../../../services/qianmo/ca/pop.js'
import { StaticPublicKeyDirectory } from '@qianmo/capability'
import {
  assertOwnCertificateAndKey,
  buildPublicKeyDirectory,
  parseResidentArgs,
} from '../resident.js'

const OPENSSL = opensslVersion()
const itNeedsOpenssl = OPENSSL === null ? test.skip : test

const BASE = [
  '--node',
  'node-a',
  '--team',
  'atlas',
  '--agent',
  'reviewer=/workspace',
  '--port',
  '7321',
  '--hostname',
  '127.0.0.1',
] as const

describe('resident argument parsing: --trust-ca / --cert / --key', () => {
  test('parses absolute paths for all three', () => {
    const parsed = parseResidentArgs(
      [
        ...BASE,
        '--trust-ca',
        '/tmp/ca.crt',
        '--cert',
        '/tmp/node-a.tls.crt',
        '--key',
        '/tmp/node-a.tls.key',
      ],
      'qianmo',
    )
    expect(parsed.trustCa).toBe('/tmp/ca.crt')
    expect(parsed.cert).toBe('/tmp/node-a.tls.crt')
    expect(parsed.key).toBe('/tmp/node-a.tls.key')
  })

  test('rejects relative paths for all three', () => {
    expect(() =>
      parseResidentArgs([...BASE, '--trust-ca', 'ca.crt'], 'qianmo'),
    ).toThrow('--trust-ca must be an absolute path')
    expect(() =>
      parseResidentArgs(
        [...BASE, '--cert', 'a.crt', '--key', '/tmp/a.key'],
        'qianmo',
      ),
    ).toThrow('--cert must be an absolute path')
    expect(() =>
      parseResidentArgs(
        [...BASE, '--cert', '/tmp/a.crt', '--key', 'a.key'],
        'qianmo',
      ),
    ).toThrow('--key must be an absolute path')
  })

  test('--cert and --key are required together', () => {
    expect(() =>
      parseResidentArgs([...BASE, '--cert', '/tmp/a.crt'], 'qianmo'),
    ).toThrow('--cert requires --key')
    expect(() =>
      parseResidentArgs([...BASE, '--key', '/tmp/a.key'], 'qianmo'),
    ).toThrow('--key requires --cert')
    // Together, or neither, is fine.
    expect(() =>
      parseResidentArgs(
        [...BASE, '--cert', '/tmp/a.crt', '--key', '/tmp/a.key'],
        'qianmo',
      ),
    ).not.toThrow()
  })

  test('--trust-ca does not require --cert/--key, and vice versa', () => {
    expect(() =>
      parseResidentArgs([...BASE, '--trust-ca', '/tmp/ca.crt'], 'qianmo'),
    ).not.toThrow()
  })
})

describe('buildPublicKeyDirectory', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-directory-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('with no --trust-ca: a StaticPublicKeyDirectory, carrying --trust', () => {
    const peer = generateNodeKeyPair().publicKey
    const directory = buildPublicKeyDirectory({
      node: 'node-a',
      team: 'atlas',
      agents: [],
      trusted: [['node-b', peer]],
      requireSignedTasks: false,
    })
    expect(directory).toBeInstanceOf(StaticPublicKeyDirectory)
    expect(directory.publicKeyOf('node-b')).toBe(peer)
  })

  itNeedsOpenssl(
    'with --trust-ca: a CertificateDirectory, carrying --trust too',
    () => {
      const caDir = join(root, 'ca')
      initCa({ directory: caDir })
      const caCertPath = join(caDir, 'ca.crt')
      const peer = generateNodeKeyPair().publicKey
      const directory = buildPublicKeyDirectory({
        node: 'node-a',
        team: 'atlas',
        agents: [],
        trusted: [['node-b', peer]],
        requireSignedTasks: false,
        trustCa: caCertPath,
      })
      expect(directory).toBeInstanceOf(CertificateDirectory)
      expect(directory.publicKeyOf('node-b')).toBe(peer)
    },
  )
})

describe('assertOwnCertificateAndKey (K-2, one of the four negative cases)', () => {
  let root: string
  let caDir: string
  let nodeKeys: NodeKeyPair
  let certificatePath: string
  let ecKeyPath: string

  beforeEach(() => {
    if (OPENSSL === null) return
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-cert-check-'))
    caDir = join(root, 'ca')
    initCa({ directory: caDir })
    nodeKeys = generateNodeKeyPair()
    ecKeyPath = join(root, 'node-a.tls.key')
    writeFileSync(
      ecKeyPath,
      runOpenssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout']),
      { mode: 0o600 },
    )
    const csrPem = runOpenssl([
      'req',
      '-new',
      '-key',
      ecKeyPath,
      '-subj',
      '/CN=node-a',
    ])
    const issued = issueCertificate({
      directory: caDir,
      node: 'node-a',
      publicKey: nodeKeys.publicKey,
      csrPem,
      popSignature: signBytes(nodeKeys, popMessage('node-a', csrPem)),
      hosts: ['node-a.example.com'],
    })
    certificatePath = join(root, 'node-a.tls.crt')
    writeFileSync(certificatePath, issued.certificatePem)
  })

  afterEach(() => {
    if (OPENSSL !== null) rmSync(root, { recursive: true, force: true })
  })

  itNeedsOpenssl('a matching --cert/--key pair passes', () => {
    expect(() =>
      assertOwnCertificateAndKey(
        {
          node: 'node-a',
          team: 'atlas',
          agents: [],
          trusted: [],
          requireSignedTasks: false,
          cert: certificatePath,
          key: ecKeyPath,
        },
        nodeKeys.publicKey,
      ),
    ).not.toThrow()
  })

  itNeedsOpenssl("--cert naming a different node's identity is refused", () => {
    const impostorKey = generateNodeKeyPair().publicKey
    expect(() =>
      assertOwnCertificateAndKey(
        {
          node: 'node-a',
          team: 'atlas',
          agents: [],
          trusted: [],
          requireSignedTasks: false,
          cert: certificatePath,
          key: ecKeyPath,
        },
        impostorKey,
      ),
    ).toThrow(/nodekey does not match identity/)
  })

  itNeedsOpenssl('a non-EC --key (Ed25519) is refused (F-5)', () => {
    const ed25519KeyPath = join(root, 'wrong-type.key')
    writeFileSync(
      ed25519KeyPath,
      runOpenssl(['genpkey', '-algorithm', 'ed25519']),
    )
    expect(() =>
      assertOwnCertificateAndKey(
        {
          node: 'node-a',
          team: 'atlas',
          agents: [],
          trusted: [],
          requireSignedTasks: false,
          cert: certificatePath,
          key: ed25519KeyPath,
        },
        nodeKeys.publicKey,
      ),
    ).toThrow(/--key must be an EC private key/)
  })

  itNeedsOpenssl('an unparseable --key is refused with a clear message', () => {
    const junkKeyPath = join(root, 'junk.key')
    writeFileSync(junkKeyPath, 'not a key at all')
    expect(() =>
      assertOwnCertificateAndKey(
        {
          node: 'node-a',
          team: 'atlas',
          agents: [],
          trusted: [],
          requireSignedTasks: false,
          cert: certificatePath,
          key: junkKeyPath,
        },
        nodeKeys.publicKey,
      ),
    ).toThrow(/--key does not parse as a private key/)
  })

  test('with neither flag, nothing is checked and nothing throws', () => {
    expect(() =>
      assertOwnCertificateAndKey(
        {
          node: 'node-a',
          team: 'atlas',
          agents: [],
          trusted: [],
          requireSignedTasks: false,
        },
        generateNodeKeyPair().publicKey,
      ),
    ).not.toThrow()
  })
})
