import { createServer, IncomingMessage, ServerResponse } from 'http';
import next from 'next';
import { Server as SocketIOServer } from 'socket.io';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);
const pty = require('node-pty') as typeof import('node-pty');

const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
const port = parseInt(process.env.PORT || '3000', 10);

// Optional auth: set AUTH_TOKEN env var to enable
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const AUTH_ENABLED = AUTH_TOKEN.length > 0;
const AUTH_COOKIE_NAME = 'rt_token';

function checkToken(token: string | undefined | null): boolean {
    if (!AUTH_ENABLED) return true;
    if (!token) return false;
    return crypto.timingSafeEqual(
        Buffer.from(token),
        Buffer.from(AUTH_TOKEN)
    );
}

function getTokenFromRequest(req: IncomingMessage): string | null {
    // Check query param ?token=xxx
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const qToken = url.searchParams.get('token');
    if (qToken) return qToken;

    // Check cookie
    const cookies = req.headers.cookie || '';
    const match = cookies.match(new RegExp(`${AUTH_COOKIE_NAME}=([^;]+)`));
    if (match) return decodeURIComponent(match[1]);

    // Check Authorization header
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) return authHeader.slice(7);

    return null;
}

// Login page HTML
function loginPage(error = false): string {
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Remote Terminal — Login</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#1c1917;color:#e7e5e4;font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{width:100%;max-width:320px;padding:32px 24px;text-align:center}
  h1{font-size:18px;font-weight:600;margin-bottom:4px}
  p{font-size:12px;color:#9b9a97;margin-bottom:24px}
  input{width:100%;padding:10px 12px;background:#2a2520;border:1px solid #3a3530;border-radius:6px;color:#e7e5e4;font-size:14px;font-family:monospace;outline:none;margin-bottom:12px}
  input:focus{border-color:#D80018}
  button{width:100%;padding:10px;background:#D80018;border:none;border-radius:6px;color:#fff;font-size:14px;font-weight:500;cursor:pointer}
  button:hover{background:#b00014}
  .error{color:#D80018;font-size:12px;margin-bottom:12px}
</style></head><body>
<div class="card">
  <h1>Remote Terminal</h1>
  <p>Enter the access token to continue</p>
  ${error ? '<div class="error">Invalid token</div>' : ''}
  <form method="POST" action="/auth">
    <input type="password" name="token" placeholder="Access token" autofocus required>
    <button type="submit">Authenticate</button>
  </form>
</div>
</body></html>`;
}

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

const MAX_SESSIONS = 5;
const SCROLLBACK_BUFFER_SIZE = 50000; // characters to keep for reconnect replay

interface PersistentSession {
    id: string;
    name: string;
    shell: ReturnType<typeof pty.spawn>;
    buffer: string;
    socketId: string | null;
    alive: boolean;
    createdAt: number;
}

const sessions = new Map<string, PersistentSession>();

function generateId() {
    return Math.random().toString(36).slice(2, 10);
}

app.prepare().then(() => {
    const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url || '/', `http://${req.headers.host}`);

        if (AUTH_ENABLED) {
            // POST /auth — login form submission
            if (url.pathname === '/auth' && req.method === 'POST') {
                let body = '';
                req.on('data', (chunk) => { body += chunk; });
                req.on('end', () => {
                    const params = new URLSearchParams(body);
                    const token = params.get('token') || '';
                    if (checkToken(token)) {
                        // Set auth cookie (httpOnly, 30 days)
                        res.writeHead(302, {
                            'Set-Cookie': `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${30 * 24 * 3600}`,
                            'Location': '/terminal',
                        });
                        res.end();
                    } else {
                        res.writeHead(200, { 'Content-Type': 'text/html' });
                        res.end(loginPage(true));
                    }
                });
                return;
            }

            // Allow static assets through
            const isPublicAsset = url.pathname.startsWith('/_next/') || url.pathname.startsWith('/xterm.css');
            if (!isPublicAsset) {
                const token = getTokenFromRequest(req);
                if (!checkToken(token)) {
                    // If token in query param, set cookie and redirect
                    const qToken = url.searchParams.get('token');
                    if (qToken && checkToken(qToken)) {
                        res.writeHead(302, {
                            'Set-Cookie': `${AUTH_COOKIE_NAME}=${encodeURIComponent(qToken)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${30 * 24 * 3600}`,
                            'Location': url.pathname,
                        });
                        res.end();
                        return;
                    }
                    // Show login page
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(loginPage());
                    return;
                }
            }
        }

        handle(req, res);
    });

    const io = new SocketIOServer(httpServer, {
        path: '/api/terminal-ws',
        cors: { origin: '*' },
        pingTimeout: 120000,
        pingInterval: 15000,
    });

    // WebSocket auth middleware
    if (AUTH_ENABLED) {
        io.use((socket, next) => {
            const token = socket.handshake.auth?.token as string
                || socket.handshake.query?.token as string
                || (() => {
                    const cookies = socket.handshake.headers.cookie || '';
                    const match = cookies.match(new RegExp(`${AUTH_COOKIE_NAME}=([^;]+)`));
                    return match ? decodeURIComponent(match[1]) : '';
                })();
            if (checkToken(token)) {
                next();
            } else {
                next(new Error('Authentication required'));
            }
        });
    }

    io.on('connection', (socket) => {
        let currentSession: PersistentSession | null = null;

        // List available sessions
        socket.on('list-sessions', () => {
            const list = Array.from(sessions.values())
                .filter(s => s.alive)
                .map(s => ({ id: s.id, name: s.name, connected: !!s.socketId, createdAt: s.createdAt }));
            socket.emit('sessions', list);
        });

        // Create a new session
        socket.on('create-session', (opts: { name?: string } = {}) => {
            const aliveSessions = Array.from(sessions.values()).filter(s => s.alive);
            if (aliveSessions.length >= MAX_SESSIONS) {
                socket.emit('error', `Max ${MAX_SESSIONS} sessions. Kill one first.`);
                return;
            }

            const id = generateId();
            const name = opts.name || `Shell ${aliveSessions.length + 1}`;

            const shell = pty.spawn('bash', [], {
                name: 'xterm-256color',
                cols: 80,
                rows: 24,
                cwd: process.env.HOME || '/home',
                env: {
                    ...process.env,
                    TERM: 'xterm-256color',
                    COLORTERM: 'truecolor',
                } as Record<string, string>,
            });

            const session: PersistentSession = {
                id,
                name,
                shell,
                buffer: '',
                socketId: null,
                alive: true,
                createdAt: Date.now(),
            };

            shell.onData((data: string) => {
                // Always buffer output for reconnect replay
                session.buffer += data;
                if (session.buffer.length > SCROLLBACK_BUFFER_SIZE) {
                    session.buffer = session.buffer.slice(-SCROLLBACK_BUFFER_SIZE);
                }
                // Send to attached socket if any
                if (session.socketId) {
                    io.to(session.socketId).emit('output', data);
                }
            });

            shell.onExit(({ exitCode, signal }) => {
                console.log(`[terminal] Session ${id} exited: code=${exitCode} signal=${signal}`);
                session.alive = false;
                if (session.socketId) {
                    io.to(session.socketId).emit('session-exited', { id, exitCode, signal });
                }
                sessions.delete(id);
                // Broadcast updated list
                broadcastSessions();
            });

            sessions.set(id, session);
            console.log(`[terminal] Created session ${id} "${name}" PID=${shell.pid}`);

            socket.emit('session-created', { id, name });
            broadcastSessions();
        });

        // Attach to an existing session
        socket.on('attach', (sessionId: string) => {
            const session = sessions.get(sessionId);
            if (!session || !session.alive) {
                socket.emit('error', `Session ${sessionId} not found`);
                return;
            }

            // Detach previous socket from this session
            if (session.socketId && session.socketId !== socket.id) {
                io.to(session.socketId).emit('detached', { id: sessionId });
            }
            // Detach this socket from any previous session
            if (currentSession && currentSession.id !== sessionId) {
                currentSession.socketId = null;
            }

            session.socketId = socket.id;
            currentSession = session;

            console.log(`[terminal] Socket ${socket.id} attached to session ${sessionId}`);
            socket.emit('attached', { id: session.id, name: session.name });

            // Replay buffered output so client sees history
            if (session.buffer.length > 0) {
                socket.emit('output', session.buffer);
            }
        });

        // Input to current attached session
        socket.on('input', (data: string) => {
            if (currentSession?.alive) {
                currentSession.shell.write(data);
            }
        });

        // Resize current attached session
        socket.on('resize', (size: { cols: number; rows: number }) => {
            if (currentSession?.alive) {
                try {
                    currentSession.shell.resize(Math.max(size.cols, 1), Math.max(size.rows, 1));
                } catch { /* ignore */ }
            }
        });

        // Kill a specific session
        socket.on('kill-session', (sessionId: string) => {
            const session = sessions.get(sessionId);
            if (session) {
                console.log(`[terminal] Killing session ${sessionId}`);
                session.alive = false;
                session.socketId = null;
                try { session.shell.kill(); } catch { /* already dead */ }
                sessions.delete(sessionId);
                if (currentSession?.id === sessionId) currentSession = null;
                broadcastSessions();
            }
        });

        // Rename a session
        socket.on('rename-session', ({ id, name }: { id: string; name: string }) => {
            const session = sessions.get(id);
            if (session) {
                session.name = name;
                broadcastSessions();
            }
        });

        // On disconnect, just detach — don't kill the session
        socket.on('disconnect', () => {
            console.log(`[terminal] Socket ${socket.id} disconnected (sessions preserved)`);
            if (currentSession) {
                currentSession.socketId = null;
                currentSession = null;
            }
        });

        function broadcastSessions() {
            const list = Array.from(sessions.values())
                .filter(s => s.alive)
                .map(s => ({ id: s.id, name: s.name, connected: !!s.socketId, createdAt: s.createdAt }));
            io.emit('sessions', list);
        }
    });

    httpServer.listen(port, hostname, () => {
        console.log(`> Ready on http://${hostname}:${port}`);
        console.log(`> Terminal UI at http://localhost:${port}/terminal`);
        console.log(`> Auth: ${AUTH_ENABLED ? 'ENABLED (AUTH_TOKEN set)' : 'DISABLED (set AUTH_TOKEN to enable)'}`);
    });
});
