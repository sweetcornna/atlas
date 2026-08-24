// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * 离线 CA 那条路的本地夹具 —— `qm ca` / `qm cert` 的真命令行。
 *
 * 五件必须先知道的事：
 *
 * ① **CA 目录不许落在任何配置根、仓库或 demo 根里面**，`caDirectory()` 会
 *    当场抛（key-distribution.md §3.3，那是全仓唯一一处不从 `paths.ts` 派生
 *    路径的地方，且抛错就是它的实现方式）。所以这里把 CA 放在场景 workdir 的
 *    `ca/` 下，而跑 `qm ca` 时用的 `OCC_CONFIG_DIR` 是它的**兄弟**目录
 *    `ca-tool-config/`，不是它的祖先。
 *
 * ② **没有 `qm ca revoke`。** 吊销是 `qm ca refresh-rl --revoke <node>=<指纹>`
 *    签一份新的吊销清单，然后**由操作者自己**把那份 JSON `PUT` 到注册中心的
 *    `/v0/revocation-list` —— CLI 不做这一步。
 *
 * ③ **不发吊销清单 = 整条 CA 路失效，不是「不吊销任何东西」。**
 *    `CertificateDirectory` 的 `handshakeCredentialOf` 第一行就是
 *    `if (selector === undefined || !this.#rlFresh()) return null`：清单没拉到
 *    或已过 `nextUpdate`，有效凭据集退回**只有 `--trust` 那几条**。这是 fail
 *    closed，`certificate/no-revocation-list-fails-closed` 钉住它。
 *
 * ④ **节点身份（Ed25519）与 TLS 叶子（EC）是两把钥匙。** 证书里用 SAN 携带
 *    前者（`--nodekey`），握手签名与能力签发用的都是前者；EC 那把只用于 TLS，
 *    因为 Bun 不接受 Ed25519 叶子（F-5）。同一个配置根跑两次 `qm cert request`
 *    会**复用同一把 Ed25519**（`wx` 创建、永不覆盖）而**重新生成 EC 与 CSR**
 *    —— 于是拿到两张指纹不同、绑定同一把签名钥匙的证书。冻结四元组的
 *    `credential` 腿正是靠这一点才隔离得出来。
 *
 * ⑤ **`qm ca` 要 openssl，而且要真 OpenSSL。** 拿不到就 {@link opensslVersion}
 *    返回 null，场景据此 skip 并把原因写进报告，不假装覆盖。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runCli } from './spawn.js'
import type { ScenarioContext } from '../types.js'

/** Ed25519 身份密钥对，形状与 `@qianmo/capability` 的 `NodeKeyPair` 一致。 */
export interface IdentityKeys {
  readonly publicKey: string
  readonly privateKey: string
}

export interface CaHandle {
  readonly dir: string
  /** 根证书 PEM 路径 —— 直接喂 `--trust-ca`。 */
  readonly certificatePath: string
  readonly fingerprint256: string
  readonly publicKey: string
  /** 跑 `qm ca` 用的环境（配置根是 CA 目录的兄弟，见文件头 ①）。 */
  readonly toolEnv: Readonly<Record<string, string>>
}

export interface IssuedCertificate {
  readonly node: string
  readonly configRoot: string
  /** 证书 PEM 原文。 */
  readonly pem: string
  readonly path: string
  /** `AA:BB:…` 大写带冒号 —— 握手里的 credential selector 就是它。 */
  readonly fingerprint256: string
  /** 节点的 Ed25519 公钥（`--nodekey`，也写在证书 SAN 里）。 */
  readonly nodePublicKey: string
  readonly keys: IdentityKeys
}

/** openssl 版本串，跑不动就是 null（场景据此 skip）。 */
export function opensslVersion(): string | null {
  const result = Bun.spawnSync(['openssl', 'version'])
  if (result.exitCode !== 0) return null
  return result.stdout.toString().trim()
}

/** openssl 支不支持给 `x509 -req` 指定绝对有效期（OpenSSL 3.5 起才有）。 */
export function opensslSupportsExplicitValidity(): boolean {
  const result = Bun.spawnSync(['openssl', 'x509', '-help'])
  const help = `${result.stdout.toString()}${result.stderr.toString()}`
  return help.includes('-not_before') && help.includes('-not_after')
}

/** 读一个配置根里的节点身份。 */
function readIdentityKeys(configRoot: string, node: string): IdentityKeys {
  const raw = readFileSync(
    join(configRoot, 'qianmo', 'identity', `${node}.json`),
    'utf8',
  )
  const parsed = JSON.parse(raw) as {
    publicKey?: unknown
    privateKey?: unknown
  }
  if (
    typeof parsed.publicKey !== 'string' ||
    typeof parsed.privateKey !== 'string'
  ) {
    throw new Error(`身份文件不含密钥对: ${configRoot} / ${node}`)
  }
  return { publicKey: parsed.publicKey, privateKey: parsed.privateKey }
}

export async function initCa(ctx: ScenarioContext): Promise<CaHandle> {
  const dir = join(ctx.workdir, 'ca')
  const toolEnv = {
    OCC_IDENTITY: 'qianmo',
    // **兄弟**目录，不是 `dir` 的祖先 —— 见文件头 ①。
    OCC_CONFIG_DIR: join(ctx.workdir, 'ca-tool-config'),
  }
  const result = await runCli({
    argv: ['ca', 'init', '--ca-dir', dir, '--cn', 'qianmo-acceptance-ca'],
    env: toolEnv,
    timeoutMs: 90_000,
  })
  if (result.code !== 0) {
    throw new Error(`qm ca init 失败 (${result.code}): ${result.stderr}`)
  }
  const fingerprint256 = field(result.stdout, 'fingerprint256')
  const publicKey = field(result.stdout, 'public key')
  return {
    dir,
    certificatePath: join(dir, 'ca.crt'),
    fingerprint256,
    publicKey,
    toolEnv,
  }
}

/**
 * 走完「节点出 CSR + PoP → CA 签发」两步，返回签好的证书。
 *
 * `--pop` 与 `--nodekey` 从 `qm cert request` 打印的那条**可直接照抄的**
 * `qm ca issue …` 命令里取 —— 那条命令行本身就是产品面，从它取值顺带把
 * 「打印出来的东西真的能用」也验了。
 */
export async function issueCertificate(
  ctx: ScenarioContext,
  ca: CaHandle,
  options: {
    readonly node: string
    /** 节点的配置根（Ed25519 身份就落在这里，复用同一个根即复用同一把钥匙）。 */
    readonly configRoot: string
    /** 输出文件名，放在场景 workdir 下。 */
    readonly outName: string
    readonly hosts?: readonly string[]
    readonly days?: number
  },
): Promise<IssuedCertificate> {
  const hosts = options.hosts ?? ['127.0.0.1']
  const request = await runCli({
    argv: [
      'cert',
      'request',
      '--node',
      options.node,
      ...hosts.flatMap(host => ['--host', host]),
    ],
    env: { OCC_IDENTITY: 'qianmo', OCC_CONFIG_DIR: options.configRoot },
    timeoutMs: 90_000,
  })
  if (request.code !== 0) {
    throw new Error(`qm cert request 失败 (${request.code}): ${request.stderr}`)
  }
  const line = request.stdout
    .split('\n')
    .find(candidate => candidate.trim().startsWith('qm ca issue'))
  if (line === undefined) {
    throw new Error(`qm cert request 没有打印 issue 命令:\n${request.stdout}`)
  }
  const tokens = line.trim().split(/\s+/)
  const valueAfter = (flag: string): string => {
    const value = tokens[tokens.indexOf(flag) + 1]
    if (value === undefined) throw new Error(`issue 命令缺 ${flag}: ${line}`)
    return value
  }

  const out = join(ctx.workdir, options.outName)
  const issue = await runCli({
    argv: [
      'ca',
      'issue',
      options.node,
      '--ca-dir',
      ca.dir,
      '--csr',
      valueAfter('--csr'),
      '--pop',
      valueAfter('--pop'),
      '--nodekey',
      valueAfter('--nodekey'),
      ...hosts.flatMap(host => ['--host', host]),
      ...(options.days === undefined ? [] : ['--days', String(options.days)]),
      '--out',
      out,
    ],
    env: ca.toolEnv,
    timeoutMs: 90_000,
  })
  if (issue.code !== 0) {
    throw new Error(`qm ca issue 失败 (${issue.code}): ${issue.stderr}`)
  }
  return {
    node: options.node,
    configRoot: options.configRoot,
    pem: readFileSync(out, 'utf8'),
    path: out,
    fingerprint256: field(issue.stdout, 'fingerprint256'),
    nodePublicKey: valueAfter('--nodekey'),
    keys: readIdentityKeys(options.configRoot, options.node),
  }
}

/**
 * 签一份吊销清单并把 JSON 原文交出来（**不**发布 —— 那是下一步，也是操作者
 * 自己要做的那一步，见文件头 ②）。
 */
export async function signRevocationList(
  ctx: ScenarioContext,
  ca: CaHandle,
  options: {
    readonly revoke?: readonly {
      readonly node: string
      readonly fingerprint256: string
    }[]
    readonly outName?: string
    readonly reason?: string
  } = {},
): Promise<string> {
  const out = join(ctx.workdir, options.outName ?? 'revocation-list.json')
  const revoke = options.revoke ?? []
  const argv = ['ca', 'refresh-rl', '--ca-dir', ca.dir, '--out', out]
  for (const entry of revoke) {
    argv.push('--revoke', `${entry.node}=${entry.fingerprint256}`)
  }
  if (revoke.length > 0) {
    argv.push('--reason', options.reason ?? 'acceptance revocation')
  }
  const result = await runCli({ argv, env: ca.toolEnv, timeoutMs: 90_000 })
  if (result.code !== 0) {
    throw new Error(`qm ca refresh-rl 失败 (${result.code}): ${result.stderr}`)
  }
  return readFileSync(out, 'utf8')
}

/** 把签好的吊销清单发布到注册中心（零鉴权，见 console.md §8.2）。 */
export async function publishRevocationList(
  registryUrl: string,
  document: string,
): Promise<number> {
  const response = await fetch(`${registryUrl}/v0/revocation-list`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: document,
  })
  return response.status
}

/**
 * 把一个带证书的节点登记进注册中心。
 *
 * **必须直接打注册中心，不能走控制台的代理路由** —— 控制台的
 * `parseRegisterInput` 收 address / endpoint / capabilities / publicKey /
 * status 五个字段，**没有 `certificate`**。经控制台登记的记录进不了
 * `CertificateDirectory` 的证书事实表，于是每一次 CA 握手都会以
 * `unknown_signer` 收场，而现场看起来像「证书签错了」。
 */
export async function publishAgentCertificate(
  registryUrl: string,
  input: {
    readonly address: string
    readonly endpoint: string
    readonly publicKey: string
    readonly certificate: string
  },
): Promise<number> {
  const response = await fetch(`${registryUrl}/v0/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  return response.status
}

function field(stdout: string, label: string): string {
  const match = new RegExp(`^\\s+${label}\\s+(\\S+)\\s*$`, 'm').exec(stdout)
  if (match?.[1] === undefined) {
    throw new Error(`输出里没有 ${label} 这一行:\n${stdout}`)
  }
  return match[1]
}

/**
 * 签一张**已经过期**的节点证书。
 *
 * 为什么不能用 `qm ca issue`：它的 `--days` 走 `positiveInteger`，最短就是
 * 一天，签出来的证书今天一定有效。要观测「过期的对端证书会被怎么处理」，
 * 只能自己指定绝对有效期。
 *
 * 这里**只替换有效期**，其余一切仍是产品的：CSR 来自 `qm cert request`、
 * 签名用 `qm ca init` 生成的那把 CA 私钥、SAN 由 `@qianmo/protocol` 的
 * `formatNodeSanEntries` 生成（与 `ca/operations.ts` 同一个函数）。手抄一份
 * SAN 格式会让这条场景在格式改动时变成假绿 —— 那正是它要抓的东西之一。
 *
 * `-not_before` / `-not_after` 是 OpenSSL 3.5 才有的开关；拿不到就由调用方
 * 按 {@link opensslSupportsExplicitValidity} skip。
 *
 * 主机分类（DNS 还是 IP）在这里是就地判断的，`ca/operations.ts` 的
 * `classifyHosts` 没有导出。调用方只传 `127.0.0.1` 这类字面量，判断不含歧义。
 */
export async function issueExpiredCertificate(
  ctx: ScenarioContext,
  ca: CaHandle,
  options: {
    readonly node: string
    readonly configRoot: string
    readonly outName: string
    readonly host?: string
  },
): Promise<IssuedCertificate> {
  const { formatNodeSanEntries } = await import('@qianmo/protocol')
  const { X509Certificate } = await import('node:crypto')
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const host = options.host ?? '127.0.0.1'

  const request = await runCli({
    argv: ['cert', 'request', '--node', options.node, '--host', host],
    env: { OCC_IDENTITY: 'qianmo', OCC_CONFIG_DIR: options.configRoot },
    timeoutMs: 90_000,
  })
  if (request.code !== 0) {
    throw new Error(`qm cert request 失败 (${request.code}): ${request.stderr}`)
  }
  const csrPath = join(
    options.configRoot,
    'qianmo',
    'identity',
    `${options.node}.tls.csr`,
  )
  const keys = readIdentityKeys(options.configRoot, options.node)
  const isIp = /^[0-9.]+$/.test(host) || host.includes(':')
  const extensions =
    `subjectAltName=${formatNodeSanEntries({
      node: options.node,
      publicKey: keys.publicKey,
      dnsNames: isIp ? [] : [host],
      ipAddresses: isIp ? [host] : [],
    })}\n` +
    'basicConstraints=CA:FALSE\n' +
    'extendedKeyUsage=serverAuth,clientAuth\n'

  const scratch = join(ctx.workdir, `expired-${options.node}`)
  mkdirSync(scratch, { recursive: true })
  const extPath = join(scratch, 'ext.cnf')
  writeFileSync(extPath, extensions, { mode: 0o600 })

  // 一整年前签发、一天后就到期 —— 「过去某一刻起、过去某一刻止」。
  const stamp = (at: number): string => {
    const iso = new Date(at).toISOString()
    return `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`
  }
  const day = 24 * 60 * 60 * 1000
  const signed = Bun.spawnSync([
    'openssl',
    'x509',
    '-req',
    '-in',
    csrPath,
    '-CA',
    ca.certificatePath,
    '-CAkey',
    join(ca.dir, 'ca.key'),
    '-CAcreateserial',
    '-CAserial',
    join(ca.dir, 'ca.srl'),
    '-not_before',
    stamp(Date.now() - 400 * day),
    '-not_after',
    stamp(Date.now() - 30 * day),
    '-extfile',
    extPath,
  ])
  if (signed.exitCode !== 0) {
    throw new Error(
      `openssl 签发过期证书失败: ${signed.stderr.toString().slice(0, 800)}`,
    )
  }
  const pem = signed.stdout.toString()
  const out = join(ctx.workdir, options.outName)
  writeFileSync(out, pem, { mode: 0o644 })
  return {
    node: options.node,
    configRoot: options.configRoot,
    pem,
    path: out,
    fingerprint256: new X509Certificate(pem).fingerprint256,
    nodePublicKey: keys.publicKey,
    keys,
  }
}
