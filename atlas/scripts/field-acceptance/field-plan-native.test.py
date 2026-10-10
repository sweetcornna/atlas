# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Run generated shell against real files and a local SSH/system identity fixture."""
import hashlib
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest

api = runpy.run_path(str(Path(__file__).with_name('field-plan.py')))

SHIM = r'''
import hashlib,json,os,pathlib,subprocess,sys
name=pathlib.Path(sys.argv[0]).name
state=json.loads(pathlib.Path(os.environ['FIXTURE_STATE']).read_text())
if name=='id': print(state['uid'])
elif name=='hostname': print(state['hostname'])
elif name=='cat': print(state['boot'])
elif name=='readlink': print(pathlib.Path(sys.argv[-1]).resolve())
elif name=='ss': print(state.get('listeners',''))
elif name=='sha256sum':
 p=sys.argv[-1]
 data=state['machine'].encode() if p=='/etc/machine-id' else pathlib.Path(p).read_bytes()
 print(hashlib.sha256(data).hexdigest()+'  '+p)
elif name=='ssh':
 host=sys.argv[-2]
 with open(state['sshLog'],'a') as f:f.write(host+'\n')
 if host==state.get('failSSH'):sys.exit(255)
 sys.exit(subprocess.run(['/bin/bash','-s'],input=sys.stdin.read(),text=True).returncode)
elif name=='systemctl':
 unit=sys.argv[-1]
 if 'show' in sys.argv:
  print('not-found' if '-hub-' in unit else 'loaded')
  sys.exit(4 if '-hub-' in unit else 0)
 else:
  with open(state['stopLog'],'a') as f:f.write(unit+'\n')
else: raise AssertionError(name)
'''


class NativeReviewTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='qm-native-review-')
        self.root = Path(self.temp.name).resolve()
        self.bin = self.root / 'tools'; self.bin.mkdir()
        for name in ['id', 'hostname', 'cat', 'readlink', 'ss', 'sha256sum', 'ssh', 'systemctl']:
            path = self.bin / name
            path.write_text('#!' + sys.executable + '\n' + SHIM)
            path.chmod(0o700)
        self.state = {'uid': 1000, 'hostname': 'fixture', 'boot': 'boot-fixture',
                      'machine': 'machine-fixture', 'sshLog': str(self.root / 'ssh.log'),
                      'stopLog': str(self.root / 'stop.log')}
        self.state_path = self.root / 'state.json'
        self.env = {'PATH': str(self.bin) + ':/usr/bin:/bin', 'FIXTURE_STATE': str(self.state_path)}
        artifacts = []
        hosts = []
        for role in ['hub', 'worker', 'witness']:
            home = self.root / ('home-' + role)
            root = home / 'qianmo-candidate' / 'candidate'; (root / 'bin').mkdir(parents=True)
            for name in sorted(api['NATIVE_ARTIFACTS']):
                path = root / 'bin' / name
                data = '#!/bin/bash\nprintf executed > "$1/executed"\n' if name == 'native-after-review.sh' else 'fixture:' + name
                path.write_text(data)
                if role == 'hub': artifacts.append({'name': name, 'sha256': hashlib.sha256(data.encode()).hexdigest()})
            hosts.append({'id': role, 'ssh': 'fixture-' + role, 'role': role, 'home': str(home),
                          'root': str(root), 'uid': 1000, 'hostname': 'fixture', 'bootId': 'boot-fixture',
                          'machineIdSha256': hashlib.sha256(b'machine-fixture').hexdigest(), 'ports': [39720]})
        self.plan = {'candidateId': 'candidate', 'hosts': hosts, 'artifacts': artifacts}
        self.out = self.root / 'review'; self.out.mkdir()
        (self.out / 'known_hosts').write_text('fixture public keys only\n')
        api['execution_wrappers'](self.plan, self.out, 'approved-fixture')

    def tearDown(self):
        self.temp.cleanup()

    def run_script(self, name):
        self.state_path.write_text(json.dumps(self.state))
        return subprocess.run(['/bin/bash', str(self.out / name), 'approved-fixture'],
                              env=self.env, capture_output=True, text=True)

    def executed(self):
        return any((Path(h['root']) / 'executed').exists() for h in self.plan['hosts'])

    def test_positive_executes_all_three_only_after_preflight(self):
        result = self.run_script('native-after-review.sh')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(all((Path(h['root']) / 'executed').read_text() == 'executed' for h in self.plan['hosts']))

    def test_every_artifact_tamper_rejected_before_any_candidate_shell(self):
        for artifact in self.plan['artifacts']:
            with self.subTest(artifact=artifact['name']):
                path = Path(self.plan['hosts'][0]['root']) / 'bin' / artifact['name']
                original = path.read_bytes(); path.write_bytes(original + b'\n# tampered')
                self.assertNotEqual(self.run_script('native-after-review.sh').returncode, 0)
                self.assertFalse(self.executed())
                path.write_bytes(original)

    def test_each_identity_change_and_busy_port_rejected(self):
        for key, value in [('uid', 1001), ('hostname', 'other'), ('boot', 'new-boot'),
                           ('machine', 'new-machine'), ('listeners', 'LISTEN 0 128 127.0.0.1:39720 0.0.0.0:*')]:
            with self.subTest(key=key):
                prior = dict(self.state); self.state[key] = value
                self.assertNotEqual(self.run_script('native-after-review.sh').returncode, 0)
                self.assertFalse(self.executed()); self.state = prior

    def test_symlink_artifact_and_changed_known_hosts_refused(self):
        path = Path(self.plan['hosts'][0]['root']) / 'bin' / 'bun-linux-x64'
        original = path.read_bytes(); other = self.root / 'same-bun'; other.write_bytes(original)
        path.unlink(); path.symlink_to(other)
        self.assertNotEqual(self.run_script('native-after-review.sh').returncode, 0)
        self.assertFalse(self.executed())
        (self.out / 'known_hosts').write_text('changed')
        (self.root / 'ssh.log').write_text('')
        for name in ['native-after-review.sh', 'stop-candidate-units.sh']:
            self.assertNotEqual(self.run_script(name).returncode, 0)
        self.assertEqual((self.root / 'ssh.log').read_text(), '')

    def test_stop_attempts_remaining_hosts_after_first_ssh_failure(self):
        self.state['failSSH'] = 'fixture-hub'
        self.assertNotEqual(self.run_script('stop-candidate-units.sh').returncode, 0)
        self.assertEqual((self.root / 'ssh.log').read_text().splitlines(), ['fixture-hub', 'fixture-worker', 'fixture-witness'])
        self.assertEqual((self.root / 'stop.log').read_text().splitlines(), ['candidate-worker-native.service', 'candidate-witness-native.service'])

    def test_collected_unit_is_skipped_without_skipping_later_hosts(self):
        self.assertEqual(self.run_script('stop-candidate-units.sh').returncode, 0)
        self.assertEqual((self.root / 'stop.log').read_text().splitlines(), ['candidate-worker-native.service', 'candidate-witness-native.service'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
