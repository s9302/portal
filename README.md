# Homelab portal

https://claude-agent.tailnet-name.ts.net (tailnet only, via `tailscale serve` -> 127.0.0.1:8800). `http://claude-agent:8800` just redirects there. Dashboard of nodes, services and guests, a chat panel that runs Claude Code sessions on this VM, and file uploads into `~/uploads/`.

- `server.mjs`: zero-dependency Node server. Serves on `127.0.0.1:8800` (behind tailscale serve, which supplies the Tailscale-User-Login header); `<sandbox-tailnet-ip>:8800` only redirects to HTTPS.
- `services.json`: the service cards. Edit and they show up on the next refresh (probes are cached 30 s).
- `public/`: front end, no build step. On wide screens "Hide AI" in the top bar (or – in a chat header) collapses the chat panel; clicking the Claude/GLM tab brings it back. Saved in localStorage `chatHidden`.
- `bin/set-password`: set or change the login password (changing it logs out every device).
- `data/`: `secret` (cookie HMAC key) and `auth.json` (scrypt hash). Both 600.

## Access control, outermost first
1. Tailnet ACL: only Spencer's macbook/iphone/desktop (and the sandbox itself) can reach claude-agent on non-SSH ports.
2. Every request: `tailscale whois` on the peer IP must be an untagged device owned by you@example.com.
3. Login: "Sign in with Authentik" (OIDC code + PKCE, `data/oidc.json`, only `akadmin` in group `authentik Admins`; added 2026-11-13) or the backup password. Either sets an HttpOnly SameSite=Strict cookie (30 days). 5 failed logins per IP per 15 min. Origin check on non-GET.

## Claude chat
Each message spawns `claude -p --output-format stream-json --permission-mode auto` (`--resume <id>` for existing sessions, `--session-id` for new ones) in the session's original cwd. Events stream to the browser over SSE and are buffered, so a reload reattaches to a running turn. One run per session at a time. Uploaded attachments are passed as absolute paths in the message.

## GLM chat
The GLM tab talks to the untrusted model deployed from `~/llm-modal`. `POST /api/llm/chat` adds the proxy token from `~/llm-modal/.proxy-token.json` on the server, retries while the model cold-starts (up to 10 minutes) and aborts the Modal request and any running command if the page disconnects. One request at a time, at most 30 model calls or 60 minutes per message. `public/glm.js` must keep using `textContent` for model and VM output, because the same origin can drive Claude sessions. History is in the browser's localStorage only.

With **VM tools** on, the model gets `run_command`, `read_file` and `write_file`. The loop runs in this server. Each tool call goes as JSON through `ssh root@pve2 llm-sandbox bridge`, which relays bytes to serial port 1 on VM 411, where `llm-exec` (source in `~/llm-modal/vm/`) runs it as `agent`. There is no network path, and the VM holds no Modal token. Nothing from the model or VM is ever run on this machine or on pve2, and replies from the VM are treated as untrusted. `GET/POST /api/llm/vm` runs only `llm-sandbox start|stop|reset|status`.

## Tracing
Every GLM message is written to `~/.local/state/llm-trace/glm.jsonl` as finished spans: the prompt, each model call (input, reasoning, reply, requested tool calls) and each tool call with its result. `~/llm-trace/ship.py` (user unit `llm-trace.service`) sends those and all Claude Code transcripts to Langfuse at https://langfuse.tailnet-name.ts.net. A model call is logged before its tools run. A reply stopped partway is logged with level WARNING and whatever had arrived.

## Service
`systemctl --user {status,restart} portal`, logs via `journalctl --user -u portal`. Needs `loginctl enable-linger claude-agent` (root) to start at boot without a login session.
