// Chat with the untrusted GLM model on Modal, which can also act on the sandbox VM. Everything from
// the model or the VM goes into the page with textContent only, because this page can also drive
// Claude sessions. Never use innerHTML here.
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

const KEY = 'glm-history';
const TOOLS_KEY = 'glm-tools';
const msgs = $('glm-messages');
const input = $('glm-input');
const toolsBox = $('glm-tools');
let history = [];
let active = null; // AbortController for the request in flight

const CUR_KEY = 'glm-convo-id';
let convoId = null;
let saveTimer = null;

const convoTitle = () => { const u = history.find((m) => m.role === 'user' && m.content); return ((u ? u.content : 'New chat').split('\n')[0].slice(0, 60)) || 'New chat'; };
async function convoApi(url, opts) {
  const r = await fetch(url, opts);
  if (r.status === 401) { location.href = '/login.html'; throw new Error('login required'); }
  return r;
}
async function flushSave() {
  if (!convoId) return;
  try { await convoApi(`/api/llm/conversations/${convoId}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: convoTitle(), messages: history }) }); } catch {}
}
// Mirror locally at once for a fast reload, and flush to the server (debounced) so the chat persists.
const save = () => {
  try { localStorage.setItem(KEY, JSON.stringify({ id: convoId, history })); } catch {}
  clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 800);
};
toolsBox.checked = localStorage.getItem(TOOLS_KEY) !== 'off';
toolsBox.addEventListener('change', () => localStorage.setItem(TOOLS_KEY, toolsBox.checked ? 'on' : 'off'));

function scrollBottom(force) {
  const near = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 160;
  if (force || near) requestAnimationFrame(() => { msgs.scrollTop = msgs.scrollHeight; });
}
function notice(text, err) { msgs.append(el('div', `notice${err ? ' err' : ''}`, text)); scrollBottom(); }
const addMsg = (role, text) => { $('glm-empty')?.remove(); const d = el('div', `msg ${role === 'user' ? 'user' : 'assistant plain'}`, text); msgs.append(d); return d; };

function callSummary(name, rawArgs) {
  let a = {}; try { a = JSON.parse(rawArgs) || {}; } catch {}
  const s = name === 'run_command' ? a.command : a.path;
  return { summary: typeof s === 'string' ? s.split('\n')[0] : '', detail: name === 'run_command' && typeof a.command === 'string' ? a.command : name === 'write_file' && typeof a.content === 'string' ? a.content : '' };
}
function addCall(name, rawArgs) {
  $('glm-empty')?.remove();
  const { summary, detail } = callSummary(name, rawArgs);
  const d = el('details', 'tool pending');
  const s = el('summary'); s.append(el('span', 'tname', name), el('span', 'tsum', summary));
  d.append(s);
  if (detail) d.append(el('pre', null, detail));
  msgs.append(d);
  return d;
}
function finishCall(d, ok, text) {
  d.classList.remove('pending');
  if (!ok) d.classList.add('err');
  d.append(el('pre', null, text || '(no output)'));
}

function showEmpty() {
  const e = el('div', 'empty'); e.id = 'glm-empty';
  e.append(el('p', null, 'GLM-5.3 Flash Abliterated'));
  e.append(el('p', 'muted', 'Untrusted model on Modal. With VM tools on, it can run commands and edit files on the sandbox VM, without asking first, as a user with no root access and no internet. Nothing it does touches this machine.'));
  e.append(el('p', 'muted', 'Costs about $9/hr while running. It takes about 4 minutes to start and shuts down after 5 idle minutes, so waking it costs at least $1.40.'));
  msgs.append(e);
}
function render() {
  msgs.replaceChildren();
  if (!history.length) showEmpty();
  const calls = new Map();
  for (const m of history) {
    if (m.role === 'tool') { const d = calls.get(m.tool_call_id); if (d) finishCall(d, !/^(Error:|\[(cancelled|timed out|exit code [1-9]))/.test(m.content), m.content); continue; }
    if (m.content) addMsg(m.role, m.content);
    for (const c of m.tool_calls || []) calls.set(c.id, addCall(c.function.name, c.function.arguments));
  }
  scrollBottom(true);
}

function setStatus(text) {
  const pill = $('glm-status');
  pill.classList.toggle('hidden', !text);
  pill.textContent = text || '';
}
function setBusy(busy) {
  $('glm-send').disabled = busy;
  $('glm-stop').classList.toggle('hidden', !busy);
  $('glm-new').disabled = busy;
  $('glm-delete').disabled = busy;
  $('glm-convos').disabled = busy;
  $('vm-stop').disabled = busy;
  $('vm-reset').disabled = busy;
  if (!busy) setStatus('');
}

// Returns text not yet saved to history, whether a step was saved, and how it ended.
async function streamReply(signal) {
  const r = await fetch('/api/llm/chat', { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: history, tools: toolsBox.checked }) });
  if (r.status === 401) { location.href = '/login.html'; throw new Error('login required'); }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);

  let text = '', reasoning = '', bubble = null, thoughts = null, thoughtsPre = null, finish = null, error = null, buf = '', saved = false;
  const calls = new Map();
  const handle = (ev) => {
    if (ev.t === 'vm_check') setStatus('checking the VM');
    else if (ev.t === 'waiting') setStatus(`starting the model (${Math.floor(ev.seconds / 60)}m ${ev.seconds % 60}s, usually about 4m)`);
    else if (ev.t === 'started') setStatus('thinking');
    else if (ev.t === 'reasoning') {
      if (!thoughts) { thoughts = el('details', 'tool'); thoughts.append(el('summary', null, 'Reasoning')); thoughtsPre = el('pre'); thoughts.append(thoughtsPre); msgs.append(thoughts); }
      reasoning += ev.text; thoughtsPre.textContent = reasoning;
    } else if (ev.t === 'text') {
      if (!bubble) bubble = addMsg('assistant', '');
      text += ev.text; bubble.textContent = text;
      setStatus('writing');
    } else if (ev.t === 'tool_writing') setStatus(`writing ${ev.name || 'tool call'} (${ev.size} characters)`);
    else if (ev.t === 'tool_call') {
      calls.set(ev.id, addCall(ev.name, ev.arguments));
      setStatus(`running ${ev.name} on the VM`);
    } else if (ev.t === 'tool_result') {
      const d = calls.get(ev.id);
      if (d) finishCall(d, ev.ok, ev.text);
      setStatus('thinking');
    } else if (ev.t === 'append') {
      // These messages are complete, so the next step starts fresh.
      history.push(...ev.messages); save();
      if (ev.messages.length) saved = true;
      text = ''; reasoning = ''; bubble = null; thoughts = null;
    } else if (ev.t === 'finish') finish = ev.reason;
    else if (ev.t === 'error') error = ev.text;
    scrollBottom();
  };
  try {
    const decoder = new TextDecoder();
    const reader = r.body.getReader(); // iOS Safari can't use for-await on a response body
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line) handle(JSON.parse(line)); }
    }
  } catch (e) {
    if (e.name !== 'AbortError') error = error || 'Lost the connection to the portal.';
  }
  return { text, saved, finish, error };
}

$('glm-composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (active) return;
  const content = input.value.trim();
  if (!content) return;
  input.value = ''; input.style.height = 'auto';
  history.push({ role: 'user', content });
  addMsg('user', content);
  scrollBottom(true);
  active = new AbortController();
  setBusy(true); setStatus('connecting');
  let reply = { text: '', saved: false, finish: null, error: null };
  try { reply = await streamReply(active.signal); }
  catch (err) { if (err.name !== 'AbortError') reply.error = err.message; }
  const stopped = active.signal.aborted;
  active = null;
  setBusy(false);
  if (reply.text) history.push({ role: 'assistant', content: reply.text }); // cut off partway, but worth keeping
  else if (!reply.saved) { history.pop(); if (!input.value) input.value = content; } // nothing came back: put the message back to resend
  save();
  flushSave().then(refreshPicker); // persist now and refresh the title in the picker
  if (reply.error) notice(reply.error, true);
  else if (stopped) notice('Stopped. The model stays up for 5 more idle minutes.');
  else if (reply.finish === 'length') notice('The reply hit the length limit and was cut off.', true);
  else if (!reply.text && !reply.saved) notice('The model returned no text.', true);
  refreshVm();
});

$('glm-stop').addEventListener('click', () => active?.abort());
$('glm-new').addEventListener('click', () => { if (!active) newConvo(); });
input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.4)}px`; });
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); $('glm-composer').requestSubmit(); }
});

// ---------- VM controls ----------
function showVm(vm) {
  $('vm-dot').className = `dot ${vm?.running ? 'up' : 'stopped'}`;
  $('vm-state').textContent = !vm ? 'VM status unavailable' : vm.running ? `VM running${vm.stopsAt ? `, stops at ${vm.stopsAt}` : ''}` : 'VM stopped';
  $('vm-start').textContent = vm?.running ? 'Extend 2h' : 'Start VM';
  $('vm-stop').classList.toggle('hidden', !vm?.running);
}
async function vmApi(opts) {
  const r = await fetch('/api/llm/vm', opts);
  if (r.status === 401) { location.href = '/login.html'; throw new Error('login required'); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}
async function refreshVm() { try { showVm(await vmApi({})); } catch { showVm(null); } }
async function vmAction(action, button) {
  const buttons = ['vm-start', 'vm-stop', 'vm-reset'].map($);
  buttons.forEach((b) => { b.disabled = true; });
  $('vm-state').textContent = button.textContent === 'Reset' ? 'Resetting the VM…' : 'Working…';
  try { showVm(await vmApi({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) })); }
  catch (e) { notice(`VM ${action} failed: ${e.message}`, true); refreshVm(); }
  buttons.forEach((b) => { b.disabled = false; });
  setBusy(!!active);
}
$('vm-start').addEventListener('click', (e) => vmAction('start', e.target));
$('vm-stop').addEventListener('click', (e) => vmAction('stop', e.target));
$('vm-reset').addEventListener('click', (e) => { if (confirm('Erase everything on the sandbox VM and restore it to its clean state? It will be left stopped.')) vmAction('reset', e.target); });

// ---------- saved conversations ----------
async function listConvos() { try { const r = await convoApi('/api/llm/conversations'); return r.ok ? await r.json() : []; } catch { return []; } }
function renderPicker(list) {
  const sel = $('glm-convos'); sel.replaceChildren();
  if (!list.length) { sel.append(Object.assign(el('option', null, 'No saved chats'), { value: '' })); sel.disabled = true; return; }
  for (const c of list) sel.append(Object.assign(el('option', null, c.title || 'Untitled'), { value: c.id }));
  if (convoId) sel.value = convoId;
  sel.disabled = !!active;
}
async function refreshPicker() { renderPicker(await listConvos()); }
async function loadConvo(id) {
  try { const r = await convoApi(`/api/llm/conversations/${id}`); const d = r.ok ? await r.json() : {}; history = Array.isArray(d.messages) ? d.messages : []; }
  catch { history = []; }
  convoId = id; try { localStorage.setItem(CUR_KEY, id); } catch {}
  render();
}
async function newConvo() {
  convoId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
  try { localStorage.setItem(CUR_KEY, convoId); } catch {}
  history = []; render();
  await flushSave(); await refreshPicker(); $('glm-convos').value = convoId;
}
$('glm-convos').addEventListener('change', (e) => { if (!active && e.target.value) loadConvo(e.target.value); });
$('glm-delete').addEventListener('click', async () => {
  if (active || !convoId) return;
  if (!confirm('Delete this conversation? This cannot be undone.')) return;
  try { await convoApi(`/api/llm/conversations/${convoId}`, { method: 'DELETE' }); } catch {}
  const rest = (await listConvos()).filter((c) => c.id !== convoId);
  if (rest.length) await loadConvo(rest[0].id); else await newConvo();
  await refreshPicker();
});

(async function initConvos() {
  const list = await listConvos();
  let legacy = null; // a chat saved before conversations existed
  try { const v = JSON.parse(localStorage.getItem(KEY)); if (Array.isArray(v) && v.length) legacy = v; } catch {}
  let stored = null; try { stored = localStorage.getItem(CUR_KEY); } catch {}
  if (stored && list.some((c) => c.id === stored)) { renderPicker(list); await loadConvo(stored); }
  else if (list.length) { renderPicker(list); await loadConvo(list[0].id); }
  else if (legacy) { convoId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()); history = legacy; try { localStorage.setItem(CUR_KEY, convoId); } catch {} render(); await flushSave(); await refreshPicker(); $('glm-convos').value = convoId; }
  else { await newConvo(); }
})();
refreshVm();
setInterval(() => { if (!document.hidden) refreshVm(); }, 60e3);
