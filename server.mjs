// Homelab portal: service dashboard, Claude Code chat, file uploads.
// Zero dependencies. Listens on the tailnet IP only; see README.md.
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME;
// 127.0.0.1 is fronted by `tailscale serve` (HTTPS with a real cert). The tailnet IP
// listener is plain HTTP and only kept while serve is not set up: PORTAL_HOSTS=127.0.0.1 drops it.
const HOSTS = (process.env.PORTAL_HOSTS || '127.0.0.1,<sandbox-tailnet-ip>').split(',');
const PORT = Number(process.env.PORTAL_PORT || 8800);
const OWNER = process.env.PORTAL_OWNER || 'you@example.com';
const DATA = path.join(ROOT, 'data');
const PUBLIC = path.join(ROOT, 'public');
const UPLOADS = path.join(HOME, 'uploads');
const PROJECTS = path.join(HOME, '.claude', 'projects');
const CLAUDE_BIN = process.env.CLAUDE_BIN || path.join(HOME, '.local', 'bin', 'claude');
const DEFAULT_CWD = HOME;
const MAX_UPLOAD = 1024 * 1024 * 1024; // 1 GiB
const COOKIE = 'portal_session';
const SESSION_DAYS = 30;

fs.mkdirSync(UPLOADS, { recursive: true });

// ---------- secrets / auth ----------

function loadSecret() {
  const p = path.join(DATA, 'secret');
  try { return fs.readFileSync(p); } catch {}
  const s = crypto.randomBytes(32);
  fs.writeFileSync(p, s, { mode: 0o600 });
  return s;
}
const SECRET = loadSecret();

function loadAuth() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, 'auth.json'), 'utf8')); } catch { return null; }
}

function checkPassword(pw) {
  const auth = loadAuth();
  if (!auth) return false;
  const salt = Buffer.from(auth.salt, 'hex');
  const want = Buffer.from(auth.hash, 'hex');
  const got = crypto.scryptSync(String(pw), salt, want.length, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(want, got);
}

function sign(v) { return crypto.createHmac('sha256', SECRET).update(v).digest('base64url'); }

function makeToken() {
  const auth = loadAuth();
  // Binding to the hash means changing the password logs out every device.
  const body = `${Date.now() + SESSION_DAYS * 864e5}.${auth.hash.slice(0, 16)}`;
  return `${body}.${sign(body)}`;
}

function validToken(tok) {
  if (!tok) return false;
  const i = tok.lastIndexOf('.');
  if (i < 0) return false;
  const body = tok.slice(0, i), mac = tok.slice(i + 1);
  const want = sign(body);
  if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return false;
  const [exp, h] = body.split('.');
  const auth = loadAuth();
  return auth && Number(exp) > Date.now() && h === auth.hash.slice(0, 16);
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Tailscale identity: the peer must be a device owned by OWNER.
const whoisCache = new Map();
function remoteIp(req) { return (req.socket.remoteAddress || '').replace(/^::ffff:/, ''); }
function whois(ip) {
  const hit = whoisCache.get(ip);
  if (hit && hit.until > Date.now()) return Promise.resolve(hit.v);
  return new Promise((resolve) => {
    execFile('tailscale', ['whois', '--json', ip], { timeout: 5000 }, (err, out) => {
      let v = null;
      if (!err) try {
        const d = JSON.parse(out);
        v = { login: d.UserProfile?.LoginName, device: d.Node?.ComputedName || d.Node?.Name, tags: d.Node?.Tags || [] };
      } catch {}
      whoisCache.set(ip, { v, until: Date.now() + 5 * 60e3 });
      resolve(v);
    });
  });
}

const loginFails = new Map(); // ip -> [timestamps]
function loginLimited(ip) {
  const now = Date.now();
  const arr = (loginFails.get(ip) || []).filter((t) => now - t < 15 * 60e3);
  loginFails.set(ip, arr);
  return arr.length >= 5;
}

// ---------- helpers ----------

function send(res, code, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body) || typeof body === 'string';
  const data = isBuf ? body : JSON.stringify(body);
  res.writeHead(code, { 'content-type': isBuf ? 'text/plain; charset=utf-8' : 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(data);
}

async function readJson(req, limit = 1024 * 1024) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw new Error('body too large'); chunks.push(c); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
  'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

// ---------- status: proxmox + service probes ----------

const SERVICES_FILE = path.join(ROOT, 'services.json');
let cluster = { at: 0, data: null, err: null, pending: null };

function fetchCluster() {
  if (cluster.pending) return cluster.pending;
  if (Date.now() - cluster.at < 15e3) return Promise.resolve(cluster);
  cluster.pending = new Promise((resolve) => {
    execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'root@proxmox', 'pvesh get /cluster/resources --output-format json'],
      { timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
        if (err) { cluster.err = String(err.message || err).slice(0, 200); }
        else {
          try {
            const rows = JSON.parse(out);
            cluster.data = {
              nodes: rows.filter((r) => r.type === 'node').sort((a, b) => a.node.localeCompare(b.node)).map((r) => ({ name: r.node, status: r.status, cpu: r.cpu, maxcpu: r.maxcpu, mem: r.mem, maxmem: r.maxmem, uptime: r.uptime })),
              guests: rows.filter((r) => r.type === 'qemu' || r.type === 'lxc').map((r) => ({ vmid: r.vmid, name: r.name, node: r.node, type: r.type, status: r.status, cpu: r.cpu, maxcpu: r.maxcpu, mem: r.mem, maxmem: r.maxmem, uptime: r.uptime })).sort((a, b) => a.vmid - b.vmid),
              storage: rows.filter((r) => r.type === 'storage' && r.maxdisk).map((r) => ({ name: r.storage, node: r.node, used: r.disk, total: r.maxdisk, shared: !!r.shared })),
            };
            cluster.err = null;
          } catch (e) { cluster.err = 'bad pvesh output'; }
        }
        cluster.at = Date.now(); cluster.pending = null; resolve(cluster);
      });
  });
  return cluster.pending;
}

// TLS is verified: every probe target has a real certificate (tailscale serve or
// Cloudflare), so a cert error now shows up as the service being down.
function probeHttp(url) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.request(url, { method: 'GET', timeout: 6000, headers: { 'user-agent': 'homelab-portal' } }, (r) => {
      r.resume();
      const ms = Math.round(performance.now() - t0);
      // Any HTTP answer below 500 means the service is up (401/302 are login walls).
      resolve({ up: r.statusCode < 500, code: r.statusCode, ms });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ up: false, err: e.code || e.message, ms: Math.round(performance.now() - t0) }));
    req.end();
  });
}

let probes = { at: 0, results: {}, pending: null };
async function runProbes() {
  if (probes.pending) return probes.pending;
  if (Date.now() - probes.at < 30e3) return probes;
  probes.pending = (async () => {
    const list = JSON.parse(await fsp.readFile(SERVICES_FILE, 'utf8'));
    const out = await Promise.all(list.map(async (s) => ({ ...s, status: s.check?.http ? await probeHttp(s.check.http) : null })));
    probes = { at: Date.now(), results: out, pending: null };
    return probes;
  })().catch((e) => { probes.pending = null; throw e; });
  return probes.pending;
}

// ---------- Claude sessions ----------

const metaCache = new Map(); // file -> {mtime, meta}

async function sessionFiles() {
  const out = [];
  let dirs = [];
  try { dirs = await fsp.readdir(PROJECTS); } catch { return out; }
  for (const d of dirs) {
    let files = [];
    try { files = await fsp.readdir(path.join(PROJECTS, d)); } catch { continue; }
    for (const f of files) if (f.endsWith('.jsonl')) out.push(path.join(PROJECTS, d, f));
  }
  return out;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return '';
}

function isNoise(text) {
  return !text || /^<(command-|local-command|system-reminder|bash-|task-notification)/.test(text.trim()) || text.startsWith('Caveat: ');
}

async function sessionMeta(file) {
  const st = await fsp.stat(file);
  const hit = metaCache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit.meta;
  const raw = await fsp.readFile(file, 'utf8');
  let title = '', first = '', cwd = '', count = 0, last = '';
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.type === 'ai-title' && d.aiTitle) title = d.aiTitle;
    else if (d.type === 'custom-title' && d.customTitle) title = d.customTitle;
    else if (d.type === 'user' && !d.isSidechain && !d.isMeta) {
      const t = textOf(d.message?.content);
      if (!isNoise(t)) { count++; if (!first) first = t; last = t; }
      if (!cwd && d.cwd) cwd = d.cwd;
    }
  }
  const meta = {
    id: path.basename(file, '.jsonl'),
    project: path.basename(path.dirname(file)),
    title: title || first.slice(0, 80) || '(empty session)',
    preview: last.slice(0, 160),
    cwd: cwd || DEFAULT_CWD,
    messages: count,
    mtime: st.mtimeMs,
    size: st.size,
  };
  metaCache.set(file, { mtime: st.mtimeMs, meta });
  return meta;
}

async function findSession(id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  for (const f of await sessionFiles()) if (path.basename(f, '.jsonl') === id) return f;
  return null;
}

function clip(s, n) { s = typeof s === 'string' ? s : JSON.stringify(s); return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars)` : s; }

// Clip each string field rather than the serialized object, so the client can still parse it.
function clipInput(o) {
  if (!o || typeof o !== 'object') return o;
  const out = Array.isArray(o) ? [] : {};
  for (const [k, v] of Object.entries(o)) out[k] = typeof v === 'string' ? clip(v, 3000) : v;
  return out;
}

function toolResultText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : '').join('\n');
  return '';
}

async function transcript(file) {
  const raw = await fsp.readFile(file, 'utf8');
  const items = [];
  const toolIdx = new Map();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.isSidechain) continue;
    if (d.type === 'user') {
      const c = d.message?.content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === 'tool_result') {
            const i = toolIdx.get(b.tool_use_id);
            if (i !== undefined) { items[i].result = clip(toolResultText(b.content), 4000); items[i].error = !!b.is_error; }
          }
        }
      }
      if (d.isMeta) continue;
      const t = textOf(c);
      if (!isNoise(t)) items.push({ kind: 'user', text: t, ts: d.timestamp });
    } else if (d.type === 'assistant') {
      for (const b of d.message?.content || []) {
        if (b.type === 'text' && b.text.trim()) items.push({ kind: 'assistant', text: b.text, ts: d.timestamp });
        else if (b.type === 'tool_use') { toolIdx.set(b.id, items.length); items.push({ kind: 'tool', id: b.id, name: b.name, input: clipInput(b.input), ts: d.timestamp }); }
      }
    }
  }
  // Long sessions: keep the tail, which is what you want to see in a chat view.
  const MAX = 400;
  return items.length > MAX ? { truncated: items.length - MAX, items: items.slice(-MAX) } : { truncated: 0, items };
}

// ---------- runs (one claude -p process per turn) ----------

const runs = new Map(); // runId -> run
const sessionRun = new Map(); // sessionId -> runId

const PORTAL_PROMPT = `The user is talking to you through their homelab portal web page, not a terminal. They cannot answer interactive permission prompts or AskUserQuestion; if you need a decision, ask in plain text and end your turn. Files they upload through the portal are saved under ${UPLOADS}/ and their paths are listed in the message when attached.`;

function startRun({ sessionId, resume, message, display, model, cwd }) {
  const id = crypto.randomUUID();
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'auto', '--append-system-prompt', PORTAL_PROMPT];
  if (resume) args.push('--resume', sessionId); else args.push('--session-id', sessionId);
  if (model) args.push('--model', model);
  const child = spawn(CLAUDE_BIN, args, { cwd, env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'portal' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const run = { id, sessionId, child, events: [], listeners: new Set(), done: false, started: Date.now() };
  runs.set(id, run);
  sessionRun.set(sessionId, id);
  child.stdin.end(message);

  const emit = (ev) => {
    run.events.push(ev);
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of run.listeners) res.write(line);
  };
  emit({ t: 'user', text: display });

  let buf = '', stderr = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let d; try { d = JSON.parse(line); } catch { continue; }
      if (d.parent_tool_use_id) continue; // subagent internals
      if (d.type === 'stream_event') {
        const e = d.event;
        if (e.type === 'content_block_start' && e.content_block?.type === 'text') emit({ t: 'text_start' });
        else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') emit({ t: 'text', text: e.delta.text });
      } else if (d.type === 'assistant') {
        for (const b of d.message?.content || []) if (b.type === 'tool_use') emit({ t: 'tool', id: b.id, name: b.name, input: clipInput(b.input) });
      } else if (d.type === 'user') {
        for (const b of d.message?.content || []) if (b.type === 'tool_result') emit({ t: 'tool_result', id: b.tool_use_id, result: clip(toolResultText(b.content), 4000), error: !!b.is_error });
      } else if (d.type === 'system' && d.subtype === 'status' && d.status) {
        emit({ t: 'status', status: d.status });
      } else if (d.type === 'result') {
        emit({ t: 'result', ok: d.subtype === 'success' && !d.is_error, text: d.subtype === 'success' ? '' : (d.result || d.subtype), cost: d.total_cost_usd, ms: d.duration_ms });
      }
    }
  });
  child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-4000); });
  child.on('close', (code, signal) => {
    run.done = true;
    if (code !== 0) emit({ t: 'error', text: signal ? `stopped (${signal})` : `claude exited ${code}${stderr ? ': ' + stderr.trim().slice(-600) : ''}` });
    emit({ t: 'end' });
    for (const res of run.listeners) res.end();
    run.listeners.clear();
    if (sessionRun.get(sessionId) === id) sessionRun.delete(sessionId);
    setTimeout(() => runs.delete(id), 15 * 60e3);
  });
  return run;
}

// ---------- GLM on Modal (untrusted model, untrusted VM) ----------
// The model and everything the VM returns are data. They only ever reach the model and the browser,
// which shows them with textContent. Tool calls go to the VM as JSON and are never run on this machine.

const LLM_URL = process.env.LLM_URL || 'https://<your-modal-endpoint>.modal.run/v1/chat/completions';
const LLM_TOKEN_FILE = path.join(HOME, 'llm-modal', '.proxy-token.json');
const LLM_START_LIMIT_MS = Number(process.env.LLM_START_LIMIT_MS || 10 * 60e3); // a cold start takes about 4 minutes
const LLM_RETRY_MS = Number(process.env.LLM_RETRY_MS || 10e3);
// No per-reply token cap: Modal bills by GPU minute, not tokens, so a reply runs
// until the model stops on its own or the per-message time budget below is hit.
// Optional ceiling only if LLM_MAX_TOKENS is set in the environment; otherwise omitted.
const LLM_MAX_TOKENS = process.env.LLM_MAX_TOKENS ? Number(process.env.LLM_MAX_TOKENS) : null;
const LLM_MAX_RUN_MS = Number(process.env.LLM_MAX_RUN_MS || 30 * 60e3); // 30 min of autonomous work per message, then it waits for you
const LLM_MAX_STEPS = Number(process.env.LLM_MAX_STEPS || 10000); // runaway guard only; the time budget is the real limit
const TOOL_TEXT_LIMIT = 24000; // per tool result, to protect the token context
// Auto-trim: the model window is 128K; keep what we send under a budget so a long
// chat never overflows and truncates. Drops the oldest turns, keeps the system
// prompt and the most recent turns, and only cuts on a user-message boundary so
// no tool result is ever orphaned from the assistant call that produced it.
const LLM_CTX_TOKENS = Number(process.env.LLM_CTX_TOKENS || 131072);
const LLM_REPLY_RESERVE = Number(process.env.LLM_REPLY_RESERVE || 32768); // room left for reasoning + the reply
function estTokens(m) { // deliberate over-estimate (chars/3.3 + overhead) so we trim early, never late
  const body = (typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')) + (m.tool_calls ? JSON.stringify(m.tool_calls) : '');
  return Math.ceil(body.length / 3.3) + 8;
}
function trimForWindow(messages) {
  const budget = LLM_CTX_TOKENS - LLM_REPLY_RESERVE;
  const sys = messages[0]?.role === 'system' ? [messages[0]] : [];
  const rest = messages.slice(sys.length);
  let total = sys.reduce((n, m) => n + estTokens(m), 0);
  let start = rest.length;
  for (let i = rest.length - 1; i >= 0; i--) { const t = estTokens(rest[i]); if (total + t > budget) break; total += t; start = i; }
  while (start < rest.length && rest[start].role !== 'user') start++; // begin on a user turn, never mid tool-group
  let lastUser = rest.length; for (let k = rest.length - 1; k >= 0; k--) if (rest[k].role === 'user') { lastUser = k; break; }
  if (start > lastUser) start = lastUser; // always keep the current turn even if it alone is huge
  return start === 0 ? messages : [...sys, ...rest.slice(start)];
}
const VM_SSH = (process.env.LLM_VM_SSH || 'ssh -T -o BatchMode=yes -o ConnectTimeout=5 root@pve2').split(' ');
let llmBusy = false; // the deployment serves one request at a time

const VM_PROMPT = `You can act on an isolated Debian 13 VM through your tools. You are the unprivileged user "agent", with home directory /home/agent and no root access. Relative paths start from the home directory.
Each run_command starts a new shell in the home directory, so only files persist between commands. Commands are killed at their timeout (default 120 seconds, maximum 600).
Python 3, gcc, g++ and make are installed. The VM has no internet access, so you cannot download or install anything.
To write and run code, save it with write_file, then compile or run it with run_command. Only say something ran if a tool result shows it, and report what the output actually said.`;

const VM_TOOLS = [
  ['run_command', 'Run a bash command on the VM and return its exit code and combined stdout and stderr.', {
    command: { type: 'string', description: 'The bash command to run.' },
    timeout_seconds: { type: 'integer', description: 'Optional limit in seconds. Default 120, maximum 600.' },
  }, ['command']],
  ['read_file', 'Read a text file on the VM.', { path: { type: 'string', description: 'File path.' } }, ['path']],
  ['write_file', 'Create or overwrite a text file on the VM, creating parent folders as needed.', {
    path: { type: 'string', description: 'File path.' },
    content: { type: 'string', description: 'The complete file contents.' },
  }, ['path', 'content']],
].map(([name, description, properties, required]) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } }));

// Everything the model is sent, says and does goes to this file as finished spans, and
// ~/llm-trace/ship.py forwards them to Langfuse. It's a local file so tracing can't slow or break a
// chat, and an outage of Langfuse loses nothing. The contents are untrusted: they are only ever stored.
const TRACE_LOG = path.join(HOME, '.local', 'state', 'llm-trace', 'glm.jsonl');
const GLM_CONVOS = path.join(DATA, 'glm-conversations');
fs.mkdirSync(GLM_CONVOS, { recursive: true, mode: 0o700 });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LLM_MODEL_NAME = 'glm-5.3-flash-abliterated';
const newSpanId = () => crypto.randomBytes(8).toString('hex');

function traceLog(span) {
  try {
    fs.mkdirSync(path.dirname(TRACE_LOG), { recursive: true, mode: 0o700 });
    fs.appendFileSync(TRACE_LOG, JSON.stringify(span) + '\n', { mode: 0o600 });
  } catch (e) { console.error(`trace log: ${e.message}`); }
}

// One connection to the VM's tool port, carried over ssh by `llm-sandbox bridge` on pve2.
class VmBridge {
  constructor() {
    this.pending = new Map();
    this.buf = '';
    this.child = spawn(VM_SSH[0], [...VM_SSH.slice(1), 'llm-sandbox', 'bridge'], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.child.stdin.on('error', () => {});
    this.child.stdin.write('{"op":"cancel"}\n'); // only one connection exists at a time, so anything still running is left over
    this.child.on('error', () => this.fail());
    this.child.on('close', () => this.fail());
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      this.buf += chunk;
      if (this.buf.length > 4 * 1024 * 1024 && !this.buf.includes('\n')) this.buf = '';
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        let d; try { d = JSON.parse(line); } catch { continue; }
        const p = d && this.pending.get(d.id);
        if (p) { this.pending.delete(d.id); clearTimeout(p.timer); p.resolve(d); }
      }
    });
  }

  call(request, ms) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('the VM did not answer in time')); }, ms);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, ...request }) + '\n');
    });
  }

  fail() {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('lost the connection to the VM')); }
    this.pending.clear();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.write('{"op":"cancel"}\n'); // ends any command still running
    setTimeout(() => this.child.kill(), 300);
  }
}

// Replies from the VM can hold any JSON, so don't let String() or Number() run on objects.
const vmText = (v) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));
const vmNumber = (v) => (typeof v === 'number' ? v : NaN);

function clipMiddle(text, limit = TOOL_TEXT_LIMIT) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit / 2)}\n... [${text.length - limit} characters omitted] ...\n${text.slice(-limit / 2)}`;
}

async function runTool(bridge, call) {
  let args;
  try { args = JSON.parse(call.function.arguments || '{}'); } catch { return { ok: false, text: 'Error: the tool arguments were not valid JSON.', meta: { status: 'bad_arguments' } }; }
  if (!args || typeof args !== 'object') return { ok: false, text: 'Error: the tool arguments must be an object.', meta: { status: 'bad_arguments' } };
  let request, limit = 60e3;
  switch (call.function.name) {
    case 'run_command': {
      if (typeof args.command !== 'string' || !args.command.trim()) return { ok: false, text: 'Error: command is required.', meta: { status: 'bad_arguments' } };
      const seconds = Number.isInteger(args.timeout_seconds) && args.timeout_seconds > 0 ? Math.min(args.timeout_seconds, 600) : 120;
      request = { op: 'run', command: args.command, timeout: seconds };
      limit = (seconds + 60) * 1000;
      break;
    }
    case 'read_file':
      request = { op: 'read', path: args.path }; limit = 120e3; break;
    case 'write_file':
      request = { op: 'write', path: args.path, content: args.content }; limit = 180e3; break;
    default:
      return { ok: false, text: `Error: there is no tool called ${call.function.name}.`, meta: { status: 'unknown_tool' } };
  }
  const r = await bridge.call(request, limit);
  // The model-facing `text` stays clipped at TOOL_TEXT_LIMIT to protect its context; `raw` is the
  // fuller output stored on the trace span (already capped ~64 KB for commands, 256 KB for reads by
  // the VM side), and `meta` carries exit code / status as structured, filterable fields.
  if (r.ok !== true) return { ok: false, text: `Error: ${vmText(r.error) || 'the tool failed'}`, meta: { op: request.op, status: 'failed' } };
  if (request.op === 'write') return { ok: true, text: `Wrote ${vmNumber(r.bytes)} bytes to ${vmText(r.path)}.`, meta: { op: 'write', status: 'ok', bytes: vmNumber(r.bytes), path: vmText(r.path) } };
  if (request.op === 'read') {
    const content = vmText(r.content), note = r.truncated ? '\n... [file is longer than the 256 KB read limit]' : '';
    return { ok: true, text: clipMiddle(content) + note, raw: content + note, meta: { op: 'read', status: 'ok', bytes: content.length, truncated: !!r.truncated } };
  }
  const timedOut = !!r.timed_out, cancelled = !!r.cancelled, exitCode = vmNumber(r.exit_code), output = vmText(r.output);
  const status = cancelled ? 'cancelled' : timedOut ? `timed out after ${request.timeout} seconds` : `exit code ${exitCode}`;
  const meta = { op: 'run', status: cancelled ? 'cancelled' : timedOut ? 'timed_out' : 'exited', timed_out: timedOut, cancelled };
  if (!cancelled && !timedOut) meta.exit_code = exitCode;
  return { ok: !timedOut && !cancelled && exitCode === 0, text: `[${status}]\n${clipMiddle(output)}`, raw: `[${status}]\n${output}`, meta };
}

function llmRequest(payload, authorization, signal) {
  return new Promise((resolve, reject) => {
    const mod = LLM_URL.startsWith('https:') ? https : http;
    const req = mod.request(LLM_URL, { method: 'POST', signal, headers: { 'content-type': 'application/json', authorization, 'content-length': Buffer.byteLength(payload) } }, resolve);
    req.on('error', reject);
    req.end(payload);
  });
}

async function llmStream(up, write) {
  up.setEncoding('utf8');
  const result = { content: '', toolCalls: [], finish: null };
  let buf = '';
  for await (const chunk of up) {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let d; try { d = JSON.parse(data); } catch { continue; }
      const choice = d.choices?.[0];
      const delta = choice?.delta;
      if (delta?.reasoning_content) write({ t: 'reasoning', text: delta.reasoning_content });
      if (delta?.content) { result.content += delta.content; write({ t: 'text', text: delta.content }); }
      for (const c of delta?.tool_calls || []) {
        const n = Number.isInteger(c.index) ? c.index : result.toolCalls.length;
        const call = result.toolCalls[n] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (c.id) call.id = String(c.id);
        if (c.function?.name) call.function.name += c.function.name;
        if (c.function?.arguments) call.function.arguments += c.function.arguments;
        if (n === result.toolCalls.length - 1) write({ t: 'tool_writing', name: call.function.name, size: call.function.arguments.length });
      }
      if (choice?.finish_reason) result.finish = choice.finish_reason;
    }
  }
  result.toolCalls = result.toolCalls.filter(Boolean);
  if (!result.finish) throw new Error('The connection to the model dropped before the reply finished.');
  return result;
}

// One model call, retrying while it cold-starts. Returns null if it could not start.
async function llmCompletion(payload, authorization, write, signal) {
  const started = Date.now();
  for (;;) {
    const up = await llmRequest(payload, authorization, signal).catch((e) => e);
    if (signal.aborted) return null;
    if (up instanceof Error || [502, 503, 504].includes(up.statusCode)) {
      if (!(up instanceof Error)) up.resume();
      const waited = Date.now() - started;
      if (waited > LLM_START_LIMIT_MS) {
        write({ t: 'error', text: `The model did not start within ${Math.round(LLM_START_LIMIT_MS / 60e3)} minutes. It may not be deployed: run "modal deploy app.py" in ~/llm-modal.` });
        return null;
      }
      write({ t: 'waiting', seconds: Math.round(waited / 1000) });
      await new Promise((resolve) => { const t = setTimeout(resolve, LLM_RETRY_MS); signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true }); });
      if (signal.aborted) return null;
      continue;
    }
    if (up.statusCode !== 200) {
      let text = ''; up.setEncoding('utf8');
      for await (const c of up) { text += c; if (text.length > 1000) break; }
      write({ t: 'error', text: `Model returned HTTP ${up.statusCode}: ${text.slice(0, 500)}` });
      return null;
    }
    write({ t: 'started' });
    return llmStream(up, write);
  }
}

// History comes from the browser. Rebuild it field by field; only calls the model makes in this
// request are ever run, never ones found in history.
function cleanMessages(list, useTools) {
  const out = [];
  for (const m of list) {
    if (m?.role === 'user' && typeof m.content === 'string') out.push({ role: 'user', content: m.content });
    else if (m?.role === 'assistant' && typeof m.content === 'string') {
      const calls = useTools && Array.isArray(m.tool_calls) ? m.tool_calls.map((c) => ({ id: String(c?.id), type: 'function', function: { name: String(c?.function?.name), arguments: String(c?.function?.arguments) } })) : [];
      if (m.content || calls.length) out.push({ role: 'assistant', content: m.content, ...(calls.length ? { tool_calls: calls } : {}) });
    } else if (m?.role === 'tool' && typeof m.content === 'string') {
      if (useTools) out.push({ role: 'tool', tool_call_id: String(m.tool_call_id), content: m.content });
    } else return null;
  }
  return out;
}

async function handleLlmChat(req, res) {
  const body = await readJson(req, 8 * 1024 * 1024);
  const useTools = body.tools === true;
  const history = Array.isArray(body.messages) ? cleanMessages(body.messages, useTools) : null;
  if (!history?.length || history.at(-1).role !== 'user') return send(res, 400, { error: 'bad messages' });
  if (llmBusy) return send(res, 409, { error: 'The model is already answering another message.' });

  let authorization;
  try { authorization = JSON.parse(await fsp.readFile(LLM_TOKEN_FILE, 'utf8')).Authorization; }
  catch { return send(res, 500, { error: 'Modal proxy token is missing on claude-agent.' }); }

  llmBusy = true;
  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
  const prompt = history.at(-1).content;
  const nowIso = () => new Date().toISOString();
  const traceName = `glm: ${prompt.replace(/\s+/g, ' ').slice(0, 70)}`;
  const trace = {
    environment: 'glm', trace_id: crypto.randomBytes(16).toString('hex'), trace_name: traceName, tags: [useTools ? 'vm-tools' : 'chat'],
    // History lives in the browser, so the first message is what ties a conversation's traces together.
    session: `glm-${crypto.createHash('sha256').update(history[0].content || '').digest('hex').slice(0, 16)}`,
  };
  const rootId = newSpanId();
  const opened = nowIso();
  traceLog({ ...trace, span_id: rootId, name: traceName, type: 'span', start: opened, end: opened, input: prompt, metadata: { messages_in_request: history.length } });
  let generation = null; // the model call in progress, kept so a stopped reply is still recorded
  const write = (o) => {
    if (generation && o.t === 'text') generation.content += o.text;
    if (generation && o.t === 'reasoning') generation.reasoning += o.text;
    if (o.t === 'error') { const at = nowIso(); traceLog({ ...trace, span_id: newSpanId(), parent: generation?.id || rootId, name: 'error', type: 'event', start: at, end: at, level: 'ERROR', status: String(o.text).slice(0, 500) }); }
    if (!res.writableEnded) res.write(JSON.stringify(o) + '\n');
  };
  const endGeneration = (extra = {}) => {
    if (!generation) return;
    const { id, name, start, input, metadata, content, reasoning } = generation;
    generation = null;
    traceLog({ ...trace, span_id: id, parent: rootId, name, type: 'generation', start, end: nowIso(), model: LLM_MODEL_NAME, input, metadata: { ...metadata, ...extra.metadata },
      output: { content, ...(reasoning ? { reasoning } : {}), ...(extra.toolCalls?.length ? { tool_calls: extra.toolCalls } : {}) }, level: extra.level, status: extra.status });
  };
  const ac = new AbortController(); // Stop or a closed page ends the model request and any running command
  res.on('close', () => ac.abort());
  const ping = setInterval(() => write({ t: 'ping' }), 20e3);
  const started = Date.now();
  let bridge = null;
  try {
    if (useTools) {
      // Check before calling the model, so a stopped VM doesn't wake the GPUs.
      write({ t: 'vm_check' });
      bridge = new VmBridge();
      const openBridge = bridge;
      ac.signal.addEventListener('abort', () => openBridge.close(), { once: true }); // also ends the wait for the command
      try { await bridge.call({ op: 'ping' }, 20e3); }
      catch { write({ t: 'error', text: 'The VM is not running or not ready. Press Start VM, wait about 30 seconds and send again, or turn off VM tools.' }); return; }
    }
    const messages = useTools ? [{ role: 'system', content: VM_PROMPT }, ...history] : history;
    let traced = 0; // messages already recorded, since each model call resends all of them
    for (let step = 0; ; step++) {
      if (ac.signal.aborted) return;
      if (Date.now() - started > LLM_MAX_RUN_MS || step >= LLM_MAX_STEPS) {
        write({ t: 'error', text: `Stopped after ${LLM_MAX_RUN_MS / 60e3} minutes of work on one message. Send another message to let it continue.` });
        return;
      }
      const sendMessages = trimForWindow(messages); // trim only the wire payload; full history stays for tracing and the browser
      if (sendMessages.length < messages.length) write({ t: 'status', status: `trimmed ${messages.length - sendMessages.length} old turns to fit the window` });
      const payload = JSON.stringify({ messages: sendMessages, stream: true, ...(LLM_MAX_TOKENS ? { max_tokens: LLM_MAX_TOKENS } : {}), ...(useTools ? { tools: VM_TOOLS } : {}) });
      generation = { id: newSpanId(), name: `step ${step + 1}`, start: nowIso(), input: messages.slice(traced), metadata: { step, total_messages: messages.length, tools: useTools }, content: '', reasoning: '' };
      traced = messages.length;
      const r = await llmCompletion(payload, authorization, write, ac.signal);
      if (!r) return;
      const generationId = generation.id;
      // Recorded before any tool runs, so a requested action is on file even if the command never returns.
      endGeneration({ toolCalls: r.toolCalls, metadata: { finish_reason: r.finish } });
      // A reply cut off at the limit can hold a half-written call, so it must not run.
      if (!r.toolCalls.length || r.finish === 'length') {
        write({ t: 'append', messages: r.content ? [{ role: 'assistant', content: r.content }] : [] });
        write({ t: 'finish', reason: r.finish });
        return;
      }
      r.toolCalls.forEach((c, i) => { c.id ||= `call_${step}_${i}`; });
      const assistant = { role: 'assistant', content: r.content, tool_calls: r.toolCalls };
      const results = [];
      for (const call of r.toolCalls) {
        write({ t: 'tool_call', id: call.id, name: call.function.name, arguments: clip(call.function.arguments, 4000) });
        const toolStart = nowIso();
        const result = await runTool(bridge, call).catch((e) => ({ ok: false, fatal: true, text: `Error: ${e.message}`, meta: { status: 'bridge_error' } }));
        let toolInput = call.function.arguments;
        try { toolInput = JSON.parse(toolInput); } catch { /* keep the raw text */ }
        traceLog({ ...trace, span_id: newSpanId(), parent: generationId, name: `tool: ${call.function.name}`, type: 'tool', start: toolStart, end: nowIso(), input: toolInput, output: result.raw ?? result.text, metadata: result.meta, ...(result.ok ? {} : { level: 'ERROR' }) });
        write({ t: 'tool_result', id: call.id, ok: result.ok, text: result.text });
        if (ac.signal.aborted) return;
        if (result.fatal) { write({ t: 'error', text: `Stopped: ${result.text.replace(/^Error: /, '')}. The VM may have shut down or be overloaded.` }); return; }
        results.push({ role: 'tool', tool_call_id: call.id, content: result.text });
      }
      messages.push(assistant, ...results);
      write({ t: 'append', messages: [assistant, ...results] });
    }
  } catch (e) {
    if (!ac.signal.aborted) write({ t: 'error', text: e.code ? `Model request failed: ${e.code}` : e.message });
  } finally {
    endGeneration({ level: 'WARNING', status: 'The reply did not finish.' });
    clearInterval(ping);
    bridge?.close();
    llmBusy = false;
    res.end();
  }
}

function vmCommand(action, timeout = 120e3) {
  return new Promise((resolve) => {
    execFile(VM_SSH[0], [...VM_SSH.slice(1), 'llm-sandbox', action], { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: String(stdout), error: String(stderr || err?.message || '').trim().slice(-300) });
    });
  });
}

async function handleLlmVm(req, res) {
  if (req.method === 'POST') {
    const { action } = await readJson(req);
    if (!['start', 'stop', 'reset'].includes(action)) return send(res, 400, { error: 'bad action' });
    if (action !== 'start' && llmBusy) return send(res, 409, { error: 'Stop the current message first.' });
    const r = await vmCommand(action);
    if (!r.ok) return send(res, 500, { error: r.error || `${action} failed` });
  }
  const r = await vmCommand('status', 20e3);
  if (!r.ok) return send(res, 500, { error: r.error || 'status failed' });
  const stops = r.output.match(/\d{4}-\d{2}-\d{2} (\d{2}:\d{2}):\d{2}/);
  return send(res, 200, { running: /status: running/.test(r.output), stopsAt: stops ? stops[1] : null });
}

// ---------- uploads ----------

function safeName(name) {
  const base = path.basename(String(name || 'upload')).replace(/[^\w.\- ()+@]/g, '_').replace(/^\.+/, '_').slice(0, 150);
  return base || 'upload';
}

function insideUploads(rel) {
  const p = path.resolve(UPLOADS, String(rel || ''));
  return p.startsWith(UPLOADS + path.sep) ? p : null;
}

async function listUploads() {
  const out = [];
  async function walk(dir) {
    for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(p);
      else if (ent.isFile() && !ent.name.startsWith('.part-')) {
        const st = await fsp.stat(p);
        out.push({ path: p, rel: path.relative(UPLOADS, p), name: ent.name, size: st.size, mtime: st.mtimeMs });
      }
    }
  }
  await walk(UPLOADS);
  return out.sort((a, b) => b.mtime - a.mtime);
}

async function handleUpload(req, res, url) {
  const len = Number(req.headers['content-length'] || 0);
  if (len > MAX_UPLOAD) return send(res, 413, { error: 'file too large (1 GiB max)' });
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(UPLOADS, day);
  await fsp.mkdir(dir, { recursive: true });
  let name = safeName(url.searchParams.get('name'));
  const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
  for (let n = 1; fs.existsSync(path.join(dir, name)); n++) name = `${stem}-${n}${ext}`;
  const tmp = path.join(dir, `.part-${crypto.randomUUID()}`);
  const out = fs.createWriteStream(tmp, { mode: 0o640 });
  let size = 0, aborted = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_UPLOAD && !aborted) { aborted = true; req.destroy(); out.destroy(); fs.rm(tmp, () => {}); send(res, 413, { error: 'file too large' }); }
  });
  req.pipe(out);
  out.on('finish', async () => {
    if (aborted) return;
    const final = path.join(dir, name);
    await fsp.rename(tmp, final);
    send(res, 200, { path: final, rel: path.relative(UPLOADS, final), name, size });
  });
  out.on('error', (e) => { if (!aborted) { aborted = true; fs.rm(tmp, () => {}); send(res, 500, { error: e.message }); } });
  req.on('aborted', () => { aborted = true; out.destroy(); fs.rm(tmp, () => {}); });
}

// ---------- routing ----------

// ---------- Authentik sign-in (OIDC authorization code + PKCE) ----------
// data/oidc.json: issuer, client_id, client_secret, redirect_uri, allowed_users, required_group.
// The password login stays as the break-glass path. Both still sit behind the tailnet ACL
// and the owner check in handle().
const OIDC_COOKIE = 'portal_oidc';
function loadOidc() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, 'oidc.json'), 'utf8')); } catch { return null; }
}
function httpsJson(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = https.request(url, { method, headers: { accept: 'application/json', ...headers }, timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; if (data.length > 1e6) r.destroy(new Error('response too large')); });
      res.on('end', () => {
        let j; try { j = JSON.parse(data); } catch { return reject(new Error(`bad JSON from ${url} (HTTP ${res.statusCode})`)); }
        if (res.statusCode >= 400) return reject(new Error(`${url} -> HTTP ${res.statusCode}: ${j.error_description || j.error || ''}`));
        resolve(j);
      });
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
let oidcMetaCache = null;
async function oidcMeta(o) {
  if (oidcMetaCache && oidcMetaCache.until > Date.now() && oidcMetaCache.issuer === o.issuer) return oidcMetaCache.v;
  const v = await httpsJson(`${o.issuer}.well-known/openid-configuration`);
  if (v.issuer !== o.issuer) throw new Error(`issuer mismatch: ${v.issuer}`);
  oidcMetaCache = { v, issuer: o.issuer, until: Date.now() + 3600e3 };
  return v;
}
const b64u = (b) => Buffer.from(b).toString('base64url');
function sealState(obj) { const body = b64u(JSON.stringify(obj)); return `${body}.${sign('oidc:' + body)}`; }
function openState(tok) {
  if (!tok) return null;
  const i = tok.lastIndexOf('.'); if (i < 0) return null;
  const body = tok.slice(0, i), mac = tok.slice(i + 1), want = sign('oidc:' + body);
  if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  try { const v = JSON.parse(Buffer.from(body, 'base64url').toString()); return v.exp > Date.now() ? v : null; } catch { return null; }
}
const safeEq = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
function htmlPage(res, code, title, msg, headers = {}) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...headers });
  res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title><link rel="stylesheet" href="/style.css"></head>` +
    `<body class="login-page"><div class="login-card"><div class="brand"><span class="logo">&gt;_</span> homelab</div><p>${esc(msg)}</p><a href="/login.html">Back to login</a></div></body></html>`);
}
async function oidcStart(res, who) {
  const o = loadOidc();
  if (!o) return htmlPage(res, 503, 'SSO off', 'Authentik sign-in is not configured.');
  let meta; try { meta = await oidcMeta(o); } catch (e) { console.log(`oidc discovery failed: ${e.message}`); return htmlPage(res, 502, 'SSO error', 'Could not reach Authentik.'); }
  const st = { s: b64u(crypto.randomBytes(24)), n: b64u(crypto.randomBytes(24)), v: b64u(crypto.randomBytes(48)), exp: Date.now() + 10 * 60e3 };
  const u = new URL(meta.authorization_endpoint);
  u.search = new URLSearchParams({
    response_type: 'code', client_id: o.client_id, redirect_uri: o.redirect_uri, scope: 'openid profile email',
    state: st.s, nonce: st.n, code_challenge: b64u(crypto.createHash('sha256').update(st.v).digest()), code_challenge_method: 'S256',
  }).toString();
  // Lax (not Strict) so it comes back on the top-level redirect from Authentik.
  res.writeHead(302, { location: u.toString(), 'cache-control': 'no-store',
    'set-cookie': `${OIDC_COOKIE}=${sealState(st)}; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=600${who.https ? '; Secure' : ''}` });
  res.end();
}
async function oidcCallback(req, res, url, ip, who) {
  const clear = `${OIDC_COOKIE}=; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=0`;
  const fail = (msg, why) => {
    (loginFails.get(ip) || loginFails.set(ip, []).get(ip)).push(Date.now());
    console.log(`sso login failed from ${ip} (${who.device}): ${why}`);
    return htmlPage(res, 401, 'Sign-in failed', msg, { 'set-cookie': clear });
  };
  if (loginLimited(ip)) return htmlPage(res, 429, 'Slow down', 'Too many attempts. Wait 15 minutes.');
  const o = loadOidc();
  if (!o) return htmlPage(res, 503, 'SSO off', 'Authentik sign-in is not configured.');
  const st = openState(cookies(req)[OIDC_COOKIE]);
  if (url.searchParams.get('error')) return fail(`Authentik said: ${url.searchParams.get('error_description') || url.searchParams.get('error')}`, url.searchParams.get('error'));
  if (!st || !safeEq(url.searchParams.get('state') || '', st.s)) return fail('Sign-in expired or was started elsewhere. Try again.', 'state mismatch');
  const code = url.searchParams.get('code');
  if (!code) return fail('No authorization code came back.', 'no code');
  let claims;
  try {
    const meta = await oidcMeta(o);
    const tok = await httpsJson(meta.token_endpoint, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: o.redirect_uri, code_verifier: st.v, client_id: o.client_id, client_secret: o.client_secret }).toString(),
    });
    // The ID token came straight from the token endpoint over verified TLS, so its signature
    // is not re-checked here (OIDC Core 3.1.3.7 step 6). Every claim below is.
    const parts = String(tok.id_token || '').split('.');
    if (parts.length !== 3) throw new Error('no id_token');
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    const aud = [].concat(claims.aud);
    if (claims.iss !== meta.issuer) throw new Error(`iss ${claims.iss}`);
    if (!aud.includes(o.client_id)) throw new Error(`aud ${aud}`);
    if (aud.length > 1 && claims.azp !== o.client_id) throw new Error('azp');
    if (!(claims.exp * 1000 > Date.now())) throw new Error('expired');
    if (!safeEq(claims.nonce || '', st.n)) throw new Error('nonce');
  } catch (e) { return fail('Authentik sign-in could not be verified.', e.message); }
  const user = claims.preferred_username, groups = [].concat(claims.groups || []);
  if (!(o.allowed_users || []).includes(user) || (o.required_group && !groups.includes(o.required_group))) {
    return fail(`${user || 'That account'} is not allowed into the portal.`, `user ${user} groups ${groups.join(',')}`);
  }
  console.log(`sso login ok from ${ip} (${who.device}) as ${user}`);
  // A fresh same-site navigation, so the SameSite=Strict session cookie is sent on the next load
  // (a plain 302 would still count as part of the cross-site redirect from Authentik).
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS,
    'set-cookie': [clear, `${COOKIE}=${makeToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${who.https ? '; Secure' : ''}`] });
  res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/"><title>Signed in</title></head><body>Signed in. <a href="/">Continue</a></body></html>');
}


async function serveStatic(res, rel) {
  const p = path.resolve(PUBLIC, rel === '/' ? 'index.html' : '.' + rel);
  if (!p.startsWith(PUBLIC + path.sep)) return send(res, 404, 'not found');
  try {
    const body = await fsp.readFile(p);
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-cache', ...SECURITY_HEADERS });
    res.end(body);
  } catch { send(res, 404, 'not found'); }
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://portal');
  let ip = remoteIp(req), who;
  if (ip === '127.0.0.1' && req.headers['tailscale-user-login']) {
    // Via tailscale serve: it strips client-supplied Tailscale-* headers and sets these
    // itself (never for tagged nodes), so they identify the tailnet user.
    ip = String(req.headers['x-forwarded-for'] || ip).split(',')[0].trim();
    who = { login: req.headers['tailscale-user-login'], device: (await whois(ip))?.device || ip, tags: [], https: true };
  } else who = await whois(ip);
  if (!who || who.login !== OWNER || who.tags.length) {
    console.log(`denied ${ip} ${who?.device || '?'} ${req.method} ${url.pathname}`);
    return send(res, 403, 'forbidden');
  }

  // Login page assets are public (to the owner's devices); everything else needs the cookie.
  const p = url.pathname;
  if (req.method === 'GET' && (p === '/login.html' || p === '/style.css' || p === '/login.js' || p === '/favicon.svg' || p === '/manifest.json' || /^\/icon-(180|192|512)\.png$/.test(p))) return serveStatic(res, p);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // CSRF guard on top of SameSite=Strict.
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, 'bad origin');
  }

  if (p === '/auth/login' && req.method === 'GET') return oidcStart(res, who);
  if (p === '/auth/callback' && req.method === 'GET') return oidcCallback(req, res, url, ip, who);

  if (p === '/api/login' && req.method === 'POST') {
    if (!loadAuth()) return send(res, 503, { error: 'No password set. Run ~/portal/bin/set-password on claude-agent.' });
    if (loginLimited(ip)) return send(res, 429, { error: 'Too many attempts. Wait 15 minutes.' });
    const body = await readJson(req).catch(() => ({}));
    if (!checkPassword(body.password || '')) {
      loginFails.get(ip).push(Date.now());
      console.log(`login failed from ${ip} (${who.device})`);
      return send(res, 401, { error: 'Wrong password' });
    }
    console.log(`login ok from ${ip} (${who.device})`);
    return send(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=${makeToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${who.https ? '; Secure' : ''}` });
  }

  if (!validToken(cookies(req)[COOKIE])) {
    if (p.startsWith('/api/')) return send(res, 401, { error: 'login required' });
    res.writeHead(302, { location: '/login.html' }); return res.end();
  }

  if (p === '/api/logout' && req.method === 'POST') return send(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
  if (p === '/api/me') return send(res, 200, { device: who.device, login: who.login });

  if (p === '/api/status') {
    const [c, s] = await Promise.all([fetchCluster(), runProbes()]);
    return send(res, 200, { cluster: c.data, clusterError: c.err, clusterAt: c.at, services: s.results, servicesAt: s.at });
  }

  if (p === '/api/sessions' && req.method === 'GET') {
    const files = await sessionFiles();
    const metas = (await Promise.all(files.map((f) => sessionMeta(f).catch(() => null)))).filter((m) => m && m.messages > 0);
    metas.sort((a, b) => b.mtime - a.mtime);
    for (const m of metas) m.running = sessionRun.get(m.id) || null;
    return send(res, 200, metas.slice(0, 100));
  }

  let m;
  if ((m = p.match(/^\/api\/sessions\/([0-9a-f-]{36})$/)) && req.method === 'GET') {
    const file = await findSession(m[1]);
    if (!file) return send(res, 404, { error: 'no such session' });
    const [meta, t] = await Promise.all([sessionMeta(file), transcript(file)]);
    const r = runs.get(sessionRun.get(m[1]));
    return send(res, 200, { ...meta, ...t, running: r ? { id: r.id, started: r.started } : null });
  }

  if (p === '/api/chat' && req.method === 'POST') {
    const body = await readJson(req);
    let message = String(body.message || '').trim();
    const files = Array.isArray(body.files) ? body.files.map((f) => insideUploads(path.relative(UPLOADS, String(f)))).filter(Boolean) : [];
    if (!message && !files.length) return send(res, 400, { error: 'empty message' });
    const display = message + (files.length ? `\n\n📎 ${files.map((f) => path.basename(f)).join(', ')}` : '');
    if (files.length) message += `\n\nAttached files (uploaded through the portal):\n${files.map((f) => `- ${f}`).join('\n')}`;
    const model = ['opus', 'sonnet', 'haiku', 'fable'].includes(body.model) ? body.model : undefined;
    let sessionId = body.sessionId, resume = false, cwd = DEFAULT_CWD;
    if (sessionId) {
      const file = await findSession(sessionId);
      if (!file) return send(res, 404, { error: 'no such session' });
      if (sessionRun.has(sessionId)) return send(res, 409, { error: 'Claude is already working in this session', runId: sessionRun.get(sessionId) });
      resume = true; cwd = (await sessionMeta(file)).cwd;
      if (!fs.existsSync(cwd)) cwd = DEFAULT_CWD;
    } else sessionId = crypto.randomUUID();
    const run = startRun({ sessionId, resume, message, display, model, cwd });
    return send(res, 200, { runId: run.id, sessionId });
  }

  if (p === '/api/llm/chat' && req.method === 'POST') return handleLlmChat(req, res);
  if (p === '/api/llm/vm' && (req.method === 'GET' || req.method === 'POST')) return handleLlmVm(req, res);

  // Saved GLM conversations, so an old chat can be reopened and continued. GLM's own chats only;
  // stored server-side (the same box already holds the trace log) behind this portal's login.
  if (p === '/api/llm/conversations' && req.method === 'GET') {
    const items = [];
    try {
      for (const f of fs.readdirSync(GLM_CONVOS)) {
        if (!f.endsWith('.json')) continue;
        try { const d = JSON.parse(fs.readFileSync(path.join(GLM_CONVOS, f), 'utf8')); items.push({ id: d.id, title: d.title || 'Untitled', updated: d.updated || 0, count: (d.messages || []).length }); } catch {}
      }
    } catch {}
    items.sort((a, b) => (b.updated || 0) - (a.updated || 0));
    return send(res, 200, items);
  }
  if ((m = p.match(/^\/api\/llm\/conversations\/([0-9a-f-]{36})$/))) {
    const id = m[1];
    const file = UUID_RE.test(id) ? path.join(GLM_CONVOS, `${id}.json`) : null;
    if (!file) return send(res, 400, { error: 'bad id' });
    if (req.method === 'GET') {
      try { return send(res, 200, JSON.parse(fs.readFileSync(file, 'utf8'))); }
      catch { return send(res, 404, { error: 'no such conversation' }); }
    }
    if (req.method === 'PUT') {
      const body = await readJson(req, 8 * 1024 * 1024);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const title = String(body.title || 'Untitled').slice(0, 200);
      let created = Date.now();
      try { created = JSON.parse(fs.readFileSync(file, 'utf8')).created || created; } catch {}
      fs.writeFileSync(file, JSON.stringify({ id, title, messages, created, updated: Date.now() }), { mode: 0o600 });
      return send(res, 200, { ok: true });
    }
    if (req.method === 'DELETE') { try { fs.unlinkSync(file); } catch {} return send(res, 200, { ok: true }); }
    return send(res, 405, { error: 'method not allowed' });
  }

  if (p === '/api/runs') return send(res, 200, [...runs.values()].filter((r) => !r.done).map((r) => ({ id: r.id, sessionId: r.sessionId, started: r.started })));

  if ((m = p.match(/^\/api\/runs\/([0-9a-f-]{36})\/events$/))) {
    const run = runs.get(m[1]);
    if (!run) return send(res, 404, { error: 'no such run' });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    const from = Number(url.searchParams.get('from') || 0);
    for (const ev of run.events.slice(from)) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    if (run.done) return res.end();
    run.listeners.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20e3);
    req.on('close', () => { clearInterval(ping); run.listeners.delete(res); });
    return;
  }

  if ((m = p.match(/^\/api\/runs\/([0-9a-f-]{36})\/stop$/)) && req.method === 'POST') {
    const run = runs.get(m[1]);
    if (!run || run.done) return send(res, 404, { error: 'not running' });
    run.child.kill('SIGINT');
    setTimeout(() => { if (!run.done) run.child.kill('SIGTERM'); }, 5000);
    return send(res, 200, { ok: true });
  }

  if (p === '/api/uploads' && req.method === 'PUT') return handleUpload(req, res, url);
  if (p === '/api/uploads' && req.method === 'GET') return send(res, 200, await listUploads());
  if (p === '/api/uploads/file') {
    const f = insideUploads(url.searchParams.get('rel'));
    if (!f || !fs.existsSync(f)) return send(res, 404, { error: 'not found' });
    if (req.method === 'DELETE') { await fsp.rm(f); return send(res, 200, { ok: true }); }
    const st = await fsp.stat(f);
    const inline = /\.(png|jpe?g|gif|webp|txt|log|md|json|pdf)$/i.test(f) && url.searchParams.get('dl') !== '1';
    res.writeHead(200, {
      'content-type': inline ? (MIME[path.extname(f).toLowerCase()] || ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf' })[path.extname(f).toLowerCase()] || 'text/plain; charset=utf-8') : 'application/octet-stream',
      'content-length': st.size,
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${path.basename(f).replace(/"/g, '')}"`,
      'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      'x-content-type-options': 'nosniff',
    });
    return fs.createReadStream(f).pipe(res);
  }

  if (req.method === 'GET' && !p.startsWith('/api/')) return serveStatic(res, p);
  send(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: String(e.message || e) }); else res.end();
  });
});
server.requestTimeout = 0; // uploads and SSE streams can run long
// The plain-HTTP tailnet listener only redirects to the HTTPS name.
const PUBLIC_URL = process.env.PORTAL_URL || 'https://claude-agent.tailnet-name.ts.net';
const redirector = http.createServer((req, res) => {
  res.writeHead(301, { location: PUBLIC_URL + (req.url.startsWith('/') ? req.url : '/') });
  res.end();
});
const servers = HOSTS.map((h) => {
  const srv = h === '127.0.0.1' ? server : redirector;
  srv.requestTimeout = 0;
  srv.on('error', (e) => console.error(`listen ${h}:${PORT}: ${e.message}`));
  srv.listen(PORT, h, () => console.log(`portal on http://${h}:${PORT}`));
  return srv;
});

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
  for (const r of runs.values()) if (!r.done) r.child.kill('SIGINT');
  for (const srv of servers) srv.close(); setTimeout(() => process.exit(0), 1500);
});
