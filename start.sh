#!/bin/bash
# Start Org Calendar Web Server
# Usage: ./start.sh [--install] [--port PORT]

set -e

cd "$(dirname "$0")"

# Default port
PORT=8766

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --install)
            INSTALL=1
            shift
            ;;
        --port)
            PORT="$2"
            shift 2
            ;;
        *)
            shift
            ;;
    esac
done

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}╔═══════════════════════════════════════╗${NC}"
echo -e "${GREEN}║       Org Calendar Web Server         ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════╝${NC}"

# Check for Python
if ! command -v python3 &> /dev/null; then
    echo -e "${RED}Python 3 is required but not installed.${NC}"
    exit 1
fi

# Create venv if needed
if [ ! -d "backend/.venv" ]; then
    echo -e "${YELLOW}Creating virtual environment...${NC}"
    python3 -m venv backend/.venv
fi

# Activate venv
source backend/.venv/bin/activate

# Install dependencies if needed or if --install flag
if [ "$INSTALL" == "1" ] || [ ! -f "backend/.venv/installed" ]; then
    echo -e "${YELLOW}Installing dependencies...${NC}"
    pip install -r backend/requirements.txt
    touch backend/.venv/installed
fi

# Check Emacs server
echo -e "${YELLOW}Checking Emacs server...${NC}"
if emacsclient --eval 't' &> /dev/null; then
    echo -e "${GREEN}✓ Emacs server is running${NC}"
else
    echo -e "${RED}✗ Emacs server is NOT running${NC}"
    echo -e "${YELLOW}  Start it with: M-x server-start in Emacs${NC}"
    echo -e "${YELLOW}  Or add (server-start) to your init.el${NC}"
fi

# Get local IP for mobile access (cross-platform)
LOCAL_IP=$(ip route get 1 2>/dev/null | awk '{print $7; exit}' || hostname -i 2>/dev/null | awk '{print $1}' || echo "your-ip")

echo ""
echo -e "${GREEN}Starting server on port ${PORT}...${NC}"
echo ""
echo -e "Access the calendar at:"
echo -e "  Local:   ${GREEN}http://localhost:${PORT}${NC}"
echo -e "  Network: ${GREEN}http://${LOCAL_IP}:${PORT}${NC}"
echo ""
echo -e "For mobile access on the same network, use the Network URL."
echo -e "Press Ctrl+C to stop the server."
echo ""

# Export port for server.py
export ORG_CAL_PORT=$PORT

# Start the server
python3 backend/server.py
