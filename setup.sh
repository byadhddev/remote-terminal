#!/usr/bin/env bash
set -e

# ──────────────────────────────────────────────
# Remote Terminal — One-click setup & launch
# ──────────────────────────────────────────────

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}┌──────────────────────────────────────┐${NC}"
echo -e "${CYAN}│     Remote Terminal — Setup           │${NC}"
echo -e "${CYAN}└──────────────────────────────────────┘${NC}"
echo ""

# 1. Check Node.js
if ! command -v node &>/dev/null; then
    echo -e "${RED}✗ Node.js is not installed. Install Node.js 18+ first.${NC}"
    exit 1
fi
echo -e "${GREEN}✓${NC} Node.js $(node -v)"

# 2. Install npm dependencies
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}→${NC} Installing dependencies..."
    npm install --silent
else
    echo -e "${GREEN}✓${NC} Dependencies installed"
fi

# 3. Install cloudflared if not present
CLOUDFLARED=""
if command -v cloudflared &>/dev/null; then
    CLOUDFLARED="cloudflared"
elif [ -f "$HOME/bin/cloudflared" ]; then
    CLOUDFLARED="$HOME/bin/cloudflared"
else
    echo -e "${YELLOW}→${NC} Installing cloudflared..."
    mkdir -p "$HOME/bin"
    curl -sL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o "$HOME/bin/cloudflared"
    chmod +x "$HOME/bin/cloudflared"
    CLOUDFLARED="$HOME/bin/cloudflared"
    echo -e "${GREEN}✓${NC} cloudflared installed to ~/bin/cloudflared"
fi
echo -e "${GREEN}✓${NC} cloudflared: $($CLOUDFLARED --version 2>&1 | head -1)"

# 4. Pick a port
PORT="${PORT:-3000}"

# Check if port is in use
if lsof -ti:$PORT &>/dev/null; then
    echo -e "${YELLOW}⚠${NC} Port $PORT is in use. Trying 3001..."
    PORT=3001
    if lsof -ti:$PORT &>/dev/null; then
        echo -e "${RED}✗ Ports 3000 and 3001 are both in use.${NC}"
        exit 1
    fi
fi

# 5. Start the server
echo ""
echo -e "${CYAN}Starting server on port $PORT...${NC}"
PORT=$PORT npx tsx server.ts &
SERVER_PID=$!

# Wait for server to be ready
echo -n "Waiting for server"
for i in {1..30}; do
    if curl -s -o /dev/null http://localhost:$PORT 2>/dev/null; then
        echo ""
        echo -e "${GREEN}✓${NC} Server ready on http://localhost:$PORT"
        break
    fi
    echo -n "."
    sleep 1
done

# 6. Start the tunnel
echo ""
echo -e "${CYAN}Starting Cloudflare tunnel...${NC}"
$CLOUDFLARED tunnel --url http://localhost:$PORT 2>&1 &
TUNNEL_PID=$!

# Wait for tunnel URL
sleep 5

echo ""
echo -e "${GREEN}┌──────────────────────────────────────┐${NC}"
echo -e "${GREEN}│     ✓ Remote Terminal is running!     │${NC}"
echo -e "${GREEN}└──────────────────────────────────────┘${NC}"
echo ""
echo -e "  Local:  ${CYAN}http://localhost:$PORT/terminal${NC}"
echo -e "  Tunnel: ${CYAN}Check the cloudflared output above for your public URL${NC}"
echo ""
echo -e "  ${YELLOW}Open the tunnel URL on your phone to access the terminal.${NC}"
echo -e "  Press ${RED}Ctrl+C${NC} to stop everything."
echo ""

# Cleanup on exit
cleanup() {
    echo ""
    echo -e "${YELLOW}Shutting down...${NC}"
    kill $SERVER_PID 2>/dev/null
    kill $TUNNEL_PID 2>/dev/null
    wait $SERVER_PID 2>/dev/null
    wait $TUNNEL_PID 2>/dev/null
    echo -e "${GREEN}✓${NC} Stopped."
}
trap cleanup EXIT INT TERM

# Keep running
wait
