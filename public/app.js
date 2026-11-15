// Homelab portal front end. No build step, no dependencies.
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { ...(opts.body && !(opts.body instanceof Blob) ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) } });
  if (r.status === 401) { location.href = '/login.html'; throw new Error('login required'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { status: r.status, data });
  return data;
}

// ---------- formatting ----------
const fmtBytes = (b) => { if (b == null) return '–'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; } return `${b.toFixed(b >= 10 || i === 0 ? 0 : 1)} ${u[i]}`; };
const fmtUptime = (s) => { if (!s) return '–'; const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; };
const fmtAgo = (t) => { const s = (Date.now() - t) / 1000; if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)}m ago`; if (s < 86400) return `${Math.floor(s / 3600)}h ago`; return new Date(t).toLocaleDateString(); };
const pct = (a, b) => (b ? Math.min(100, (a / b) * 100) : 0);

function bar(p) {
  const b = el('span', `bar${p > 90 ? ' crit' : p > 75 ? ' hot' : ''}`);
  const f = el('span'); f.style.width = `${p.toFixed(1)}%`; b.append(f);
  return b;
}
function meter(label, p, val) {
  const m = el('div', 'meter');
  m.append(el('span', null, label), bar(p), el('span', 'val', val));
  return m;
}

// ---------- tabs (narrow screens) ----------
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  if (t.dataset.view !== 'overview') setChatHidden(false); // clicking an AI tab brings the panel back
  setView(t.dataset.view);
}));
function setView(v) {
  $('layout').dataset.view = v;
  // Wide screens have no Overview tab: that view shows the overview beside Claude.
  const shown = v === 'overview' && matchMedia('(min-width: 901px)').matches ? 'claude' : v;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === shown));
  localStorage.setItem('view', v);
  if (v === 'claude') scrollBottom(true);
}

// ---------- minimize the AI panel (wide screens) ----------
function setChatHidden(hide) {
  $('layout').classList.toggle('chat-hidden', hide);
  $('chat-toggle').textContent = hide ? 'Show AI' : 'Hide AI';
  localStorage.setItem('chatHidden', hide ? '1' : '');
}
$('chat-toggle').addEventListener('click', () => setChatHidden(!$('layout').classList.contains('chat-hidden')));
document.querySelectorAll('.chat-min').forEach((b) => b.addEventListener('click', () => setChatHidden(true)));
setChatHidden(localStorage.getItem('chatHidden') === '1');

$('logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); location.href = '/login.html'; });
api('/api/me').then((m) => { $('me').textContent = m.device || ''; }).catch(() => {});

// ---------- overview ----------
async function refreshStatus() {
  let d;
  try { d = await api('/api/status'); } catch (e) { $('updated').textContent = `status error: ${e.message}`; return; }
  $('updated').textContent = `updated ${new Date().toLocaleTimeString()}`;

  const nodes = $('nodes'); nodes.replaceChildren();
  if (!d.cluster) nodes.append(el('div', 'muted', d.clusterError ? `Couldn't reach Proxmox: ${d.clusterError}` : 'Loading…'));
  for (const n of d.cluster?.nodes || []) {
    const c = el('div', 'node');
    const name = el('div', 'node-name'); name.append(el('span', `dot ${n.status === 'online' ? 'up' : 'down'}`), el('span', null, n.name), el('span', 'muted small', n.status === 'online' ? `up ${fmtUptime(n.uptime)}` : n.status));
    c.append(name);
    if (n.status === 'online') {
      c.append(meter('CPU', n.cpu * 100, `${(n.cpu * 100).toFixed(0)}% of ${n.maxcpu}`));
      c.append(meter('RAM', pct(n.mem, n.maxmem), `${fmtBytes(n.mem)} / ${fmtBytes(n.maxmem)}`));
    }
    nodes.append(c);
  }

  const svc = $('services'); svc.replaceChildren();
  const groups = new Map();
  for (const s of d.services || []) { if (!groups.has(s.group)) groups.set(s.group, []); groups.get(s.group).push(s); }
  let up = 0, total = 0;
  for (const [g, list] of groups) {
    svc.append(el('div', 'group-title', g));
    const grid = el('div', 'svc-grid');
    for (const s of list) {
      total++; if (s.status?.up) up++;
      const a = el('a', 'svc'); a.href = s.url; a.target = '_blank'; a.rel = 'noopener';
      const top = el('div', 'svc-top'); top.append(el('span', `dot ${s.status ? (s.status.up ? 'up' : 'down') : ''}`), el('span', null, s.name));
      const meta = s.status ? (s.status.up ? `${s.status.code} · ${s.status.ms} ms` : `down · ${s.status.err || s.status.code}`) : 'not checked';
      a.title = s.url;
      a.append(top, el('div', 'svc-desc', s.desc || ''), el('div', 'svc-meta', `${s.url.replace(/^https?:\/\//, '')} · ${meta}`));
      grid.append(a);
    }
    svc.append(grid);
  }
  $('svc-summary').textContent = total ? `${up}/${total} responding` : '';

  const tb = $('guests'); tb.replaceChildren();
  const guests = d.cluster?.guests || [];
  for (const g of guests) {
    const tr = el('tr', g.status === 'running' ? '' : 'stopped');
    const name = el('td'); const nm = el('span'); nm.style.display = 'inline-flex'; nm.style.gap = '8px'; nm.style.alignItems = 'center';
    nm.append(el('span', `dot ${g.status === 'running' ? 'up' : 'stopped'}`), el('span', null, g.name)); name.append(nm);
    const cpu = el('td', 'num'); const mem = el('td', 'num');
    if (g.status === 'running') {
      const cb = bar(g.cpu * 100); cb.classList.add('cell-bar'); cpu.append(cb, document.createTextNode(`${(g.cpu * 100).toFixed(0)}%`));
      const mb = bar(pct(g.mem, g.maxmem)); mb.classList.add('cell-bar'); mem.append(mb, document.createTextNode(`${fmtBytes(g.mem)} / ${fmtBytes(g.maxmem)}`));
    } else { cpu.textContent = '–'; mem.textContent = g.status; }
    tr.append(el('td', 'num', g.vmid), name, el('td', null, g.node), el('td', 'muted', g.type === 'qemu' ? 'VM' : 'LXC'), cpu, mem, el('td', 'num', g.status === 'running' ? fmtUptime(g.uptime) : '–'));
    tb.append(tr);
  }
  const running = guests.filter((g) => g.status === 'running').length;
  $('guest-summary').textContent = guests.length ? `${running} running, ${guests.length - running} stopped` : '';

  const st = $('storage'); st.replaceChildren();
  const seen = new Set();
  for (const s of (d.cluster?.storage || []).sort((a, b) => a.node.localeCompare(b.node) || a.name.localeCompare(b.name))) {
    const key = s.shared ? s.name : `${s.node}/${s.name}`;
    if (seen.has(key)) continue; seen.add(key);
    const c = el('div', 'store');
    c.append(el('div', null, s.shared ? `${s.name} (shared)` : `${s.node} · ${s.name}`), meter('', pct(s.used, s.total), `${fmtBytes(s.used)} / ${fmtBytes(s.total)}`));
    c.querySelector('.meter').firstChild.remove();
    st.append(c);
  }
}
refreshStatus();
setInterval(() => { if (!document.hidden) refreshStatus(); }, 30e3);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshStatus(); });

// ---------- markdown (small, escape-first) ----------
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function inline(s) {
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`)
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, p, u) => `${p}<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[i])}</code>`);
}
function markdown(src) {
  const lines = src.replace(/\r/g, '').split('\n');
  let out = '', i = 0;
  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
  while (i < lines.length) {
    const l = lines[i];
    let m;
    if ((m = l.match(/^\s*(```+|~~~+)\s*(\S*)/))) {
      const fence = m[1]; const buf = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) buf.push(lines[i++]);
      i++; out += `<pre><code>${esc(buf.join('\n'))}</code></pre>`; continue;
    }
    if ((m = l.match(/^(#{1,6})\s+(.*)/))) { const n = Math.min(4, m[1].length + 1); out += `<h${n}>${inline(m[2])}</h${n}>`; i++; continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(l)) { out += '<hr>'; i++; continue; }
    if (l.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      out += '<table><thead><tr>' + cells(l).map((c) => `<th>${c}</th>`).join('') + '</tr></thead><tbody>';
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { out += '<tr>' + cells(lines[i]).map((c) => `<td>${c}</td>`).join('') + '</tr>'; i++; }
      out += '</tbody></table>'; continue;
    }
    if (/^\s*>/.test(l)) { const buf = []; while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, '')); out += `<blockquote>${markdown(buf.join('\n'))}</blockquote>`; continue; }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
      const ordered = /^\s*\d/.test(l); const items = [];
      while (i < lines.length && (/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        const t = lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '');
        if (/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) items.push(t); else items[items.length - 1] += ' ' + t.trim();
        i++;
      }
      out += `<${ordered ? 'ol' : 'ul'}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`; continue;
    }
    if (!l.trim()) { i++; continue; }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*```|\s*~~~|\s*>|\s*([-*+]|\d+[.)])\s+)/.test(lines[i]) && !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))) buf.push(lines[i++]);
    out += `<p>${buf.map(inline).join('<br>')}</p>`;
  }
  return out;
}

// ---------- chat ----------
const state = { sessionId: null, runId: null, es: null, evCount: 0, attachments: [], sessions: [], liveText: null, liveRaw: '', tools: new Map() };
const msgs = $('messages');

function scrollBottom(force) {
  const near = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 160;
  if (force || near) requestAnimationFrame(() => { msgs.scrollTop = msgs.scrollHeight; });
}

function toolSummary(name, input) {
  let o = input; if (typeof o === 'string') { try { o = JSON.parse(o); } catch { return o.slice(0, 120); } }
  if (!o || typeof o !== 'object') return '';
  return o.description || o.command || o.file_path || o.pattern || o.url || o.query || o.prompt || o.skill || Object.values(o).find((v) => typeof v === 'string') || '';
}

function addUser(text) { $('empty')?.remove(); const d = el('div', 'msg user', text); msgs.append(d); }
function addAssistant(text) { $('empty')?.remove(); const d = el('div', 'msg assistant'); d.innerHTML = markdown(text); msgs.append(d); return d; }
function addTool(t) {
  $('empty')?.remove();
  const d = el('details', `tool${t.result === undefined ? ' pending' : ''}${t.error ? ' err' : ''}`);
  const s = el('summary'); s.append(el('span', 'tname', t.name), el('span', 'tsum', toolSummary(t.name, t.input)));
  d.append(s);
  const inp = typeof t.input === 'string' ? t.input : JSON.stringify(t.input, null, 2);
  d.append(el('pre', null, prettyJson(inp)));
  if (t.result !== undefined) d.append(el('pre', null, t.result || '(no output)'));
  msgs.append(d);
  return d;
}
function prettyJson(s) { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } }
function addNotice(text, err) { msgs.append(el('div', `notice${err ? ' err' : ''}`, text)); }

function resetMessages() {
  msgs.replaceChildren();
  state.tools.clear(); state.liveText = null; state.liveRaw = '';
}

async function openSession(id) {
  closeDrawers();
  stopStream();
  state.sessionId = id;
  localStorage.setItem('session', id || '');
  resetMessages();
  $('busy-warn').classList.add('hidden');
  if (!id) {
    $('chat-title').textContent = 'New session';
    const e = el('div', 'empty'); e.id = 'empty';
    e.innerHTML = '<p><strong>New session</strong></p><p class="muted">Claude runs here on claude-agent with the same access as your terminal sessions, in auto permission mode. Attach files with 📎 or drag them in.</p>';
    msgs.append(e);
    setRunning(null);
    return;
  }
  $('chat-title').textContent = 'Loading…';
  let s;
  try { s = await api(`/api/sessions/${id}`); } catch (e) { $('chat-title').textContent = 'Session not found'; return; }
  if (state.sessionId !== id) return;
  $('chat-title').textContent = s.title;
  if (s.truncated) addNotice(`${s.truncated} earlier items not shown`);
  // If a turn is in flight, the transcript already holds part of it; draw only what came
  // before the run and let the event replay draw the rest.
  const cutoff = s.running ? s.running.started - 1000 : Infinity;
  for (const it of s.items) {
    if (it.ts && Date.parse(it.ts) >= cutoff) break;
    if (it.kind === 'user') addUser(it.text);
    else if (it.kind === 'assistant') addAssistant(it.text);
    else addTool(it);
  }
  if (s.running) attachRun(s.running.id, 0, true);
  else {
    setRunning(null);
    if (Date.now() - s.mtime < 90e3) {
      $('busy-warn').textContent = 'This session was active in the last 90 seconds. If it is still open in a terminal, sending here will run alongside it and the two will interleave.';
      $('busy-warn').classList.remove('hidden');
    }
  }
  scrollBottom(true);
}

function setRunning(runId, status) {
  state.runId = runId;
  $('stop-btn').classList.toggle('hidden', !runId);
  $('send-btn').disabled = !!runId;
  const pill = $('run-status');
  pill.classList.toggle('hidden', !runId);
  pill.textContent = status || 'working';
}

function stopStream() { if (state.es) { state.es.close(); state.es = null; } }

// showUser: draw the run's user message from the stream (reattaching), rather than
// relying on the copy the composer already drew (fresh send).
function attachRun(runId, from = 0, showUser = false) {
  stopStream();
  setRunning(runId);
  state.evCount = from;
  const es = new EventSource(`/api/runs/${runId}/events?from=${from}`);
  state.es = es;
  es.onmessage = (m) => {
    state.evCount++;
    const ev = JSON.parse(m.data);
    if (ev.t === 'user') { if (showUser) addUser(ev.text); return; }
    handleEvent(ev);
  };
  es.onerror = () => {
    es.close();
    if (state.es !== es || !state.runId) return;
    // Network blip: resume from where we were.
    setTimeout(() => { if (state.runId === runId) attachRun(runId, state.evCount, showUser); }, 1500);
  };
}

function handleEvent(ev) {
  switch (ev.t) {
    case 'text_start':
      state.liveRaw = ''; state.liveText = addAssistant(''); break;
    case 'text':
      if (!state.liveText) state.liveText = addAssistant('');
      state.liveRaw += ev.text; state.liveText.innerHTML = markdown(state.liveRaw);
      setRunning(state.runId, 'writing'); break;
    case 'tool':
      state.liveText = null;
      state.tools.set(ev.id, addTool({ name: ev.name, input: ev.input }));
      setRunning(state.runId, `running ${ev.name}`); break;
    case 'tool_result': {
      const d = state.tools.get(ev.id);
      if (d) { d.classList.remove('pending'); if (ev.error) d.classList.add('err'); d.append(el('pre', null, ev.result || '(no output)')); }
      setRunning(state.runId, 'thinking'); break;
    }
    case 'status':
      setRunning(state.runId, ev.status === 'requesting' ? 'thinking' : ev.status); break;
    case 'result':
      if (!ev.ok && ev.text) addNotice(ev.text, true);
      else if (ev.cost != null) addNotice(`done in ${(ev.ms / 1000).toFixed(0)}s · $${ev.cost.toFixed(2)}`);
      break;
    case 'error':
      addNotice(ev.text, true); break;
    case 'end':
      stopStream(); setRunning(null); loadSessions();
      if (state.pendingReload) { state.pendingReload = false; openSession(state.sessionId); }
      break;
  }
  scrollBottom();
}

$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.runId) return;
  const text = $('input').value.trim();
  if (state.attachments.some((a) => !a.path)) { addNotice('Wait for uploads to finish'); return; }
  const files = state.attachments.map((a) => a.path);
  if (!text && !files.length) return;
  $('empty')?.remove();
  $('busy-warn').classList.add('hidden');
  addUser(text + (files.length ? `\n\n📎 ${state.attachments.map((a) => a.name).join(', ')}` : ''));
  $('input').value = ''; autosize();
  state.attachments = []; renderAttachments();
  scrollBottom(true);
  try {
    const r = await api('/api/chat', { method: 'POST', body: JSON.stringify({ sessionId: state.sessionId, message: text, files, model: $('model').value || undefined }) });
    if (!state.sessionId) {
      state.sessionId = r.sessionId; localStorage.setItem('session', r.sessionId);
      $('chat-title').textContent = text.slice(0, 80) || 'New session';
      state.pendingReload = true; // pick up the generated title once the turn ends
    }
    attachRun(r.runId);
  } catch (err) {
    addNotice(err.message, true);
  }
});

$('stop-btn').addEventListener('click', async () => { if (state.runId) await api(`/api/runs/${state.runId}/stop`, { method: 'POST' }).catch(() => {}); });
$('new-btn').addEventListener('click', () => openSession(null));

const input = $('input');
function autosize() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.4)}px`; }
input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); $('composer').requestSubmit(); }
});

// ---------- sessions drawer ----------
function closeDrawers() { document.querySelectorAll('.drawer').forEach((d) => d.classList.add('hidden')); }
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => $(b.dataset.close).classList.add('hidden')));
$('sessions-btn').addEventListener('click', () => { const d = $('sessions-drawer'); const open = d.classList.contains('hidden'); closeDrawers(); if (open) { d.classList.remove('hidden'); loadSessions(); } });
$('files-btn').addEventListener('click', () => { const d = $('files-drawer'); const open = d.classList.contains('hidden'); closeDrawers(); if (open) { d.classList.remove('hidden'); loadFiles(); } });

async function loadSessions() {
  try { state.sessions = await api('/api/sessions'); } catch { return; }
  const ul = $('session-list'); ul.replaceChildren();
  for (const s of state.sessions) {
    const li = el('li', s.id === state.sessionId ? 'current' : '');
    const t = el('div', 's-title'); t.append(el('span', null, s.title)); if (s.running) t.append(el('span', 'badge', 'working'));
    li.append(t, el('div', 's-prev', s.preview), el('div', 's-meta', `${fmtAgo(s.mtime)} · ${s.messages} messages${s.cwd !== '/home/claude-agent' ? ' · ' + s.cwd : ''}`));
    li.addEventListener('click', () => { openSession(s.id); setView('claude'); });
    ul.append(li);
  }
  if (!state.sessions.length) ul.append(el('li', 'muted', 'No sessions yet'));
}

// ---------- uploads ----------
function uploadFile(file, onDone) {
  const xhr = new XMLHttpRequest();
  xhr.open('PUT', `/api/uploads?name=${encodeURIComponent(file.name)}`);
  xhr.onload = () => {
    if (xhr.status === 401) { location.href = '/login.html'; return; }
    let d = {}; try { d = JSON.parse(xhr.responseText); } catch {}
    onDone(xhr.status === 200 ? null : new Error(d.error || `upload failed (${xhr.status})`), d);
  };
  xhr.onerror = () => onDone(new Error('upload failed'));
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) onDone.progress?.(e.loaded / e.total); };
  xhr.send(file);
  return xhr;
}

function attachFiles(fileList) {
  for (const f of fileList) {
    const a = { name: f.name, path: null, pct: 0 };
    state.attachments.push(a); renderAttachments();
    const done = (err, d) => {
      if (err) { state.attachments = state.attachments.filter((x) => x !== a); addNotice(`${f.name}: ${err.message}`, true); }
      else a.path = d.path;
      renderAttachments();
    };
    done.progress = (p) => { a.pct = p; renderAttachments(); };
    a.xhr = uploadFile(f, done);
  }
}

function renderAttachments() {
  const box = $('attachments'); box.replaceChildren();
  for (const a of state.attachments) {
    const c = el('span', `chip${a.path ? '' : ' uploading'}`, a.path ? a.name : `${a.name} ${(a.pct * 100).toFixed(0)}%`);
    const x = el('button', null, '×'); x.type = 'button'; x.title = 'Remove';
    x.addEventListener('click', () => { a.xhr?.abort(); state.attachments = state.attachments.filter((y) => y !== a); renderAttachments(); });
    c.append(x); box.append(c);
  }
}

$('attach-input').addEventListener('change', (e) => { attachFiles(e.target.files); e.target.value = ''; });
input.addEventListener('paste', (e) => { const files = [...(e.clipboardData?.files || [])]; if (files.length) { e.preventDefault(); attachFiles(files); } });

// Drag and drop onto the chat panel attaches; onto the files drawer just uploads.
const claude = $('claude');
let dragDepth = 0;
claude.addEventListener('dragenter', (e) => { if ([...e.dataTransfer.types].includes('Files')) { dragDepth++; $('drop-overlay').classList.remove('hidden'); } });
claude.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop-overlay').classList.add('hidden'); } });
claude.addEventListener('dragover', (e) => e.preventDefault());
claude.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('drop-overlay').classList.add('hidden');
  if (!e.dataTransfer.files.length) return;
  if (!$('files-drawer').classList.contains('hidden')) drawerUpload(e.dataTransfer.files);
  else attachFiles(e.dataTransfer.files);
});

function drawerUpload(files) {
  let left = files.length;
  for (const f of files) uploadFile(f, (err) => { if (err) alert(`${f.name}: ${err.message}`); if (--left === 0) loadFiles(); });
}
$('drawer-input').addEventListener('change', (e) => { drawerUpload(e.target.files); e.target.value = ''; });

async function loadFiles() {
  const ul = $('file-list'); ul.replaceChildren();
  let files = [];
  try { files = await api('/api/uploads'); } catch { return; }
  if (!files.length) ul.append(el('li', 'muted', 'Nothing uploaded yet'));
  for (const f of files) {
    const li = el('li');
    const a = el('a', 'f-name', f.rel); a.href = `/api/uploads/file?rel=${encodeURIComponent(f.rel)}`; a.target = '_blank'; a.title = f.path;
    const dl = el('button', 'ghost small', 'Download'); dl.title = 'Download this file';
    dl.addEventListener('click', () => {
      const link = el('a'); link.href = `/api/uploads/file?rel=${encodeURIComponent(f.rel)}&dl=1`; link.download = f.name;
      document.body.append(link); link.click(); link.remove();
    });
    const use = el('button', 'ghost small', 'Attach'); use.title = 'Attach to the next message';
    use.addEventListener('click', () => { if (!state.attachments.some((x) => x.path === f.path)) state.attachments.push({ name: f.name, path: f.path }); renderAttachments(); closeDrawers(); input.focus(); });
    const del = el('button', 'ghost small', 'Delete');
    del.addEventListener('click', async () => { if (!confirm(`Delete ${f.rel}?`)) return; await api(`/api/uploads/file?rel=${encodeURIComponent(f.rel)}`, { method: 'DELETE' }); loadFiles(); });
    li.append(a, el('span', 'f-size', `${fmtBytes(f.size)} · ${fmtAgo(f.mtime)}`), dl, use, del);
    ul.append(li);
  }
}

// ---------- boot ----------
setView(localStorage.getItem('view') || 'overview'); // scrolls the chat, so it has to run after the chat code is set up
loadSessions();
openSession(localStorage.getItem('session') || null);

// Installed Chrome app: mark when the folded title bar (window-controls overlay) is actually showing.
// In macOS full screen the controls hide, so the layout must not keep reserving room for them.
(function () {
  var o = navigator.windowControlsOverlay;
  if (!o) return;
  var sync = function () { document.documentElement.classList.toggle("wco", !!o.visible); };
  o.addEventListener("geometrychange", sync);
  addEventListener("resize", sync);
  sync();
})();
