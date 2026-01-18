#!/usr/bin/env python3
"""
Combined server that serves both API and static files
"""
import os
import sys

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import uvicorn
from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from main import app as api_app

# Get paths
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(os.path.dirname(SCRIPT_DIR), 'frontend')

# Create new app that includes both API and static
app = FastAPI(title="Org Calendar Web")

# Include all routes from the API app
app.mount("/api", api_app)

# Serve static files
app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")

# Serve index.html for root and any non-API routes (SPA support)
@app.get("/")
async def serve_root():
    return FileResponse(os.path.join(FRONTEND_DIR, 'index.html'))

@app.get("/{path:path}")
async def serve_static(path: str):
    # Try to serve the exact file
    file_path = os.path.join(FRONTEND_DIR, path)
    if os.path.isfile(file_path):
        return FileResponse(file_path)
    # Fall back to index.html for SPA routing
    return FileResponse(os.path.join(FRONTEND_DIR, 'index.html'))

if __name__ == "__main__":
    port = int(os.environ.get("ORG_CAL_PORT", 8766))
    uvicorn.run(app, host="0.0.0.0", port=port)
