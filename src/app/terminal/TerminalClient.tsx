'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { Wifi, WifiOff, Plus, X, Keyboard, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, CornerDownLeft, ArrowBigUp, Terminal } from 'lucide-react';

type Status = 'connecting' | 'connected' | 'disconnected';

interface SessionInfo {
    id: string;
    name: string;
    connected: boolean;
    createdAt: number;
}

const MODIFIER_KEYS = [
    { label: 'ESC', code: '\x1b' },
    { label: '⇧TAB', code: '\x1b[Z' },
    { label: 'TAB', code: '\t' },
    { label: 'CTRL', code: null },
    { label: 'SHIFT', code: null },
    { label: '↑', code: '\x1b[A' },
    { label: '↓', code: '\x1b[B' },
    { label: '←', code: '\x1b[D' },
    { label: '→', code: '\x1b[C' },
] as const;

const CTRL_COMBOS = [
    { label: 'C', code: '\x03' },
    { label: 'D', code: '\x04' },
    { label: 'Z', code: '\x1a' },
    { label: 'L', code: '\x0c' },
    { label: 'A', code: '\x01' },
    { label: 'E', code: '\x05' },
    { label: 'P', code: '\x10' },
    { label: 'R', code: '\x12' },
    { label: 'W', code: '\x17' },
    { label: 'N', code: '\x0e' },
    { label: 'K', code: '\x0b' },
    { label: 'U', code: '\x15' },
] as const;

export default function TerminalClient() {
    const terminalRef = useRef<HTMLDivElement>(null);
    const socketRef = useRef<Socket | null>(null);
    const xtermRef = useRef<import('@xterm/xterm').Terminal | null>(null);
    const fitAddonRef = useRef<import('@xterm/addon-fit').FitAddon | null>(null);
    const [status, setStatus] = useState<Status>('disconnected');
    const [ctrlMode, setCtrlMode] = useState(false);
    const ctrlModeRef = useRef(false);
    const [shiftMode, setShiftMode] = useState(false);
    const shiftModeRef = useRef(false);
    const [showKeys, setShowKeys] = useState(true);
    const [sessions, setSessions] = useState<SessionInfo[]>([]);
    const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
    const activeSessionRef = useRef<string | null>(null);
    const [keybarBottom, setKeybarBottom] = useState(0);

    const setActiveSession = useCallback((id: string | null) => {
        activeSessionRef.current = id;
        setActiveSessionId(id);
    }, []);

    useEffect(() => {
        const vv = window.visualViewport;
        if (!vv) return;
        const onResize = () => {
            const offset = window.innerHeight - vv.height - vv.offsetTop;
            setKeybarBottom(Math.max(0, offset));
            try { fitAddonRef.current?.fit(); } catch { /* ignore */ }
        };
        vv.addEventListener('resize', onResize);
        vv.addEventListener('scroll', onResize);
        return () => {
            vv.removeEventListener('resize', onResize);
            vv.removeEventListener('scroll', onResize);
        };
    }, []);

    const sendInput = useCallback((data: string) => {
        socketRef.current?.emit('input', data);
    }, []);

    const setShift = useCallback((on: boolean) => {
        shiftModeRef.current = on;
        setShiftMode(on);
    }, []);

    const setCtrl = useCallback((on: boolean) => {
        ctrlModeRef.current = on;
        setCtrlMode(on);
    }, []);

    const SHIFT_MAP: Record<string, string> = {
        '1': '!', '2': '@', '3': '#', '4': '$', '5': '%',
        '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
        '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|',
        ';': ':', "'": '"', ',': '<', '.': '>', '/': '?', '`': '~',
    };

    const applyModifiers = useCallback((data: string): string => {
        if (ctrlModeRef.current) {
            setCtrl(false);
            if (data.length === 1) {
                const ch = data.toLowerCase();
                if (ch >= 'a' && ch <= 'z') {
                    return String.fromCharCode(ch.charCodeAt(0) - 96);
                }
            }
            return data;
        }
        if (shiftModeRef.current) {
            setShift(false);
            if (data.startsWith('\x1b[') && data.length === 3) {
                return `\x1b[1;2${data.slice(-1)}`;
            }
            if (data === '\t') return '\x1b[Z';
            if (data.length === 1) {
                const ch = data;
                if (ch >= 'a' && ch <= 'z') return ch.toUpperCase();
                if (ch >= 'A' && ch <= 'Z') return ch;
                if (SHIFT_MAP[ch]) return SHIFT_MAP[ch];
            }
            return data;
        }
        return data;
    }, [setShift, setCtrl]);

    const handleModifierKey = useCallback((key: typeof MODIFIER_KEYS[number]) => {
        if (key.label === 'CTRL') {
            setCtrl(!ctrlModeRef.current);
            setShift(false);
            return;
        }
        if (key.label === 'SHIFT') {
            setShift(!shiftModeRef.current);
            setCtrl(false);
            return;
        }
        if (key.code) sendInput(applyModifiers(key.code));
        xtermRef.current?.focus();
    }, [sendInput, applyModifiers, setShift, setCtrl]);

    const handleCtrlCombo = useCallback((combo: typeof CTRL_COMBOS[number]) => {
        sendInput(combo.code);
        setCtrlMode(false);
        xtermRef.current?.focus();
    }, [sendInput]);

    const initTerminal = useCallback(async () => {
        const { Terminal: XTerminal } = await import('@xterm/xterm');
        const { FitAddon } = await import('@xterm/addon-fit');

        if (xtermRef.current) xtermRef.current.dispose();
        if (terminalRef.current) terminalRef.current.innerHTML = '';

        const term = new XTerminal({
            cursorBlink: true,
            fontSize: 14,
            fontFamily: 'Menlo, Monaco, "Courier New", monospace',
            theme: {
                background: '#1c1917',
                foreground: '#e7e5e4',
                cursor: '#D80018',
                selectionBackground: '#D8001830',
                black: '#1c1917',
                red: '#D80018',
                green: '#50fa7b',
                yellow: '#f1fa8c',
                blue: '#bd93f9',
                magenta: '#ff79c6',
                cyan: '#8be9fd',
                white: '#e7e5e4',
            },
            allowProposedApi: true,
            scrollback: 10000,
            smoothScrollDuration: 100,
        });

        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        xtermRef.current = term;
        fitAddonRef.current = fitAddon;

        if (terminalRef.current) {
            term.open(terminalRef.current);
            requestAnimationFrame(() => {
                try { fitAddon.fit(); } catch { /* ignore */ }
            });
        }

        term.onData((data) => socketRef.current?.emit('input', applyModifiers(data)));

        return { term, fitAddon };
    }, [applyModifiers]);

    const connect = useCallback(async () => {
        if (socketRef.current?.connected) return;
        setStatus('connecting');

        const { term, fitAddon } = await initTerminal();

        // Read auth token from cookie for WebSocket auth
        const tokenMatch = document.cookie.match(/(?:^|;\s*)rt_token=([^;]*)/);
        const authToken = tokenMatch ? decodeURIComponent(tokenMatch[1]) : undefined;

        const socket = io({
            path: '/api/terminal-ws',
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            ...(authToken ? { auth: { token: authToken } } : {}),
        });
        socketRef.current = socket;

        socket.on('connect', () => {
            setStatus('connected');
            socket.emit('list-sessions');
            if (activeSessionRef.current) {
                socket.emit('attach', activeSessionRef.current);
            }
            const dims = fitAddon.proposeDimensions();
            if (dims) socket.emit('resize', { cols: dims.cols, rows: dims.rows });
        });

        socket.on('sessions', (list: SessionInfo[]) => setSessions(list));

        socket.on('session-created', ({ id }: { id: string; name: string }) => {
            socket.emit('attach', id);
            setActiveSession(id);
        });

        socket.on('attached', ({ id, name }: { id: string; name: string }) => {
            setActiveSession(id);
            term.clear();
            term.writeln(`\x1b[38;2;216;0;24m●\x1b[0m Attached to \x1b[1m${name}\x1b[0m\r\n`);
        });

        socket.on('output', (data: string) => term.write(data));

        socket.on('session-exited', ({ id, exitCode }: { id: string; exitCode: number; signal: number }) => {
            term.writeln(`\r\n\x1b[31m● Session exited (code: ${exitCode})\x1b[0m`);
            if (activeSessionRef.current === id) setActiveSession(null);
        });

        socket.on('detached', () => {
            term.writeln('\r\n\x1b[33m● Detached (attached from another client)\x1b[0m');
        });

        socket.on('error', (msg: string) => {
            term.writeln(`\r\n\x1b[31m● ${msg}\x1b[0m`);
        });

        socket.on('disconnect', () => {
            setStatus('disconnected');
            term.writeln('\r\n\x1b[33m● Connection lost — reconnecting…\x1b[0m');
        });

        socket.on('reconnect', () => {
            setStatus('connected');
            term.writeln('\r\n\x1b[32m● Reconnected\x1b[0m');
            socket.emit('list-sessions');
            if (activeSessionRef.current) {
                socket.emit('attach', activeSessionRef.current);
            }
        });

        const handleResize = () => {
            try {
                fitAddon.fit();
                const dims = fitAddon.proposeDimensions();
                if (dims && socket.connected) socket.emit('resize', { cols: dims.cols, rows: dims.rows });
            } catch { /* ignore */ }
        };

        window.addEventListener('resize', handleResize);
        window.addEventListener('orientationchange', () => setTimeout(handleResize, 200));

        return () => { window.removeEventListener('resize', handleResize); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initTerminal]);

    const disconnect = useCallback(() => {
        socketRef.current?.disconnect();
        socketRef.current = null;
        setStatus('disconnected');
    }, []);

    const createSession = useCallback(() => {
        socketRef.current?.emit('create-session');
    }, []);

    const attachSession = useCallback((id: string) => {
        if (id === activeSessionRef.current) return;
        xtermRef.current?.clear();
        socketRef.current?.emit('attach', id);
        setActiveSession(id);
    }, [setActiveSession]);

    const killSession = useCallback((id: string) => {
        socketRef.current?.emit('kill-session', id);
        if (activeSessionRef.current === id) {
            setActiveSession(null);
            xtermRef.current?.clear();
            xtermRef.current?.writeln('\x1b[33m● Session killed\x1b[0m');
        }
    }, [setActiveSession]);

    useEffect(() => {
        connect();
        return () => {
            socketRef.current?.disconnect();
            xtermRef.current?.dispose();
        };
    }, [connect]);

    const focusTerminal = useCallback(() => {
        xtermRef.current?.focus();
    }, []);

    return (
        <div className="fixed inset-0 bg-[#1c1917] flex flex-col">
            {/* Header */}
            <div className="shrink-0 flex items-center justify-between px-3 py-2 bg-[#1c1917] border-b border-[#e7e5e4]/10">
                <div className="flex items-center gap-2 min-w-0">
                    <Terminal size={14} className="text-[#D80018] shrink-0" />
                    <span className="text-[#9b9a97] text-xs font-medium">Remote Terminal</span>
                    <div className="h-4 w-px bg-[#e7e5e4]/10 shrink-0" />
                    <div className={`w-1.5 h-1.5 rounded-full shrink-0 transition-colors ${
                        status === 'connected' ? 'bg-[#50fa7b]' :
                        status === 'connecting' ? 'bg-[#f1fa8c] animate-pulse' :
                        'bg-[#D80018]'
                    }`} />
                </div>
                <div className="flex items-center gap-1.5">
                    {status === 'disconnected' ? (
                        <button
                            onClick={connect}
                            className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium bg-[#D80018] hover:bg-[#b00014] text-white rounded transition-colors"
                        >
                            <Wifi size={12} />
                            <span>Connect</span>
                        </button>
                    ) : (
                        <button
                            onClick={disconnect}
                            className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-[#9b9a97] hover:text-[#D80018] hover:bg-[#D80018]/10 rounded transition-colors"
                        >
                            <WifiOff size={12} />
                        </button>
                    )}
                </div>
            </div>

            {/* Tab bar */}
            <div className="shrink-0 flex items-center gap-0.5 px-2 py-1 bg-[#1c1917] border-b border-[#e7e5e4]/10 overflow-x-auto">
                {sessions.map((s) => (
                    <div
                        key={s.id}
                        className={`group flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium cursor-pointer transition-colors shrink-0 ${
                            s.id === activeSessionId
                                ? 'bg-[#e7e5e4]/10 text-[#e7e5e4]'
                                : 'text-[#9b9a97] hover:text-[#e7e5e4] hover:bg-[#e7e5e4]/5'
                        }`}
                        onClick={() => attachSession(s.id)}
                    >
                        <span>{s.name}</span>
                        <button
                            onClick={(e) => { e.stopPropagation(); killSession(s.id); }}
                            className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-[#D80018] transition-all"
                        >
                            <X size={10} />
                        </button>
                    </div>
                ))}
                <button
                    onClick={createSession}
                    className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium text-[#9b9a97] hover:text-[#e7e5e4] hover:bg-[#e7e5e4]/5 transition-colors shrink-0"
                    title="New terminal"
                    disabled={status !== 'connected'}
                >
                    <Plus size={12} />
                    <span className="hidden sm:inline">New</span>
                </button>
            </div>

            {/* Terminal area */}
            <div
                ref={terminalRef}
                className="flex-1 overflow-hidden relative"
                onClick={focusTerminal}
                style={{ padding: '8px 8px 4px' }}
            />

            {/* Floating keyboard toggle */}
            {!showKeys && (
                <button
                    onClick={() => setShowKeys(true)}
                    className="fixed bottom-4 right-4 w-10 h-10 rounded-full bg-[#e7e5e4]/10 border border-[#e7e5e4]/15 flex items-center justify-center text-[#9b9a97] hover:text-[#e7e5e4] hover:bg-[#e7e5e4]/15 active:scale-95 transition-all backdrop-blur-sm z-10"
                    style={{ marginBottom: `max(env(safe-area-inset-bottom), ${keybarBottom}px)` }}
                >
                    <Keyboard size={16} />
                </button>
            )}

            {/* Modifier key bar */}
            {showKeys && (
                <div
                    className="shrink-0 border-t border-[#e7e5e4]/10 bg-[#1c1917]/95 backdrop-blur-sm"
                    style={{ paddingBottom: `max(env(safe-area-inset-bottom), ${keybarBottom}px)` }}
                >
                    {ctrlMode && (
                        <div className="flex items-center justify-center gap-1 px-2 py-1.5 border-b border-[#e7e5e4]/5 overflow-x-auto">
                            <span className="text-[10px] text-[#D80018] font-medium shrink-0 mr-0.5">CTRL+</span>
                            {CTRL_COMBOS.map((combo) => (
                                <button
                                    key={combo.label}
                                    onClick={() => handleCtrlCombo(combo)}
                                    className="shrink-0 min-w-[26px] px-1.5 py-1 text-[11px] font-mono font-medium text-[#e7e5e4] bg-[#D80018]/15 hover:bg-[#D80018]/25 active:bg-[#D80018]/35 border border-[#D80018]/20 rounded transition-colors"
                                >
                                    {combo.label}
                                </button>
                            ))}
                        </div>
                    )}
                    <div className="flex items-center justify-center gap-1 px-2 py-1.5">
                        <button onClick={() => setShowKeys(false)} className="shrink-0 p-1.5 text-[#9b9a97] hover:text-[#e7e5e4] rounded transition-colors active:scale-95" title="Hide keys">
                            <Keyboard size={13} />
                        </button>
                        <div className="w-px h-4 bg-[#e7e5e4]/10 shrink-0" />
                        {MODIFIER_KEYS.map((key) => {
                            const isActive = (key.label === 'CTRL' && ctrlMode) || (key.label === 'SHIFT' && shiftMode);
                            const icon = key.label === '↑' ? <ChevronUp size={13} /> :
                                         key.label === '↓' ? <ChevronDown size={13} /> :
                                         key.label === '←' ? <ChevronLeft size={13} /> :
                                         key.label === '→' ? <ChevronRight size={13} /> :
                                         key.label === 'SHIFT' ? <ArrowBigUp size={13} /> :
                                         key.label === '⇧TAB' ? <><ArrowBigUp size={10} /><CornerDownLeft size={10} /></> :
                                         null;
                            return (
                                <button
                                    key={key.label}
                                    onClick={() => handleModifierKey(key)}
                                    className={`shrink-0 flex items-center justify-center gap-0.5 min-w-[32px] px-2 py-1.5 text-[10px] font-mono font-medium rounded transition-colors active:scale-95 ${
                                        isActive
                                            ? 'text-white bg-[#D80018] border border-[#D80018]'
                                            : 'text-[#e7e5e4]/80 bg-[#e7e5e4]/5 hover:bg-[#e7e5e4]/10 active:bg-[#e7e5e4]/15 border border-[#e7e5e4]/10'
                                    }`}
                                    title={key.label}
                                >
                                    {icon || key.label}
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}
