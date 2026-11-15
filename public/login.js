document.getElementById('login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('error');
  err.textContent = '';
  const r = await fetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: document.getElementById('password').value }),
  });
  if (r.ok) { location.href = '/'; return; }
  const d = await r.json().catch(() => ({}));
  err.textContent = d.error || `Login failed (${r.status})`;
});
