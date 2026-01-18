# Org Calendar Web

A mobile-friendly web interface for your Emacs org-mode agenda. Access your calendar from any device on your local network.

![Week View](screenshot.png)

## Features

- **Week View** - Beautiful time-block calendar view with events
- **Mobile Optimized** - Touch-friendly, installable as PWA
- **Real-time Sync** - Direct integration with Emacs via emacsclient
- **Full CRUD** - Create, edit, reschedule, and archive events
- **Category Filtering** - Filter events by category with color coding
- **Dark Theme** - Easy on the eyes, matches your Emacs theme

## Requirements

- Python 3.8+
- Emacs with server mode running (`M-x server-start`)
- Your existing org-agenda setup
- The `org-agenda-calendar` script (from orgCalendar widget)

## Quick Start

```bash
# Clone/copy to your laptop
cd ~/Code/org-calendar-web

# Start the server (first run will install dependencies)
./start.sh --install

# Access from your browser
# Local:   http://localhost:8765
# Mobile:  http://<your-laptop-ip>:8765
```

## Usage

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `n` | New event |
| `t` | Go to today |
| `←` | Previous week |
| `→` | Next week |
| `Esc` | Close popup/modal |

### Mobile Gestures

- **Swipe left/right** - Navigate weeks
- **Tap event** - View details
- **Tap + button** - Create new event

### Installing as PWA

On mobile Chrome/Safari:
1. Open the webapp URL
2. Tap "Add to Home Screen" 
3. Launch like a native app

## Architecture

```
org-calendar-web/
├── backend/
│   ├── main.py          # FastAPI server
│   └── requirements.txt
├── frontend/
│   ├── index.html       # Single page app
│   ├── styles.css       # Dark theme styles
│   ├── app.js           # Vanilla JS frontend
│   ├── manifest.json    # PWA manifest
│   └── sw.js            # Service worker
└── start.sh             # Startup script
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/events` | GET | Get events for date range |
| `/api/events` | POST | Create new event |
| `/api/events/{file}/{line}/done` | POST | Mark event as DONE |
| `/api/events/{file}/{line}/reschedule` | POST | Reschedule event |
| `/api/events/{file}/{line}` | DELETE | Archive event |
| `/api/categories` | GET | List all categories |
| `/api/status` | GET | Server/Emacs status |

## Remote Access (Outside Home Network)

For secure access from anywhere:

### Option 1: Tailscale (Recommended)
```bash
# Install Tailscale on laptop and phone
# Access via: http://<tailscale-ip>:8765
```

### Option 2: Cloudflare Tunnel
```bash
cloudflared tunnel --url http://localhost:8765
```

### Option 3: Nginx + Let's Encrypt
Set up reverse proxy with HTTPS on your home server.

## Troubleshooting

### "Emacs server not running"
```bash
# In Emacs:
M-x server-start

# Or add to init.el:
(server-start)
```

### Events not loading
```bash
# Test the org-agenda-calendar script directly:
~/.local/bin/org-agenda-calendar 2025-01

# Should output JSON with your events
```

### Can't access from phone
1. Ensure phone is on same WiFi network
2. Check laptop's IP: `hostname -I`
3. Check firewall: `sudo ufw allow 8765`

## Credits

Built to complement the [orgCalendar](https://github.com/user/DankMaterialShell) Plasma widget.

## License

MIT
