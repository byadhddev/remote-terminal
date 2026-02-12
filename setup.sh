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
BOLD='\033[1m'
DIM='\033[2m'
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
    bun install --silent
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
PORT=$PORT bun run server.ts &>/dev/null &
SERVER_PID=$!

echo -n "Waiting for server"
for i in {1..30}; do
    if curl -s -o /dev/null http://localhost:$PORT 2>/dev/null; then
        echo ""
        echo -e "${GREEN}✓${NC} Server ready"
        break
    fi
    echo -n "."
    sleep 1
done

# 6. Start the tunnel and capture URL
echo -e "${CYAN}Starting Cloudflare tunnel...${NC}"
TUNNEL_LOG=$(mktemp)
$CLOUDFLARED tunnel --url http://localhost:$PORT 2>"$TUNNEL_LOG" &
TUNNEL_PID=$!

# Wait for tunnel URL to appear in logs
TUNNEL_URL=""
for i in {1..20}; do
    TUNNEL_URL=$(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1)
    if [ -n "$TUNNEL_URL" ]; then
        break
    fi
    sleep 1
done

if [ -z "$TUNNEL_URL" ]; then
    echo -e "${RED}✗ Could not detect tunnel URL. Check cloudflared output.${NC}"
    TUNNEL_URL="(tunnel URL not detected)"
fi

FULL_URL="${TUNNEL_URL}/terminal"
LOCAL_URL="http://localhost:$PORT/terminal"

# Get LAN IP
LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
LAN_URL="http://${LAN_IP}:$PORT/terminal"

# ── Display connection info ────────────────────

clear
echo ""
echo -e "${GREEN}${BOLD}  ✓ Remote Terminal is running${NC}"
echo ""
echo -e "  ${DIM}────────────────────────────────────────${NC}"
echo ""
echo -e "  ${BOLD}Tunnel${NC}  ${CYAN}${FULL_URL}${NC}"
echo -e "  ${BOLD}LAN${NC}     ${CYAN}${LAN_URL}${NC}"
echo -e "  ${BOLD}Local${NC}   ${CYAN}${LOCAL_URL}${NC}"
echo ""
echo -e "  ${DIM}────────────────────────────────────────${NC}"
echo ""

# Write URL to file for easy access
echo "$FULL_URL" > "$DIR/.tunnel-url"

# QR code for mobile — scan to open
if bunx qrcode-terminal --help &>/dev/null 2>&1; then
    echo -e "  ${BOLD}Scan to open on mobile:${NC}"
    echo ""
    bunx qrcode-terminal "$FULL_URL" --small 2>/dev/null
    echo ""
else
    echo -e "  ${YELLOW}Tip:${NC} Install qrcode-terminal for a scannable QR code"
fi

echo -e "  ${DIM}────────────────────────────────────────${NC}"
echo ""
echo -e "  ${DIM}URL saved to ${DIR}/.tunnel-url${NC}"
echo -e "  ${DIM}Press ${NC}${RED}Ctrl+C${NC}${DIM} to stop${NC}"
echo ""

# Cleanup on exit
cleanup() {
    echo ""
    echo -e "${YELLOW}Shutting down...${NC}"
    kill $SERVER_PID 2>/dev/null
    kill $TUNNEL_PID 2>/dev/null
    wait $SERVER_PID 2>/dev/null
    wait $TUNNEL_PID 2>/dev/null
    rm -f "$TUNNEL_LOG" "$DIR/.tunnel-url"
    echo -e "${GREEN}✓${NC} Stopped."
}
trap cleanup EXIT INT TERM

# Keep running
wait
