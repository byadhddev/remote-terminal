import { createServer } from 'http';
import next from 'next';
import { Server as SocketIOServer } from 'socket.io';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pty = require('node-pty') as typeof import('node-pty');

const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
const port = parseInt(process.env.PORT || '3000', 10);

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
    const httpServer = createServer((req, res) => {
        handle(req, res);
    });

    const io = new SocketIOServer(httpServer, {
        path: '/api/terminal-ws',
        cors: { origin: '*' },
        pingTimeout: 120000,
        pingInterval: 15000,
    });

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
        console.log(`> WebSocket terminal at /api/terminal-ws`);
        console.log(`> Terminal UI at http://localhost:${port}/terminal`);
    });
});
