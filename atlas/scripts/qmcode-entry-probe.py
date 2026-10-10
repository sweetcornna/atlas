#!/usr/bin/env python3
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Actual qmcode builtin MCP/notify/shell path against a real local qm hub.

Usage: python3 atlas/scripts/qmcode-entry-probe.py /absolute/qmcode /evidence/dir
Requires macOS sandbox-exec, Python 3, Bun on PATH and a built qmcode fork.
Only a loopback fixed Responses provider is used. This validates local protocol
integration, not a literal TUI slash keystroke, cloud execution or offline drill.
"""
import atexit
import hashlib
import socket
import urllib.request
from pathlib import Path
import http.server
import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time

if len(sys.argv) != 3:
    raise SystemExit("Usage: python3 qmcode-entry-probe.py /absolute/qmcode /evidence/dir")
if sys.platform != "darwin" or not os.path.exists("/usr/bin/sandbox-exec"):
    raise SystemExit("This probe requires macOS sandbox-exec; Linux bwrap verification is separate")
QMCODE = os.path.abspath(sys.argv[1])
OUT = os.path.abspath(sys.argv[2])
HERE = os.path.dirname(os.path.abspath(__file__))
os.makedirs(OUT, exist_ok=True)

requests_seen = []


class MockResponses(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        requests_seen.append(("GET", self.path))
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        self.rfile.read(length)
        requests_seen.append(("POST", self.path))
        if not self.path.endswith("/responses"):
            self.send_response(404)
            self.end_headers()
            return
        rid = f"resp-{len(requests_seen)}"
        events = [
            {"type": "response.created", "response": {"id": rid}},
            {
                "type": "response.output_item.done",
                "item": {
                    "type": "message",
                    "role": "assistant",
                    "id": f"msg-{rid}",
                    "content": [{"type": "output_text", "text": "mock reply"}],
                },
            },
            {
                "type": "response.completed",
                "response": {
                    "id": rid,
                    "usage": {
                        "input_tokens": 0,
                        "input_tokens_details": None,
                        "output_tokens": 0,
                        "output_tokens_details": None,
                        "total_tokens": 0,
                    },
                },
            },
        ]
        body = "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events)
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", str(len(body.encode())))
        self.end_headers()
        self.wfile.write(body.encode())


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), MockResponses)
threading.Thread(target=server.serve_forever, daemon=True).start()
port = server.server_address[1]

root = tempfile.mkdtemp(prefix="qm-e2e-", dir=OUT)
home = os.path.join(root, "home")
qmcode_home = os.path.join(root, "qmcode-home")
work = os.path.join(root, "work")
bindir = os.path.join(root, "bin")
logdir = os.path.join(root, "log")
for d in (home, qmcode_home, work, bindir, logdir):
    os.makedirs(d)
bun = shutil.which("bun")
if not bun:
    raise SystemExit("Bun >=1.4 is required on PATH")
cli = str(Path(__file__).resolve().parents[1] / "packages/node/src/cli.ts")
qmconfig = os.path.join(root, "qm-config")
qmenv = {"HOME": home, "QMCODE_HOME": qmcode_home, "QIANMO_CONFIG_DIR": qmconfig,
         "PATH": f"{bindir}:{os.path.dirname(bun)}:/usr/bin:/bin", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"}
wrapper = f"#!{sys.executable}\nimport os,json,sys\n" + f"env={qmenv!r}\nif os.environ.get('CODEX_THREAD_ID'): env['CODEX_THREAD_ID']=os.environ['CODEX_THREAD_ID']\n" + f"with open({os.path.join(logdir, 'qm-calls.jsonl')!r}, 'a') as f: f.write(json.dumps({{'argv':sys.argv[1:], 'cwd':os.getcwd()}})+'\\n')\n" + f"os.execve({bun!r}, [{bun!r}, 'run', {cli!r}, *sys.argv[1:]], env)\n"
# The wrapper records argv, then executes the actual qm source. It does not
# answer MCP, invent sync results or fabricate task state.
with open(os.path.join(bindir, "qm"), "w") as f: f.write(wrapper)
os.chmod(os.path.join(bindir, "qm"), 0o700)
with open(os.path.join(qmcode_home, "config.toml"), "w") as f:
    f.write(
        f"""model = "mock-model"
model_provider = "mock"
approval_policy = "never"
sandbox_mode = "danger-full-access"

[model_providers.mock]
name = "mock"
base_url = "http://127.0.0.1:{port}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0

[features]
plugins = false

[analytics]
enabled = false
"""
    )

env = {
    "HOME": home,
    "QMCODE_HOME": qmcode_home,
    "PATH": f"{bindir}:/usr/bin:/bin",
    "QM_E2E_LOG_DIR": logdir,
    "RUST_LOG": "warn",
}
env.update(qmenv)
def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def run(args, cwd=work):
    result=subprocess.run(args, cwd=cwd, env=qmenv, capture_output=True, text=True, timeout=30)
    if result.returncode: raise RuntimeError(result.stderr or result.stdout)
    return result.stdout
run(["git", "init", "-q", "-b", "main"])
PathFile = os.path.join(work,"task.txt")
with open(PathFile,"w") as f: f.write("real qm entry fixture\n")
run(["git", "add", "."])
run(["git", "-c", "user.name=EntryProbe", "-c", "user.email=entry@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "initial"])
head_before=run(["git","rev-parse","HEAD"]).strip()
index_before=sha256_file(os.path.join(work,".git/index"))
admin=os.path.join(root,"admin.token"); view=os.path.join(root,"view.token")
for name,value in [(admin,"p173-admin-local-only"),(view,"p173-view-local-only")]:
    with open(name,"w") as f: f.write(value)
    os.chmod(name,0o600)
listener=socket.socket(); listener.bind(("127.0.0.1",0)); hubport=listener.getsockname()[1]; listener.close()
hubroot=os.path.join(root,"hub-repos")
hub=subprocess.Popen([bun,"run",cli,"console","--port",str(hubport),"--admin-token-file",admin,"--view-token-file",view,"--handoff-root",hubroot],cwd=root,env={**qmenv,"QIANMO_CONFIG_DIR":os.path.join(root,"hub-config")},stdout=open(os.path.join(logdir,"hub.stdout"),"w"),stderr=open(os.path.join(logdir,"hub.stderr"),"w"))
def cleanup():
    if "proc" in globals() and proc.poll() is None:
        proc.terminate()
        try: proc.wait(timeout=5)
        except subprocess.TimeoutExpired: proc.kill(); proc.wait()
    hub.terminate()
    try: hub.wait(timeout=5)
    except subprocess.TimeoutExpired: hub.kill(); hub.wait()
atexit.register(cleanup)
for _ in range(100):
    try:
        with socket.create_connection(("127.0.0.1",hubport),timeout=.1): break
    except OSError: time.sleep(.05)
else: raise RuntimeError("hub not ready")
run([bun,"run",cli,"handoff","init","--hub",hubroot,"--console",f"http://127.0.0.1:{hubport}","--device","laptop","--project","entry","--token-file",admin])
proc = subprocess.Popen(
    ["/usr/bin/sandbox-exec", "-p", '(version 1)(allow default)(deny network-outbound (remote ip "*:*"))(allow network-outbound (remote ip "localhost:*"))', QMCODE, *json.loads(os.environ.get("E2E_EXTRA_ARGS", "[]")), "app-server"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=open(os.path.join(logdir, "app-server.stderr"), "w"),
    env=env,
    cwd=root,
    text=True,
)
messages = queue.Queue()
transcript = open(os.path.join(logdir, "jsonrpc.jsonl"), "w")


def reader():
    for line in proc.stdout:
        transcript.write(line)
        transcript.flush()
        try:
            messages.put(json.loads(line))
        except json.JSONDecodeError:
            pass


threading.Thread(target=reader, daemon=True).start()
next_id = 0


def send(method, params=None, notify=False):
    global next_id
    msg = {"method": method}
    if params is not None:
        msg["params"] = params
    if not notify:
        next_id += 1
        msg["id"] = next_id
    transcript.write(">> " + json.dumps(msg) + "\n")
    proc.stdin.write(json.dumps(msg) + "\n")
    proc.stdin.flush()
    return msg.get("id")


seen = []


def wait_for(pred, timeout=30.0, what=""):
    deadline = time.time() + timeout
    for m in seen:
        if pred(m):
            return m
    while time.time() < deadline:
        try:
            m = messages.get(timeout=0.2)
        except queue.Empty:
            continue
        seen.append(m)
        if pred(m):
            return m
    raise SystemExit(f"timeout waiting for {what}")


def response_to(req_id, what):
    m = wait_for(lambda m: m.get("id") == req_id and ("result" in m or "error" in m), what=what)
    if "error" in m:
        raise SystemExit(f"{what} failed: {m['error']}")
    return m["result"]


response_to(send("initialize", {"clientInfo": {"name": "qianmo-e2e", "version": "0"}}), "initialize")
send("initialized", notify=True)
thread = response_to(send("thread/start", {"cwd": work}), "thread/start")["thread"]
thread_id = thread["id"]

# 1. one model turn against the mock: notify fires after it completes.
response_to(
    send("turn/start", {"threadId": thread_id, "input": [{"type": "text", "text": "hello", "text_elements": []}]}),
    "turn/start",
)
wait_for(lambda m: m.get("method") == "turn/completed", what="turn/completed (model turn)")
time.sleep(1.5)

# 2. the /handoff path: thread/shellCommand "qm handoff now".
response_to(send("thread/shellCommand", {"threadId": thread_id, "command": "qm handoff now"}), "thread/shellCommand")
done = wait_for(
    lambda m: m.get("method") == "item/completed"
    and m["params"]["item"].get("type") == "commandExecution"
    and m["params"]["item"].get("source") == "userShell",
    what="user shell item/completed",
)
wait_for(
    lambda m: m.get("method") == "turn/completed" and m is not None and m is not done and seen.index(m) > seen.index(done),
    what="turn/completed (shell turn)",
)
time.sleep(1.5)

statuses = [
    m["params"] for m in seen if m.get("method") == "mcpServer/startupStatus/updated"
]
proc.stdin.close()
try:
    proc.wait(timeout=10)
except subprocess.TimeoutExpired:
    proc.kill()
server.shutdown()

calls = [json.loads(l) for l in open(os.path.join(logdir, "qm-calls.jsonl"))] if os.path.exists(os.path.join(logdir, "qm-calls.jsonl")) else []
summary = {
    "qmcode_binary": QMCODE,
    "qmcode_sha256": sha256_file(QMCODE),
    "work": work,
    "thread_id": thread_id,
    "mock_requests": requests_seen,
    "mcp_startup_statuses": statuses,
    "shell_item": {k: done["params"]["item"].get(k) for k in ("command", "cwd", "status", "exitCode", "aggregatedOutput", "source")},
    "qm_calls": calls,
    "scope": "two local processes, actual qm + cached qmcode; loopback provider, no cross-machine claim",
    "refs": run(["git","--git-dir",os.path.join(hubroot,"entry.git"),"for-each-ref","--format=%(refname) %(objectname)"]),
    "sync_log": open(os.path.join(qmconfig,"qianmo/handoff/sync.log")).read(),
}
def require(condition, detail):
    if not condition: raise RuntimeError(detail)
require(any(x.get("status") == "ready" for x in statuses), statuses)
require(summary["shell_item"]["exitCode"] == 0, summary["shell_item"])
require("refs/qianmo/" in summary["refs"], summary)
require(any(c["argv"][:2] == ["handoff","mcp"] for c in calls), calls)
require(any(c["argv"][:4] == ["handoff","sync","--hook","qmcode"] for c in calls), calls)
req=urllib.request.Request(f"http://127.0.0.1:{hubport}/v0/handoff",headers={"Authorization":"Bearer p173-admin-local-only"})
with urllib.request.urlopen(req) as response: summary["tasks"]=json.load(response)
require(len(summary["tasks"]["tasks"]) == 1, summary["tasks"])
manifest = summary["tasks"]["tasks"][0]["manifest"]
require(summary["tasks"]["tasks"][0]["state"] == "accepted", summary["tasks"])
def hub_ref(ref):
    return run(["git", "--git-dir", os.path.join(hubroot,"entry.git"), "rev-parse", ref]).strip()
require(hub_ref("refs/qianmo/wip/laptop/main") == manifest["wip"], "WIP ref mismatch")
require(hub_ref(manifest["sessionRef"]) == manifest["sessionCommit"], "Session ref mismatch")
require(hub_ref(manifest["wip"] + "^{tree}") == manifest["tree"], "Tree mismatch")
require(any(row.get("trigger") == "hook:qmcode" and row.get("ok") is True
            for row in map(json.loads, summary["sync_log"].splitlines())), "No successful real notify sync")
require(run(["git","rev-parse","HEAD"]).strip() == head_before, "Original HEAD changed")
require(sha256_file(os.path.join(work,".git/index")) == index_before, "Original index changed")
summary["git_integrity"] = {"head_unchanged": True, "index_unchanged": True, "manifest_refs_verified": True}
json.dump(summary, open(os.path.join(logdir, "summary.json"), "w"), indent=2)
print(json.dumps(summary, indent=2))
print("LOGDIR", logdir)
