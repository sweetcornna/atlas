// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { testBashes } from './testBashes'
import { processAlive, TestProcessTable } from './testProcessTable'

const common = path.join(import.meta.dir, 'common.sh')
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})

// Very large fixture PIDs avoid reading another process through /proc on Linux.
// A deterministic process table also exercises the safety contracts in sandboxes that
// prohibit ps and sockets. Signals change the fixture state, never the host's processes.
function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beta-node-identity-'))
  roots.push(dir)
  const root = path.join(dir, 'beta')
  for (const sub of ['run', 'logs', 'state', 'nodes/rowan/config'])
    fs.mkdirSync(path.join(root, sub), { recursive: true })
  fs.mkdirSync(path.join(dir, 'home'))
  fs.writeFileSync(path.join(root, '.qianmo-beta-env'), 'qianmo-beta-env/v1\n')
  return { dir, root }
}

const processSignals = String.raw`
reuse_child() {
  [ -f "$FIXTURE/reuse-child" ] || return 0
  printf '99\n' >"$FIXTURE/2147483002.ppid"
  printf 'replacement\n' >"$FIXTURE/2147483002.start"
  printf '2147483002 (unrelated) S 99 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 9999\n' >"$FIXTURE/proc/2147483002/stat"
}
# Reuse the child's PID after enumeration captured its tuple and before lineage is
# verified: wrap the verifier once, whichever copy of common.sh defined it.
if ! declare -F beta_test_collect_descendants >/dev/null; then
  eval "beta_test_collect_descendants$(declare -f beta_collect_descendants | sed 1s/^beta_collect_descendants//)"
  beta_collect_descendants() { reuse_child; beta_test_collect_descendants "$@"; }
fi
ps() {
  local pid opts="$*" file
  for pid in "$@"; do :; done
  case "$opts" in
    *pid=,ppid=*)
      for file in "$FIXTURE"/*.ppid; do
        [ -f "$file" ] || continue
        printf '%s %s\n' "$(basename "$file" .ppid)" "$(cat "$file")"
        reuse_child
      done ;;
    *pid=,args=*)
      for file in "$FIXTURE"/*.args; do
        [ -f "$file" ] || continue
        printf '%s %s\n' "$(basename "$file" .args)" "$(cat "$file")"
      done ;;
    *lstart=*) cat "$FIXTURE/$pid.start" ;;
    *stat=*) cat "$FIXTURE/$pid.stat" ;;
    *command=*) cat "$FIXTURE/$pid.env" ;;
    *args=*) cat "$FIXTURE/$pid.args" ;;
    *) return 1 ;;
  esac
}
kill() {
  local sig="$1" pid="$2"
  if [ "$sig" = -0 ]; then [ -s "$FIXTURE/$pid.stat" ]; return; fi
  printf '%s %s\n' "$sig" "$pid" >>"$FIXTURE/signals"
  if [ "$sig" = -KILL ] || [ ! -f "$FIXTURE/$pid.ignore-term" ]; then
    : >"$FIXTURE/$pid.stat"
    printf '%s (exited) Z 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 100\n' "$pid" >"$FIXTURE/proc/$pid/stat"
  fi
}
sleep() { :; }
`
const processTable =
  String.raw`
beta_proc_dir() { printf '%s/proc/%s\n' "$FIXTURE" "$1"; }
beta_proc_dirs() { printf '%s\n' "$FIXTURE"/proc/[0-9]*; }
` + processSignals

function procStatus(
  w: { dir: string },
  pid: number,
  effective: number,
  real = effective,
) {
  fs.writeFileSync(
    path.join(w.dir, 'proc', String(pid), 'status'),
    `Name:\tfixture\nUid:\t${real}\t${effective}\t${real}\t${real}\n`,
  )
}

function procStat(w: { dir: string }, pid: number, flags: number) {
  const fields = Array(20).fill('0')
  fields[0] = 'S'
  fields[1] = '99'
  fields[6] = String(flags) // /proc stat field 9, after removing PID and comm.
  fields[19] = '100'
  fs.writeFileSync(
    path.join(w.dir, 'proc', String(pid), 'stat'),
    `${pid} (worker ) tricky comm) ${fields.join(' ')}\n`,
  )
}

// Both OSes execute the production procfs accessors, enumeration and parser. Only
// fixed paths and the observer UID in this temporary copy change; no env bypass.
function scanCommon(w: { dir: string }, uid: number): string {
  const beta = path.join(w.dir, 'repo/demo/env/beta')
  fs.mkdirSync(beta, { recursive: true })
  fs.mkdirSync(path.join(w.dir, 'proc/self'), { recursive: true })
  const copy = path.join(beta, 'common.sh')
  fs.writeFileSync(
    copy,
    fs
      .readFileSync(common, 'utf8')
      .replaceAll('/proc/', `${w.dir}/proc/`)
      .replace('uid="$EUID"', `uid="${uid}"`) + processSignals,
  )
  fs.copyFileSync(
    path.join(import.meta.dir, 'beta-down.sh'),
    path.join(beta, 'beta-down.sh'),
  )
  return copy
}

function unreadableProcess(w: { dir: string; root: string }, uid: number) {
  const pid = 2147483001
  processFixture(w, pid, 'unrelated')
  procStatus(w, pid, uid, 1000)
  // exe/environ are inaccessible and argv is empty, like a kernel thread or a
  // protected foreign process. A same-UID userspace process must still fail closed.
  fs.unlinkSync(path.join(w.dir, `proc/${pid}/exe`))
  fs.unlinkSync(path.join(w.dir, `proc/${pid}/environ`))
  fs.writeFileSync(path.join(w.dir, `proc/${pid}/cmdline`), '')
  return pid
}

function processFixture(
  w: { dir: string; root: string },
  pid: number,
  node: string,
  root = w.root,
) {
  fs.writeFileSync(
    path.join(w.dir, `${pid}.args`),
    `bun qm resident --node ${node} --agent ops=${w.root}/workspaces/${node}/ops\n`,
  )
  fs.writeFileSync(
    path.join(w.dir, `${pid}.env`),
    `QIANMO_CONFIG_DIR=${root}/nodes/${node}/config\n`,
  )
  fs.writeFileSync(
    path.join(w.dir, `${pid}.start`),
    `Mon Oct 12 09:00:00 2026\n`,
  )
  fs.writeFileSync(path.join(w.dir, `${pid}.stat`), 'S\n')
  const proc = path.join(w.dir, 'proc', String(pid))
  fs.mkdirSync(proc, { recursive: true })
  fs.symlinkSync(process.execPath, path.join(proc, 'exe'))
  fs.writeFileSync(
    path.join(proc, 'cmdline'),
    [process.execPath, common, 'resident', '--node', node].join('\0') + '\0',
  )
  fs.writeFileSync(
    path.join(proc, 'environ'),
    `QIANMO_CONFIG_DIR=${root}/nodes/${node}/config\0`,
  )
  procStatus(w, pid, process.geteuid?.() ?? -1)
  fs.writeFileSync(
    path.join(proc, 'stat'),
    `${pid} (qm ) worker) S 99 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 100\n`,
  )
}

function run(
  bash: string,
  w: { dir: string; root: string },
  body: string,
  provider = processTable,
  commonFile = common,
) {
  const child = Bun.spawnSync(
    [
      bash,
      '-c',
      `set -euo pipefail\n. "$1"\n${provider}\n${body}`,
      'identity-test',
      commonFile,
    ],
    {
      env: {
        HOME: path.join(w.dir, 'home'),
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        QIANMO_BETA_ROOT: w.root,
        FIXTURE: w.dir,
        QIANMO_QM_BINARY: common,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  return {
    code: child.exitCode,
    out: child.stdout.toString(),
    err: child.stderr.toString(),
  }
}

for (const bash of testBashes()) {
  describe(`node safety and launch metadata (${bash.version})`, () => {
    for (const view of [
      'root with kernel threads',
      'non-root with foreign processes',
    ]) {
      const uid = view.startsWith('root') ? 0 : 1000
      function scannedWorld() {
        const w = world()
        processFixture(w, 2147483000, 'rowan')
        procStatus(w, 2147483000, 1000, 0)
        const excluded = unreadableProcess(w, 0)
        if (uid === 0) procStat(w, excluded, 0x00200000 | 2)
        else {
          // A foreign effective UID must be excluded before stat or identity,
          // even when its real UID matches and kill -0 succeeds in the fixture.
          fs.unlinkSync(path.join(w.dir, `proc/${excluded}/stat`))
        }
        return { w, excluded, copy: scanCommon(w, uid) }
      }

      test(`${view}: missing PID recovery finds and stops only the resident`, () => {
        const { w, excluded, copy } = scannedWorld()
        const recovered = run(bash.path, w, 'beta_node_pids rowan', '', copy)
        expect(recovered).toEqual({ code: 0, out: '2147483000\n', err: '' })
        const stopped = run(bash.path, w, 'beta_stop_node rowan', '', copy)
        expect({ code: stopped.code, err: stopped.err }).toEqual({
          code: 0,
          err: '',
        })
        expect(fs.readFileSync(path.join(w.dir, 'signals'), 'utf8')).toBe(
          '-TERM 2147483000\n',
        )
        expect(
          fs.readFileSync(path.join(w.dir, `${excluded}.stat`), 'utf8'),
        ).toBe('S\n')
      })

      test(`${view}: beta-down all completes and a repeated stop remains successful`, () => {
        const { w, excluded, copy } = scannedWorld()
        fs.writeFileSync(path.join(w.root, 'run/rowan.pid'), '2147483000\n')
        const stopped = run(
          bash.path,
          w,
          'set --; . "$FIXTURE/repo/demo/env/beta/beta-down.sh"',
          '',
          copy,
        )
        expect({ code: stopped.code, err: stopped.err }).toEqual({
          code: 0,
          err: '',
        })
        expect(fs.existsSync(path.join(w.root, 'run/rowan.pid'))).toBe(false)
        expect(run(bash.path, w, 'beta_stop_node rowan', '', copy).code).toBe(0)
        expect(fs.readFileSync(path.join(w.dir, 'signals'), 'utf8')).toBe(
          '-TERM 2147483000\n',
        )
        expect(
          fs.readFileSync(path.join(w.dir, `${excluded}.stat`), 'utf8'),
        ).toBe('S\n')
      })
    }

    for (const view of [
      'root with another UID',
      'non-root with the same effective UID',
    ]) {
      test(`${view}: unreadable userspace identity aborts recovery and all-stop`, () => {
        const w = world()
        processFixture(w, 2147483000, 'rowan')
        procStatus(w, 2147483000, 1000)
        const uid = view.startsWith('root') ? 0 : 1000
        const candidate = unreadableProcess(w, uid === 0 ? 2000 : 1000)
        procStat(w, candidate, 0)
        if (uid !== 0) procStatus(w, candidate, 1000, 0)
        const copy = scanCommon(w, uid)
        const recovered = run(bash.path, w, 'beta_node_pids rowan', '', copy)
        expect(recovered.code).toBe(2)
        expect(recovered.err).toContain(`无法读取进程 ${candidate} 的身份`)
        const stopped = run(bash.path, w, 'beta_stop_node rowan', '', copy)
        expect(stopped.code).toBe(3)
        expect(fs.existsSync(path.join(w.dir, 'signals'))).toBe(false)
        // With the node recorded, stop succeeds but the post-stop scan must still
        // report the unreadable candidate rather than claim a successful all-stop.
        fs.writeFileSync(path.join(w.root, 'run/rowan.pid'), '2147483000\n')
        const all = run(
          bash.path,
          w,
          'set --; . "$FIXTURE/repo/demo/env/beta/beta-down.sh"',
          '',
          copy,
        )
        expect(all.code).not.toBe(0)
        expect(all.err).toContain(`无法读取进程 ${candidate} 的身份`)
        expect(fs.readFileSync(path.join(w.dir, 'signals'), 'utf8')).toBe(
          '-TERM 2147483000\n',
        )
      })
    }

    // Linux hides exe/environ of non-dumpable processes (sshd sessions, services
    // that dropped privileges to this UID) even from their own UID, while cmdline
    // stays readable. GitHub's Linux runner always has one; so does any node an
    // operator reaches over SSH.
    function hiddenProcess(w: { dir: string; root: string }, argv: string) {
      const hidden = unreadableProcess(w, 1000)
      procStat(w, hidden, 0)
      fs.writeFileSync(path.join(w.dir, `proc/${hidden}/cmdline`), argv)
      return hidden
    }

    test('a non-dumpable same-UID process whose argv cannot name the node is skipped', () => {
      for (const argv of [
        'sshd: runner@notty\0',
        '/usr/bin/bun\0qm\0resident\0--node\0rowan-2\0',
        '/usr/bin/bun\0qm\0console\0--node\0rowan\0',
      ]) {
        const w = world()
        processFixture(w, 2147483000, 'rowan')
        procStatus(w, 2147483000, 1000)
        const hidden = hiddenProcess(w, argv)
        const copy = scanCommon(w, 1000)
        expect(run(bash.path, w, 'beta_node_pids rowan', '', copy)).toEqual({
          code: 0,
          out: '2147483000\n',
          err: '',
        })
        const stopped = run(bash.path, w, 'beta_stop_node rowan', '', copy)
        expect({ code: stopped.code, err: stopped.err }).toEqual({
          code: 0,
          err: '',
        })
        expect(fs.readFileSync(path.join(w.dir, 'signals'), 'utf8')).toBe(
          '-TERM 2147483000\n',
        )
        expect(
          fs.readFileSync(path.join(w.dir, `${hidden}.stat`), 'utf8'),
        ).toBe('S\n')
      }
    })

    test('a non-dumpable process whose argv may name the node still aborts the scan', () => {
      for (const argv of [
        '/usr/bin/bun\0qm\0resident\0--node\0rowan\0',
        '/usr/bin/bun\0qm\0resident\0--node=rowan\0',
        // The last word lost its NUL: the prefilter still counts it.
        '/usr/bin/bun\0qm\0resident\0--node\0rowan',
      ]) {
        const w = world()
        processFixture(w, 2147483000, 'rowan')
        procStatus(w, 2147483000, 1000)
        const hidden = hiddenProcess(w, argv)
        const copy = scanCommon(w, 1000)
        const recovered = run(bash.path, w, 'beta_node_pids rowan', '', copy)
        expect(recovered.code).toBe(2)
        expect(recovered.err).toContain(`无法读取进程 ${hidden} 的身份`)
        // The stop path refuses too: not even the readable resident is signalled.
        const stopped = run(bash.path, w, 'beta_stop_node rowan', '', copy)
        expect(stopped.code).toBe(3)
        expect(stopped.err).toContain(`无法读取进程 ${hidden} 的身份`)
        expect(fs.existsSync(path.join(w.dir, 'signals'))).toBe(false)
      }
    })

    test('a node named resident is still found in both qm entry forms, duplicates included', () => {
      for (const compiled of [false, true]) {
        const w = world()
        for (const pid of [2147483000, 2147483003]) {
          processFixture(w, pid, 'resident')
          if (!compiled) continue
          const proc = path.join(w.dir, `proc/${pid}`)
          fs.unlinkSync(path.join(proc, 'exe'))
          fs.symlinkSync(common, path.join(proc, 'exe'))
          fs.writeFileSync(
            path.join(proc, 'cmdline'),
            `${common}\0resident\0--node\0resident\0`,
          )
        }
        expect(run(bash.path, w, 'beta_node_pids resident')).toEqual({
          code: 0,
          out: '2147483000\n2147483003\n',
          err: '',
        })
      }
    })

    test('an empty userspace cmdline is an identity error, never evidence of PF_KTHREAD', () => {
      const w = world()
      processFixture(w, 2147483000, 'rowan')
      procStat(w, 2147483000, 0)
      fs.writeFileSync(path.join(w.dir, 'proc/2147483000/cmdline'), '')
      const scanned = run(
        bash.path,
        w,
        'beta_node_pids rowan',
        '',
        scanCommon(w, 0),
      )
      expect(scanned.code).toBe(2)
      expect(scanned.err).toContain('无法读取进程 2147483000 的身份')
      expect(fs.existsSync(path.join(w.dir, 'signals'))).toBe(false)
    })

    test('root can scan userspace PID 1 but cannot signal it or report it stopped', () => {
      const w = world()
      processFixture(w, 1, 'rowan')
      const copy = scanCommon(w, 0)
      expect(run(bash.path, w, 'beta_node_pids rowan', '', copy)).toEqual({
        code: 0,
        out: '1\n',
        err: '',
      })
      const stopped = run(bash.path, w, 'beta_stop_node rowan', '', copy)
      expect(stopped.code).toBe(3)
      expect(fs.existsSync(path.join(w.dir, 'signals'))).toBe(false)
      expect(fs.readFileSync(path.join(w.dir, '1.stat'), 'utf8')).toBe('S\n')
    })

    for (const invalid of ['missing Uid', 'malformed Uid', 'malformed flags']) {
      test(`${invalid}: a live process cannot become an empty successful scan`, () => {
        const w = world()
        processFixture(w, 2147483000, 'rowan')
        procStatus(w, 2147483000, 1000)
        const proc = path.join(w.dir, 'proc/2147483000')
        if (invalid === 'missing Uid') fs.unlinkSync(path.join(proc, 'status'))
        else if (invalid === 'malformed Uid')
          fs.writeFileSync(
            path.join(proc, 'status'),
            'Uid:\t0\tunknown\t0\t0\n',
          )
        else {
          const fields = Array(20).fill('0')
          fields[0] = 'S'
          fields[1] = '99'
          fields[6] = 'unknown'
          fields[19] = '100'
          fs.writeFileSync(
            path.join(proc, 'stat'),
            `2147483000 (qm) ${fields.join(' ')}\n`,
          )
        }
        const scanned = run(
          bash.path,
          w,
          'beta_node_pids rowan',
          '',
          scanCommon(w, 1000),
        )
        expect(scanned.code).toBe(2)
        expect(scanned.err).toContain('无法读取进程 2147483000')
        expect(fs.existsSync(path.join(w.dir, 'signals'))).toBe(false)
      })
    }

    for (const [before, after] of [
      ['R', 'S'],
      ['S', 'R'],
    ]) {
      test(`a ${before} to ${after} scheduling transition preserves the running identity and permits a verified stop`, () => {
        const w = world()
        processFixture(w, 2147483000, 'rowan')
        const stat = path.join(w.dir, 'proc/2147483000/stat')
        fs.writeFileSync(
          stat,
          `2147483000 (qm) ${before} 99 ${Array(17).fill('0').join(' ')} 100\n`,
        )
        fs.writeFileSync(path.join(w.root, 'run/rowan.pid'), '2147483000\n')
        const stopped = run(
          bash.path,
          w,
          'beta_running rowan; beta_stop_node rowan',
          processTable +
            `\nreadlink() {
              if [ "$1" = "$FIXTURE/proc/2147483000/exe" ]; then
                printf '2147483000 (qm) ${after} 99 ${Array(17).fill('0').join(' ')} 100\\n' >"$FIXTURE/proc/2147483000/stat"
              fi
              command readlink "$@"
            }`,
        )
        expect({ code: stopped.code, err: stopped.err }).toEqual({
          code: 0,
          err: '',
        })
        expect(fs.readFileSync(path.join(w.dir, 'signals'), 'utf8')).toBe(
          '-TERM 2147483000\n',
        )
        expect(fs.existsSync(path.join(w.root, 'run/rowan.pid'))).toBe(false)
      })
    }

    test('zombie and exited states before or during a snapshot cannot be recorded as a launch identity', () => {
      for (const state of ['Z', 'X', 'x']) {
        for (const during of [false, true]) {
          const w = world()
          processFixture(w, 2147483000, 'rowan')
          const tuple = `2147483000 (qm) ${state} 99 ${Array(17).fill('0').join(' ')} 100\n`
          if (!during)
            fs.writeFileSync(path.join(w.dir, 'proc/2147483000/stat'), tuple)
          const provider = during
            ? processTable +
              `\nreadlink() {
                printf '%s' '${tuple}' >"$FIXTURE/proc/2147483000/stat"
                command readlink "$@"
              }`
            : processTable
          const recorded = run(
            bash.path,
            w,
            'beta_record_pid_identity rowan 2147483000',
            provider,
          )
          expect(recorded.code).toBe(3)
          expect(
            fs.existsSync(path.join(w.root, 'run/rowan.pid.identity')),
          ).toBe(false)
          expect(fs.existsSync(path.join(w.dir, 'signals'))).toBe(false)
        }
      }
    })

    test('a live process with unreadable stat or identity fails node recovery instead of reporting no node', () => {
      for (const unreadable of ['stat', 'environ']) {
        const w = world()
        processFixture(w, 2147483000, 'rowan')
        fs.unlinkSync(path.join(w.dir, 'proc/2147483000', unreadable))
        const stopped = run(bash.path, w, 'beta_stop_node rowan')
        expect(stopped.code).toBe(3)
        expect(stopped.err).toContain('读取进程')
        expect(stopped.err).toContain('2147483000')
        expect(stopped.out).not.toContain('本来就没在跑')
        expect(fs.existsSync(path.join(w.dir, 'signals'))).toBe(false)
      }
    })

    test('a descendant whose exe and environ are hidden is still stopped through its stat lineage', () => {
      const w = world()
      processFixture(w, 2147483000, 'rowan')
      processFixture(w, 2147483002, 'child')
      fs.writeFileSync(path.join(w.dir, '2147483002.ppid'), '2147483000\n')
      fs.writeFileSync(
        path.join(w.dir, 'proc/2147483002/stat'),
        '2147483002 (helper) S 2147483000 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 100\n',
      )
      fs.unlinkSync(path.join(w.dir, 'proc/2147483002/exe'))
      fs.unlinkSync(path.join(w.dir, 'proc/2147483002/environ'))
      fs.writeFileSync(path.join(w.root, 'run/rowan.pid'), '2147483000\n')
      const stopped = run(bash.path, w, 'beta_stop_node rowan')
      expect({ code: stopped.code, err: stopped.err }).toEqual({
        code: 0,
        err: '',
      })
      expect(
        fs.readFileSync(path.join(w.dir, 'signals'), 'utf8').trim().split('\n'),
      ).toEqual(['-TERM 2147483002', '-TERM 2147483000'])
      expect(fs.existsSync(path.join(w.root, 'run/rowan.pid'))).toBe(false)
    })

    test('a live child with unreadable stat aborts descendant scanning before any signal', () => {
      const w = world()
      processFixture(w, 2147483000, 'rowan')
      processFixture(w, 2147483002, 'child')
      fs.unlinkSync(path.join(w.dir, 'proc/2147483002/stat'))
      fs.writeFileSync(path.join(w.root, 'run/rowan.pid'), '2147483000\n')
      const stopped = run(bash.path, w, 'beta_stop_node rowan')
      expect(stopped.code).toBe(3)
      expect(stopped.err).toContain('读取进程')
      expect(stopped.err).toContain('2147483002')
      expect(fs.existsSync(path.join(w.dir, 'signals'))).toBe(false)
      expect(fs.readFileSync(path.join(w.root, 'run/rowan.pid'), 'utf8')).toBe(
        '2147483000\n',
      )
    })

    if (process.platform === 'darwin') {
      test('macOS without a copied process provider refuses launch before executing the command or writing a PID', () => {
        const w = world()
        const pidFile = path.join(w.root, 'run/rowan.pid')
        const started = run(
          bash.path,
          w,
          `beta_start_process rowan "$BETA_NODES_DIR/rowan/config" /bin/sh -c 'printf launched >"$FIXTURE/launched"; exec /bin/sleep 30'`,
          '',
        )
        // Clean up the known test launch if this regression reintroduces side effects.
        if (fs.existsSync(pidFile)) {
          const pid = Number(fs.readFileSync(pidFile, 'utf8'))
          if (pid > 1) {
            try {
              process.kill(pid, 'SIGKILL')
            } catch {}
          }
        }
        expect(started.code).not.toBe(0)
        expect(started.err).toContain('启动前无法可靠读取进程身份')
        expect(fs.existsSync(path.join(w.dir, 'launched'))).toBe(false)
        expect(fs.existsSync(pidFile)).toBe(false)
        expect(fs.existsSync(`${pidFile}.identity`)).toBe(false)
      })
    }

    test('caller fixture paths cannot enable a production identity bypass', () => {
      const w = world()
      processFixture(w, 2147483000, 'rowan')
      fs.writeFileSync(path.join(w.root, 'run/rowan.pid'), '2147483000\n')
      // Keep the production accessors intact. A valid caller-owned process table
      // in FIXTURE cannot authorize signals, even when kill -0 reports a live PID.
      const stopped = run(
        bash.path,
        w,
        'beta_stop_node rowan',
        String.raw`kill() {
          [ "$1" != -0 ] || return 0
          printf '%s\n' "$*" >>"$FIXTURE/signals"
        }`,
      )
      expect(stopped.code).toBe(3)
      expect(stopped.out + stopped.err).toContain('身份不符')
      expect(fs.existsSync(path.join(w.dir, 'signals'))).toBe(false)
      expect(fs.readFileSync(path.join(w.root, 'run/rowan.pid'), 'utf8')).toBe(
        '2147483000\n',
      )
    })

    test('copied process provider starts and stops the real resident with argv and config boundaries intact', () => {
      const w = world()
      const beta = path.join(w.dir, 'repo/demo/env/beta')
      fs.mkdirSync(beta, { recursive: true })
      const copy = path.join(beta, 'common.sh')
      fs.copyFileSync(common, copy)
      const table = new TestProcessTable(w.dir)
      expect(() => table.install(common)).toThrow(
        'Process fixtures require a temporary common.sh copy',
      )
      table.install(copy)
      const entry = path.join(w.dir, 'resident fixture.js')
      fs.writeFileSync(
        entry,
        '#!/usr/bin/env bun\nsetInterval(() => {}, 60000)\n',
      )
      fs.chmodSync(entry, 0o755)
      const env = {
        HOME: path.join(w.dir, 'home'),
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        QIANMO_BETA_ROOT: w.root,
        QIANMO_QM_BINARY: entry,
        QIANMO_BETA_START_GRACE_S: '0.2',
        CAPTURE: path.join(w.dir, 'captured.identity'),
      }
      const started = Bun.spawnSync(
        [
          bash.path,
          '-c',
          `set -euo pipefail
            . "$1"
            beta_start_process rowan "$BETA_NODES_DIR/rowan/config" "$BETA_QM_BIN" resident --node rowan --example 'one two'
            cat "$(beta_pidfile rowan)"
            cat "$(beta_pidfile rowan).identity" >"$CAPTURE"`,
          'copied-provider-test',
          copy,
        ],
        {
          env,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const pidFile = path.join(w.root, 'run/rowan.pid')
      const startedPid = fs.existsSync(pidFile)
        ? Number(fs.readFileSync(pidFile, 'utf8'))
        : 0
      let aliveBefore = false
      if (startedPid > 1) {
        try {
          process.kill(startedPid, 0)
          aliveBefore = true
        } catch {}
      }
      const stopped = Bun.spawnSync(
        [
          bash.path,
          '-c',
          'set -euo pipefail; . "$1"; beta_stop_node rowan',
          'stop-fixture',
          copy,
        ],
        { env, stdout: 'pipe', stderr: 'pipe' },
      )
      const aliveAfter = startedPid > 1 && processAlive(startedPid)
      // Clean up our own known test process even if a regression aborts before stop.
      if (startedPid > 1 && aliveAfter) {
        try {
          process.kill(startedPid, 'SIGKILL')
        } catch {}
      }
      expect({
        code: started.exitCode,
        err: started.stderr.toString(),
      }).toEqual({ code: 0, err: '' })
      expect({
        code: stopped.exitCode,
        err: stopped.stderr.toString(),
      }).toEqual({ code: 0, err: '' })
      expect(stopped.stdout.toString()).toContain('子进程已退出')
      expect({ aliveBefore, aliveAfter }).toEqual({
        aliveBefore: true,
        aliveAfter: false,
      })
      expect(fs.existsSync(pidFile)).toBe(false)
      const identity = fs
        .readFileSync(path.join(w.dir, 'captured.identity'), 'utf8')
        .split('\0')
      expect(identity.slice(3)).toEqual([
        fs.realpathSync(process.execPath),
        path.join(w.root, 'nodes/rowan/config'),
        process.execPath,
        entry,
        'resident',
        '--node',
        'rowan',
        '--example',
        'one two',
        '',
      ])
    })

    test('similar argv from an unrelated executable or entry and forged env text cannot authorize a signal', () => {
      for (const mode of [
        'executable',
        'entry',
        'subcommand',
        'boundary',
        'env',
      ]) {
        const w = world()
        processFixture(w, 2147483000, 'rowan')
        const proc = path.join(w.dir, 'proc/2147483000')
        if (mode === 'executable') {
          fs.unlinkSync(path.join(proc, 'exe'))
          fs.symlinkSync('/usr/bin/python3', path.join(proc, 'exe'))
          fs.writeFileSync(
            path.join(proc, 'cmdline'),
            '/usr/bin/python3\0unrelated-worker.py\0resident\0--node\0rowan\0',
          )
        } else if (mode === 'entry') {
          fs.writeFileSync(
            path.join(proc, 'cmdline'),
            `${process.execPath}\0unrelated-worker.py\0resident\0--node\0rowan\0`,
          )
        } else if (mode === 'subcommand') {
          fs.writeFileSync(
            path.join(proc, 'cmdline'),
            `${process.execPath}\0${common}\0unrelated\0resident\0--node\0rowan\0`,
          )
        } else if (mode === 'boundary') {
          fs.writeFileSync(
            path.join(proc, 'cmdline'),
            `${process.execPath}\0${common}\0resident --node rowan\0`,
          )
        } else {
          fs.writeFileSync(path.join(proc, 'environ'), 'UNRELATED=1\0')
          fs.appendFileSync(
            path.join(w.dir, '2147483000.args'),
            `QIANMO_CONFIG_DIR=${w.root}/nodes/rowan/config\n`,
          )
          // macOS ps eww mixes argv into the environment-looking text. This token
          // exists only in argv; the independent proc environ above has none.
          fs.writeFileSync(
            path.join(w.dir, '2147483000.env'),
            fs
              .readFileSync(path.join(w.dir, '2147483000.args'), 'utf8')
              .trim()
              .replaceAll('\n', ' ') + ' UNRELATED=1\n',
          )
        }
        if (mode !== 'env')
          fs.writeFileSync(
            path.join(w.dir, '2147483000.args'),
            fs
              .readFileSync(path.join(proc, 'cmdline'), 'utf8')
              .replaceAll('\0', ' ')
              .trim() + '\n',
          )
        fs.writeFileSync(path.join(w.root, 'run/rowan.pid'), '2147483000\n')
        const stopped = run(bash.path, w, 'beta_stop_node rowan')
        expect(stopped.code).toBe(3)
        expect(fs.existsSync(path.join(w.dir, 'signals'))).toBe(false)
        expect(
          fs.readFileSync(path.join(w.root, 'run/rowan.pid'), 'utf8'),
        ).toBe('2147483000\n')
      }
    })

    test('child PID reused between enumeration and start-time capture is never signalled', () => {
      const w = world()
      processFixture(w, 2147483000, 'rowan')
      processFixture(w, 2147483002, 'child')
      fs.writeFileSync(path.join(w.dir, '2147483002.ppid'), '2147483000\n')
      fs.writeFileSync(
        path.join(w.dir, 'proc/2147483002/stat'),
        '2147483002 (child) S 2147483000 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 100\n',
      )
      fs.writeFileSync(path.join(w.dir, 'reuse-child'), '')
      fs.writeFileSync(path.join(w.root, 'run/rowan.pid'), '2147483000\n')
      const stopped = run(bash.path, w, 'beta_stop_node rowan')
      const signals = fs.existsSync(path.join(w.dir, 'signals'))
        ? fs.readFileSync(path.join(w.dir, 'signals'), 'utf8')
        : ''
      expect(signals).not.toContain('2147483002')
      expect(stopped.code).toBe(3)
      expect(fs.existsSync(path.join(w.root, 'run/rowan.pid'))).toBe(true)
    })

    test('beta-down all stops resident and recorded handoff helpers after checking their identities', () => {
      const w = world()
      const names = [
        'rowan',
        'handoff-node',
        'handoff-app-server',
        'sidecar-worker',
      ]
      for (let i = 0; i < names.length; i++) {
        const name = names[i] as string
        const pid = 2147483000 + i
        processFixture(w, pid, name)
        if (i > 0) {
          fs.writeFileSync(path.join(w.dir, `${pid}.args`), `qm ${name}\n`)
          fs.writeFileSync(
            path.join(w.dir, `proc/${pid}/cmdline`),
            `${process.execPath}\0${common}\0${name}\0`,
          )
        }
        fs.writeFileSync(path.join(w.root, `run/${name}.pid`), `${pid}\n`)
      }
      const beta = path.join(w.dir, 'repo/demo/env/beta')
      fs.mkdirSync(beta, { recursive: true })
      fs.writeFileSync(
        path.join(beta, 'common.sh'),
        fs.readFileSync(common, 'utf8') + processTable,
      )
      fs.copyFileSync(
        path.join(import.meta.dir, 'beta-down.sh'),
        path.join(beta, 'beta-down.sh'),
      )
      const stopped = run(
        bash.path,
        w,
        `for name in rowan handoff-node handoff-app-server sidecar-worker; do beta_record_pid_identity "$name" "$(cat "$(beta_pidfile "$name")")"; done\nset --\n. "$FIXTURE/repo/demo/env/beta/beta-down.sh"`,
      )
      expect({ code: stopped.code, err: stopped.err }).toEqual({
        code: 0,
        err: '',
      })
      expect(
        fs
          .readFileSync(path.join(w.dir, 'signals'), 'utf8')
          .trim()
          .split('\n')
          .sort(),
      ).toEqual([
        '-TERM 2147483000',
        '-TERM 2147483001',
        '-TERM 2147483002',
        '-TERM 2147483003',
      ])
      for (const name of names)
        expect(fs.existsSync(path.join(w.root, `run/${name}.pid`))).toBe(false)
      expect(fs.existsSync(path.join(w.root, '.qianmo-beta-env'))).toBe(true)
    })
    test('live PID with another node, root or command cannot be reported running or signalled', () => {
      for (const mode of ['node', 'root', 'command']) {
        const w = world()
        processFixture(
          w,
          2147483000,
          mode === 'node' ? 'alder' : 'rowan',
          mode === 'root' ? `${w.dir}/other` : w.root,
        )
        if (mode === 'command') {
          fs.writeFileSync(
            path.join(w.dir, '2147483000.args'),
            'bun unrelated-worker\n',
          )
          fs.writeFileSync(
            path.join(w.dir, 'proc/2147483000/cmdline'),
            `${process.execPath}\0unrelated-worker\0`,
          )
        }
        fs.writeFileSync(path.join(w.root, 'run/rowan.pid'), '2147483000\n')
        const running = run(bash.path, w, 'beta_running rowan')
        expect(running.code).toBe(3)
        const start = run(
          bash.path,
          w,
          'beta_start_process rowan "$BETA_NODES_DIR/rowan/config" definitely-invalid-command',
        )
        expect(start.code).not.toBe(0)
        expect(start.out + start.err).toContain('身份不符')

        const stopped = run(bash.path, w, 'beta_stop_node rowan')
        expect(stopped.code).toBe(3)
        expect(stopped.out + stopped.err).toContain('身份不符')
        expect(fs.existsSync(path.join(w.dir, 'signals'))).toBe(false)
        expect(
          fs.readFileSync(path.join(w.root, 'run/rowan.pid'), 'utf8'),
        ).toBe('2147483000\n')
      }
    })

    test('a live PID with an unreadable process table is refused and its record is retained', () => {
      const w = world()
      processFixture(w, 2147483000, 'rowan')
      fs.writeFileSync(path.join(w.root, 'run/rowan.pid'), '2147483000\n')
      const stopped = run(
        bash.path,
        w,
        'beta_proc_stat() { return 1; }; beta_proc_dirs() { return 1; }; beta_stop_node rowan',
      )
      expect(stopped.code).toBe(3)
      expect(fs.existsSync(path.join(w.dir, 'signals'))).toBe(false)
      expect(fs.readFileSync(path.join(w.root, 'run/rowan.pid'), 'utf8')).toBe(
        '2147483000\n',
      )
    })

    test('missing PID plus an unreadable process table cannot report a successful stop', () => {
      const w = world()
      processFixture(w, 2147483000, 'rowan')
      const stopped = run(
        bash.path,
        w,
        'beta_proc_stat() { return 1; }; beta_proc_dirs() { return 1; }; beta_stop_node rowan',
      )
      expect(stopped.code).toBe(3)
      expect(stopped.out + stopped.err).toContain('没法按命令行复核')
      expect(fs.existsSync(path.join(w.dir, 'signals'))).toBe(false)
    })

    test('reused PID with matching node and root but a different start time is refused', () => {
      const w = world()
      processFixture(w, 2147483000, 'rowan')
      fs.writeFileSync(path.join(w.root, 'run/rowan.pid'), '2147483000\n')
      expect(
        run(bash.path, w, 'beta_record_pid_identity rowan 2147483000').code,
      ).toBe(0)
      fs.writeFileSync(
        path.join(w.dir, 'proc/2147483000/stat'),
        '2147483000 (qm) S 99 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 101\n',
      )
      expect(run(bash.path, w, 'beta_stop_node rowan').code).toBe(3)
      expect(fs.existsSync(path.join(w.dir, 'signals'))).toBe(false)
    })

    test('stop waits for descendants, escalates surviving child and leaves the other node alive', () => {
      const w = world()
      processFixture(w, 2147483000, 'rowan')
      processFixture(w, 2147483001, 'alder')
      processFixture(w, 2147483002, 'child')
      fs.writeFileSync(path.join(w.dir, '2147483002.ppid'), '2147483000\n')
      fs.writeFileSync(
        path.join(w.dir, 'proc/2147483002/stat'),
        '2147483002 (child) S 2147483000 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 100\n',
      )
      fs.writeFileSync(path.join(w.dir, '2147483002.ignore-term'), '')
      fs.writeFileSync(path.join(w.root, 'run/rowan.pid'), '2147483000\n')
      const result = run(bash.path, w, 'beta_stop_node rowan')
      expect({ code: result.code, err: result.err }).toEqual({
        code: 0,
        err: '',
      })
      expect(
        fs.readFileSync(path.join(w.dir, 'signals'), 'utf8').trim().split('\n'),
      ).toEqual(['-TERM 2147483002', '-TERM 2147483000', '-KILL 2147483002'])
      expect(fs.readFileSync(path.join(w.dir, '2147483001.stat'), 'utf8')).toBe(
        'S\n',
      )
      expect(fs.existsSync(path.join(w.root, 'run/rowan.pid'))).toBe(false)
    })

    test('a persisted agent path cannot escape the node workspace', () => {
      const w = world()
      fs.writeFileSync(
        path.join(w.root, 'state/rowan.launch'),
        `root=${w.root}\nport=40231\nbind=127.0.0.1\nagents=../../../outside\n`,
      )
      const loaded = run(
        bash.path,
        w,
        'beta_load_node_launch rowan; mkdir -p "$BETA_WORKSPACE_DIR/rowan/$BETA_AGENTS"',
      )
      expect(loaded.code).not.toBe(0)
      expect(fs.existsSync(path.join(w.dir, 'outside'))).toBe(false)
    })

    test('helper identity keeps argv boundaries, config spaces and executable; changed records refuse full stop', () => {
      for (const changed of ['argv', 'exe', 'config']) {
        const w = world()
        processFixture(w, 2147483000, 'handoff-node')
        const proc = path.join(w.dir, 'proc/2147483000')
        const cfg = `${w.root}/handoff/config with spaces`
        fs.writeFileSync(
          path.join(proc, 'cmdline'),
          `${process.execPath}\0${common}\0handoff\0node\0one two\0`,
        )
        fs.writeFileSync(
          path.join(proc, 'environ'),
          `QIANMO_CONFIG_DIR=${cfg}\0OPENAI_API_KEY=secret-canary\0`,
        )
        fs.writeFileSync(
          path.join(w.root, 'run/handoff-node.pid'),
          '2147483000\n',
        )
        expect(
          run(
            bash.path,
            w,
            'beta_record_pid_identity handoff-node 2147483000; beta_running handoff-node',
          ).code,
        ).toBe(0)
        expect(
          fs
            .readFileSync(path.join(w.root, 'run/handoff-node.pid.identity'))
            .includes(Buffer.from('secret-canary')),
        ).toBe(false)
        if (changed === 'argv')
          fs.writeFileSync(
            path.join(proc, 'cmdline'),
            `${process.execPath}\0${common}\0handoff\0node\0one\0two\0`,
          )
        else if (changed === 'exe') {
          fs.unlinkSync(path.join(proc, 'exe'))
          fs.symlinkSync('/usr/bin/python3', path.join(proc, 'exe'))
        } else
          fs.writeFileSync(
            path.join(proc, 'environ'),
            `QIANMO_CONFIG_DIR=${w.root}/other\0`,
          )
        const stopped = run(bash.path, w, 'beta_stop_one handoff-node')
        expect(stopped.code).toBe(3)
        expect(fs.existsSync(path.join(w.dir, 'signals'))).toBe(false)
        expect(fs.existsSync(path.join(w.root, 'run/handoff-node.pid'))).toBe(
          true,
        )
      }
    })

    test('persisted port is resolved after restart; explicit override wins and a relocated record is refused', () => {
      const w = world()
      expect(
        run(bash.path, w, 'BETA_NODE_PORT=40231; beta_save_node_launch rowan')
          .code,
      ).toBe(0)
      expect(
        run(
          bash.path,
          w,
          'beta_load_node_launch rowan; printf "%s" "$BETA_NODE_PORT"',
        ).out,
      ).toBe('40231')
      expect(
        run(
          bash.path,
          w,
          'BETA_NODE_PORT_GIVEN=40232; beta_load_node_launch rowan; printf "%s" "$BETA_NODE_PORT"',
        ).out,
      ).toBe('40232')
      fs.writeFileSync(
        path.join(w.root, 'state/rowan.launch'),
        `root=${w.dir}/other\nport=40231\nbind=127.0.0.1\nagents=ops\n`,
      )
      expect(run(bash.path, w, 'beta_load_node_launch rowan').code).not.toBe(0)
    })
  })
}
