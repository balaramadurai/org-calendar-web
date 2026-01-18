#!/usr/bin/env python3
"""
Org Calendar Web API
FastAPI backend that interfaces with Emacs org-mode files
"""

import os
import json
import subprocess
import asyncio
import logging
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# Configure logging
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

app = FastAPI(title="Org Calendar API", version="1.0.0")

# CORS for local development and mobile access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, restrict this
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Cache for events (in-memory, refreshed periodically)
events_cache: Dict[str, Any] = {}
cache_timestamp: Optional[datetime] = None
CACHE_TTL_SECONDS = 300  # 5 minutes

# PARA folder paths (Tiago Forte's PARA method)
PARA_FOLDERS = {
    "Inbox": "/Documents/0Inbox/",
    "Projects": "/Documents/1Projects/",
    "Areas": "/Documents/2Areas/",
    "Resources": "/Documents/3Resources/",
    "Archives": "/Documents/4Archives/",
}


def classify_para(file_path: str) -> str:
    """Classify a file path into PARA category based on folder location."""
    if not file_path:
        return "Other"
    for para_name, folder_pattern in PARA_FOLDERS.items():
        if folder_pattern in file_path:
            return para_name
    return "Other"


def add_para_to_events(events: Dict[str, List[Dict]]) -> Dict[str, List[Dict]]:
    """Add PARA classification to all events based on their file paths."""
    for date_key, day_events in events.items():
        for event in day_events:
            event["para"] = classify_para(event.get("file", ""))
    return events


class EventCreate(BaseModel):
    title: str
    date: str  # YYYY-MM-DD
    time: Optional[str] = None  # HH:MM
    end_time: Optional[str] = None
    type: str = "scheduled"  # scheduled, deadline, timestamp
    category: Optional[str] = None
    priority: Optional[str] = None  # A, B, C
    tags: Optional[str] = None
    notes: Optional[str] = None
    capture_file: Optional[str] = None  # Custom file path for capture
    capture_headline: Optional[str] = "Inbox"  # Headline to file under


class EventUpdate(BaseModel):
    title: Optional[str] = None
    date: Optional[str] = None
    time: Optional[str] = None
    end_time: Optional[str] = None
    state: Optional[str] = None  # TODO, DONE, etc
    priority: Optional[str] = None
    category: Optional[str] = None


class EventReschedule(BaseModel):
    file: str
    line: int
    new_date: str  # YYYY-MM-DD
    new_time: Optional[str] = None


class EventLocation(BaseModel):
    """Used for operations that just need file and line."""
    file: str
    line: int


class EventUpdateRequest(BaseModel):
    """Full update request with file location and updates."""
    file: str
    line: int
    title: Optional[str] = None
    date: Optional[str] = None
    time: Optional[str] = None
    end_time: Optional[str] = None
    type: Optional[str] = None  # scheduled, deadline, timestamp
    state: Optional[str] = None
    priority: Optional[str] = None
    category: Optional[str] = None
    notes: Optional[str] = None


class CheckboxToggle(BaseModel):
    """Toggle a checkbox in event notes."""
    file: str
    line: int
    checkbox_index: int  # 0-based index of checkbox in notes
    checked: bool


def check_emacs_server() -> bool:
    """Check if Emacs server is running."""
    try:
        result = subprocess.run(
            ["emacsclient", "--eval", "t"],
            capture_output=True,
            text=True,
            timeout=5
        )
        return result.returncode == 0 and "t" in result.stdout
    except Exception:
        return False


async def fetch_events_for_month(year_month: str) -> Dict[str, List[Dict]]:
    """Fetch events for a specific month using org-agenda-calendar."""
    script_path = Path.home() / ".local/bin/org-agenda-calendar"
    
    if not script_path.exists():
        raise HTTPException(status_code=500, detail="org-agenda-calendar script not found")
    
    try:
        proc = await asyncio.create_subprocess_exec(
            str(script_path), year_month,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
        
        if proc.returncode != 0:
            error_msg = stderr.decode() if stderr else "Unknown error"
            if "emacs_server_not_running" in error_msg or "emacs_server_not_running" in stdout.decode():
                raise HTTPException(status_code=503, detail="Emacs server not running")
            raise HTTPException(status_code=500, detail=f"Failed to fetch events: {error_msg}")
        
        events = json.loads(stdout.decode())
        return events
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Request timed out")
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=500, detail=f"Invalid JSON response: {e}")


def parse_ics_simple(content: str, name: str, color: str, target_tz: str = "local") -> Dict[str, List[Dict]]:
    """Simple regex-based ICS parser as fallback when icalendar is not installed."""
    import re
    from zoneinfo import ZoneInfo
    
    events_by_date: Dict[str, List[Dict]] = {}
    
    # Get target timezone
    if target_tz == "local":
        local_tz = ZoneInfo("localtime") if os.path.exists("/etc/localtime") else None
    else:
        try:
            local_tz = ZoneInfo(target_tz)
        except Exception:
            local_tz = None
    
    def parse_ics_datetime(line_prefix: str, block: str):
        """Parse ICS datetime with TZID support.
        
        Handles formats:
        - DTSTART:20260115 (all-day)
        - DTSTART:20260115T090000Z (UTC)
        - DTSTART:20260115T090000 (floating/local time)
        - DTSTART;TZID=America/New_York:20260115T090000 (with timezone)
        - DTSTART;VALUE=DATE:20260115 (explicit date)
        """
        # Match the full line to capture TZID if present
        pattern = rf'{line_prefix}(?:;([^:]+))?:(\d{{8}}(?:T\d{{6}}Z?)?)'
        match = re.search(pattern, block)
        if not match:
            return None, None, None
        
        params_str = match.group(1) or ""
        dt_str = match.group(2)
        
        # Extract TZID from parameters (e.g., "TZID=America/New_York" or "TZID=America/New_York;VALUE=DATE-TIME")
        tzid = None
        if 'TZID=' in params_str:
            tzid_match = re.search(r'TZID=([^;:]+)', params_str)
            if tzid_match:
                tzid = tzid_match.group(1)
        
        return dt_str, tzid, params_str
    
    def convert_to_target_tz(dt_str: str, tzid: str | None, params_str: str | None):
        """Convert datetime string to target timezone."""
        if len(dt_str) == 8:
            # All-day event: YYYYMMDD
            date_str = f"{dt_str[:4]}-{dt_str[4:6]}-{dt_str[6:8]}"
            return date_str, None, True
        
        # Timed event: YYYYMMDDTHHMMSS or YYYYMMDDTHHMMSSZ
        is_utc = dt_str.endswith('Z')
        
        # Parse the datetime
        dt = datetime(
            int(dt_str[:4]), int(dt_str[4:6]), int(dt_str[6:8]),
            int(dt_str[9:11]), int(dt_str[11:13]), int(dt_str[13:15]) if len(dt_str) >= 15 else 0
        )
        
        # Determine source timezone and convert
        if is_utc:
            # UTC time - convert to target
            if local_tz:
                dt = dt.replace(tzinfo=ZoneInfo("UTC")).astimezone(local_tz)
        elif tzid:
            # Has explicit TZID - convert from that timezone to target
            try:
                source_tz = ZoneInfo(tzid)
                if local_tz:
                    dt = dt.replace(tzinfo=source_tz).astimezone(local_tz)
            except Exception:
                # Unknown timezone, treat as local/floating
                pass
        # else: floating time (no Z, no TZID) - keep as-is
        
        return dt.strftime('%Y-%m-%d'), dt.strftime('%H:%M'), False
    
    # Split into events
    event_blocks = re.findall(r'BEGIN:VEVENT.*?END:VEVENT', content, re.DOTALL)
    
    for block in event_blocks:
        # Extract fields
        summary_match = re.search(r'SUMMARY[^:]*:(.+?)(?:\r?\n|\Z)', block)
        uid_match = re.search(r'UID[^:]*:(.+?)(?:\r?\n|\Z)', block)
        
        # Parse DTSTART with TZID support
        dtstart_str, dtstart_tzid, dtstart_params = parse_ics_datetime('DTSTART', block)
        dtend_str, dtend_tzid, dtend_params = parse_ics_datetime('DTEND', block)
        
        if not dtstart_str:
            continue
        
        summary = summary_match.group(1).strip() if summary_match else 'No title'
        
        # Convert to target timezone
        date_str, time_str, all_day = convert_to_target_tz(dtstart_str, dtstart_tzid, dtstart_params)
        
        end_time = None
        if dtend_str and len(dtend_str) > 8:
            _, end_time, _ = convert_to_target_tz(dtend_str, dtend_tzid or dtstart_tzid, dtend_params)
        
        # Extract UID for Google Calendar link
        uid = uid_match.group(1).strip() if uid_match else None
        
        event = {
            'title': summary,
            'time': time_str,
            'end_time': end_time,
            'all_day': all_day,
            'category': name,
            'color': color,
            'source': 'ics',
            'ics_calendar': name,
            'uid': uid
        }
        
        if date_str not in events_by_date:
            events_by_date[date_str] = []
        events_by_date[date_str].append(event)
    
    return events_by_date


async def fetch_ics_events(url: str, name: str, color: str, target_tz: str = "local") -> Dict[str, List[Dict]]:
    """Fetch events from an ICS calendar feed."""
    import urllib.request
    import ssl
    
    # First try external script
    script_path = Path.home() / ".local/bin/ics-calendar-fetch"
    
    if script_path.exists():
        try:
            # Pass timezone as 4th argument to the script
            proc = await asyncio.create_subprocess_exec(
                str(script_path), url, name, color, target_tz,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
            
            if proc.returncode == 0:
                result = json.loads(stdout.decode())
                # Check for errors in the response
                if isinstance(result, dict) and result.get('_error'):
                    logger.warning(f"ICS script error: {result.get('_message')}")
                    raise Exception(result.get('_message', 'Unknown error'))
                return result
            else:
                logger.warning(f"ICS script failed with code {proc.returncode}: {stderr.decode()}")
        except json.JSONDecodeError as e:
            logger.warning(f"ICS script returned invalid JSON: {e}")
        except Exception as e:
            logger.warning(f"External script failed: {e}")
    
    # Fetch the ICS content
    try:
        # Create SSL context that doesn't verify (for self-signed certs)
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        
        req = urllib.request.Request(url, headers={'User-Agent': 'OrgCalendarWeb/1.0'})
        with urllib.request.urlopen(req, timeout=30, context=ctx) as response:
            content = response.read().decode('utf-8', errors='replace')
    except Exception as e:
        print(f"Failed to fetch ICS URL: {e}")
        raise
    
    # Try icalendar library first
    try:
        from icalendar import Calendar  # type: ignore
        from zoneinfo import ZoneInfo
        
        # Get target timezone
        if target_tz == "local":
            # Try to get system local timezone
            try:
                import time
                # Get local timezone name from system
                if time.daylight:
                    local_tz_name = time.tzname[1]
                else:
                    local_tz_name = time.tzname[0]
                # Try to create ZoneInfo from local timezone
                # This might not work for all timezone names, so we have fallback
                local_tz = None  # Will use .astimezone() for system local
                logger.debug(f"Using system local timezone: {local_tz_name}")
            except Exception:
                local_tz = None
        else:
            try:
                local_tz = ZoneInfo(target_tz)
                logger.debug(f"Using explicit timezone: {target_tz}")
            except Exception as e:
                logger.warning(f"Failed to load timezone {target_tz}: {e}")
                local_tz = None
        
        cal = Calendar.from_ical(content)
        events_by_date: Dict[str, List[Dict]] = {}
        
        def convert_dt_to_target(dt, target_tz_obj):
            """Convert datetime to target timezone, handling various cases."""
            if not hasattr(dt, 'hour'):
                return dt, None, True  # date object, no time, all-day
            
            # If datetime has timezone info, convert it
            if hasattr(dt, 'tzinfo') and dt.tzinfo is not None:
                if target_tz_obj:
                    dt = dt.astimezone(target_tz_obj)
                else:
                    dt = dt.astimezone()  # System local
            else:
                # No timezone info - check if it looks like UTC (common for Google Calendar)
                # Try to get TZID from the raw value parameters
                # For now, assume floating times without tzinfo are meant to be in target timezone
                # (this is a reasonable default for personal calendars)
                pass
            
            return dt, dt.strftime('%H:%M'), False
        
        for component in cal.walk():
            if component.name == "VEVENT":
                dtstart = component.get('dtstart')
                if not dtstart:
                    continue
                
                dt = dtstart.dt
                original_dt = dt  # Keep for logging
                
                # Check for TZID in parameters
                dtstart_params = dtstart.params if hasattr(dtstart, 'params') else {}
                tzid = dtstart_params.get('TZID')
                
                summary = str(component.get('summary', 'No title'))
                
                if hasattr(dt, 'hour'):
                    # datetime object - may have timezone info
                    has_tzinfo = hasattr(dt, 'tzinfo') and dt.tzinfo is not None
                    logger.debug(f"Event: {summary[:30]}, original_dt={original_dt}, tzinfo={dt.tzinfo if has_tzinfo else 'None'}, TZID param={tzid}, target_tz={target_tz}, local_tz={local_tz}")
                    
                    if has_tzinfo:
                        # Already has timezone, convert to target
                        if local_tz:
                            dt = dt.astimezone(local_tz)
                        else:
                            dt = dt.astimezone()
                        logger.debug(f"  -> Converted (had tzinfo): {dt}")
                    elif tzid:
                        # Has TZID parameter but icalendar didn't apply it
                        try:
                            source_tz = ZoneInfo(tzid)
                            dt = dt.replace(tzinfo=source_tz)
                            if local_tz:
                                dt = dt.astimezone(local_tz)
                            else:
                                dt = dt.astimezone()
                            logger.debug(f"  -> Converted (from TZID param): {dt}")
                        except Exception as e:
                            logger.debug(f"  -> Failed to convert TZID {tzid}: {e}")
                    else:
                        logger.debug(f"  -> No conversion (floating time)")
                    
                    date_str = dt.strftime('%Y-%m-%d')
                    time_str = dt.strftime('%H:%M')
                    all_day = False
                else:
                    # date object (all-day event)
                    date_str = dt.strftime('%Y-%m-%d')
                    time_str = None
                    all_day = True
                
                dtend = component.get('dtend')
                end_time = None
                if dtend:
                    end_dt = dtend.dt
                    dtend_params = dtend.params if hasattr(dtend, 'params') else {}
                    end_tzid = dtend_params.get('TZID') or tzid  # Fallback to start TZID
                    
                    if hasattr(end_dt, 'hour'):
                        if hasattr(end_dt, 'tzinfo') and end_dt.tzinfo is not None:
                            if local_tz:
                                end_dt = end_dt.astimezone(local_tz)
                            else:
                                end_dt = end_dt.astimezone()
                        elif end_tzid:
                            try:
                                source_tz = ZoneInfo(end_tzid)
                                end_dt = end_dt.replace(tzinfo=source_tz)
                                if local_tz:
                                    end_dt = end_dt.astimezone(local_tz)
                                else:
                                    end_dt = end_dt.astimezone()
                            except Exception:
                                pass
                        end_time = end_dt.strftime('%H:%M')
                
                # Extract UID for Google Calendar link
                uid = str(component.get('uid', '')) if component.get('uid') else None
                
                event = {
                    'title': summary,
                    'time': time_str,
                    'end_time': end_time,
                    'all_day': all_day,
                    'category': name,
                    'color': color,
                    'source': 'ics',
                    'ics_calendar': name,
                    'uid': uid
                }
                
                if date_str not in events_by_date:
                    events_by_date[date_str] = []
                events_by_date[date_str].append(event)
        
        return events_by_date
    except ImportError:
        # icalendar not installed, use simple parser
        print("icalendar not installed, using simple parser")
        return parse_ics_simple(content, name, color, target_tz)
    except Exception as e:
        print(f"icalendar parsing failed: {e}, trying simple parser")
        return parse_ics_simple(content, name, color, target_tz)


def run_emacsclient_eval(elisp: str) -> str:
    """Execute elisp via emacsclient and return result."""
    try:
        result = subprocess.run(
            ["emacsclient", "--eval", elisp],
            capture_output=True,
            text=True,
            timeout=30
        )
        if result.returncode != 0:
            raise HTTPException(status_code=500, detail=f"Emacs error: {result.stderr}")
        return result.stdout.strip()
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="Emacs command timed out")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/")
async def root():
    """API root - health check."""
    emacs_running = check_emacs_server()
    return {
        "status": "ok",
        "service": "Org Calendar API",
        "emacs_server": "connected" if emacs_running else "disconnected",
        "timestamp": datetime.now().isoformat()
    }


@app.get("/status")
async def get_status():
    """Get detailed API status."""
    return {
        "emacs_server": check_emacs_server(),
        "cache_age": (datetime.now() - cache_timestamp).seconds if cache_timestamp else None,
        "cached_months": list(events_cache.keys())
    }


@app.get("/events")
async def get_events(
    start_date: str = Query(..., description="Start date YYYY-MM-DD"),
    end_date: str = Query(..., description="End date YYYY-MM-DD"),
    refresh: bool = Query(False, description="Force cache refresh")
):
    """Get events for a date range."""
    global events_cache, cache_timestamp
    
    try:
        start = datetime.strptime(start_date, "%Y-%m-%d")
        end = datetime.strptime(end_date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format")
    
    # Determine which months we need
    months_needed = set()
    current = start.replace(day=1)
    while current <= end:
        months_needed.add(current.strftime("%Y-%m"))
        if current.month == 12:
            current = current.replace(year=current.year + 1, month=1)
        else:
            current = current.replace(month=current.month + 1)
    
    # Check cache validity
    cache_valid = (
        cache_timestamp is not None and
        (datetime.now() - cache_timestamp).seconds < CACHE_TTL_SECONDS and
        not refresh
    )
    
    # Fetch missing months
    all_events = {}
    for month in months_needed:
        if cache_valid and month in events_cache:
            month_events = events_cache[month]
        else:
            month_events = await fetch_events_for_month(month)
            events_cache[month] = month_events
        
        # Merge events
        for date_key, day_events in month_events.items():
            if start_date <= date_key <= end_date:
                if date_key not in all_events:
                    all_events[date_key] = []
                all_events[date_key].extend(day_events)
    
    cache_timestamp = datetime.now()
    
    # Add PARA classification to all events
    all_events = add_para_to_events(all_events)
    
    return {
        "events": all_events,
        "start_date": start_date,
        "end_date": end_date,
        "total_events": sum(len(v) for v in all_events.values())
    }


@app.get("/events/{date}")
async def get_events_for_date(date: str):
    """Get events for a specific date (includes both org-mode and ICS events)."""
    try:
        datetime.strptime(date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format")

    # Fetch org-mode events
    month = date[:7]
    events = await fetch_events_for_month(month)
    events = add_para_to_events(events)
    day_events = events.get(date, [])

    # Fetch ICS events if calendars are configured
    settings = load_server_settings()
    ics_calendars = settings.get('icsCalendars', [])
    enabled_calendars = [cal for cal in ics_calendars if cal.get('enabled', True)]

    if enabled_calendars:
        try:
            ics_timezone = settings.get('icsTimezone', 'local')
            for calendar in enabled_calendars:
                url = calendar.get('url', '')
                name = calendar.get('name', 'Unknown')
                color = calendar.get('color', '#89b4fa')

                if url:
                    ics_events = await fetch_ics_events(url, name, color, ics_timezone)
                    if date in ics_events:
                        # Add icsDone field to ICS events
                        ics_done_events = settings.get('icsDoneEvents', {})
                        for event in ics_events[date]:
                            event_key = f"{name}:{event.get('uid', '')}"
                            if event_key in ics_done_events:
                                event['icsDone'] = True
                            else:
                                event['icsDone'] = False

                        day_events.extend(ics_events[date])
        except Exception as e:
            logger.warning(f"Failed to fetch ICS events: {e}")

    return {"date": date, "events": day_events}


@app.get("/categories")
async def get_categories():
    """Get all categories from org-agenda files."""
    elisp = '''
    (let ((cats '()))
      (dolist (file (org-agenda-files))
        (when (file-exists-p file)
          (with-current-buffer (find-file-noselect file)
            (org-map-entries
             (lambda ()
               (let ((cat (org-get-category)))
                 (when cat (cl-pushnew cat cats :test #'string=))))))))
      (json-encode (sort cats #'string<)))
    '''
    result = run_emacsclient_eval(elisp)
    
    # Parse the result (it's a quoted JSON string)
    if result.startswith('"') and result.endswith('"'):
        result = result[1:-1].replace('\\"', '"')
    
    try:
        categories = json.loads(result)
        return {"categories": categories}
    except json.JSONDecodeError:
        return {"categories": []}


@app.get("/todo-keywords")
async def get_todo_keywords():
    """Get org-todo-keywords from Emacs configuration."""
    elisp = '''
    (let ((keywords '()))
      (dolist (sequence org-todo-keywords)
        (dolist (kw (cdr sequence))
          (unless (string-match-p "|" kw)
            (let ((clean-kw (replace-regexp-in-string "(.)$" "" kw)))
              (cl-pushnew clean-kw keywords :test #'string=)))))
      (json-encode (nreverse keywords)))
    '''
    result = run_emacsclient_eval(elisp)
    
    # Parse the result
    if result.startswith('"') and result.endswith('"'):
        result = result[1:-1].replace('\\"', '"')
    
    try:
        keywords = json.loads(result)
        return {"keywords": keywords}
    except json.JSONDecodeError:
        # Return default keywords if parsing fails
        return {"keywords": ["TODO", "NEXT", "WAITING", "DONE", "CANCELLED"]}


@app.post("/events")
async def create_event(event: EventCreate):
    """Create a new event by appending to org file."""
    # Build timestamp
    timestamp = f"<{event.date}"
    if event.time:
        timestamp += f" {event.time}"
        if event.end_time:
            timestamp += f"-{event.end_time}"
    timestamp += ">"
    
    # Build entry components
    todo_state = "TODO " if event.type in ("scheduled", "deadline") else ""
    priority_str = f"[#{event.priority}] " if event.priority else ""
    
    # Escape special characters for elisp string
    escaped_title = event.title.replace('\\', '\\\\').replace('"', '\\"')
    escaped_notes = (event.notes or "").replace('\\', '\\\\').replace('"', '\\"')
    escaped_headline = (event.capture_headline or "Inbox").replace('\\', '\\\\').replace('"', '\\"')
    
    # Build the scheduling line
    if event.type == "scheduled":
        schedule_line = f"SCHEDULED: {timestamp}"
    elif event.type == "deadline":
        schedule_line = f"DEADLINE: {timestamp}"
    else:
        schedule_line = timestamp
    
    # Handle custom capture file
    if event.capture_file:
        # Expand ~ to home directory
        escaped_file = event.capture_file.replace('\\', '\\\\').replace('"', '\\"')
        file_expr = f'(expand-file-name "{escaped_file}")'
    else:
        file_expr = '''(or org-default-notes-file 
                           (car (org-agenda-files))
                           (expand-file-name "notes.org" org-directory))'''
    
    # Create entry under specified headline in org file
    elisp = f'''
    (progn
      (let* ((file {file_expr})
             (target-headline "{escaped_headline}")
             (entry-headline "** {todo_state}{priority_str}{escaped_title}")
             (schedule "{schedule_line}")
             (notes "{escaped_notes}"))
        (with-current-buffer (find-file-noselect file)
          (goto-char (point-min))
          ;; Find or create the target headline
          (if (re-search-forward (concat "^\\\\* " (regexp-quote target-headline) "\\\\s-*$") nil t)
              (progn
                (org-end-of-subtree t t)
                (unless (bolp) (insert "\\n")))
            ;; Create the headline if it doesn't exist
            (goto-char (point-max))
            (unless (bolp) (insert "\\n"))
            (insert "* " target-headline "\\n"))
          ;; Insert the new entry
          (insert entry-headline "\\n")
          (insert schedule "\\n")
          (when (and notes (not (string-empty-p notes)))
            (insert notes "\\n"))
          (save-buffer))
        "created"))
    '''
    
    result = run_emacsclient_eval(elisp)
    
    # Clear cache for this month
    month = event.date[:7]
    if month in events_cache:
        del events_cache[month]
    
    return {"status": "created", "title": event.title, "date": event.date}


@app.post("/events/update")
async def update_event(request: EventUpdateRequest):
    """Update an existing event."""
    file_path = request.file
    line_num = request.line

    # Validate file exists
    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail=f"File not found: {file_path}")

    # Build list of operations to perform
    operations = []

    if request.title:
        escaped_title = request.title.replace('\\', '\\\\').replace('"', '\\"')
        operations.append(f'(org-edit-headline "{escaped_title}")')

    if request.state:
        escaped_state = request.state.replace('"', '\\"')
        operations.append(f'(org-todo "{escaped_state}")')

    if request.priority is not None:
        if request.priority in ('A', 'B', 'C'):
            operations.append(f'(org-priority ?{request.priority})')
        elif request.priority == '':
            operations.append('(org-priority 32)')  # Remove priority (32 = space character)

    if request.category:
        escaped_cat = request.category.replace('\\', '\\\\').replace('"', '\\"')
        operations.append(f'(org-set-property "CATEGORY" "{escaped_cat}")')

    # Handle date/time updates
    if request.date:
        event_type = request.type or "scheduled"

        # For gcal events, don't modify timestamps
        if event_type != "gcal":
            time_part = ""
            if request.time:
                if request.end_time:
                    time_part = f" {request.time}-{request.end_time}"
                else:
                    time_part = f" {request.time}"
            date_time_str = f"{request.date}{time_part}"

            if event_type == "deadline":
                operations.append(f'(org-deadline nil "{date_time_str}")')
            else:
                operations.append(f'(org-schedule nil "{date_time_str}")')

    # Handle notes update
    notes_operation = ""
    if request.notes is not None:
        escaped_notes = request.notes.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n')
        notes_operation = f'''
        ;; Update notes/body
        (org-end-of-meta-data t)
        (let* ((body-start (point))
               (subtree-end (save-excursion (org-end-of-subtree t t) (point)))
               (body-end (save-excursion
                           (if (re-search-forward "^\\\\*+ " subtree-end t)
                               (line-beginning-position)
                             subtree-end))))
          (when (and (< body-start body-end)
                     (not (= body-start subtree-end)))
            (delete-region body-start body-end))
          (goto-char body-start)
          (when (not (string-empty-p "{escaped_notes}"))
            (insert "{escaped_notes}")
            (unless (bolp) (insert "\\n"))))'''

    if not operations and not notes_operation:
        return {"status": "no changes"}

    # Build elisp that performs all operations at the correct heading
    operations_str = '\n        '.join(operations) if operations else ""

    elisp = f'''
    (progn
      (find-file "{file_path}")
      (goto-line {line_num})
      (org-back-to-heading t)
      (save-excursion
        {operations_str}
        {notes_operation})
      (save-buffer)
      "updated")
    '''

    logger.debug(f"Executing elisp for event update at {file_path}:{line_num}")
    result = run_emacsclient_eval(elisp)

    # Clear cache
    events_cache.clear()

    return {"status": "updated"}


@app.post("/events/reschedule")
async def reschedule_event(request: EventReschedule):
    """Reschedule an event to a new date."""
    file_path = request.file
    line_num = request.line
    
    # Validate file exists
    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail=f"File not found: {file_path}")
    
    timestamp = f"<{request.new_date}"
    if request.new_time:
        timestamp += f" {request.new_time}"
    timestamp += ">"
    
    elisp = f'''
    (progn
      (find-file "{file_path}")
      (goto-line {line_num})
      (org-back-to-heading t)
      (let ((end (save-excursion (org-end-of-subtree t) (point))))
        (when (re-search-forward "SCHEDULED: <[^>]+>" end t)
          (replace-match "SCHEDULED: {timestamp}"))
        (when (re-search-forward "DEADLINE: <[^>]+>" end t)
          (replace-match "DEADLINE: {timestamp}")))
      (save-buffer)
      "rescheduled")
    '''
    
    result = run_emacsclient_eval(elisp)
    events_cache.clear()
    
    return {"status": "rescheduled", "new_date": request.new_date}


@app.post("/events/done")
async def mark_event_done(request: EventLocation):
    """Mark an event as DONE."""
    file_path = request.file
    line_num = request.line
    
    # Validate file exists
    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail=f"File not found: {file_path}")
    
    elisp = f'''
    (progn
      (find-file "{file_path}")
      (goto-line {line_num})
      (org-back-to-heading t)
      (org-todo "DONE")
      (save-buffer)
      "done")
    '''
    
    result = run_emacsclient_eval(elisp)
    events_cache.clear()
    
    return {"status": "done"}


class EventStateRequest(BaseModel):
    """Request to change event TODO state."""
    file: str
    line: int
    state: str  # TODO, DONE, CANCELLED, WAITING, etc.


@app.post("/events/state")
async def update_event_state(request: EventStateRequest):
    """Update an event's TODO state."""
    file_path = request.file
    line_num = request.line
    new_state = request.state
    
    # Validate file exists
    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail=f"File not found: {file_path}")
    
    # Escape the state for elisp
    escaped_state = new_state.replace('"', '\\"')
    
    elisp = f'''
    (progn
      (find-file "{file_path}")
      (goto-line {line_num})
      (org-back-to-heading t)
      (org-todo "{escaped_state}")
      (save-buffer)
      "state-updated")
    '''
    
    result = run_emacsclient_eval(elisp)
    events_cache.clear()
    
    return {"status": "updated", "state": new_state}


@app.post("/events/delete")
async def delete_event(request: EventLocation, archive: bool = True):
    """Delete (archive) an event."""
    file_path = request.file
    line_num = request.line
    
    # Validate file exists
    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail=f"File not found: {file_path}")
    
    if archive:
        elisp = f'''
        (progn
          (find-file "{file_path}")
          (goto-line {line_num})
          (org-back-to-heading t)
          (org-archive-subtree)
          (save-buffer)
          "archived")
        '''
    else:
        elisp = f'''
        (progn
          (find-file "{file_path}")
          (goto-line {line_num})
          (org-back-to-heading t)
          (org-cut-subtree)
          (save-buffer)
          "deleted")
        '''
    
    result = run_emacsclient_eval(elisp)
    events_cache.clear()
    
    return {"status": "archived" if archive else "deleted"}


@app.post("/events/toggle-checkbox")
async def toggle_checkbox(request: CheckboxToggle):
    """Toggle a checkbox in an event's notes section."""
    file_path = request.file
    line_num = request.line
    checkbox_index = request.checkbox_index
    checked = request.checked
    
    # Validate file exists
    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail=f"File not found: {file_path}")
    
    # Elisp to toggle the nth checkbox in the entry's body
    # We search for checkboxes (- [ ] or - [X]) and toggle the one at the given index
    new_state = "X" if checked else " "
    
    elisp = f'''
    (progn
      (find-file "{file_path}")
      (goto-line {line_num})
      (org-back-to-heading t)
      (let* ((heading-end (save-excursion (org-end-of-meta-data t) (point)))
             (subtree-end (save-excursion (org-end-of-subtree t t) (point)))
             (body-end (save-excursion
                         (goto-char heading-end)
                         (if (re-search-forward "^\\\\*+ " subtree-end t)
                             (line-beginning-position)
                           subtree-end)))
             (checkbox-count 0)
             (found nil))
        (goto-char heading-end)
        (while (and (not found)
                    (re-search-forward "- \\\\[\\\\([ Xx]\\\\)\\\\]" body-end t))
          (when (= checkbox-count {checkbox_index})
            (replace-match "- [{new_state}]")
            (setq found t))
          (setq checkbox-count (1+ checkbox-count)))
        (if found
            (progn (save-buffer) "toggled")
          (error "Checkbox not found at index {checkbox_index}"))))
    '''
    
    try:
        result = run_emacsclient_eval(elisp)
        events_cache.clear()
        return {"status": "toggled", "checked": checked}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/refresh")
async def refresh_cache():
    """Force refresh of the event cache."""
    global events_cache, cache_timestamp
    events_cache.clear()
    cache_timestamp = None
    return {"status": "cache cleared"}


@app.get("/refile-targets")
async def get_refile_targets():
    """Get refile targets using Emacs org-refile-targets configuration."""
    elisp = r'''
    (progn
      (require 'org-refile)
      (let ((targets '())
            refile-targets)
        ;; org-refile-get-targets needs org-mode context, use temp buffer
        (with-temp-buffer
          (org-mode)
          (setq refile-targets (org-refile-get-targets)))
        ;; Structure: (headline file regex-or-nil level)
        (dolist (target refile-targets)
          (let* ((headline (nth 0 target))
                 (file (nth 1 target))
                 (level (nth 3 target)))
            ;; Only include targets with valid file and heading
            (when (and file (not (string-empty-p file))
                       headline (not (string-empty-p headline)))
              (push (list (cons "file" file)
                          (cons "heading" headline)
                          (cons "level" (or level 1)))
                    targets))))
        (json-encode (nreverse targets))))
    '''
    result = run_emacsclient_eval(elisp)

    # Parse the result
    if result.startswith('"') and result.endswith('"'):
        result = result[1:-1].replace('\\"', '"').replace('\\\\', '\\')

    try:
        targets = json.loads(result)
        # Add PARA classification to each target
        for t in targets:
            t['para'] = classify_para(t.get('file', ''))
        return {"targets": targets}
    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse refile targets: {e}, result: {result}")
        return {"targets": []}


class RefileRequest(BaseModel):
    source_file: str
    source_line: int
    target_file: str
    target_heading: str


@app.post("/events/refile")
async def refile_event(request: RefileRequest):
    """Refile an org heading to a different location using org-refile."""
    # Escape quotes in heading for elisp
    escaped_heading = request.target_heading.replace('\\', '\\\\').replace('"', '\\"')
    elisp = f'''
    (progn
      (find-file "{request.source_file}")
      (goto-char (point-min))
      (forward-line {request.source_line - 1})
      (org-back-to-heading t)
      (let* ((target-file "{request.target_file}")
             (target-heading "{escaped_heading}")
             (org-refile-targets `((,target-file :regexp . ,(concat "^\\\\*+ " (regexp-quote target-heading))))))
        (org-refile nil nil (list target-heading target-file nil nil)))
      (save-buffer)
      (with-current-buffer (find-file-noselect "{request.target_file}")
        (save-buffer))
      "refiled")
    '''
    
    result = run_emacsclient_eval(elisp)
    
    if "refiled" in result:
        # Clear cache to reflect changes
        global events_cache, cache_timestamp
        events_cache.clear()
        cache_timestamp = None
        return {"status": "refiled", "target": request.target_heading}
    else:
        raise HTTPException(status_code=500, detail=f"Refile failed: {result}")


class OpenRequest(BaseModel):
    file: str
    line: int


@app.post("/open")
async def open_in_emacs(request: OpenRequest):
    """Open a file at a specific line in Emacs."""
    file_path = request.file
    line_num = request.line
    
    # Validate file exists
    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail=f"File not found: {file_path}")
    
    elisp = f'''
    (progn
      (find-file "{file_path}")
      (goto-line {line_num})
      (org-back-to-heading t)
      (org-show-entry)
      (recenter)
      (select-frame-set-input-focus (selected-frame))
      "opened")
    '''
    
    result = run_emacsclient_eval(elisp)
    return {"status": "opened", "file": file_path, "line": line_num}


# ==================== ICS Calendar Endpoints ====================

class IcsCalendarRequest(BaseModel):
    """Request to fetch events from ICS calendars."""
    calendars: List[Dict[str, Any]]  # List of {url, name, color, enabled}
    start_date: str  # YYYY-MM-DD
    end_date: str  # YYYY-MM-DD
    timezone: str = "local"  # Target timezone for conversion


@app.post("/ics/events")
async def get_ics_events(request: IcsCalendarRequest):
    """Fetch events from multiple ICS calendar feeds."""
    all_events: Dict[str, List[Dict]] = {}
    errors: List[str] = []
    
    try:
        start = datetime.strptime(request.start_date, "%Y-%m-%d")
        end = datetime.strptime(request.end_date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format")
    
    for calendar in request.calendars:
        if not calendar.get('enabled', True):
            continue
        
        url = calendar.get('url', '')
        name = calendar.get('name', 'Unknown')
        color = calendar.get('color', '#89b4fa')
        
        if not url:
            continue
        
        try:
            events = await fetch_ics_events(url, name, color, request.timezone)
            
            # Filter events within date range and merge
            for date_key, day_events in events.items():
                if request.start_date <= date_key <= request.end_date:
                    if date_key not in all_events:
                        all_events[date_key] = []
                    all_events[date_key].extend(day_events)
        except Exception as e:
            errors.append(f"{name}: {str(e)}")
    
    return {
        "events": all_events,
        "start_date": request.start_date,
        "end_date": request.end_date,
        "total_events": sum(len(v) for v in all_events.values()),
        "errors": errors if errors else None
    }


class IcsMarkDoneRequest(BaseModel):
    """Request to mark an ICS event as done."""
    uid: str
    calendar: str
    timestamp: str


@app.post("/api/ics/mark-done")
async def mark_ics_done(request: IcsMarkDoneRequest):
    """Mark an ICS calendar event as done (for Android notifications)."""
    settings = load_server_settings()

    # Initialize icsDoneEvents if not present
    if 'icsDoneEvents' not in settings:
        settings['icsDoneEvents'] = {}

    # Create key from calendar:uid:date
    # Extract date from uid if possible, otherwise use current date
    key = f"{request.calendar}:{request.uid}"

    settings['icsDoneEvents'][key] = {
        'markedAt': request.timestamp,
        'calendar': request.calendar
    }

    save_server_settings(settings)

    return {
        "status": "marked",
        "uid": request.uid,
        "calendar": request.calendar
    }


# ==================== Settings Sync ====================

SETTINGS_FILE = Path.home() / ".config" / "org-calendar-web" / "settings.json"

def load_server_settings() -> Dict[str, Any]:
    """Load settings from server-side file."""
    if SETTINGS_FILE.exists():
        try:
            with open(SETTINGS_FILE, 'r') as f:
                return json.load(f)
        except Exception as e:
            logger.warning(f"Failed to load settings: {e}")
    return {}

def save_server_settings(settings: Dict[str, Any]) -> None:
    """Save settings to server-side file."""
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(SETTINGS_FILE, 'w') as f:
        json.dump(settings, f, indent=2)

@app.get("/settings")
async def get_settings():
    """Get shared settings (ICS calendars, timezone, etc.)."""
    settings = load_server_settings()
    return settings

@app.post("/settings")
async def save_settings(request: Dict[str, Any]):
    """Save shared settings."""
    # Merge with existing settings
    current = load_server_settings()
    current.update(request)
    save_server_settings(current)
    return {"status": "saved"}

@app.patch("/settings")
async def patch_settings(request: Dict[str, Any]):
    """Partially update settings (merge with existing)."""
    current = load_server_settings()
    current.update(request)
    save_server_settings(current)
    return {"status": "updated", "settings": current}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8765)
