// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `model-apply-enroll.sh` 的契约（P18.13，`providers-console-m1.md` §2.9 第 2 步）。
 *
 * 三台「机器」是三个临时家目录：运维本机、中枢 H、节点。机器之间只有 PATH 上那个
 * `ssh` 桩，它分两种来电演：
 *
 *   · 运维本机发起的（没有 `-i`）：按 ssh 目标找到那台机器，以它的 HOME 跑命令；
 *   · 中枢执行器那一路（带 `-i`，即 `hub-verify`）：演 sshd —— 先按 `UserKnownHostsFile`
 *     核主机钥，再按 `-i` 那把私钥的公钥在节点 `authorized_keys` 里找第一条匹配行，
 *     有 `command="…"` 就跑它（`SSH_ORIGINAL_COMMAND` = 客户端发来的哨兵），没有就跑哨兵本身。
 *
 * 强制命令跑的是**仓库里真的 `model-apply.sh`**（部署树里软链过去），它再起 PATH 上的
 * `bun` 桩演 `provider serve-stdin`。于是「装上去的那一行真能用」是端到端核过的，
 * 而不只是字符串长得对。主机钥、专用 key 都是真 `ssh-keygen` 生成的。
 *
 * 每个 bash 各跑一遍（`testBashes.ts`）：远端的 `bash` 也换成同一个（桩目录里的软链）。
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { type TestBash, testBashes } from '../testBashes'

const REPOSITORY_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const SCRIPT = join(REPOSITORY_ROOT, 'demo/env/beta/ops/model-apply-enroll.sh')
const BASHES = testBashes()
const NODE = 'beta-2'
/**
 * 节点「机器」的登录用户。node-install 拿 `id -un` 与坐标行的 user 比，桩里换不了 uid，
 * 所以坐标行与假 sshd 都用跑用例的这个用户名。
 */
const LOCAL_USER = userInfo().username
const SENTINEL = 'qianmo-model-apply-v1'
/** 每条用例要起几十个进程；macOS 上第一次 exec 新文件还会被扫一遍。 */
const SLOW = 60_000

const BASE = mkdtempSync(join(tmpdir(), 'qm-enroll-'))
afterAll(() => rmSync(BASE, { recursive: true, force: true }))

// ── 桩（模块作用域只写一次）──────────────────────────────────────────────────

const FAKE_SSH = `#!/bin/bash
set -u
net="\${FAKE_NET:?}"
printf 'ssh %s\\n' "$*" >>"$net/ssh.log"
key='' kh='' port=22
while [ "$#" -gt 0 ]; do
  case "$1" in
    -F | -i | -o | -p)
      case "$1" in
        -i) key="$2" ;;
        -p) port="$2" ;;
        -o) case "$2" in UserKnownHostsFile=*) kh="\${2#UserKnownHostsFile=}" ;; esac ;;
      esac
      shift 2
      ;;
    -T | -x | -a | -n) shift ;;
    -*) printf 'fake ssh: unexpected option %s\\n' "$1" >&2; exit 254 ;;
    *) break ;;
  esac
done
target="$1"
shift
cmd="$*"
if [ -z "$key" ]; then
  m="$net/targets/$target"
  [ -f "$m" ] || { printf 'ssh: Could not resolve hostname %s\\n' "$target" >&2; exit 255; }
  . "$m"
  exec env -i PATH="$PATH" HOME="$M_HOME" LC_ALL=C FAKE_NET="$net" QIANMO_SSHD_HOST_KEY="$M_HOSTKEY" bash -c "$cmd"
fi
user="\${target%%@*}"
host="\${target#*@}"
m="$net/addrs/\${host}_\${port}"
[ -f "$m" ] || { printf 'ssh: connect to host %s port %s: Connection refused\\n' "$host" "$port" >&2; exit 255; }
. "$m"
name="$host"
[ "$port" = 22 ] || name="[$host]:$port"
want="$(awk '{ print $2 }' "$M_HOSTKEY")"
if [ -z "$kh" ] || [ ! -f "$kh" ] \\
  || ! ssh-keygen -F "$name" -f "$kh" 2>/dev/null | awk -v b="$want" '$3 == b { ok = 1 } END { exit ok ? 0 : 1 }'; then
  printf 'Host key verification failed.\\n' >&2
  exit 255
fi
[ "$user" = "$M_USER" ] || { printf '%s: Permission denied (publickey).\\n' "$target" >&2; exit 255; }
blob="$(ssh-keygen -y -f "$key" | awk '{ print $2 }')"
line="$(grep -F " $blob" "$M_HOME/.ssh/authorized_keys" 2>/dev/null | head -n 1)"
[ -n "$line" ] || { printf '%s: Permission denied (publickey).\\n' "$target" >&2; exit 255; }
forced="$(printf '%s\\n' "$line" | sed -n 's/^command="\\([^"]*\\)".*/\\1/p')"
if [ -n "$forced" ]; then
  exec env -i PATH="$PATH" HOME="$M_HOME" LC_ALL=C FAKE_NET="$net" SSH_ORIGINAL_COMMAND="$cmd" bash -c "$forced"
fi
exec env -i PATH="$PATH" HOME="$M_HOME" LC_ALL=C FAKE_NET="$net" bash -c "$cmd"
`

const FAKE_KEYSCAN = `#!/bin/bash
net="\${FAKE_NET:?}"
port=22 host=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -T | -t) shift 2 ;;
    -p) port="$2"; shift 2 ;;
    -*) shift ;;
    *) host="$1"; shift ;;
  esac
done
printf 'keyscan %s %s\\n' "$host" "$port" >>"$net/ssh.log"
m="$net/addrs/\${host}_\${port}"
[ -f "$m" ] || exit 1
. "$m"
name="$host"
[ "$port" = 22 ] || name="[$host]:$port"
printf '# %s:%s SSH-2.0-OpenSSH_9.6\\n' "$host" "$port" >&2
printf '%s %s\\n' "$name" "$(awk '{ print $1 " " $2 }' "\${M_SCAN_KEY:-$M_HOSTKEY}")"
`

/** 演 `bun <occ> provider serve-stdin --node <n>`：记下怎么被起的，回一行 status。 */
const FAKE_BUN = `#!/bin/bash
{
  printf 'ARGV %s\\n' "$*"
  printf 'OCC_CONFIG_DIR=%s\\n' "\${OCC_CONFIG_DIR-<unset>}"
  printf 'SSH_ORIGINAL_COMMAND=%s\\n' "\${SSH_ORIGINAL_COMMAND-<unset>}"
} >>"$HOME/serve-stdin.calls"
IFS= read -r req
rid="$(printf '%s' "$req" | sed -n 's/.*"requestId":"\\([^"]*\\)".*/\\1/p')"
printf '{"v":1,"requestId":"%s","ok":true,"state":{"managed":false,"applied":null}}\\n' "$rid"
`

function writeExec(path: string, body: string): void {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

function binFor(bash: TestBash): string {
  const dir = join(
    BASE,
    `bin-${bash.major}-${bash.version.replace(/[^0-9.]/g, '')}`,
  )
  if (existsSync(dir)) return dir
  mkdirSync(dir, { recursive: true })
  writeExec(join(dir, 'ssh'), FAKE_SSH)
  writeExec(join(dir, 'ssh-keyscan'), FAKE_KEYSCAN)
  writeExec(join(dir, 'bun'), FAKE_BUN)
  symlinkSync(bash.path, join(dir, 'bash'))
  return dir
}

/** 部署树：只放用得到的几份，软链回仓库（跑的就是当前这一份）。 */
function deployTree(name: string, withModelApply: boolean): string {
  const tree = join(BASE, 'trees', name)
  const ops = join(tree, 'demo/env/beta/ops')
  mkdirSync(ops, { recursive: true })
  mkdirSync(join(tree, 'dist'), { recursive: true })
  writeFileSync(join(tree, 'dist/cli-node.js'), '// 构建产物占位\n')
  const link = (rel: string) =>
    symlinkSync(join(REPOSITORY_ROOT, rel), join(tree, rel))
  link('demo/env/beta/common.sh')
  link('demo/env/beta/ops/model-apply-enroll.sh')
  if (withModelApply) link('demo/env/beta/ops/model-apply.sh')
  return tree
}

const HUB_TREE = deployTree('hub', true)
const NODE_TREE = deployTree('node', true)
const BARE_TREE = deployTree('bare', false)
const NODE_TREE_LINK = join(BASE, 'trees', 'node-current')
symlinkSync(NODE_TREE, NODE_TREE_LINK)

function keygen(path: string, comment: string): string {
  const child = Bun.spawnSync(
    ['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', path],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  if (child.exitCode !== 0) throw new Error(child.stderr.toString())
  return readFileSync(`${path}.pub`, 'utf8').trim()
}

mkdirSync(join(BASE, 'keys'), { recursive: true })
const NODE_HOSTKEY = join(BASE, 'keys/node-host')
const OTHER_HOSTKEY = join(BASE, 'keys/other-host')
const NODE_HOSTKEY_PUB = keygen(NODE_HOSTKEY, 'root@node')
const OTHER_HOSTKEY_PUB = keygen(OTHER_HOSTKEY, 'root@mallory')
const blobOf = (pub: string) => pub.split(' ')[1] ?? ''

// ── 一个世界 ────────────────────────────────────────────────────────────────

interface World {
  readonly dir: string
  readonly net: string
  readonly opsHome: string
  readonly hubHome: string
  readonly nodeHome: string
}

interface WorldOptions {
  /** peers.conf 里那条坐标行；`null` = 不写坐标行。 */
  readonly coordinate?: string | null
  /** 坐标行里的 host / port（ssh 桩据此找到节点）。 */
  readonly host?: string
  readonly port?: number
  /** 节点上有没有这个节点的配置根。 */
  readonly configRoot?: boolean
  /** 从 H 扫到的主机钥换成别的（中间人 / 坐标指错了机器）。 */
  readonly mitm?: boolean
  /** 坐标行里的 user（缺省 = 跑用例的用户）。 */
  readonly user?: string
}

let worldCount = 0

function machineFile(
  home: string,
  user: string,
  extra: Record<string, string> = {},
): string {
  const lines = [
    `M_HOME='${home}'`,
    `M_USER='${user}'`,
    `M_HOSTKEY='${NODE_HOSTKEY}.pub'`,
  ]
  for (const [k, v] of Object.entries(extra)) lines.push(`${k}='${v}'`)
  return `${lines.join('\n')}\n`
}

function makeWorld(options: WorldOptions = {}): World {
  worldCount += 1
  const dir = join(BASE, `w${worldCount}`)
  const net = join(dir, 'net')
  const opsHome = join(dir, 'ops')
  const hubHome = join(dir, 'hub')
  const nodeHome = join(dir, 'node')
  for (const d of [
    join(net, 'targets'),
    join(net, 'addrs'),
    opsHome,
    join(hubHome, 'qianmo-beta'),
    join(nodeHome, 'qianmo-beta'),
  ]) {
    mkdirSync(d, { recursive: true })
  }
  const host = options.host ?? 'node2.example'
  const port = options.port ?? 2222
  const coordinate =
    options.coordinate === undefined
      ? `node ${NODE} user=${options.user ?? LOCAL_USER} host=${host} port=${port} local-port=38632`
      : options.coordinate
  writeFileSync(
    join(hubHome, 'qianmo-beta/peers.conf'),
    [
      `qianmo://${NODE}/planner ws://127.0.0.1:38632`,
      ...(coordinate === null ? [] : [coordinate]),
      '',
    ].join('\n'),
  )
  if (options.configRoot !== false) {
    mkdirSync(join(nodeHome, 'qianmo-beta/nodes', NODE, 'config'), {
      recursive: true,
    })
  }
  writeFileSync(join(net, 'targets/hub-h'), machineFile(hubHome, 'ops'))
  const node = machineFile(
    nodeHome,
    LOCAL_USER,
    options.mitm === true ? { M_SCAN_KEY: `${OTHER_HOSTKEY}.pub` } : {},
  )
  writeFileSync(join(net, 'targets/node-2'), node)
  writeFileSync(join(net, 'addrs', `${host}_${port}`), node)
  writeFileSync(join(net, 'ssh.log'), '')
  return { dir, net, opsHome, hubHome, nodeHome }
}

interface Run {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

function run(
  bash: TestBash,
  world: World,
  args: readonly string[],
  options: { home?: string; stdin?: string; env?: Record<string, string> } = {},
): Run {
  const child = Bun.spawnSync([bash.path, SCRIPT, ...args], {
    env: {
      PATH: `${binFor(bash)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: options.home ?? world.opsHome,
      FAKE_NET: world.net,
      LC_ALL: 'C',
      QIANMO_SSHD_HOST_KEY: `${NODE_HOSTKEY}.pub`,
      ...options.env,
    },
    stdin: options.stdin === undefined ? 'ignore' : Buffer.from(options.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    code: child.exitCode ?? -1,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  }
}

function enroll(
  bash: TestBash,
  world: World,
  extra: readonly string[] = [],
  nodeTree: string = NODE_TREE,
): Run {
  return run(bash, world, [
    'enroll',
    '--node',
    NODE,
    '--hub',
    'hub-h',
    '--hub-tree',
    HUB_TREE,
    '--node-ssh',
    'node-2',
    '--node-tree',
    nodeTree,
    ...extra,
  ])
}

const hubKey = (w: World) => join(w.hubHome, '.ssh/qianmo-model-apply', NODE)
const hubKnownHosts = (w: World) =>
  join(w.hubHome, '.ssh/qianmo-model-apply/known_hosts')
const authorizedKeys = (w: World) => join(w.nodeHome, '.ssh/authorized_keys')

function expectedLine(tree: string, pub: string): string {
  return `command="${tree}/demo/env/beta/ops/model-apply.sh ${NODE}",restrict ssh-ed25519 ${blobOf(pub)} qianmo-model-apply ${NODE}`
}

/** 目录树快照：相对路径 → 类型、权限位与内容摘要。 */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      const rel = path.slice(root.length)
      const st = lstatSync(path)
      if (st.isSymbolicLink()) {
        out[rel] = `link:${readlinkSync(path)}`
      } else if (st.isDirectory()) {
        out[rel] = `dir:${(st.mode & 0o777).toString(8)}`
        walk(path)
      } else {
        const digest = createHash('sha256')
          .update(readFileSync(path))
          .digest('hex')
        out[rel] = `file:${(st.mode & 0o777).toString(8)}:${digest}`
      }
    }
  }
  walk(root)
  return out
}

const mode = (path: string) => (statSync(path).mode & 0o777).toString(8)

for (const bash of BASHES) {
  describe(`model-apply-enroll.sh（bash ${bash.version}）`, () => {
    test(
      '一次登记：H 生成专用 key，节点装上逐字那一行，中枢 known_hosts 写 [host]:port，⑥ 经真 model-apply.sh 回 ok',
      () => {
        const w = makeWorld()
        const r = enroll(bash, w)
        // 远端的过程话走 stderr、原样到运维终端；这里只要求其中没有 FAIL / WARN。
        expect(r.stderr).not.toMatch(/^(FAIL|WARN)/m)
        expect(r.code).toBe(0)

        const pub = readFileSync(`${hubKey(w)}.pub`, 'utf8').trim()
        expect(pub.startsWith('ssh-ed25519 ')).toBe(true)
        expect(pub.endsWith(` qianmo-model-apply ${NODE}`)).toBe(true)
        expect(mode(hubKey(w))).toBe('600')
        expect(mode(join(w.hubHome, '.ssh/qianmo-model-apply'))).toBe('700')

        // 那一行：逐字。
        const line = expectedLine(NODE_TREE, pub)
        expect(readFileSync(authorizedKeys(w), 'utf8')).toBe(`${line}\n`)
        expect(mode(authorizedKeys(w))).toBe('600')
        expect(mode(join(w.nodeHome, '.ssh'))).toBe('700')
        expect(r.stdout).toContain(`INSTALLED：${line}`)

        // known_hosts：非 22 口写 [host]:port，钥是节点自己的主机钥。
        expect(readFileSync(hubKnownHosts(w), 'utf8')).toBe(
          `[node2.example]:2222 ssh-ed25519 ${blobOf(NODE_HOSTKEY_PUB)}\n`,
        )
        expect(mode(hubKnownHosts(w))).toBe('600')

        // ⑥：中枢执行器的参数、哨兵；强制命令跑的是真 model-apply.sh，它不把
        // SSH_ORIGINAL_COMMAND 往下传，在节点配置根下起 serve-stdin。
        const log = readFileSync(join(w.net, 'ssh.log'), 'utf8')
        expect(log).toContain(
          `-o StrictHostKeyChecking=yes -o UserKnownHostsFile=${hubKnownHosts(w)} -o GlobalKnownHostsFile=/dev/null`,
        )
        expect(log).toContain(`-p 2222 ${LOCAL_USER}@node2.example ${SENTINEL}`)
        const calls = readFileSync(
          join(w.nodeHome, 'serve-stdin.calls'),
          'utf8',
        )
        expect(calls).toContain(`provider serve-stdin --node ${NODE}`)
        expect(calls).toContain(
          `OCC_CONFIG_DIR=${join(w.nodeHome, 'qianmo-beta/nodes', NODE, 'config')}`,
        )
        expect(calls).toContain('SSH_ORIGINAL_COMMAND=<unset>')
        expect(r.stdout).toContain('VERIFY ok managed=false')
        expect(r.stdout).toContain(
          'systemctl --user restart qianmo-console.service',
        )

        // 私钥一个字节都没离开 H。
        const privateKey = readFileSync(hubKey(w), 'utf8')
        const everything = `${r.stdout}${r.stderr}${log}${readFileSync(authorizedKeys(w), 'utf8')}`
        expect(everything).not.toContain('PRIVATE KEY')
        expect(everything).not.toContain(privateKey.split('\n')[1] ?? '∅')
      },
      SLOW,
    )

    test(
      '幂等：再跑一次什么都不改（同一把 key、同一行、同一条 known_hosts、不多备份）；原有内容一个字节不动',
      () => {
        const w = makeWorld()
        // 节点上原有两行，最后一行没有换行。
        mkdirSync(join(w.nodeHome, '.ssh'), { recursive: true, mode: 0o700 })
        const prior =
          'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExistingExistingExistingExistingExist1 alice\nrestrict,port-forwarding ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITunnelTunnelTunnelTunnelTunnelTunnel12 tunnel'
        writeFileSync(authorizedKeys(w), prior, { mode: 0o600 })

        const first = enroll(bash, w)
        expect(first.code).toBe(0)
        const pub = readFileSync(`${hubKey(w)}.pub`, 'utf8').trim()
        expect(readFileSync(authorizedKeys(w), 'utf8')).toBe(
          `${prior}\n${expectedLine(NODE_TREE, pub)}\n`,
        )
        const backups = readdirSync(join(w.nodeHome, '.ssh')).filter(n =>
          n.startsWith('authorized_keys.bak-'),
        )
        expect(backups).toHaveLength(1)
        expect(
          readFileSync(join(w.nodeHome, '.ssh', backups[0] ?? ''), 'utf8'),
        ).toBe(prior)

        const hubBefore = snapshot(w.hubHome)
        const nodeBefore = snapshot(join(w.nodeHome, '.ssh'))
        const second = enroll(bash, w)
        expect(second.code).toBe(0)
        expect(second.stdout).toContain('PRESENT：')
        expect(second.stdout).toContain('VERIFY ok')
        expect(snapshot(w.hubHome)).toEqual(hubBefore)
        expect(snapshot(join(w.nodeHome, '.ssh'))).toEqual(nodeBefore)
        expect(second.stderr).toContain('已在')
      },
      SLOW,
    )

    test(
      'dry-run：新世界与「key 已在、还没装」两种情形下，三台机器一个文件都不变，也不连节点做 ⑥',
      () => {
        const w = makeWorld()
        const all = () => ({
          ops: snapshot(w.opsHome),
          hub: snapshot(w.hubHome),
          node: snapshot(w.nodeHome),
        })
        const before = all()
        const r = enroll(bash, w, ['--dry-run'])
        expect(r.code).toBe(0)
        expect(all()).toEqual(before)
        expect(r.stdout).toContain(
          `WOULD-ADD：command="${NODE_TREE}/demo/env/beta/ops/model-apply.sh ${NODE}",restrict ssh-ed25519 <H 上将生成的公钥> qianmo-model-apply ${NODE}`,
        )
        expect(r.stdout).toContain(
          `WOULD-ADD：[node2.example]:2222 ssh-ed25519 ${blobOf(NODE_HOSTKEY_PUB)}`,
        )
        expect(r.stdout).toContain('dry-run 结束')
        expect(readFileSync(join(w.net, 'ssh.log'), 'utf8')).not.toContain(
          SENTINEL,
        )

        // key 已在（单独跑过 hub-key）：dry-run 给出的是真那一行，仍然什么都不写。
        const key = run(bash, w, ['hub-key', '--node', NODE], {
          home: w.hubHome,
        })
        expect(key.code).toBe(0)
        const pub = readFileSync(`${hubKey(w)}.pub`, 'utf8').trim()
        const before2 = all()
        const r2 = enroll(bash, w, ['--dry-run'])
        expect(r2.code).toBe(0)
        expect(all()).toEqual(before2)
        expect(r2.stdout).toContain(
          `WOULD-ADD：${expectedLine(NODE_TREE, pub)}`,
        )
        expect(existsSync(authorizedKeys(w))).toBe(false)
        expect(existsSync(hubKnownHosts(w))).toBe(false)
      },
      SLOW,
    )

    test(
      '中间人：H 扫到的主机钥与节点经已认证通道自报的不同 → 拒绝，known_hosts 不写',
      () => {
        const w = makeWorld({ mitm: true })
        const r = enroll(bash, w)
        expect(r.code).toBe(1)
        expect(r.stderr).toContain('中间人')
        expect(existsSync(hubKnownHosts(w))).toBe(false)
        expect(readFileSync(join(w.net, 'ssh.log'), 'utf8')).not.toContain(
          SENTINEL,
        )
      },
      SLOW,
    )

    test(
      '中枢 known_hosts 里同名已登记另一把主机钥 → 拒绝、原文件不动',
      () => {
        const w = makeWorld()
        const dir = join(w.hubHome, '.ssh/qianmo-model-apply')
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        const stale = `[node2.example]:2222 ${OTHER_HOSTKEY_PUB.split(' ').slice(0, 2).join(' ')}\n`
        writeFileSync(hubKnownHosts(w), stale, { mode: 0o600 })
        const r = enroll(bash, w)
        expect(r.code).toBe(1)
        expect(r.stderr).toContain('另一把 ed25519 主机钥')
        expect(readFileSync(hubKnownHosts(w), 'utf8')).toBe(stale)
      },
      SLOW,
    )

    test(
      '同一把公钥已在 authorized_keys 但选项不同 → 拒绝、文件不动（sshd 只认第一条）',
      () => {
        const w = makeWorld()
        expect(
          run(bash, w, ['hub-key', '--node', NODE], { home: w.hubHome }).code,
        ).toBe(0)
        const pub = readFileSync(`${hubKey(w)}.pub`, 'utf8').trim()
        mkdirSync(join(w.nodeHome, '.ssh'), { recursive: true, mode: 0o700 })
        const conflicting = `restrict,port-forwarding ${pub}\n`
        writeFileSync(authorizedKeys(w), conflicting, { mode: 0o600 })
        const r = enroll(bash, w)
        expect(r.code).toBe(1)
        expect(r.stderr).toContain('已经有这把公钥')
        expect(readFileSync(authorizedKeys(w), 'utf8')).toBe(conflicting)
        expect(
          readdirSync(join(w.nodeHome, '.ssh')).filter(n =>
            n.includes('.bak-'),
          ),
        ).toEqual([])
      },
      SLOW,
    )

    test(
      '换过 key：同节点的旧 model-apply 行留着并点名 WARN，新行追加在后',
      () => {
        const w = makeWorld()
        mkdirSync(join(w.nodeHome, '.ssh'), { recursive: true, mode: 0o700 })
        const old = `command="${NODE_TREE}/demo/env/beta/ops/model-apply.sh ${NODE}",restrict ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOldOldOldOldOldOldOldOldOldOldOldOldOldOl qianmo-model-apply ${NODE}\n`
        writeFileSync(authorizedKeys(w), old, { mode: 0o600 })
        const r = enroll(bash, w)
        expect(r.code).toBe(0)
        expect(r.stderr).toContain(
          '还有 1 行别的 key 指向 beta-2 的 model-apply.sh',
        )
        const pub = readFileSync(`${hubKey(w)}.pub`, 'utf8').trim()
        expect(readFileSync(authorizedKeys(w), 'utf8')).toBe(
          `${old}${expectedLine(NODE_TREE, pub)}\n`,
        )
      },
      SLOW,
    )

    test(
      '强制命令那一行没了（被改成裸公钥）：hub-verify 不回 ok，退出码 127 点名哨兵',
      () => {
        const w = makeWorld()
        expect(enroll(bash, w).code).toBe(0)
        const pub = readFileSync(`${hubKey(w)}.pub`, 'utf8').trim()
        writeFileSync(authorizedKeys(w), `${pub}\n`, { mode: 0o600 })
        const r = run(bash, w, ['hub-verify', '--node', NODE], {
          home: w.hubHome,
        })
        expect(r.code).toBe(1)
        expect(r.stderr).toContain('退出码 127')
        expect(r.stderr).toContain(SENTINEL)
        expect(r.stdout).toBe('')
      },
      SLOW,
    )

    test(
      '经 --node-ssh 登录的不是中枢要拨的那个用户 → ③ 拒绝，什么都没装',
      () => {
        const w = makeWorld({ user: 'someone-else' })
        const r = enroll(bash, w)
        expect(r.code).toBe(1)
        expect(r.stderr).toContain(
          `登录的是 ${LOCAL_USER}，而中枢按 peers.conf 拨的是 someone-else`,
        )
        expect(existsSync(authorizedKeys(w))).toBe(false)
      },
      SLOW,
    )

    test(
      '没有 node 坐标行（跑在 H 上 / 直连）→ ② 拒绝，节点上什么都没写',
      () => {
        const w = makeWorld({ coordinate: null })
        const r = enroll(bash, w)
        expect(r.code).toBe(1)
        expect(r.stderr).toContain('没有 node 坐标行')
        expect(existsSync(join(w.nodeHome, '.ssh'))).toBe(false)
      },
      SLOW,
    )

    test(
      '节点上没有这个节点的配置根 / 部署树里没有 model-apply.sh → ③ 拒绝，authorized_keys 不建',
      () => {
        const noRoot = makeWorld({ configRoot: false })
        const r1 = enroll(bash, noRoot)
        expect(r1.code).toBe(1)
        expect(r1.stderr).toContain('配置根')
        expect(existsSync(authorizedKeys(noRoot))).toBe(false)

        const bare = makeWorld()
        const r2 = enroll(bash, bare, [], BARE_TREE)
        expect(r2.code).toBe(1)
        expect(r2.stderr).toContain('不在或不可执行')
        expect(existsSync(authorizedKeys(bare))).toBe(false)
      },
      SLOW,
    )

    test(
      '节点会话设了别的 QIANMO_BETA_ROOT → 拒绝（sshd 强制命令下只看默认根）',
      () => {
        const w = makeWorld()
        const r = run(bash, w, ['node-install', '--node', NODE], {
          home: w.nodeHome,
          stdin: `PUBKEY ${NODE_HOSTKEY_PUB}\n`,
          env: { QIANMO_BETA_ROOT: join(w.dir, 'elsewhere') },
        })
        expect(r.code).toBe(1)
        expect(r.stderr).toContain('只看')
        expect(existsSync(authorizedKeys(w))).toBe(false)
      },
      SLOW,
    )

    test(
      'IPv6 坐标、默认 22 口：known_hosts 写裸地址；部署根是软链时强制命令走软链（逻辑路径）',
      () => {
        const w = makeWorld({ host: '2001:db8::7', port: 22 })
        writeFileSync(
          join(w.hubHome, 'qianmo-beta/peers.conf'),
          `qianmo://${NODE}/planner ws://127.0.0.1:38632\nnode ${NODE} user=${LOCAL_USER} host=2001:db8::7 local-port=38632\n`,
        )
        const r = enroll(bash, w, [], NODE_TREE_LINK)
        // 远端的过程话走 stderr、原样到运维终端；这里只要求其中没有 FAIL / WARN。
        expect(r.stderr).not.toMatch(/^(FAIL|WARN)/m)
        expect(r.code).toBe(0)
        expect(readFileSync(hubKnownHosts(w), 'utf8')).toBe(
          `2001:db8::7 ssh-ed25519 ${blobOf(NODE_HOSTKEY_PUB)}\n`,
        )
        const pub = readFileSync(`${hubKey(w)}.pub`, 'utf8').trim()
        expect(readFileSync(authorizedKeys(w), 'utf8')).toBe(
          `${expectedLine(NODE_TREE_LINK, pub)}\n`,
        )
        expect(readFileSync(join(w.net, 'ssh.log'), 'utf8')).toContain(
          `-p 22 ${LOCAL_USER}@2001:db8::7 ${SENTINEL}`,
        )
      },
      SLOW,
    )

    test(
      '用法错退 2：部署根含空格 / 相对路径、节点名带大写、ssh 目标以 - 开头',
      () => {
        const w = makeWorld()
        const base = [
          '--node',
          NODE,
          '--hub',
          'hub-h',
          '--hub-tree',
          HUB_TREE,
          '--node-ssh',
          'node-2',
        ]
        for (const args of [
          ['enroll', ...base, '--node-tree', '/srv/qm tree'],
          ['enroll', ...base, '--node-tree', 'qianmo-tree'],
          ['enroll', ...base, '--node-tree', `${NODE_TREE}/../node`],
          [
            'enroll',
            '--node',
            'Beta-2',
            ...base.slice(2),
            '--node-tree',
            NODE_TREE,
          ],
          [
            'enroll',
            '--node',
            NODE,
            '--hub',
            '-oProxyCommand=x',
            '--hub-tree',
            HUB_TREE,
            '--node-ssh',
            'node-2',
            '--node-tree',
            NODE_TREE,
          ],
          ['bogus'],
        ]) {
          const r = run(bash, w, args)
          expect({ args, code: r.code }).toEqual({ args, code: 2 })
        }
        expect(readFileSync(join(w.net, 'ssh.log'), 'utf8')).toBe('')
      },
      SLOW,
    )

    test(
      'authorized-key 纯函数：从 stdin 读公钥打印那一行，私钥文件拒收',
      () => {
        const w = makeWorld()
        const r = run(
          bash,
          w,
          ['authorized-key', '--node', NODE, '--pubkey-file', '-'],
          {
            stdin: `${NODE_HOSTKEY_PUB}\n`,
          },
        )
        expect(r.code).toBe(0)
        expect(r.stdout).toBe(
          `command="${REPOSITORY_ROOT}/demo/env/beta/ops/model-apply.sh ${NODE}",restrict ssh-ed25519 ${blobOf(NODE_HOSTKEY_PUB)} qianmo-model-apply ${NODE}\n`,
        )
        const priv = run(bash, w, [
          'authorized-key',
          '--node',
          NODE,
          '--pubkey-file',
          NODE_HOSTKEY,
        ])
        expect(priv.code).toBe(1)
        expect(priv.stdout).toBe('')
      },
      SLOW,
    )
  })
}

test('这台机器上至少找到一个 bash', () => {
  expect(BASHES.length).toBeGreaterThan(0)
})
