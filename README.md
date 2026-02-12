# Remote Terminal

Access your local shell from anywhere — phone, tablet, or another computer — through a web-based terminal with full PTY support.

![Architecture](https://img.shields.io/badge/stack-Next.js%20%2B%20Socket.io%20%2B%20node--pty-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## Features

- **Full terminal emulation** — xterm.js renders a real terminal with colors, cursor, scrollback, vim/nano support
- **Persistent sessions** — lock your phone, switch apps, close the tab — your shell keeps running. Reconnect and pick up where you left off
- **Multiple tabs** — run several shell sessions in parallel, switch between them
- **Mobile-first UI** — on-screen modifier keys (ESC, TAB, ⇧TAB, CTRL, SHIFT, arrows), touch-optimized
- **CTRL combos** — CTRL+C, CTRL+P, CTRL+Z and more, either from the button bar or tap CTRL then type on keyboard
- **SHIFT support** — uppercase letters, shifted symbols, Shift+Tab, Shift+Arrow
- **Cloudflare tunnel** — one command to expose securely to the internet (no port forwarding, no admin)
- **Session replay** — reconnecting replays the last 50KB of output so you never lose context
- **Optional authentication** — protect with a token when exposed to the internet

## Quick Start

```bash
# No auth (local use):
bash setup.sh

# With auth (recommended for remote access):
AUTH_TOKEN=mysecret bash setup.sh

# With your own domain (requires Cloudflare account + domain):
TUNNEL_DOMAIN=terminal.yourdomain.com AUTH_TOKEN=mysecret bash setup.sh
```

That's it. The script:
1. Installs npm dependencies
2. Downloads `cloudflared` (if missing)
3. Starts the server
4. Opens a Cloudflare tunnel
5. **Displays a QR code** — scan with your phone camera to instantly open
6. Shows Tunnel, LAN, and Local URLs
7. Saves the URL to `.tunnel-url` for scripting

## Manual Setup

```bash
# 1. Install dependencies
npm install

# 2. Start the terminal server
npm run dev

# 3. (Optional) Expose to internet
npm run tunnel
# Or: ~/bin/cloudflared tunnel --url http://localhost:3000

# 4. Open in browser
# Local:  http://localhost:3000/terminal
# Remote: https://<tunnel-url>/terminal
```

## Authentication

Authentication is **optional** and controlled by the `AUTH_TOKEN` environment variable.

| `AUTH_TOKEN` | Behavior |
|---|---|
| Not set / empty | No auth — anyone with the URL can access |
| Set to any string | Token required — login page shown |

### How it works

1. **Enable**: `AUTH_TOKEN=mysecret bun run server.ts`
2. **Login**: Browser shows a login page → enter the token → sets an HttpOnly cookie (30 days)
3. **Direct URL**: Append `?token=mysecret` to skip the login page (sets cookie automatically)
4. **WebSocket**: The client passes the token via cookie to authenticate socket.io connections
5. **Disable**: Just don't set `AUTH_TOKEN`

### Token sources (checked in order)
- `Authorization: Bearer <token>` header
- `rt_token` cookie
- `?token=<token>` query parameter

## Custom Domain

By default, `setup.sh` creates a **quick tunnel** with a random `*.trycloudflare.com` URL that changes every time. To use your own domain:

### Prerequisites
1. A domain with DNS managed by Cloudflare (free plan works)
2. `cloudflared` logged in: `cloudflared login`
3. A named tunnel created: `cloudflared tunnel create remote-terminal`
4. A DNS CNAME record pointing your subdomain to the tunnel:
   ```bash
   cloudflared tunnel route dns remote-terminal terminal.yourdomain.com
   ```

### Usage
```bash
TUNNEL_DOMAIN=terminal.yourdomain.com bash setup.sh
```

This gives you a **permanent, memorable URL** — no more copying random URLs or scanning QR codes.

| Variable | Behavior |
|---|---|
| Not set | Quick tunnel with random `*.trycloudflare.com` URL |
| `TUNNEL_DOMAIN=terminal.example.com` | Named tunnel at your domain |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser (Phone/Laptop)                                         │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  xterm.js          — terminal emulator (renders output) │    │
│  │  socket.io-client  — WebSocket connection               │    │
│  │  Modifier key bar  — ESC, TAB, CTRL, SHIFT, arrows      │    │
│  └─────────────────────┬───────────────────────────────────┘    │
│                        │ WebSocket (wss://)                      │
└────────────────────────┼────────────────────────────────────────┘
                         │
┌────────────────────────┼────────────────────────────────────────┐
│  Cloudflare Tunnel     │  (optional — for remote access)        │
│  HTTPS + WSS proxy     │                                        │
└────────────────────────┼────────────────────────────────────────┘
                         │
┌────────────────────────┼────────────────────────────────────────┐
│  Server (server.ts)    │  Node.js custom HTTP server            │
│  ┌─────────────────────┴───────────────────────────────────┐    │
│  │  Next.js            — serves the web UI pages           │    │
│  │  socket.io          — WebSocket server at /api/terminal-ws│   │
│  │  Session Manager    — creates/tracks/persists PTY sessions│   │
│  │  node-pty           — spawns real bash PTY processes     │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  Sessions persist across WebSocket disconnects.                  │
│  Output is buffered (50KB) for replay on reconnect.              │
│  Max 5 concurrent sessions.                                      │
└──────────────────────────────────────────────────────────────────┘
```

## How It Works

### 1. Custom Server (`server.ts`)

A Node.js HTTP server wraps Next.js and adds a Socket.io WebSocket endpoint. When a client requests a new session:

```
Client → "create-session" → Server spawns bash via node-pty → PTY process
Client → "attach" <session-id> → Server pipes PTY output to this socket
Client → "input" <keystrokes> → Server writes to PTY stdin
Client → "resize" {cols, rows} → Server resizes PTY
```

### 2. Persistent Sessions

Sessions are **not tied to WebSocket connections**. When you disconnect:
- The PTY process keeps running
- Output is buffered in memory (last 50KB)
- When you reconnect and `attach`, the buffer is replayed
- Your shell state (current directory, running processes, env vars) is preserved

### 3. Terminal UI (`TerminalClient.tsx`)

The client uses [xterm.js](https://xtermjs.org/) — the same terminal emulator used by VS Code's integrated terminal. It handles:
- Full ANSI escape sequences (colors, cursor positioning, alternate screen)
- Mouse events, selection, clipboard
- Scrollback buffer (10,000 lines)
- Terminal resize (synced with server)

### 4. Mobile Modifier Keys

On-screen buttons send escape sequences directly:

| Button | Sends | Use Case |
|--------|-------|----------|
| ESC | `\x1b` | Exit vim insert mode, cancel |
| ⇧TAB | `\x1b[Z` | Copilot CLI mode switch |
| TAB | `\t` | Autocomplete |
| CTRL + letter | `\x01`-`\x1a` | CTRL+C (cancel), CTRL+P (copilot), etc. |
| SHIFT + letter | Uppercase | Typing capital letters |
| ↑ ↓ ← → | Arrow escape sequences | Navigate history, move cursor |

CTRL and SHIFT are **sticky** — tap once to activate, then type a key. They auto-deactivate after one keypress.

### 5. Cloudflare Tunnel

[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/) creates an outbound-only connection from your machine to Cloudflare's edge:

- **No inbound ports** — works behind firewalls, NAT, WSL2
- **No admin required** — no `netsh`, no firewall rules
- **HTTPS + WSS** — encrypted end-to-end
- **Free** — no account needed for quick tunnels
- **Reliable** — unlike localtunnel, no splash pages or POST failures

## Project Structure

```
remote-terminal/
├── server.ts                          # Custom HTTP + WebSocket server
├── setup.sh                           # One-click setup & launch script
├── package.json                       # Dependencies and scripts
├── next.config.ts                     # Next.js configuration
├── tsconfig.json                      # TypeScript configuration
├── postcss.config.mjs                 # PostCSS + Tailwind
├── public/
│   └── xterm.css                      # xterm.js terminal styles
└── src/app/
    ├── layout.tsx                     # Root layout
    ├── globals.css                    # Global styles
    ├── page.tsx                       # Redirects to /terminal
    └── terminal/
        ├── page.tsx                   # Terminal page (server component)
        └── TerminalClient.tsx         # Terminal UI (client component)
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `NODE_ENV` | `development` | Environment |

Max concurrent sessions: 5 (configurable in `server.ts` → `MAX_SESSIONS`)
Output buffer size: 50KB per session (configurable → `SCROLLBACK_BUFFER_SIZE`)

## Security

> ⚠️ **This is a local development tool.** It exposes a full shell — treat the tunnel URL like your SSH password.

- No authentication built in (intentionally — it's a personal dev tool)
- Sessions are process-scoped (die when server stops)
- Cloudflare quick tunnels generate random URLs (unguessable)
- Stop the tunnel to immediately cut off remote access

For production use, add authentication middleware to the Socket.io connection handler.

## Requirements

- **Node.js** 18+ 
- **Linux/macOS/WSL2** (node-pty requires a Unix-like environment)
- **cloudflared** (auto-installed by `setup.sh`)

## License

MIT
