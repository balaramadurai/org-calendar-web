/**
 * Org Calendar Web Application
 * Mobile-friendly calendar interface for org-mode
 */

const API_BASE = window.location.origin;

// State
const state = {
    currentDate: new Date(),
    weekStart: getWeekStart(new Date()),
    selectedDate: new Date(),
    events: {},
    categories: [],
    hiddenCategories: new Set(),
    hiddenParaItems: new Set(),  // Hidden PARA items as "ParaType:ParentName" keys
    selectedEvent: null,
    selectedEventDate: null,
    loading: false,
    viewMode: null, // week, 3day, day, agenda, month, year - null means use defaultView from settings
    sidebarOpen: false,
    searchQuery: '',
    isOffline: true,  // Start as offline until server responds
    serverOnline: false,  // Tracks actual server connectivity
    pendingEventsCount: 0,
    isDragging: false,  // Track drag operations
    // Project timeline mode
    timelineMode: null,  // { paraType: 'Projects', parent: 'ProjectName', startDate, endDate }
    previousViewMode: null,  // To restore when exiting timeline
    // Selection mode state
    selectionMode: false,
    selectedEvents: new Set() // Set of strings "dateKey:idx"
};

// Color palette for categories
const categoryColors = {};
const defaultColors = [
    '#4dd0e1', '#ba68c8', '#ffb74d', '#81c784', '#f06292',
    '#64b5f6', '#e57373', '#fff176', '#4db6ac', '#9575cd',
    '#aed581', '#ff8a65', '#90a4ae', '#dce775', '#7986cb'
];

// PARA section configuration (Tiago Forte's PARA method)
const paraConfig = {
    Inbox: { color: '#ffb74d', listId: 'inboxList', sectionId: 'inboxSection', icon: '📥' },
    Projects: { color: '#e57373', listId: 'projectsList', sectionId: 'projectsSection', icon: '🎯' },
    Subprojects: { color: '#f06292', listId: 'subprojectsList', sectionId: 'subprojectsSection', icon: '📁' },
    Areas: { color: '#81c784', listId: 'areasList', sectionId: 'areasSection', icon: '🔄' },
    Resources: { color: '#64b5f6', listId: 'resourcesList', sectionId: 'resourcesSection', icon: '📚' },
    Archives: { color: '#90a4ae', listId: 'archivesList', sectionId: 'archivesSection', icon: '📦' }
};

// Get icon for PARA type
function getParaIcon(paraType) {
    return paraConfig[paraType]?.icon || '📋';
}

// Special category for events without a category property
const UNCATEGORIZED = '(Uncategorized)';

// Helper to get PARA item key for an event
function getParaItemKey(e) {
    const para = e.para || 'Other';

    // Inbox events - group by parent or filename
    if (para === 'Inbox') {
        const key = e.parent || e.file?.split('/').pop()?.replace('.org', '') || 'Inbox Items';
        return `Inbox:${key}`;
    }

    // Area events: group by level-1 ancestor (matching renderParaFilters logic)
    const tags = e.tags ? e.tags.toLowerCase().split(':').filter(t => t) : [];
    const isArea = tags.includes('area') || para === 'Areas';
    if (isArea) {
        let areaName;
        if (!e.parent) {
            areaName = e.title;
        } else {
            areaName = e.parent.split('/')[0];
        }
        return areaName ? `Areas:${areaName}` : null;
    }

    // Events not in any PARA folder - don't filter by PARA (let category handle it)
    if (para === 'Other') {
        return null;  // No PARA filtering for these
    }

    // Events without parent - don't filter by PARA
    if (!e.parent) {
        return null;
    }

    return `${para}:${e.parent}`;
}

// ==================== Todo Keywords ====================

// Cache for org-todo-keywords
let todoKeywords = ['TODO', 'NEXT', 'WAITING', 'DONE', 'CANCELLED'];

// Fetch todo keywords from Emacs
async function fetchTodoKeywords() {
    try {
        const response = await fetchWithTimeout(`${API_BASE}/api/todo-keywords`, {}, 5000);
        if (response.ok) {
            const data = await response.json();
            if (data.keywords && data.keywords.length > 0) {
                todoKeywords = data.keywords;
                updateStateDropdownFromKeywords();
            }
        }
    } catch (e) {
        console.warn('Failed to fetch todo keywords:', e);
    }
}

// Update state dropdown in edit modal based on fetched keywords
function updateStateDropdownFromKeywords() {
    const select = document.getElementById('editState');
    if (!select) return;

    // Build options - None first, then all keywords
    let html = '<option value="">None</option>';

    todoKeywords.forEach(kw => {
        // Strip flags like (!) or (@!) from display, keep full value for API
        const displayName = kw.replace(/\([^)]*\)$/, '').trim();
        html += `<option value="${kw}">${displayName}</option>`;
    });

    select.innerHTML = html;
}

// ==================== Helper Functions ====================

function getWeekStart(date) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(d.getFullYear(), d.getMonth(), diff);
}

// Special states/tags that indicate a project/area heading
const PROJECT_STATES = ['PROJ', 'PROJECT', 'DISCUSSION', 'PROPOSAL', 'AREA'];
const PROJECT_TAGS = ['proj', 'area', 'project'];

// Check if an event is a project/area heading itself (by state or tag)
function isProjectHeadingEvent(e) {
    if (e.state && PROJECT_STATES.includes(e.state.toUpperCase())) {
        return true;
    }
    if (e.tags) {
        const eventTags = e.tags.toLowerCase().split(':').filter(t => t);
        return eventTags.some(t => PROJECT_TAGS.includes(t));
    }
    return false;
}

// Get the project name for an event (either its own title if it's a project, or its parent)
function getProjectNameForEvent(e, projectHeadingTitles) {
    // If this event IS a project heading, use its own title
    if (isProjectHeadingEvent(e)) {
        return e.title;
    }
    // If parent is a known project heading, use it
    if (projectHeadingTitles && projectHeadingTitles.has(e.parent)) {
        return e.parent;
    }
    // If no project headings are defined, fall back to parent
    if (!projectHeadingTitles || projectHeadingTitles.size === 0) {
        return e.parent;
    }
    // Parent is not a project heading - return null to skip
    return null;
}

function formatDate(date) {
    // Use local date components to avoid timezone offset issues
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function formatDateDisplay(date) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return `${days[date.getDay()]}, ${months[date.getMonth()]} ${date.getDate()}`;
}

function formatDateTitle(start, end) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    if (start.getMonth() === end.getMonth()) {
        return `${months[start.getMonth()]} ${start.getDate()} - ${end.getDate()}`;
    }
    return `${months[start.getMonth()]} ${start.getDate()} - ${months[end.getMonth()]} ${end.getDate()}`;
}

function getRelativeTime(dateKey, time) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const eventDate = new Date(dateKey + 'T00:00:00');
    const dayDiff = Math.floor((eventDate - today) / (1000 * 60 * 60 * 24));
    
    if (dayDiff === -1) return 'Yesterday';
    if (dayDiff === 0) {
        if (time) {
            const [h, m] = time.split(':').map(Number);
            const eventTime = new Date(now);
            eventTime.setHours(h, m, 0, 0);
            const hoursDiff = (eventTime - now) / (1000 * 60 * 60);
            if (hoursDiff < 0) return `${Math.abs(Math.floor(hoursDiff))}h ago`;
            if (hoursDiff < 1) return `in ${Math.floor(hoursDiff * 60)}m`;
            return `in ${Math.floor(hoursDiff)}h`;
        }
        return 'Today';
    }
    if (dayDiff === 1) return 'Tomorrow';
    if (dayDiff > 1 && dayDiff < 7) return `in ${dayDiff} days`;
    return formatDateDisplay(eventDate);
}

function getColorForCategory(category) {
    if (!category) return '#607d8b';
    if (categoryColors[category]) return categoryColors[category];
    let hash = 0;
    for (let i = 0; i < category.length; i++) {
        hash = ((hash << 5) - hash) + category.charCodeAt(i);
        hash = hash & hash;
    }
    const color = defaultColors[Math.abs(hash) % defaultColors.length];
    categoryColors[category] = color;
    return color;
}

// Get event background color based on settings (solid or transparent)
function getEventBackground(hexColor) {
    const style = settings?.eventColorStyle || 'solid';
    
    if (style === 'transparent') {
        // Return transparent version (hex + alpha)
        return hexColor + '40'; // ~25% opacity
    }
    
    // Solid style: use the full category color
    return hexColor;
}

// Get contrasting text color for a background (white or dark)
function getContrastingTextColor(hexColor) {
    const hex = hexColor.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    // Calculate relative luminance
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.5 ? '#1a1a2e' : '#ffffff';
}

// Get text color for event based on settings
function getEventTextColor(hexColor) {
    const style = settings?.eventColorStyle || 'solid';
    if (style === 'solid') {
        return getContrastingTextColor(hexColor);
    }
    // Transparent style uses default text color
    return null;
}

// Alias for backward compatibility
function getSolidEventBackground(hexColor) {
    return getEventBackground(hexColor);
}

function parseTime(timeStr) {
    if (!timeStr) return null;
    const [hours, mins] = timeStr.split(':').map(Number);
    return hours * 60 + mins;
}

function formatTime12(time) {
    if (!time) return '';
    const [h, m] = time.split(':').map(Number);
    
    // Use 24-hour format if settings say so
    if (typeof settings !== 'undefined' && settings.timeFormat === '24') {
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
    
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

function calculateOverlapPositions(events) {
    if (events.length === 0) return [];
    
    // Helper to check if two events overlap in time
    const overlaps = (a, b) => a.startMins < b.endMins && a.endMins > b.startMins;
    
    // For each event, find all events that directly overlap with it
    const overlapSets = events.map((event, i) => {
        const overlapping = [i];
        for (let j = 0; j < events.length; j++) {
            if (i !== j && overlaps(event, events[j])) {
                overlapping.push(j);
            }
        }
        return overlapping;
    });
    
    // Assign columns - process events in start time order
    const sortedIndices = events.map((_, i) => i).sort((a, b) => events[a].startMins - events[b].startMins);
    const columns = new Array(events.length).fill(-1);
    const columnEndTimes = []; // Track when each column becomes free
    
    sortedIndices.forEach(i => {
        const event = events[i];
        // Find first available column
        let col = 0;
        for (; col < columnEndTimes.length; col++) {
            if (event.startMins >= columnEndTimes[col]) {
                break;
            }
        }
        columns[i] = col;
        if (col >= columnEndTimes.length) {
            columnEndTimes.push(event.endMins);
        } else {
            columnEndTimes[col] = event.endMins;
        }
    });
    
    // For each event, calculate totalColumns based on directly overlapping events only
    const result = events.map((event, i) => {
        const overlappingIndices = overlapSets[i];
        if (overlappingIndices.length === 1) {
            // No overlaps - full width
            return { event, column: 0, totalColumns: 1 };
        }
        
        // Find max column among overlapping events
        let maxCol = 0;
        overlappingIndices.forEach(j => {
            maxCol = Math.max(maxCol, columns[j]);
        });
        
        return { event, column: columns[i], totalColumns: maxCol + 1 };
    });
    
    return result;
}

// Check if event passes settings filters (type visibility, completed state)
function passesSettingsFilters(e) {
    if (typeof settings !== 'undefined') {
        if (!settings.showCompleted && e.state === 'DONE') return false;
        if (!settings.showScheduled && e.type === 'scheduled') return false;
        if (!settings.showDeadlines && e.type === 'deadline') return false;
        if (!settings.showTimestamps && e.type === 'timestamp') return false;
        if (!settings.showGcal && e.type === 'gcal') return false;
    }
    return true;
}

function getEventsForDate(dateKey) {
    return (state.events[dateKey] || [])
        .filter(e => {
            // Category filter: handle uncategorized events
            const category = e.category || UNCATEGORIZED;
            if (state.hiddenCategories.has(category)) return false;
            
            // PARA filter: if PARA item is explicitly hidden, hide the event
            const itemKey = getParaItemKey(e);
            if (itemKey && state.hiddenParaItems.has(itemKey)) return false;
            
            return true;
        })
        .filter(passesSettingsFilters)
        .filter(e => {
            if (!state.searchQuery) return true;
            const q = state.searchQuery.toLowerCase();
            return (e.title || '').toLowerCase().includes(q) ||
                   (e.category || '').toLowerCase().includes(q) ||
                   (e.notes || '').toLowerCase().includes(q);
        })
        .sort((a, b) => {
            if (!a.time && !b.time) return 0;
            if (!a.time) return 1;
            if (!b.time) return -1;
            return a.time.localeCompare(b.time);
        });
}

// Save filter state to localStorage
function saveFilterState() {
    localStorage.setItem('hiddenCategories', JSON.stringify([...state.hiddenCategories]));
    localStorage.setItem('hiddenParaItems', JSON.stringify([...state.hiddenParaItems]));
}

// Load filter state from localStorage
function loadFilterState() {
    try {
        const cats = JSON.parse(localStorage.getItem('hiddenCategories') || '[]');
        state.hiddenCategories = new Set(cats);
        const para = JSON.parse(localStorage.getItem('hiddenParaItems') || '[]');
        state.hiddenParaItems = new Set(para);
    } catch (e) {
        console.warn('Failed to load filter state:', e);
    }
}

// ==================== UI Helpers ====================

function showLoading(show) {
    state.loading = show;
    document.getElementById('loadingOverlay').hidden = !show;
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function showConnectionStatus(connected, message = null) {
    const el = document.getElementById('connectionStatus');
    el.hidden = connected;
    if (!connected && message) {
        // Update the message text
        const textEl = el.querySelector('.status-text');
        if (textEl) textEl.textContent = message;
    }
}

// Update the navbar year view toggle buttons
function updateNavYearToggle() {
    const toggle = document.getElementById('navYearToggle');
    if (!toggle) return;
    
    toggle.querySelectorAll('.year-toggle-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === state.yearViewMode);
    });
    
    // Also update the legend visibility in year header
    const legend = document.querySelector('.year-legend');
    if (legend) {
        legend.style.display = state.yearViewMode === 'glance' ? 'none' : '';
    }
}

// Initialize navbar year toggle event handlers
function initNavYearToggle() {
    const toggle = document.getElementById('navYearToggle');
    if (!toggle) return;
    
    toggle.querySelectorAll('.year-toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            state.yearViewMode = btn.dataset.mode;
            updateNavYearToggle();
            if (state.viewMode === 'year') {
                renderYearView();
            }
        });
    });
}

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const isMobile = window.innerWidth <= 768;
    
    if (isMobile) {
        // Mobile: slide in/out
        state.sidebarOpen = !state.sidebarOpen;
        sidebar.classList.toggle('open', state.sidebarOpen);
        document.getElementById('sidebarBackdrop')?.remove();
        if (state.sidebarOpen) {
            // Sync mini calendar to current view date
            syncMiniCalendarToView();
            
            const backdrop = document.createElement('div');
            backdrop.id = 'sidebarBackdrop';
            backdrop.className = 'sidebar-backdrop';
            backdrop.onclick = toggleSidebar;
            document.getElementById('app').appendChild(backdrop);
        }
    } else {
        // Desktop: show/hide
        sidebar.classList.toggle('hidden-sidebar');
    }
}

// Sync mini calendar month to the currently viewed date
function syncMiniCalendarToView() {
    let viewDate;
    if (state.viewMode === 'day' || state.viewMode === '3day' || state.viewMode === 'agenda') {
        viewDate = state.selectedDate || new Date();
    } else {
        // For week view, use the middle of the week or today if it's in view
        const today = new Date();
        const weekEnd = new Date(state.weekStart);
        weekEnd.setDate(weekEnd.getDate() + 6);
        if (today >= state.weekStart && today <= weekEnd) {
            viewDate = today;
        } else {
            // Use middle of the week
            viewDate = new Date(state.weekStart);
            viewDate.setDate(viewDate.getDate() + 3);
        }
    }
    
    // Update miniCalendarMonth to show the correct month
    state.miniCalendarMonth = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1);
    renderMiniCalendar();
}

// ==================== Offline Storage ====================

const EVENTS_CACHE_KEY = 'orgCalendarEventsCache';
const CACHE_TIMESTAMP_KEY = 'orgCalendarCacheTimestamp';
const PENDING_CHANGES_KEY = 'orgCalendarPendingChanges';

function saveEventsToCache(events) {
    try {
        // Merge with existing cache instead of replacing
        const existing = loadEventsFromCache();
        const merged = { ...existing, ...events };
        localStorage.setItem(EVENTS_CACHE_KEY, JSON.stringify(merged));
        localStorage.setItem(CACHE_TIMESTAMP_KEY, new Date().toISOString());
    } catch (e) {
        console.warn('Failed to cache events:', e);
    }
}

function loadEventsFromCache() {
    try {
        const cached = localStorage.getItem(EVENTS_CACHE_KEY);
        return cached ? JSON.parse(cached) : {};
    } catch (e) {
        console.warn('Failed to load cached events:', e);
        return {};
    }
}

function getCacheTimestamp() {
    try {
        const ts = localStorage.getItem(CACHE_TIMESTAMP_KEY);
        return ts ? new Date(ts) : null;
    } catch (e) {
        return null;
    }
}

function isOnline() {
    // Return true only if server is actually reachable
    return state.serverOnline;
}

// Check if server is reachable (ping with short timeout)
async function checkServerConnection() {
    // If no network at all, definitely offline
    if (!navigator.onLine) {
        setServerStatus(false, 'No network connection');
        return false;
    }

    try {
        // Quick ping to server status endpoint
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);

        const response = await fetch(`${API_BASE}/status`, {
            method: 'GET',
            signal: controller.signal,
            cache: 'no-store'
        });
        clearTimeout(timeoutId);

        if (response.ok) {
            setServerStatus(true);
            return true;
        } else {
            setServerStatus(false, 'Server error');
            return false;
        }
    } catch (e) {
        setServerStatus(false, 'Server unreachable');
        return false;
    }
}

// Update server online status and UI
function setServerStatus(online, message = null) {
    const wasOffline = state.isOffline;
    state.serverOnline = online;
    state.isOffline = !online;

    if (online) {
        showConnectionStatus(true);
    } else {
        showConnectionStatus(false, message || 'Offline - showing cached data');
    }

    // If we just came online, sync pending changes and refresh data
    if (wasOffline && online) {
        showToast('Connected to server', 'success');
        syncOfflineEvents();
        // Refresh events from server
        loadEvents(true, false);
    } else if (!wasOffline && !online) {
        showToast('Server offline - using cached data', 'warning');
    }

    updateOfflineUI();
}

// Fetch with timeout - crucial for detecting unreachable servers
async function fetchWithTimeout(url, options = {}, timeout = 8000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        return response;
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            throw new Error('Request timeout - server unreachable');
        }
        throw error;
    }
}

// Check if we have cached data available
function hasCachedData() {
    const cached = loadEventsFromCache();
    return cached && Object.keys(cached).length > 0;
}

// ==================== Pending Changes Queue ====================

function savePendingChange(operation, data) {
    try {
        const pending = JSON.parse(localStorage.getItem(PENDING_CHANGES_KEY) || '[]');
        pending.push({
            id: Date.now() + Math.random(),
            operation,
            data,
            timestamp: new Date().toISOString()
        });
        localStorage.setItem(PENDING_CHANGES_KEY, JSON.stringify(pending));
        updatePendingChangesIndicator();
        return true;
    } catch (e) {
        console.error('Failed to save pending change:', e);
        return false;
    }
}

function getPendingChanges() {
    try {
        return JSON.parse(localStorage.getItem(PENDING_CHANGES_KEY) || '[]');
    } catch (e) {
        return [];
    }
}

function clearPendingChanges() {
    localStorage.removeItem(PENDING_CHANGES_KEY);
    updatePendingChangesIndicator();
}

function removePendingChange(id) {
    try {
        const pending = getPendingChanges();
        const filtered = pending.filter(c => c.id !== id);
        localStorage.setItem(PENDING_CHANGES_KEY, JSON.stringify(filtered));
        updatePendingChangesIndicator();
    } catch (e) {
        console.error('Failed to remove pending change:', e);
    }
}

function updatePendingChangesIndicator() {
    const pending = getPendingChanges();
    const indicator = document.getElementById('pendingChangesIndicator');
    if (indicator) {
        const textEl = indicator.querySelector('.pending-text');
        if (pending.length > 0) {
            if (textEl) textEl.textContent = `${pending.length} pending`;
            indicator.hidden = false;
        } else {
            indicator.hidden = true;
        }
    }
}

async function syncPendingChanges() {
    const pending = getPendingChanges();
    if (pending.length === 0) return;

    console.log(`Syncing ${pending.length} pending changes...`);
    showToast(`Syncing ${pending.length} pending changes...`, 'info');

    let successCount = 0;
    let failCount = 0;

    for (const change of pending) {
        try {
            let success = false;
            switch (change.operation) {
                case 'createEvent':
                    success = await createEventDirect(change.data.eventData);
                    break;
                case 'updateEvent':
                    success = await updateEventDirect(change.data.event, change.data.updates);
                    break;
                case 'updateState':
                    success = await updateEventStateDirect(change.data.event, change.data.state);
                    break;
                case 'reschedule':
                    success = await rescheduleEventDirect(change.data.event, change.data.newDate, change.data.newTime);
                    break;
                case 'delete':
                    success = await deleteEventDirect(change.data.event);
                    break;
                case 'toggleIcsDone':
                    success = await syncIcsDone(change.data.key, change.data.done);
                    break;
            }

            if (success) {
                removePendingChange(change.id);
                successCount++;
            } else {
                failCount++;
            }
        } catch (e) {
            console.error('Failed to sync change:', e);
            failCount++;
        }
    }

    if (successCount > 0) {
        showToast(`Synced ${successCount} changes`, 'success');
        await loadEvents(true, false);
    }
    if (failCount > 0) {
        showToast(`${failCount} changes failed to sync`, 'error');
    }
}

// Reset local cache and reload from server
async function resetLocalData() {
    if (!confirm('This will clear all local data and reload from the server.\n\nContinue?')) {
        return;
    }
    
    showLoading(true);
    showToast('Clearing local data...', 'info');
    
    try {
        // Clear event cache
        localStorage.removeItem(EVENTS_CACHE_KEY);
        localStorage.removeItem(CACHE_TIMESTAMP_KEY);
        
        // Clear state
        state.events = {};
        state.categories = [];
        state.hiddenCategories = new Set();
        state.hiddenParaItems = new Set();
        state.timelineMode = null;
        
        // Clear filter state
        localStorage.removeItem('hiddenCategories');
        localStorage.removeItem('hiddenParaItems');
        
        // Clear ICS done cache (but keep server-synced data)
        icsDoneCache = null;
        
        // Reload from server with force refresh
        await loadEvents(true, false);
        
        // Re-render
        renderView();
        renderCategories();
        renderParaFilters();
        
        showToast('Local data reset successfully', 'success');
    } catch (error) {
        console.error('Reset failed:', error);
        showToast('Reset failed: ' + error.message, 'error');
    } finally {
        showLoading(false);
    }
}

// ==================== API Calls ====================

async function fetchEvents(startDate, endDate, refresh = false) {
    // If offline, use cached data immediately
    if (!isOnline()) {
        console.log('Offline - using cached events');
        showConnectionStatus(false, 'Offline - showing cached data');
        return loadEventsFromCache();
    }

    try {
        const url = `${API_BASE}/api/events?start_date=${startDate}&end_date=${endDate}&refresh=${refresh}`;
        // Use fetchWithTimeout to detect unreachable servers quickly (8 second timeout)
        const response = await fetchWithTimeout(url, {}, 8000);
        if (!response.ok) {
            if (response.status === 503) {
                showConnectionStatus(false, 'Emacs server not running');
                // Try to use cached data
                const cached = loadEventsFromCache();
                if (Object.keys(cached).length > 0) {
                    showToast('Using cached data', 'warning');
                    return cached;
                }
                throw new Error('Emacs server not running');
            }
            throw new Error(`HTTP ${response.status}`);
        }
        showConnectionStatus(true);
        const data = await response.json();
        let orgEvents = data.events;
        
        // Fetch ICS events if there are enabled calendars
        const icsCalendars = (settings.icsCalendars || []).filter(c => c.enabled !== false);
        if (icsCalendars.length > 0 && settings.showGcal !== false) {
            const icsEvents = await fetchIcsEvents(startDate, endDate, icsCalendars);
            // Merge ICS events with org events
            orgEvents = mergeEvents(orgEvents, icsEvents);
        }
        
        // Cache the events for offline use
        saveEventsToCache(orgEvents);
        
        return orgEvents;
    } catch (error) {
        console.error('Failed to fetch events:', error);
        
        // Try to use cached data on network error
        const cached = loadEventsFromCache();
        if (Object.keys(cached).length > 0) {
            showConnectionStatus(false, 'Network error - showing cached data');
            showToast('Using cached data', 'warning');
            return cached;
        }
        
        showToast(error.message, 'error');
        return {};
    }
}

async function fetchIcsEvents(startDate, endDate, calendars) {
    if (!calendars || calendars.length === 0) return {};

    // Deduplicate calendars by URL to prevent duplicate events
    const seenUrls = new Set();
    const uniqueCalendars = calendars.filter(cal => {
        if (!cal.url || seenUrls.has(cal.url)) return false;
        seenUrls.add(cal.url);
        return true;
    });
    if (uniqueCalendars.length === 0) return {};

    // Determine timezone to use
    let timezone = settings.icsTimezone || 'local';
    if (timezone === 'local') {
        // Get browser's timezone (e.g., "Asia/Kolkata")
        timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    }
    
    try {
        const response = await fetchWithTimeout(`${API_BASE}/api/ics/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                calendars: uniqueCalendars,
                start_date: startDate,
                end_date: endDate,
                timezone: timezone
            })
        }, 10000); // 10 second timeout for ICS (may need to fetch external calendars)

        if (!response.ok) {
            console.warn('ICS fetch failed:', response.status);
            return {};
        }

        const data = await response.json();
        if (data.errors && data.errors.length > 0) {
            console.warn('ICS fetch errors:', data.errors);
        }
        return data.events || {};
    } catch (error) {
        console.warn('Failed to fetch ICS events:', error);
        return {};
    }
}

// ==================== ICS Event Done Tracking ====================

function getIcsEventKey(event, dateKey) {
    // Create a unique key for an ICS event based on its properties
    return `ics:${dateKey}:${event.time || 'allday'}:${event.title}:${event.ics_calendar || event.calendarName || ''}`;
}

function loadIcsDoneEvents() {
    try {
        const saved = localStorage.getItem('orgCalendarIcsDone');
        return saved ? JSON.parse(saved) : {};
    } catch (e) {
        return {};
    }
}

function saveIcsDoneEvents(doneEvents) {
    try {
        localStorage.setItem('orgCalendarIcsDone', JSON.stringify(doneEvents));
    } catch (e) {
        console.error('Failed to save ICS done events:', e);
    }
    // Sync to server
    syncIcsDoneToServer(doneEvents);
}

async function syncIcsDoneToServer(doneEvents) {
    try {
        const response = await fetchWithTimeout(`${API_BASE}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ icsDoneEvents: doneEvents })
        }, 5000);
        if (response.ok) {
            console.log('ICS done events synced to server');
        }
    } catch (e) {
        console.warn('Failed to sync ICS done events to server:', e);
    }
}

async function loadIcsDoneFromServer() {
    try {
        const response = await fetchWithTimeout(`${API_BASE}/api/settings`, {}, 5000);
        if (response.ok) {
            const serverSettings = await response.json();
            const serverDone = serverSettings.icsDoneEvents || {};
            const local = loadIcsDoneEvents();
            
            // Merge: combine both, newer timestamps win for conflicts
            const merged = { ...serverDone };
            for (const [key, value] of Object.entries(local)) {
                if (!merged[key] || (value.markedAt && (!merged[key].markedAt || value.markedAt > merged[key].markedAt))) {
                    merged[key] = value;
                }
            }
            
            // Save merged locally
            localStorage.setItem('orgCalendarIcsDone', JSON.stringify(merged));
            
            // If local had items not on server, sync back to server
            if (Object.keys(local).length > 0 && Object.keys(merged).length > Object.keys(serverDone).length) {
                console.log('Syncing local ICS done events to server...');
                await syncIcsDoneToServer(merged);
            }
            
            console.log('ICS done events synced:', Object.keys(merged).length, 'items');
            return merged;
        }
    } catch (e) {
        console.warn('Failed to load ICS done events from server:', e);
    }
    
    // If server unavailable, still try to sync local to server
    const local = loadIcsDoneEvents();
    if (Object.keys(local).length > 0) {
        syncIcsDoneToServer(local);  // Fire and forget
    }
    return local;
}

// Cache for ICS done events to avoid repeated localStorage reads
let icsDoneCache = null;

function getIcsDoneCache() {
    if (icsDoneCache === null) {
        icsDoneCache = loadIcsDoneEvents();
    }
    return icsDoneCache;
}

function invalidateIcsDoneCache() {
    icsDoneCache = null;
}

function isIcsEventDone(event, dateKey) {
    const doneEvents = getIcsDoneCache();
    const key = getIcsEventKey(event, dateKey);
    return !!doneEvents[key];
}

function toggleIcsEventDone(event, dateKey) {
    const doneEvents = loadIcsDoneEvents();  // Get fresh copy to modify
    const key = getIcsEventKey(event, dateKey);
    
    if (doneEvents[key]) {
        delete doneEvents[key];
    } else {
        doneEvents[key] = { 
            markedAt: new Date().toISOString(),
            title: event.title 
        };
    }
    
    saveIcsDoneEvents(doneEvents);
    invalidateIcsDoneCache();  // Clear cache so next read gets fresh data
    
    // Update the icsDone flag in the current state.events
    const eventsForDate = state.events[dateKey];
    if (eventsForDate) {
        for (let i = 0; i < eventsForDate.length; i++) {
            const e = eventsForDate[i];
            if (e.source === 'ics' && getIcsEventKey(e, dateKey) === key) {
                eventsForDate[i] = { ...e, icsDone: !!doneEvents[key] };
                break;
            }
        }
    }
    
    // Re-render to show updated state
    renderView();
    return !!doneEvents[key]; // Return new done state
}

// Clean up old done events (older than 30 days)
function cleanupOldIcsDoneEvents() {
    const doneEvents = loadIcsDoneEvents();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    
    let changed = false;
    for (const [key, value] of Object.entries(doneEvents)) {
        if (value.markedAt && new Date(value.markedAt) < cutoff) {
            delete doneEvents[key];
            changed = true;
        }
    }
    
    if (changed) {
        saveIcsDoneEvents(doneEvents);
    }
}

function mergeEvents(orgEvents, icsEvents) {
    const merged = { ...orgEvents };

    for (const [dateKey, events] of Object.entries(icsEvents)) {
        if (!merged[dateKey]) {
            merged[dateKey] = [];
        }

        // Create a set of existing ICS event keys for deduplication
        const existingIcsKeys = new Set(
            merged[dateKey]
                .filter(e => e.source === 'ics')
                .map(e => `${e.time || 'allday'}:${e.title}:${e.ics_calendar || e.calendarName || ''}`)
        );

        // Mark ICS events and check done status, filtering out duplicates
        const markedEvents = events
            .map(e => ({
                ...e,
                readOnly: true,
                source: 'ics',
                icsDone: isIcsEventDone(e, dateKey)
            }))
            .filter(e => {
                const key = `${e.time || 'allday'}:${e.title}:${e.ics_calendar || e.calendarName || ''}`;
                if (existingIcsKeys.has(key)) {
                    return false; // Skip duplicate
                }
                existingIcsKeys.add(key);
                return true;
            });

        merged[dateKey] = merged[dateKey].concat(markedEvents);
    }

    return merged;
}

async function createEventDirect(eventData) {
    const response = await fetch(`${API_BASE}/api/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(eventData)
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(data.detail || `Failed to create event (${response.status})`);
    }
    return true;
}

async function createEvent(eventData) {
    // Check if online
    if (!isOnline()) {
        savePendingChange('createEvent', { eventData });
        showToast('Event queued (offline)', 'warning');
        return true; // Return true to update UI
    }

    try {
        await createEventDirect(eventData);
        showToast('Event created', 'success');
        return true;
    } catch (error) {
        console.error('Create event error:', error);

        // Queue for later if network error
        if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError') ||
            (error.name === 'TypeError' && error.message.includes('fetch'))) {
            savePendingChange('createEvent', { eventData });
            showToast('Event queued (network error)', 'warning');
            return true;
        }

        showToast(error.message || 'Failed to create event', 'error');
        return false;
    }
}

async function updateEventDirect(event, updates) {
    if (!event || !event.file || !event.line) {
        throw new Error('No file location available for this event');
    }
    const response = await fetch(`${API_BASE}/api/events/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: event.file, line: event.line, ...updates })
    });
    if (!response.ok) {
        const data = await response.json();
        throw new Error(data.detail || 'Failed to update event');
    }
    return true;
}

async function updateEvent(event, updates) {
    if (!event || !event.file || !event.line) {
        showToast('No file location available for this event', 'error');
        return false;
    }

    // Check if online
    if (!isOnline()) {
        savePendingChange('updateEvent', { event, updates });
        showToast('Update queued (offline)', 'warning');
        return true; // Return true to indicate change was saved locally
    }

    try {
        await updateEventDirect(event, updates);
        showToast('Event updated', 'success');
        return true;
    } catch (error) {
        // Queue for later if network error
        if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
            savePendingChange('updateEvent', { event, updates });
            showToast('Update queued (network error)', 'warning');
            return true;
        }
        showToast(error.message, 'error');
        return false;
    }
}

async function markEventDone(event) {
    if (!event || !event.file || !event.line) return false;
    try {
        const response = await fetch(`${API_BASE}/api/events/done`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // send title so the backend can verify the heading at `line` before
            // mutating (guards against a stale line marking the wrong task done)
            body: JSON.stringify({ file: event.file, line: event.line, title: event.title })
        });
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.detail || 'Failed to mark done');
        }
        showToast('Marked as done', 'success');
        return true;
    } catch (error) {
        showToast(error.message, 'error');
        return false;
    }
}

async function updateEventStateDirect(event, newState) {
    if (!event || !event.file || !event.line) {
        throw new Error('No file location available');
    }
    const response = await fetch(`${API_BASE}/api/events/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: event.file, line: event.line, state: newState })
    });
    if (!response.ok) {
        const data = await response.json();
        throw new Error(data.detail || 'Failed to update state');
    }
    return true;
}

async function updateEventState(event, newState) {
    if (!event || !event.file || !event.line) return false;

    // Check if online
    if (!isOnline()) {
        savePendingChange('updateState', { event, state: newState });
        return true; // Return true for optimistic UI updates
    }

    try {
        await updateEventStateDirect(event, newState);
        return true;
    } catch (error) {
        // Queue for later if network error
        if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
            savePendingChange('updateState', { event, state: newState });
            return true;
        }
        showToast(error.message, 'error');
        return false;
    }
}

async function rescheduleEventDirect(event, newDate, newTime = null) {
    if (!event || !event.file || !event.line) {
        throw new Error('No file location available');
    }
    const response = await fetch(`${API_BASE}/api/events/reschedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: event.file, line: event.line, new_date: newDate, new_time: newTime || event.time })
    });
    if (!response.ok) {
        const data = await response.json();
        throw new Error(data.detail || 'Failed to reschedule');
    }
    return true;
}

async function rescheduleEvent(event, newDate, newTime = null) {
    if (!event || !event.file || !event.line) return false;

    // Check if online
    if (!isOnline()) {
        savePendingChange('reschedule', { event, newDate, newTime });
        showToast('Reschedule queued (offline)', 'warning');
        return true;
    }

    try {
        await rescheduleEventDirect(event, newDate, newTime);
        showToast(`Rescheduled to ${newDate}`, 'success');
        return true;
    } catch (error) {
        // Queue for later if network error
        if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
            savePendingChange('reschedule', { event, newDate, newTime });
            showToast('Reschedule queued (network error)', 'warning');
            return true;
        }
        showToast(error.message, 'error');
        return false;
    }
}

async function deleteEventDirect(event) {
    if (!event || !event.file || !event.line) {
        throw new Error('No file location available');
    }
    const response = await fetch(`${API_BASE}/api/events/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: event.file, line: event.line })
    });
    if (!response.ok) {
        const data = await response.json();
        throw new Error(data.detail || 'Failed to delete');
    }
    return true;
}

async function deleteEvent(event) {
    if (!event || !event.file || !event.line) return false;

    // Check if online
    if (!isOnline()) {
        savePendingChange('delete', { event });
        showToast('Delete queued (offline)', 'warning');
        return true;
    }

    try {
        await deleteEventDirect(event);
        showToast('Event archived', 'success');
        return true;
    } catch (error) {
        // Queue for later if network error
        if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
            savePendingChange('delete', { event });
            showToast('Delete queued (network error)', 'warning');
            return true;
        }
        showToast(error.message, 'error');
        return false;
    }
}

async function openInEmacs(event) {
    if (!event.file || !event.line) {
        showToast('No file location available', 'error');
        return false;
    }
    try {
        const response = await fetch(`${API_BASE}/api/open`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file: event.file, line: event.line })
        });
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.detail || 'Failed to open in Emacs');
        }
        showToast('Opened in Emacs', 'success');
        return true;
    } catch (error) {
        showToast(error.message, 'error');
        return false;
    }
}

// Toggle a checkbox in event notes
async function toggleCheckbox(event, checkboxIndex, checked) {
    if (!event || !event.file || !event.line) {
        showToast('Cannot update: no file location', 'error');
        return false;
    }
    try {
        const response = await fetch(`${API_BASE}/api/events/toggle-checkbox`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                file: event.file, 
                line: event.line, 
                checkbox_index: checkboxIndex,
                checked: checked
            })
        });
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.detail || 'Failed to toggle checkbox');
        }
        return true;
    } catch (error) {
        showToast(error.message, 'error');
        return false;
    }
}

// Parse notes and render with interactive checkboxes
function renderNotesWithCheckboxes(notes, event, isReadOnly = false) {
    if (!notes) return '';
    
    // Decode encoded newlines and pipes from backend
    // Also handle <br> tags from ICS/external calendars
    let content = notes
        .replace(/<NL>/g, '\n')
        .replace(/<PIPE>/g, '|')
        .replace(/<br\s*\/?>/gi, '\n');
    
    // Split into lines
    const lines = content.split('\n');
    let html = '';
    let checkboxIndex = 0;
    
    for (const line of lines) {
        // Match org-mode checkbox patterns: - [ ] or - [X] or - [x]
        const checkboxMatch = line.match(/^(\s*)-\s*\[([ Xx])\]\s*(.*)$/);
        
        if (checkboxMatch) {
            const indent = checkboxMatch[1] || '';
            const isChecked = checkboxMatch[2].toLowerCase() === 'x';
            const text = checkboxMatch[3];
            const idx = checkboxIndex++;
            
            // Calculate indent level (2 spaces = 1 level typically in org-mode)
            const indentLevel = Math.floor(indent.length / 2);
            
            const checkedClass = isChecked ? 'checked' : '';
            const checkedAttr = isChecked ? 'checked' : '';
            const disabledAttr = isReadOnly ? 'disabled' : '';
            
            html += `<div class="notes-checkbox-item ${checkedClass}" data-index="${idx}" data-indent="${indentLevel}" style="margin-left: ${indentLevel * 20}px;">
                <input type="checkbox" ${checkedAttr} ${disabledAttr} id="cb-${idx}">
                <label for="cb-${idx}">${escapeHtml(text)}</label>
            </div>`;
        } else if (line.trim()) {
            // Regular text line - also preserve indentation
            const textIndent = line.match(/^(\s*)/)[1] || '';
            const indentLevel = Math.floor(textIndent.length / 2);
            const textContent = line.trim();
            html += `<p style="margin-left: ${indentLevel * 20}px;">${escapeHtml(textContent)}</p>`;
        }
    }
    
    return html;
}

// Helper to escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ==================== Render Functions ====================

function getWeekNumber(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function renderMiniCalendar() {
    const miniMonth = document.getElementById('miniMonth');
    const miniBody = document.getElementById('miniCalendarBody');
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    
    // Use miniCalendarMonth state, or default to today's month
    if (!state.miniCalendarMonth) {
        state.miniCalendarMonth = new Date();
    }
    const currentMonth = state.miniCalendarMonth;
    
    miniMonth.textContent = `${months[currentMonth.getMonth()]} ${currentMonth.getFullYear()}`;
    
    const firstDay = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1);
    const lastDay = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 0);
    const startDay = (firstDay.getDay() + 6) % 7; // Monday = 0
    
    const today = new Date();
    const todayStr = formatDate(today);
    
    // Get current view week range
    const viewWeekStart = state.weekStart;
    const viewWeekEnd = new Date(viewWeekStart);
    viewWeekEnd.setDate(viewWeekEnd.getDate() + 6);
    
    // Build all days including prev/next month padding
    const allDays = [];
    
    // Previous month days
    const prevMonthLast = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 0);
    for (let i = startDay - 1; i >= 0; i--) {
        const date = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, prevMonthLast.getDate() - i);
        allDays.push({ date, otherMonth: true });
    }
    
    // Current month days
    for (let d = 1; d <= lastDay.getDate(); d++) {
        const date = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), d);
        allDays.push({ date, otherMonth: false });
    }
    
    // Next month days to fill remaining cells
    const remaining = 42 - allDays.length;
    for (let d = 1; d <= remaining; d++) {
        const date = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, d);
        allDays.push({ date, otherMonth: true });
    }
    
    // Group into weeks
    miniBody.innerHTML = '';
    for (let w = 0; w < 6; w++) {
        const weekDays = allDays.slice(w * 7, (w + 1) * 7);
        if (weekDays.length === 0) continue;
        
        // Check if this week contains today or is the current view week
        const weekStart = weekDays[0].date;
        const weekEnd = weekDays[6].date;
        const isCurrentWeek = (today >= weekStart && today <= weekEnd) || 
                             (viewWeekStart >= weekStart && viewWeekStart <= weekEnd);
        
        const weekRow = document.createElement('div');
        weekRow.className = 'mini-week-row' + (isCurrentWeek ? ' current-week' : '');
        
        // Week number
        const weekNum = document.createElement('div');
        weekNum.className = 'mini-week-num';
        weekNum.textContent = getWeekNumber(weekDays[0].date);
        weekRow.appendChild(weekNum);
        
        // Days
        weekDays.forEach(({ date, otherMonth }) => {
            const day = document.createElement('div');
            day.className = 'mini-day';
            day.textContent = date.getDate();
            
            const dateKey = formatDate(date);
            const dayEvents = state.events[dateKey] || [];
            
            if (otherMonth) day.classList.add('other-month');
            if (dateKey === todayStr) day.classList.add('today');
            if (dayEvents.length > 0) day.classList.add('has-events');
            if (formatDate(state.selectedDate) === dateKey) day.classList.add('selected');
            
            // Check for overdue events (past date with incomplete tasks)
            const isPastDay = date < new Date(today.getFullYear(), today.getMonth(), today.getDate());
            if (isPastDay && dayEvents.length > 0) {
                const completedStates = ['DONE', 'CANCELLED', 'CANCELED'];
                const inactiveStates = ['HOLD', 'WAITING', 'SOMEDAY'];
                const hasOverdue = dayEvents.some(e => {
                    const isDone = completedStates.includes(e.state) || e.icsDone;
                    const isInactive = inactiveStates.includes(e.state);
                    return !isDone && !isInactive && (e.source !== 'ics' || !e.icsDone);
                });
                if (hasOverdue) day.classList.add('has-overdue');
            }
            
            day.addEventListener('click', () => {
                state.selectedDate = new Date(date);
                state.miniCalendarMonth = new Date(date.getFullYear(), date.getMonth(), 1);
                if (state.viewMode === 'day') {
                    renderDayView();
                } else {
                    state.weekStart = getWeekStart(date);
                    syncMiniCalendarToView();
                    loadEvents(false, false);  // No spinner for mini-calendar clicks
                }
            });
            
            weekRow.appendChild(day);
        });
        
        miniBody.appendChild(weekRow);
    }
}

function renderCategories() {
    const categoryList = document.getElementById('categoryList');
    const catCounts = {};
    
    // Count events per category (only those passing settings filters)
    // Include uncategorized events
    Object.values(state.events).forEach(dayEvents => {
        dayEvents.forEach(e => {
            if (!passesSettingsFilters(e)) return;
            const category = e.category || UNCATEGORIZED;
            catCounts[category] = (catCounts[category] || 0) + 1;
        });
    });
    
    // Sort categories, but put Uncategorized at the end
    state.categories = Object.keys(catCounts).sort((a, b) => {
        if (a === UNCATEGORIZED) return 1;
        if (b === UNCATEGORIZED) return -1;
        return a.localeCompare(b);
    });
    
    categoryList.innerHTML = state.categories.map(cat => {
        const color = getColorForCategory(cat);
        const hidden = state.hiddenCategories.has(cat);
        const emoji = getEmojiForCategory(cat);
        const count = catCounts[cat] || 0;
        return `
            <div class="category-item ${hidden ? 'hidden' : ''}" data-category="${cat}">
                <div class="category-checkbox ${hidden ? '' : 'checked'}" style="background: ${hidden ? 'transparent' : color}"></div>
                <span class="category-emoji">${emoji}</span>
                <span class="category-name">${cat}</span>
                <span class="category-count">${count}</span>
            </div>
        `;
    }).join('');
    
    categoryList.querySelectorAll('.category-item').forEach(item => {
        // Single click: toggle visibility
        item.addEventListener('click', (e) => {
            if (e.detail > 1) return;  // Ignore double-clicks
            const cat = item.dataset.category;
            state.hiddenCategories.has(cat) ? state.hiddenCategories.delete(cat) : state.hiddenCategories.add(cat);
            saveFilterState();
            renderView();
        });
        
        // Double click: show only this category (or show all if already solo)
        item.addEventListener('dblclick', () => {
            const cat = item.dataset.category;
            
            // Check if this is already the only visible category
            const visibleCatCount = state.categories.filter(c => !state.hiddenCategories.has(c)).length;
            const isOnlyVisible = visibleCatCount === 1 && !state.hiddenCategories.has(cat);
            
            if (isOnlyVisible) {
                // Show all categories
                state.hiddenCategories.clear();
            } else {
                // Hide all categories except this one
                state.hiddenCategories = new Set(state.categories.filter(c => c !== cat));
            }
            // Don't touch PARA filters - they work independently
            saveFilterState();
            renderView();
        });
    });
}

// Render PARA sections (Inbox, Projects, Subprojects, Areas, Resources, Archives, Uncategorized)
// Each section shows Level 1 headings (parent) that have events
function renderParaFilters() {
    // Group events by PARA type and parent (Level 1 heading)
    // Only count events that pass settings filters
    const paraData = {
        Inbox: {},
        Projects: {},
        Subprojects: {},
        Areas: {},
        Resources: {},
        Archives: {}
    };

    // Special states that indicate a project heading (not inherited)
    const projectStates = ['PROJ', 'PROJECT', 'DISCUSSION', 'PROPOSAL'];

    // Helper to get tags from event (returns lowercase array)
    const getEventTags = (e) => {
        if (!e.tags) return [];
        return e.tags.toLowerCase().split(':').filter(t => t);
    };

    // Check if event has a specific tag (case-insensitive)
    const hasTag = (e, tagName) => {
        const tags = getEventTags(e);
        return tags.includes(tagName.toLowerCase());
    };

    // Check if an event is a project heading itself (from Projects folder)
    const isProjectHeading = (e) => {
        // Check state
        if (e.state && projectStates.includes(e.state.toUpperCase())) {
            return true;
        }
        // Check for proj tag
        return hasTag(e, 'proj');
    };

    // Check if event is a subproject (has :Project: tag)
    const isSubproject = (e) => hasTag(e, 'project');

    // Check if event is an area heading (has :Area: tag - direct, not inherited)
    const isAreaHeading = (e) => hasTag(e, 'area');

    // First pass: collect all project heading titles
    const projectHeadingTitles = new Set();
    Object.values(state.events).forEach(dayEvents => {
        dayEvents.forEach(e => {
            if (!passesSettingsFilters(e)) return;
            if (isProjectHeading(e) && e.title) {
                projectHeadingTitles.add(e.title);
            }
        });
    });

    // Count events per parent within each PARA type
    Object.values(state.events).forEach(dayEvents => {
        dayEvents.forEach(e => {
            // Skip events that don't pass settings filters
            if (!passesSettingsFilters(e)) return;

            const para = e.para || 'Other';

            // Handle Inbox events - group by parent or filename
            if (para === 'Inbox') {
                const key = e.parent || e.file?.split('/').pop()?.replace('.org', '') || 'Inbox Items';
                paraData.Inbox[key] = (paraData.Inbox[key] || 0) + 1;
                return;
            }

            // Check for Subprojects first (events with :Project: tag anywhere)
            if (isSubproject(e)) {
                const name = e.title || e.parent;
                if (name) {
                    paraData.Subprojects[name] = (paraData.Subprojects[name] || 0) + 1;
                }
                return;
            }

            // Check for Areas: an area is a level-1 heading tagged :Area:
            // Events may inherit the :Area: tag from their level-1 parent,
            // so group them by the level-1 ancestor heading name.
            if (isAreaHeading(e) || para === 'Areas') {
                let areaName;
                if (!e.parent) {
                    // This event IS a level-1 heading (no ancestors)
                    areaName = e.title;
                } else {
                    // Get the level-1 ancestor (first component of outline path)
                    areaName = e.parent.split('/')[0];
                }
                if (areaName) {
                    paraData.Areas[areaName] = (paraData.Areas[areaName] || 0) + 1;
                }
                return;
            }

            // Skip events not in PARA folders (for Projects, Resources, Archives)
            if (para === 'Other') return;

            // Use parent heading name
            let projectName = e.parent;

            // If this event IS a project heading, use its own title
            if (isProjectHeading(e)) {
                projectName = e.title;
            }
            // If parent is not a known project heading and we have project headings,
            // try to find a matching project heading for this event
            else if (projectHeadingTitles.size > 0 && !projectHeadingTitles.has(e.parent)) {
                // Skip - this event's parent is not a project heading
                // (it's probably a subtask under a non-project heading)
                return;
            }

            if (!projectName) return;

            // Normal PARA items (Projects, Resources, Archives)
            if (!paraData[para]) return;
            paraData[para][projectName] = (paraData[para][projectName] || 0) + 1;
        });
    });
    
    // Collect all PARA item keys for "show only" feature
    const allParaKeys = [];
    Object.entries(paraData).forEach(([paraType, parents]) => {
        Object.keys(parents).forEach(parent => {
            allParaKeys.push(`${paraType}:${parent}`);
        });
    });
    
    // Render each PARA section
    Object.entries(paraConfig).forEach(([paraType, config]) => {
        const listEl = document.getElementById(config.listId);
        const sectionEl = document.getElementById(config.sectionId);
        const parents = paraData[paraType] || {};
        const sortedParents = Object.entries(parents).sort((a, b) => a[0].localeCompare(b[0]));
        
        // Hide section if no events
        if (sortedParents.length === 0) {
            sectionEl.classList.add('empty');
            listEl.innerHTML = '';
            return;
        }
        sectionEl.classList.remove('empty');
        
        listEl.innerHTML = sortedParents.map(([parent, count]) => {
            const itemKey = `${paraType}:${parent}`;
            const hidden = state.hiddenParaItems.has(itemKey);
            const isActiveTimeline = state.timelineMode?.paraType === paraType && state.timelineMode?.parent === parent;
            return `
                <div class="para-item ${hidden ? 'hidden' : ''} ${isActiveTimeline ? 'timeline-active' : ''}" data-para="${paraType}" data-parent="${parent}" title="${parent}">
                    <div class="para-checkbox ${hidden ? '' : 'checked'}" style="background: ${hidden ? 'transparent' : config.color}"></div>
                    <span class="para-name">${parent}</span>
                    <span class="para-count">${count}</span>
                    <button class="para-timeline-btn" title="View full timeline" aria-label="View timeline for ${parent}">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg>
                    </button>
                </div>
            `;
        }).join('');
        
        // Add click handlers
        listEl.querySelectorAll('.para-item').forEach(item => {
            // Timeline button click
            item.querySelector('.para-timeline-btn')?.addEventListener('click', (e) => {
                e.stopPropagation();  // Don't trigger item click
                const paraType = item.dataset.para;
                const parent = item.dataset.parent;
                openProjectTimeline(paraType, parent);
            });
            
            // Single click: toggle visibility (or exit timeline if in timeline mode)
            item.addEventListener('click', (e) => {
                // Ignore if it was a double-click or timeline button
                if (e.detail > 1) return;
                if (e.target.closest('.para-timeline-btn')) return;
                
                // If in timeline mode, clicking any PARA item exits timeline
                if (state.timelineMode) {
                    closeProjectTimeline();
                    return;
                }
                
                const paraType = item.dataset.para;
                const parent = item.dataset.parent;
                const itemKey = `${paraType}:${parent}`;
                state.hiddenParaItems.has(itemKey) 
                    ? state.hiddenParaItems.delete(itemKey) 
                    : state.hiddenParaItems.add(itemKey);
                saveFilterState();
                renderView();
            });
            
            // Double click: show only this PARA item (or show all if already solo)
            item.addEventListener('dblclick', () => {
                const paraType = item.dataset.para;
                const parent = item.dataset.parent;
                const itemKey = `${paraType}:${parent}`;
                
                // Check if this is already the only visible PARA item
                const visibleParaCount = allParaKeys.filter(k => !state.hiddenParaItems.has(k)).length;
                const isOnlyVisible = visibleParaCount === 1 && !state.hiddenParaItems.has(itemKey);
                
                if (isOnlyVisible) {
                    // Show all PARA items
                    state.hiddenParaItems.clear();
                } else {
                    // Hide all PARA items except this one
                    state.hiddenParaItems = new Set(allParaKeys.filter(k => k !== itemKey));
                }
                // Don't touch category filters - they work independently
                saveFilterState();
                renderView();
            });
        });
    });
}

// Open project timeline view showing all events for a specific PARA item
async function openProjectTimeline(paraType, parent) {
    // Build set of project heading titles for matching
    const projectHeadingTitles = new Set();
    Object.values(state.events || {}).forEach(dayEvents => {
        dayEvents.forEach(e => {
            if (isProjectHeadingEvent(e) && e.title) {
                projectHeadingTitles.add(e.title);
            }
        });
    });

    // Helper to find events for this project in current state
    function findProjectEvents() {
        let minDate = null;
        let maxDate = null;
        let eventCount = 0;

        Object.entries(state.events || {}).forEach(([dateKey, dayEvents]) => {
            dayEvents.forEach(e => {
                // For Areas, match by tag or PARA folder (same logic as renderParaFilters)
                if (paraType === 'Areas') {
                    const tags = e.tags ? e.tags.toLowerCase().split(':').filter(t => t) : [];
                    const isArea = tags.includes('area') || e.para === 'Areas';
                    if (!isArea) return;
                    const areaName = !e.parent ? e.title : e.parent.split('/')[0];
                    if (areaName !== parent) return;
                } else {
                    if (e.para !== paraType) return;
                    // Match by project name (using same logic as renderParaFilters)
                    const projectName = getProjectNameForEvent(e, projectHeadingTitles);
                    if (projectName !== parent) return;
                }
                eventCount++;
                const date = new Date(dateKey);
                if (!minDate || date < minDate) minDate = date;
                if (!maxDate || date > maxDate) maxDate = date;
            });
        });

        return { minDate, maxDate, eventCount };
    }
    
    // First check cached events
    let { minDate, maxDate, eventCount } = findProjectEvents();
    
    if (eventCount === 0) {
        showToast('No events found for this project', 'info');
        return;
    }
    
    // Store previous state to restore later
    state.previousViewMode = state.viewMode;
    
    // Set timeline mode with cached data
    state.timelineMode = {
        paraType,
        parent,
        startDate: minDate,
        endDate: maxDate,
        eventCount
    };
    
    // Switch to agenda view and render with cached data
    state.viewMode = 'agenda';
    state.selectedDate = new Date(minDate);
    renderView(true);  // Scroll to today divider in timeline
    renderParaFilters();
    
    showToast(`Showing ${eventCount} events from ${parent}`, 'success');
    
    // Fetch wider date range in background to find more events
    const today = new Date();
    const fetchStart = new Date(today);
    fetchStart.setFullYear(fetchStart.getFullYear() - 5);
    const fetchEnd = new Date(today);
    fetchEnd.setFullYear(fetchEnd.getFullYear() + 2);
    
    try {
        const events = await fetchEvents(formatDate(fetchStart), formatDate(fetchEnd), false);
        
        // Merge fetched events with state
        if (events && Object.keys(events).length > 0) {
            state.events = { ...state.events, ...events };
            
            // Re-check for project events
            const updated = findProjectEvents();
            
            // If we found more events, update the view
            if (updated.eventCount > eventCount) {
                state.timelineMode = {
                    paraType,
                    parent,
                    startDate: updated.minDate,
                    endDate: updated.maxDate,
                    eventCount: updated.eventCount
                };
                state.selectedDate = new Date(updated.minDate);
                renderView();
                showToast(`Found ${updated.eventCount - eventCount} more events`, 'info');
            }
        }
    } catch (error) {
        console.error('Failed to fetch extended timeline:', error);
        // Already showing cached data, so just log the error
    }
}

// Exit timeline mode and return to previous view
function closeProjectTimeline() {
    if (!state.timelineMode) return;
    
    state.timelineMode = null;
    state.viewMode = state.previousViewMode || 'week';
    state.previousViewMode = null;
    state.selectedDate = new Date();
    
    renderView(true);  // Scroll to today when exiting timeline
    loadEvents(false, false);
}

// Load more events for timeline (fetch older events)
async function loadMoreTimelineEvents() {
    if (!state.timelineMode) return;
    
    const { paraType, parent, startDate } = state.timelineMode;
    
    // Fetch 2 more years before current start
    const fetchEnd = new Date(startDate);
    fetchEnd.setDate(fetchEnd.getDate() - 1);  // Day before current start
    const fetchStart = new Date(fetchEnd);
    fetchStart.setFullYear(fetchStart.getFullYear() - 2);
    
    showToast('Loading older events...', 'info');
    
    try {
        const events = await fetchEvents(formatDate(fetchStart), formatDate(fetchEnd), false);
        
        if (events && Object.keys(events).length > 0) {
            // Merge fetched events
            state.events = { ...state.events, ...events };
            
            // Recount project events
            let minDate = null;
            let maxDate = null;
            let eventCount = 0;
            
            Object.entries(state.events || {}).forEach(([dateKey, dayEvents]) => {
                dayEvents.forEach(e => {
                    if (e.para === paraType && e.parent === parent) {
                        eventCount++;
                        const date = new Date(dateKey);
                        if (!minDate || date < minDate) minDate = date;
                        if (!maxDate || date > maxDate) maxDate = date;
                    }
                });
            });
            
            const oldCount = state.timelineMode.eventCount;
            
            // Update timeline mode
            state.timelineMode = {
                paraType,
                parent,
                startDate: minDate,
                endDate: maxDate,
                eventCount
            };
            
            state.selectedDate = new Date(minDate);
            renderView();
            
            if (eventCount > oldCount) {
                showToast(`Found ${eventCount - oldCount} older events`, 'success');
            } else {
                showToast('No older events found', 'info');
            }
        } else {
            showToast('No older events found', 'info');
        }
    } catch (error) {
        console.error('Failed to load more events:', error);
        showToast('Failed to load older events', 'error');
    }
}

// Initialize pull-to-refresh for timeline view (mobile)
function initPullToRefresh() {
    const container = document.querySelector('.time-grid-container');
    if (!container) return;
    
    let startY = 0;
    let pulling = false;
    
    container.addEventListener('touchstart', (e) => {
        if (container.scrollTop === 0 && state.timelineMode) {
            startY = e.touches[0].clientY;
            pulling = true;
        }
    }, { passive: true });
    
    container.addEventListener('touchmove', (e) => {
        if (!pulling || !state.timelineMode) return;
        
        const currentY = e.touches[0].clientY;
        const diff = currentY - startY;
        
        if (diff > 0 && container.scrollTop === 0) {
            const indicator = document.querySelector('.pull-to-refresh-indicator');
            if (indicator) {
                const progress = Math.min(diff / 100, 1);
                indicator.style.opacity = progress;
                indicator.style.transform = `translateY(${Math.min(diff * 0.5, 50)}px)`;
                if (diff > 80) {
                    indicator.classList.add('ready');
                } else {
                    indicator.classList.remove('ready');
                }
            }
        }
    }, { passive: true });
    
    container.addEventListener('touchend', () => {
        if (!pulling || !state.timelineMode) return;
        pulling = false;
        
        const indicator = document.querySelector('.pull-to-refresh-indicator');
        if (indicator) {
            if (indicator.classList.contains('ready')) {
                loadMoreTimelineEvents();
            }
            indicator.style.opacity = '0';
            indicator.style.transform = 'translateY(0)';
            indicator.classList.remove('ready');
        }
    });
}

// Get emoji for category based on keywords
function getEmojiForCategory(category) {
    const emojiMap = {
        'work': '💼', 'job': '💼', 'office': '🏢', 'meeting': '🤝', 'project': '📊',
        'teach': '👨‍🏫', 'professor': '👨‍🏫', 'lecture': '📚', 'class': '🎓',
        'learn': '📖', 'study': '📚', 'course': '🎓', 'student': '🎒',
        'blog': '✍️', 'write': '✍️', 'author': '📝', 'book': '📖',
        'podcast': '🎙️', 'video': '🎬', 'content': '📱',
        'friend': '👥', 'family': '👨‍👩‍👧‍👦', 'person': '👤', 'social': '🤝',
        'health': '🏥', 'fitness': '💪', 'exercise': '🏃', 'gym': '🏋️',
        'finance': '💰', 'money': '💵', 'budget': '📊', 'invest': '📈',
        'home': '🏠', 'house': '🏡', 'personal': '👤',
        'code': '💻', 'dev': '👨‍💻', 'tech': '🔧', 'software': '💾',
        'org': '📋', 'plan': '📅', 'organize': '🗂️', 'schedule': '📆',
        'task': '✅', 'todo': '📝', 'inbox': '📥',
        'coach': '🎯', 'mentor': '🧭', 'consult': '💡',
        'travel': '✈️', 'trip': '🧳', 'vacation': '🏖️',
        'event': '🎉', 'party': '🎊',
        'email': '📧', 'call': '📞', 'phone': '📱',
        'research': '🔬', 'music': '🎵', 'hobby': '🎮', 'game': '🎯',
        'read': '📖', 'review': '📋', 'note': '📝',
        'entrepreneur': '🚀', 'startup': '🌱', 'founder': '👨‍💼',
        'blogger': '✍️', 'podcaster': '🎙️', 'learner': '📚',
        'organizer': '📋', 'others': '📌'
    };
    
    const lower = category.toLowerCase();
    for (const [keyword, emoji] of Object.entries(emojiMap)) {
        if (lower.includes(keyword)) {
            return emoji;
        }
    }
    return '📌';  // Default
}

// ==================== Selection Mode ====================

function toggleSelection(dateKey, idx) {
    const key = `${dateKey}:${idx}`;
    if (state.selectedEvents.has(key)) {
        state.selectedEvents.delete(key);
        // If last event deselected, exit selection mode
        if (state.selectedEvents.size === 0) {
            exitSelectionMode();
            return;
        }
    } else {
        state.selectedEvents.add(key);
    }
    updateSelectionUI();
}

function enterSelectionMode(initialDateKey, initialIdx) {
    state.selectionMode = true;
    state.selectedEvents.clear();
    document.body.classList.add('selection-mode');
    
    // Add initial event
    toggleSelection(initialDateKey, initialIdx);
}

function exitSelectionMode() {
    state.selectionMode = false;
    state.selectedEvents.clear();
    document.body.classList.remove('selection-mode');
    
    const bar = document.getElementById('selectionBar');
    if (bar) bar.classList.remove('visible');
    
    // Re-render to clear visual selection state
    renderView();
}

function updateSelectionUI() {
    // Update visual state of events
    document.querySelectorAll('.event, .agenda-event, .all-day-event').forEach(el => {
        const dateKey = el.dataset.date;
        const idx = el.dataset.eventIdx || el.dataset.idx;
        const key = `${dateKey}:${idx}`;
        
        if (state.selectedEvents.has(key)) {
            el.classList.add('selected');
        } else {
            el.classList.remove('selected');
        }
    });
    
    // Update or create selection bar
    let bar = document.getElementById('selectionBar');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'selectionBar';
        bar.className = 'selection-bar';
        bar.innerHTML = `
            <div class="selection-count">0 selected</div>
            <div class="selection-actions">
                <button class="selection-btn secondary" id="selectionCancel">Cancel</button>
                <button class="selection-btn primary" id="selectionDone">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                    Mark Done
                </button>
            </div>
        `;
        document.body.appendChild(bar);
        
        document.getElementById('selectionCancel').addEventListener('click', exitSelectionMode);
        document.getElementById('selectionDone').addEventListener('click', bulkMarkDone);
    }
    
    bar.querySelector('.selection-count').textContent = `${state.selectedEvents.size} selected`;
    bar.classList.add('visible');
}

async function bulkMarkDone() {
    const count = state.selectedEvents.size;
    if (count === 0) return;

    showLoading(true);
    let successCount = 0;
    
    const updates = Array.from(state.selectedEvents).map(async key => {
        const [dateKey, idxStr] = key.split(':');
        const idx = parseInt(idxStr);
        const event = state.events[dateKey]?.[idx];
        
        if (!event) return;
        
        // Skip already done events
        if (event.state === 'DONE' || event.icsDone) return;
        
        if (event.source === 'ics') {
            // Handle ICS event
            if (toggleIcsEventDone(event, dateKey)) successCount++;
        } else {
            // Handle Org event
            if (await markEventDone(event)) successCount++;
        }
    });
    
    await Promise.all(updates);
    
    showLoading(false);
    showToast(`Marked ${successCount} events as done`, 'success');
    exitSelectionMode();
    
    // Refresh to show updates
    loadEvents(false, false);
}

function renderWeekHeader() {
    const header = document.getElementById('weekHeader');
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const today = new Date();
    
    // Day headers row
    let html = '<div class="week-header-row">';
    html += '<div class="week-header-spacer"></div>';
    for (let i = 0; i < 7; i++) {
        const date = new Date(state.weekStart);
        date.setDate(date.getDate() + i);
        const isToday = date.toDateString() === today.toDateString();
        html += `
            <div class="week-day-header ${isToday ? 'today' : ''}" data-date="${formatDate(date)}">
                <div class="week-day-name">${days[i]}</div>
                <div class="week-day-date">${date.getDate()}</div>
            </div>
        `;
    }
    html += '</div>';
    
    // All-day events row
    html += '<div class="all-day-row">';
    html += '<div class="all-day-label">All day</div>';
    for (let i = 0; i < 7; i++) {
        const date = new Date(state.weekStart);
        date.setDate(date.getDate() + i);
        const dateKey = formatDate(date);
        const allDayEvents = getEventsForDate(dateKey).filter(e => !e.time);
        
        html += `<div class="all-day-cell" data-date="${dateKey}">`;
        allDayEvents.forEach(event => {
            const color = event.color || getColorForCategory(event.category);
            const idx = (state.events[dateKey] || []).indexOf(event);
            const icsClass = event.source === 'ics' ? 'ics-event' : '';
            const icsDoneClass = event.icsDone ? 'ics-done' : '';
            const bgColor = getEventBackground(color);
            const textColor = getEventTextColor(color);
            const textStyle = textColor ? `color: ${textColor};` : '';
            html += `
                <div class="all-day-event ${event.state === 'DONE' ? 'done' : ''} ${icsClass} ${icsDoneClass}" 
                     style="background: ${bgColor}; border-left-color: ${color}; ${textStyle}"
                     data-date="${dateKey}" data-event-idx="${idx}">
                    ${event.title}
                </div>
            `;
        });
        html += '</div>';
    }
    html += '</div>';
    
    header.innerHTML = html;
    
    // Click on day header to go to day view
    header.querySelectorAll('.week-day-header').forEach(el => {
        el.addEventListener('click', () => {
            state.selectedDate = new Date(el.dataset.date + 'T00:00:00');
            state.viewMode = 'day';
            renderView();
        });
    });
    
    // Click handlers for all-day events
    header.querySelectorAll('.all-day-event').forEach(el => {
        const dateKey = el.dataset.date;
        const idx = parseInt(el.dataset.eventIdx);

        // Long press detection with movement tolerance
        let pressTimer;
        let touchStartX, touchStartY;
        const MOVE_TOLERANCE = 15;

        el.addEventListener('touchstart', (e) => {
            const touch = e.touches[0];
            touchStartX = touch.clientX;
            touchStartY = touch.clientY;
            pressTimer = setTimeout(() => {
                enterSelectionMode(dateKey, idx);
                if (navigator.vibrate) navigator.vibrate(50);
            }, 500);
        }, { passive: true });

        el.addEventListener('touchend', () => clearTimeout(pressTimer));
        el.addEventListener('touchmove', (e) => {
            const touch = e.touches[0];
            const dx = Math.abs(touch.clientX - touchStartX);
            const dy = Math.abs(touch.clientY - touchStartY);
            if (dx > MOVE_TOLERANCE || dy > MOVE_TOLERANCE) {
                clearTimeout(pressTimer);
            }
        }, { passive: true });

        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            enterSelectionMode(dateKey, idx);
        });

        el.addEventListener('click', (e) => {
            e.stopPropagation();

            if (state.selectionMode) {
                toggleSelection(dateKey, idx);
                return;
            }

            const event = state.events[dateKey][idx];
            showEventPopup(event, dateKey, e.clientX, e.clientY);
        });

        if (state.selectedEvents.has(`${dateKey}:${idx}`)) {
            el.classList.add('selected');
        }
    });

    const endDate = new Date(state.weekStart);
    endDate.setDate(endDate.getDate() + 6);
    document.getElementById('dateTitle').textContent = formatDateTitle(state.weekStart, endDate);
}

function render3DayHeader() {
    const header = document.getElementById('weekHeader');
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const today = new Date();
    const startDate = state.selectedDate || new Date();
    
    // Day headers row
    let html = '<div class="week-header-row three-day-view">';
    html += '<div class="week-header-spacer"></div>';
    for (let i = 0; i < 3; i++) {
        const date = new Date(startDate);
        date.setDate(date.getDate() + i);
        const isToday = date.toDateString() === today.toDateString();
        html += `
            <div class="week-day-header ${isToday ? 'today' : ''}" data-date="${formatDate(date)}">
                <div class="week-day-name">${days[date.getDay()]}</div>
                <div class="week-day-date">${date.getDate()}</div>
            </div>
        `;
    }
    html += '</div>';
    
    // All-day events row
    html += '<div class="all-day-row three-day-view">';
    html += '<div class="all-day-label">All day</div>';
    for (let i = 0; i < 3; i++) {
        const date = new Date(startDate);
        date.setDate(date.getDate() + i);
        const dateKey = formatDate(date);
        const allDayEvents = getEventsForDate(dateKey).filter(e => !e.time);
        
        html += `<div class="all-day-cell" data-date="${dateKey}">`;
        allDayEvents.forEach(event => {
            const color = event.color || getColorForCategory(event.category);
            const idx = (state.events[dateKey] || []).indexOf(event);
            const icsClass = event.source === 'ics' ? 'ics-event' : '';
            const icsDoneClass = event.icsDone ? 'ics-done' : '';
            const bgColor = getEventBackground(color);
            const textColor = getEventTextColor(color);
            const textStyle = textColor ? `color: ${textColor};` : '';
            html += `
                <div class="all-day-event ${event.state === 'DONE' ? 'done' : ''} ${icsClass} ${icsDoneClass}" 
                     style="background: ${bgColor}; border-left-color: ${color}; ${textStyle}"
                     data-date="${dateKey}" data-event-idx="${idx}">
                    ${event.title}
                </div>
            `;
        });
        html += '</div>';
    }
    html += '</div>';
    
    header.innerHTML = html;
    
    // Click on day header to go to day view
    header.querySelectorAll('.week-day-header').forEach(el => {
        el.addEventListener('click', () => {
            state.selectedDate = new Date(el.dataset.date + 'T00:00:00');
            state.viewMode = 'day';
            renderView();
        });
    });
    
    // Click handlers for all-day events
    header.querySelectorAll('.all-day-event').forEach(el => {
        const dateKey = el.dataset.date;
        const idx = parseInt(el.dataset.eventIdx);

        // Long press detection with movement tolerance
        let pressTimer;
        let touchStartX, touchStartY;
        const MOVE_TOLERANCE = 15;

        el.addEventListener('touchstart', (e) => {
            const touch = e.touches[0];
            touchStartX = touch.clientX;
            touchStartY = touch.clientY;
            pressTimer = setTimeout(() => {
                enterSelectionMode(dateKey, idx);
                if (navigator.vibrate) navigator.vibrate(50);
            }, 500);
        }, { passive: true });

        el.addEventListener('touchend', () => clearTimeout(pressTimer));
        el.addEventListener('touchmove', (e) => {
            const touch = e.touches[0];
            const dx = Math.abs(touch.clientX - touchStartX);
            const dy = Math.abs(touch.clientY - touchStartY);
            if (dx > MOVE_TOLERANCE || dy > MOVE_TOLERANCE) {
                clearTimeout(pressTimer);
            }
        }, { passive: true });

        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            enterSelectionMode(dateKey, idx);
        });

        el.addEventListener('click', (e) => {
            e.stopPropagation();

            if (state.selectionMode) {
                toggleSelection(dateKey, idx);
                return;
            }

            const event = state.events[dateKey][idx];
            showEventPopup(event, dateKey, e.clientX, e.clientY);
        });

        if (state.selectedEvents.has(`${dateKey}:${idx}`)) {
            el.classList.add('selected');
        }
    });

    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 2);
    document.getElementById('dateTitle').textContent = formatDateTitle(startDate, endDate);
}

function renderTimeGrid(preserveScroll = true) {
    // Remove month-view class (for scrollable view)
    document.querySelector('.time-grid-container')?.classList.remove('month-view');
    document.getElementById('timeGrid')?.classList.remove('month-view');
    
    const grid = document.getElementById('timeGrid');
    const container = document.querySelector('.time-grid-container');
    const startHour = settings?.startHour ?? 6;
    const endHour = settings?.endHour ?? 22;
    const densityMapLocal = { 'compact': 40, 'comfortable': 60, 'spacious': 80 };
    const hourHeight = settings?.hourHeightPx || densityMapLocal[settings?.density] || 60;
    
    // Save scroll position before re-render
    const savedScrollTop = container?.scrollTop || 0;
    const hadScroll = savedScrollTop > 0;
    
    let timeCol = '<div class="time-column">';
    for (let h = startHour; h <= endHour; h++) {
        const label = h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`;
        timeCol += `<div class="time-label" style="top: ${(h - startHour) * hourHeight}px">${label}</div>`;
    }
    timeCol += '</div>';
    
    let dayCols = '<div class="day-columns">';
    const today = new Date();
    const numDays = state.viewMode === 'day' ? 1 : (state.viewMode === '3day' ? 3 : 7);
    const startDate = (state.viewMode === 'day' || state.viewMode === '3day') ? state.selectedDate : state.weekStart;
    
    for (let d = 0; d < numDays; d++) {
        const date = new Date(startDate);
        date.setDate(date.getDate() + d);
        const dateKey = formatDate(date);
        const isToday = date.toDateString() === today.toDateString();
        
        dayCols += `<div class="day-column" data-date="${dateKey}">`;
        
        for (let h = startHour; h <= endHour; h++) {
            dayCols += `<div class="hour-line" style="top: ${(h - startHour) * hourHeight}px"></div>`;
            if (h < endHour) {
                dayCols += `<div class="hour-line half" style="top: ${(h - startHour) * hourHeight + hourHeight / 2}px"></div>`;
            }
        }
        
        if (isToday) {
            const now = new Date();
            const currentMins = now.getHours() * 60 + now.getMinutes();
            const topPos = ((currentMins / 60) - startHour) * hourHeight;
            if (topPos >= 0 && topPos <= (endHour - startHour) * hourHeight) {
                dayCols += `<div class="current-time-line" style="top: ${topPos}px"></div>`;
            }
        }
        
        const dayEvents = getEventsForDate(dateKey)
            .filter(e => parseTime(e.time) !== null)
            .map((event, idx) => {
                const startMins = parseTime(event.time);
                const endMins = parseTime(event.endTime) || startMins + 60;
                return { ...event, idx, startMins, endMins, originalIdx: (state.events[dateKey] || []).indexOf(event) };
            })
            .sort((a, b) => a.startMins - b.startMins);
        
        const positioned = calculateOverlapPositions(dayEvents);
        
        positioned.forEach(({ event, column, totalColumns }) => {
            const startHourPos = Math.max(event.startMins / 60, startHour);
            const endHourPos = Math.min(event.endMins / 60, endHour);
            if (endHourPos <= startHour || startHourPos >= endHour) return;
            
            const top = (startHourPos - startHour) * hourHeight;
            const height = Math.max((endHourPos - startHourPos) * hourHeight, 20);
            const color = event.color || getColorForCategory(event.category);
            const bgColor = getEventBackground(color);
            const textColor = getEventTextColor(color);
            const width = totalColumns > 1 ? `calc(${100 / totalColumns}% - 4px)` : 'calc(100% - 4px)';
            const left = totalColumns > 1 ? `calc(${(column * 100) / totalColumns}% + 2px)` : '2px';
            
            const stateClass = event.state ? event.state.toLowerCase() : '';
            const icsClass = event.source === 'ics' ? 'ics-event' : '';
            const icsDoneClass = event.icsDone ? 'ics-done' : '';
            const isDraggable = event.source !== 'ics';
            const textStyle = textColor ? `color: ${textColor};` : '';
            dayCols += `
                <div class="event ${event.type || ''} ${stateClass} ${icsClass} ${icsDoneClass}" 
                     style="top: ${top}px; height: ${height}px; background: ${bgColor}; border-left-color: ${color}; ${textStyle} width: ${width}; left: ${left}; right: auto;"
                     data-event-idx="${event.originalIdx}"
                     data-date="${dateKey}"
                     draggable="${isDraggable}">
                    <div class="event-title">${event.title}</div>
                    ${height > 30 ? `<div class="event-time">${event.time}${event.endTime ? '-' + event.endTime : ''}</div>` : ''}
                </div>
            `;
        });
        
        dayCols += '</div>';
    }
    dayCols += '</div>';
    
    grid.innerHTML = timeCol + dayCols;
    grid.style.minHeight = `${(endHour - startHour + 1) * hourHeight}px`;

    // Event handlers
    grid.querySelectorAll('.event').forEach(el => {
        const dateKey = el.dataset.date;
        const idx = parseInt(el.dataset.eventIdx);

        // Long press detection with movement tolerance
        let pressTimer;
        let touchStartX, touchStartY;
        const MOVE_TOLERANCE = 15;

        el.addEventListener('touchstart', (e) => {
            const touch = e.touches[0];
            touchStartX = touch.clientX;
            touchStartY = touch.clientY;
            pressTimer = setTimeout(() => {
                enterSelectionMode(dateKey, idx);
                if (navigator.vibrate) navigator.vibrate(50);
            }, 500);
        }, { passive: true });

        el.addEventListener('touchend', () => clearTimeout(pressTimer));
        el.addEventListener('touchmove', (e) => {
            const touch = e.touches[0];
            const dx = Math.abs(touch.clientX - touchStartX);
            const dy = Math.abs(touch.clientY - touchStartY);
            if (dx > MOVE_TOLERANCE || dy > MOVE_TOLERANCE) {
                clearTimeout(pressTimer);
            }
        }, { passive: true });

        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            enterSelectionMode(dateKey, idx);
        });

        el.addEventListener('click', (e) => {
            e.stopPropagation();
            hideEventTooltip();

            if (state.selectionMode) {
                toggleSelection(dateKey, idx);
                return;
            }

            const event = state.events[dateKey][idx];
            showEventPopup(event, dateKey, e.clientX, e.clientY);
        });

        if (state.selectedEvents.has(`${dateKey}:${idx}`)) {
            el.classList.add('selected');
        }

        // Tooltip on hover
        el.addEventListener('mouseenter', (e) => {
            const dateKey = el.dataset.date;
            const idx = parseInt(el.dataset.eventIdx);
            const event = state.events[dateKey]?.[idx];
            if (event) {
                tooltipTimeout = setTimeout(() => {
                    showEventTooltip(event, dateKey, e.clientX, e.clientY);
                }, 400);
            }
        });
        
        el.addEventListener('mouseleave', () => {
            hideEventTooltip();
        });
        
        el.addEventListener('mousemove', (e) => {
            const tooltip = document.getElementById('eventTooltip');
            if (tooltip) {
                let left = e.clientX + 12;
                let top = e.clientY + 12;
                if (left + 280 > window.innerWidth) left = e.clientX - 292;
                if (top + 150 > window.innerHeight) top = e.clientY - 162;
                tooltip.style.left = `${Math.max(8, left)}px`;
                tooltip.style.top = `${Math.max(8, top)}px`;
            }
        });
        
        // Drag support with custom drag image
        el.addEventListener('dragstart', (e) => {
            const dateKey = el.dataset.date;
            const idx = parseInt(el.dataset.eventIdx);
            const event = state.events[dateKey]?.[idx];
            if (!event) {
                e.preventDefault();
                return;
            }
            
            // Create custom drag image
            const dragGhost = el.cloneNode(true);
            dragGhost.id = 'dragGhost';
            dragGhost.style.cssText = `
                position: absolute;
                top: -1000px;
                left: -1000px;
                width: ${el.offsetWidth}px;
                opacity: 0.8;
                pointer-events: none;
                z-index: 9999;
            `;
            document.body.appendChild(dragGhost);
            e.dataTransfer.setDragImage(dragGhost, el.offsetWidth / 2, 10);
            
            // Clean up ghost after drag starts
            setTimeout(() => dragGhost.remove(), 0);
            
            // Store event identifying info
            e.dataTransfer.setData('text/plain', JSON.stringify({
                date: dateKey,
                file: event.file,
                line: event.line,
                title: event.title,
                time: event.time
            }));
            e.dataTransfer.effectAllowed = 'move';
            el.classList.add('dragging');
            state.isDragging = true;
        });
        
        el.addEventListener('dragend', () => {
            el.classList.remove('dragging');
            state.isDragging = false;
            // Clean up any lingering drag-over states and time indicators
            grid.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
            document.querySelectorAll('.drop-time-indicator').forEach(el => el.remove());
        });
    });
    
    // Drop zones on day columns with hour-level precision
    grid.querySelectorAll('.day-column').forEach(col => {
        let dragCounter = 0;
        let timeIndicator = null;
        
        col.addEventListener('dragenter', (e) => {
            e.preventDefault();
            dragCounter++;
            col.classList.add('drag-over');
        });
        
        col.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            
            // Calculate time from Y position and show indicator
            const rect = col.getBoundingClientRect();
            const y = e.clientY - rect.top + col.parentElement.scrollTop;
            const hour = Math.floor(y / hourHeight) + startHour;
            const minutes = Math.round((y % hourHeight) / hourHeight * 60 / 15) * 15; // Snap to 15-min
            const clampedHour = Math.max(startHour, Math.min(endHour, hour));
            const clampedMins = minutes >= 60 ? 0 : minutes;
            
            // Create or update time indicator
            if (!timeIndicator) {
                timeIndicator = document.createElement('div');
                timeIndicator.className = 'drop-time-indicator';
                col.appendChild(timeIndicator);
            }
            const indicatorTop = (clampedHour - startHour) * hourHeight + (clampedMins / 60) * hourHeight;
            const timeLabel = `${clampedHour > 12 ? clampedHour - 12 : clampedHour || 12}:${String(clampedMins).padStart(2, '0')} ${clampedHour >= 12 ? 'PM' : 'AM'}`;
            timeIndicator.style.top = `${indicatorTop}px`;
            timeIndicator.textContent = timeLabel;
            timeIndicator.dataset.hour = clampedHour;
            timeIndicator.dataset.mins = clampedMins;
        });
        
        col.addEventListener('dragleave', (e) => {
            dragCounter--;
            if (dragCounter === 0) {
                col.classList.remove('drag-over');
                if (timeIndicator) {
                    timeIndicator.remove();
                    timeIndicator = null;
                }
            }
        });
        
        col.addEventListener('drop', (e) => {
            e.preventDefault();
            dragCounter = 0;
            col.classList.remove('drag-over');

            // Get the drop time from indicator
            let newTime = null;
            if (timeIndicator) {
                const hour = parseInt(timeIndicator.dataset.hour);
                const mins = parseInt(timeIndicator.dataset.mins);
                newTime = `${String(hour).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
                timeIndicator.remove();
                timeIndicator = null;
            }

            try {
                const data = JSON.parse(e.dataTransfer.getData('text/plain'));
                const newDate = col.dataset.date;

                // Find the event by file+line (unique identifier)
                const events = state.events[data.date] || [];
                const event = events.find(e => e.file === data.file && e.line === data.line);

                if (!event) {
                    console.warn('Could not find event to reschedule:', data);
                    showToast('Event not found - please refresh', 'error');
                    return;
                }

                // Don't allow dragging ICS events
                if (event.source === 'ics') {
                    showToast('External calendar events cannot be moved', 'warning');
                    return;
                }

                // Skip if same date AND same time (or no time change)
                const sameDate = data.date === newDate;
                const sameTime = !newTime || newTime === event.time;
                if (sameDate && sameTime) return;

                // Optimistic update: move event in state immediately
                const oldDate = data.date;
                const oldTime = event.time;

                // Remove from old date
                if (state.events[oldDate]) {
                    state.events[oldDate] = state.events[oldDate].filter(e => e !== event);
                }

                // Update event fields
                event.date = newDate;
                if (newTime) event.time = newTime;

                // Add to new date
                if (!state.events[newDate]) state.events[newDate] = [];
                state.events[newDate].push(event);

                // Re-render immediately for instant feedback
                renderView();

                // API call in background
                rescheduleEvent(event, newDate, newTime).then(success => {
                    if (success) {
                        loadEvents(true, false);  // Sync with server
                    } else {
                        // Revert optimistic update on failure
                        if (state.events[newDate]) {
                            state.events[newDate] = state.events[newDate].filter(e => e !== event);
                        }
                        event.date = oldDate;
                        event.time = oldTime;
                        if (!state.events[oldDate]) state.events[oldDate] = [];
                        state.events[oldDate].push(event);
                        renderView();
                    }
                });
            } catch (err) {
                console.error('Drop error:', err);
                showToast('Failed to move event', 'error');
            }
        });
    });
    
    // Restore scroll position or scroll to current time
    if (preserveScroll) {
        // Preserve scroll position (even if at top)
        container.scrollTop = savedScrollTop;
    } else {
        // Initial load or explicit navigation: scroll to current time
        const now = new Date();
        if (now.getHours() >= startHour && now.getHours() <= endHour) {
            container.scrollTop = Math.max(0, ((now.getHours() - startHour) * hourHeight) - 100);
        }
    }
}

function renderAgendaView(shouldScroll = false) {
    // Remove month-view class (for scrollable view)
    document.querySelector('.time-grid-container')?.classList.remove('month-view');
    document.getElementById('timeGrid')?.classList.remove('month-view');
    
    const today = new Date();
    const todayKey = formatDate(today);
    const isTimelineMode = !!state.timelineMode;
    
    // Determine date range based on mode
    let rangeStart, rangeEnd;
    if (isTimelineMode) {
        // Timeline mode: show full project range
        rangeStart = state.timelineMode.startDate;
        rangeEnd = state.timelineMode.endDate;
    } else {
        // Normal agenda: 7 days before to 30 days after selectedDate
        const startDate = state.selectedDate || today;
        rangeStart = new Date(startDate);
        rangeStart.setDate(rangeStart.getDate() - 7);
        rangeEnd = new Date(startDate);
        rangeEnd.setDate(rangeEnd.getDate() + 30);
    }
    
    // Collect events in the date range
    const eventsList = [];
    const current = new Date(rangeStart);
    while (current <= rangeEnd) {
        const dateKey = formatDate(current);
        let dayEvents = getEventsForDate(dateKey);
        
        // In timeline mode, filter to only show events from this project
        if (isTimelineMode) {
            // Build set of project heading titles for matching
            const projectHeadingTitles = new Set();
            Object.values(state.events || {}).forEach(de => {
                de.forEach(ev => {
                    if (isProjectHeadingEvent(ev) && ev.title) {
                        projectHeadingTitles.add(ev.title);
                    }
                });
            });

            dayEvents = dayEvents.filter(e => {
                if (e.para !== state.timelineMode.paraType) return false;
                const projectName = getProjectNameForEvent(e, projectHeadingTitles);
                return projectName === state.timelineMode.parent;
            });
        }
        
        dayEvents.forEach((e, originalIdx) => {
            // Store the original index in state.events for this date
            const actualIdx = (state.events[dateKey] || []).findIndex(ev => 
                ev.title === e.title && ev.time === e.time && ev.category === e.category
            );
            eventsList.push({ 
                ...e, 
                dateKey, 
                date: new Date(current),
                eventIdx: actualIdx >= 0 ? actualIdx : originalIdx
            });
        });
        current.setDate(current.getDate() + 1);
    }
    
    // Group by date
    const grouped = {};
    eventsList.forEach(e => {
        if (!grouped[e.dateKey]) grouped[e.dateKey] = [];
        grouped[e.dateKey].push(e);
    });
    
    // Sort events within each day by time
    Object.values(grouped).forEach(dayEvents => {
        dayEvents.sort((a, b) => {
            const timeA = parseTime(a.time) || 0;
            const timeB = parseTime(b.time) || 0;
            return timeA - timeB;
        });
    });
    
    let html = '<div class="agenda-view">';
    
    // Timeline mode header
    if (isTimelineMode) {
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const startStr = `${months[rangeStart.getMonth()]} ${rangeStart.getDate()}, ${rangeStart.getFullYear()}`;
        const endStr = `${months[rangeEnd.getMonth()]} ${rangeEnd.getDate()}, ${rangeEnd.getFullYear()}`;
        html += `
            <div class="timeline-header">
                <div class="timeline-header-info">
                    <span class="timeline-header-icon">${getParaIcon(state.timelineMode.paraType)}</span>
                    <div class="timeline-header-text">
                        <span class="timeline-header-title">${state.timelineMode.parent}</span>
                        <span class="timeline-header-range">${startStr} - ${endStr} · ${state.timelineMode.eventCount} events</span>
                    </div>
                </div>
                <button class="timeline-close-btn" onclick="closeProjectTimeline()">Close</button>
            </div>
            <button class="timeline-load-more" onclick="loadMoreTimelineEvents()">
                <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>
                Load older events
            </button>
            <div class="pull-to-refresh-indicator">
                <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>
                <span>Pull to load older</span>
            </div>
        `;
    }
    
    // If no events, show message
    const sortedDates = Object.keys(grouped).sort();
    if (sortedDates.length === 0) {
        html += '<div class="search-empty">No events in this period</div>';
    }
    
    // In timeline mode, find where to insert TODAY divider
    let todayDividerInserted = false;
    let lastYearShown = null;
    const needsTodayDivider = isTimelineMode && sortedDates.some(d => d < todayKey) && sortedDates.some(d => d >= todayKey);
    const currentYear = today.getFullYear();
    
    sortedDates.forEach((dateKey, index) => {
        const events = grouped[dateKey];
        const date = new Date(dateKey + 'T00:00:00');
        const isToday = todayKey === dateKey;
        const isPast = dateKey < todayKey;
        const eventYear = date.getFullYear();
        
        // Insert year divider when year changes (in timeline mode)
        if (isTimelineMode && lastYearShown !== null && eventYear !== lastYearShown) {
            html += `
                <div class="timeline-year-divider">
                    <span class="timeline-year-label">${eventYear}</span>
                </div>
            `;
        }
        lastYearShown = eventYear;
        
        // Insert TODAY divider in timeline mode before first future/today event
        if (isTimelineMode && needsTodayDivider && !todayDividerInserted && dateKey >= todayKey) {
            html += `
                <div class="timeline-today-divider">
                    <span class="timeline-today-label">TODAY</span>
                </div>
            `;
            todayDividerInserted = true;
        }
        
        const showYear = eventYear !== currentYear;
        
        html += `
            <div class="agenda-day ${isToday ? 'today' : ''} ${isPast ? 'past' : ''} ${isTimelineMode && isPast ? 'timeline-past' : ''}">
                <div class="agenda-date">
                    <span class="agenda-date-day">${date.getDate()}</span>
                    <span class="agenda-date-info">
                        <span class="agenda-date-weekday">${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][date.getDay()]}</span>
                        <span class="agenda-date-month">${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][date.getMonth()]}${showYear ? ` '${String(eventYear).slice(-2)}` : ''}</span>
                    </span>
                </div>
                <div class="agenda-events">
                    ${events.map((e) => {
                        const color = e.color || getColorForCategory(e.category);
                        const stateClass = e.state ? e.state.toLowerCase() : '';
                        const icsClass = e.source === 'ics' ? 'ics-event' : '';
                        const icsDoneClass = e.icsDone ? 'ics-done' : '';
                        const categoryLabel = e.ics_calendar || e.icsCalendar ? `${e.ics_calendar || e.icsCalendar}` : e.category;
                        const doneIndicator = e.icsDone ? '<span class="agenda-event-done-badge">DONE</span>' : '';
                        // Mark overdue: past event that is not done and not cancelled/inactive
                        const completedStates = ['DONE', 'CANCELLED', 'CANCELED'];
                        const inactiveStates = ['HOLD', 'WAITING', 'SOMEDAY'];
                        const isDone = completedStates.includes(e.state) || e.icsDone;
                        const isInactive = inactiveStates.includes(e.state);
                        // Overdue if: past, not done, not inactive, and either org event or undone ICS event
                        const isOverdue = isPast && !isDone && !isInactive && (e.source !== 'ics' || !e.icsDone);
                        const overdueClass = isOverdue ? 'overdue' : '';
                        // In timeline mode, show check for completed past events
                        const timelineCompleted = isTimelineMode && isPast && isDone;
                        const timelinePast = isTimelineMode && isPast && !isDone;
                        return `
                            <div class="agenda-event ${stateClass} ${icsClass} ${icsDoneClass} ${overdueClass} ${timelineCompleted ? 'timeline-completed' : ''} ${timelinePast ? 'timeline-past-event' : ''}" data-date="${dateKey}" data-idx="${e.eventIdx}">
                                ${timelineCompleted ? '<span class="timeline-check">✓</span>' : ''}
                                <div class="agenda-event-color" style="background: ${isTimelineMode && isPast ? '#4b5563' : color}"></div>
                                <div class="agenda-event-time">${e.time || 'All day'}</div>
                                <div class="agenda-event-title">${e.title}</div>
                                ${doneIndicator}
                                ${isOverdue ? '<span class="agenda-event-overdue-badge">OVERDUE</span>' : ''}
                                ${categoryLabel ? `<div class="agenda-event-category">${categoryLabel}</div>` : ''}
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;
    });
    
    html += '</div>';
    
    document.getElementById('weekHeader').innerHTML = '';
    document.getElementById('timeGrid').innerHTML = html;
    
    // Update title to show date range
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    if (isTimelineMode) {
        document.getElementById('dateTitle').textContent = `Timeline - ${state.timelineMode.parent}`;
    } else {
        const displayDate = state.selectedDate || today;
        document.getElementById('dateTitle').textContent = `Agenda - ${months[displayDate.getMonth()]} ${displayDate.getFullYear()}`;
    }

    // Event click handlers
    document.querySelectorAll('.agenda-event').forEach(el => {
        const dateKey = el.dataset.date;
        const idx = parseInt(el.dataset.idx);

        // Long press detection with movement tolerance
        let pressTimer;
        let touchStartX, touchStartY;
        const MOVE_TOLERANCE = 15; // pixels - allow small finger movements

        el.addEventListener('touchstart', (e) => {
            const touch = e.touches[0];
            touchStartX = touch.clientX;
            touchStartY = touch.clientY;
            pressTimer = setTimeout(() => {
                enterSelectionMode(dateKey, idx);
                if (navigator.vibrate) navigator.vibrate(50);
            }, 500);
        }, { passive: true });

        el.addEventListener('touchend', () => clearTimeout(pressTimer));
        el.addEventListener('touchmove', (e) => {
            // Only cancel if finger moved significantly (> tolerance)
            const touch = e.touches[0];
            const dx = Math.abs(touch.clientX - touchStartX);
            const dy = Math.abs(touch.clientY - touchStartY);
            if (dx > MOVE_TOLERANCE || dy > MOVE_TOLERANCE) {
                clearTimeout(pressTimer);
            }
        }, { passive: true });

        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            enterSelectionMode(dateKey, idx);
        });

        el.addEventListener('click', (e) => {
            if (state.selectionMode) {
                toggleSelection(dateKey, idx);
                return;
            }

            const events = state.events[dateKey];
            if (events && idx >= 0 && idx < events.length) {
                showEventPopup(events[idx], dateKey, e.clientX, e.clientY);
            }
        });
        
        if (state.selectedEvents.has(`${dateKey}:${idx}`)) {
            el.classList.add('selected');
        }
    });
    
    // Scroll into view only when explicitly requested (navigation, initial load, view switch)
    // Skip scrolling for state changes, refreshes, etc. to avoid jarring jumps
    if (shouldScroll) {
        setTimeout(() => {
            if (isTimelineMode) {
                // In timeline mode, scroll to TODAY divider or first upcoming event
                const todayDivider = document.querySelector('.timeline-today-divider');
                if (todayDivider) {
                    todayDivider.scrollIntoView({ behavior: 'smooth', block: 'center' });
                } else {
                    // If no divider (all past or all future), scroll to top
                    document.querySelector('.agenda-view')?.scrollTo(0, 0);
                }
            } else {
                const todayEl = document.querySelector('.agenda-day.today');
                if (todayEl) {
                    todayEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            }
        }, 100);
    }
}

function renderSearchResults() {
    const query = state.searchQuery.toLowerCase();
    
    // Search across ALL cached events
    const results = [];
    Object.keys(state.events).forEach(dateKey => {
        state.events[dateKey].forEach((event, idx) => {
            const matches = (event.title || '').toLowerCase().includes(query) ||
                          (event.category || '').toLowerCase().includes(query) ||
                          (event.notes || '').toLowerCase().includes(query) ||
                          (event.file || '').toLowerCase().includes(query);
            if (matches) {
                results.push({ ...event, dateKey, idx });
            }
        });
    });
    
    // Sort by date
    results.sort((a, b) => a.dateKey.localeCompare(b.dateKey));
    
    // Group by date
    const grouped = {};
    results.forEach(e => {
        if (!grouped[e.dateKey]) grouped[e.dateKey] = [];
        grouped[e.dateKey].push(e);
    });
    
    let html = '<div class="agenda-view search-results">';
    
    if (results.length === 0) {
        html += `<div class="search-empty">No events found for "${state.searchQuery}"</div>`;
    } else {
        html += `<div class="search-count">${results.length} result${results.length !== 1 ? 's' : ''}</div>`;
        
        Object.keys(grouped).sort().forEach(dateKey => {
            const events = grouped[dateKey];
            const date = new Date(dateKey + 'T00:00:00');
            const today = new Date();
            const isToday = formatDate(today) === dateKey;
            const isPast = date < today && !isToday;
            
            html += `
                <div class="agenda-day ${isToday ? 'today' : ''} ${isPast ? 'past' : ''}">
                    <div class="agenda-date">
                        <span class="agenda-date-day">${date.getDate()}</span>
                        <span class="agenda-date-info">
                            <span class="agenda-date-weekday">${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][date.getDay()]}</span>
                            <span class="agenda-date-month">${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][date.getMonth()]} ${date.getFullYear()}</span>
                        </span>
                    </div>
                    <div class="agenda-events">
                        ${events.map(e => {
                            const color = e.color || getColorForCategory(e.category);
                            const stateClass = e.state ? e.state.toLowerCase() : '';
                            return `
                                <div class="agenda-event ${stateClass}" data-date="${e.dateKey}" data-idx="${e.idx}">
                                    <div class="agenda-event-color" style="background: ${color}"></div>
                                    <div class="agenda-event-time">${e.time || 'All day'}</div>
                                    <div class="agenda-event-title">${highlightMatch(e.title, state.searchQuery)}</div>
                                    ${e.category ? `<div class="agenda-event-category">${e.category}</div>` : ''}
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            `;
        });
    }
    
    html += '</div>';
    
    document.getElementById('weekHeader').innerHTML = '';
    document.getElementById('timeGrid').innerHTML = html;
    document.getElementById('dateTitle').textContent = `Search: ${state.searchQuery}`;

    // Event click handlers
    document.querySelectorAll('.agenda-event').forEach(el => {
        const dateKey = el.dataset.date;
        const idx = parseInt(el.dataset.idx);

        // Long press detection with movement tolerance
        let pressTimer;
        let touchStartX, touchStartY;
        const MOVE_TOLERANCE = 15; // pixels - allow small finger movements

        el.addEventListener('touchstart', (e) => {
            const touch = e.touches[0];
            touchStartX = touch.clientX;
            touchStartY = touch.clientY;
            pressTimer = setTimeout(() => {
                enterSelectionMode(dateKey, idx);
                if (navigator.vibrate) navigator.vibrate(50);
            }, 500);
        }, { passive: true });

        el.addEventListener('touchend', () => clearTimeout(pressTimer));
        el.addEventListener('touchmove', (e) => {
            // Only cancel if finger moved significantly (> tolerance)
            const touch = e.touches[0];
            const dx = Math.abs(touch.clientX - touchStartX);
            const dy = Math.abs(touch.clientY - touchStartY);
            if (dx > MOVE_TOLERANCE || dy > MOVE_TOLERANCE) {
                clearTimeout(pressTimer);
            }
        }, { passive: true });

        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            enterSelectionMode(dateKey, idx);
        });

        el.addEventListener('click', (e) => {
            if (state.selectionMode) {
                toggleSelection(dateKey, idx);
                return;
            }

            if (idx >= 0 && state.events[dateKey]) {
                showEventPopup(state.events[dateKey][idx], dateKey, e.clientX, e.clientY);
            }
        });
        
        if (state.selectedEvents.has(`${dateKey}:${idx}`)) {
            el.classList.add('selected');
        }
    });
}

function closeSearch() {
    const searchBar = document.getElementById('searchBar');
    const searchInput = document.getElementById('searchInput');
    
    // Hide search bar
    searchBar.hidden = true;
    
    // Clear search query and input
    state.searchQuery = '';
    if (searchInput) searchInput.value = '';
    
    // Return to calendar view
    renderView(true);  // Scroll to today when closing search
}

function highlightMatch(text, query) {
    if (!query || !text) return text || '';
    const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return text.replace(regex, '<mark>$1</mark>');
}

function calculateDayLoad(events) {
    // Calculate total hours accounting for overlapping events
    let hasTravel = false;
    let hasCompleted = false;
    let bigRocks = 0;
    
    // Filter out ICS events based on per-calendar includeInLoad setting
    const filteredEvents = events.filter(e => {
        if (e.source !== 'ics') return true;  // Always include org-mode events
        // Check if this ICS calendar has includeInLoad enabled
        const calName = e.ics_calendar || e.icsCalendar;
        const calendar = (settings?.icsCalendars || []).find(c => c.name === calName);
        return calendar?.includeInLoad === true;
    });
    
    // Collect time intervals for timed events
    const intervals = [];
    let allDayHours = 0;
    
    filteredEvents.forEach(e => {
        const startMin = parseTime(e.time);
        const endMin = parseTime(e.endTime) || (startMin !== null ? startMin + 60 : null);
        
        if (startMin !== null && endMin !== null) {
            intervals.push({ start: startMin, end: endMin });
        } else {
            // All-day or no-time events count as 1 hour
            allDayHours += 1;
        }
        
        // Check for travel
        if (e.category?.toLowerCase().includes('travel') || e.title?.toLowerCase().includes('travel') ||
            e.title?.toLowerCase().includes('trip') || e.title?.toLowerCase().includes('flight')) {
            hasTravel = true;
        }
        if (e.state === 'DONE') hasCompleted = true;
        
        // Calculate duration for big rocks (individual event duration, not merged)
        const duration = startMin !== null ? (endMin - startMin) / 60 : 1;
        const rockThreshold = settings?.rockThreshold || 3;
        if (duration >= rockThreshold) bigRocks++;
    });
    
    // Merge overlapping intervals to avoid double-counting
    let mergedHours = 0;
    if (intervals.length > 0) {
        // Sort by start time
        intervals.sort((a, b) => a.start - b.start);
        
        // Merge overlapping intervals
        const merged = [intervals[0]];
        for (let i = 1; i < intervals.length; i++) {
            const last = merged[merged.length - 1];
            const curr = intervals[i];
            if (curr.start <= last.end) {
                // Overlapping - extend the end if needed
                last.end = Math.max(last.end, curr.end);
            } else {
                // No overlap - add new interval
                merged.push(curr);
            }
        }
        
        // Sum merged intervals
        merged.forEach(interval => {
            mergedHours += (interval.end - interval.start) / 60;
        });
    }
    
    const totalHours = mergedHours + allDayHours;
    
    return { totalHours, hasTravel, hasCompleted, bigRocks };
}

function buildMonthCellTooltip(date, events, totalHours, hasTravel, bigRocks) {
    const dateStr = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const dayOfWeek = date.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    
    let lines = [dateStr + (isWeekend ? ' (Weekend)' : '')];
    lines.push(`${totalHours.toFixed(1)} hours, ${events.length} events`);
    
    if (hasTravel) lines.push('✈ Travel day');
    
    // Categorize events by importance
    const rockThreshold = settings?.rockThreshold || 3;
    const majorEvents = [];
    const otherEvents = [];
    
    events.forEach(e => {
        const duration = e.time ? 
            ((parseTime(e.endTime) || parseTime(e.time) + 60) - parseTime(e.time)) / 60 : 1;
        const time = e.time ? e.time.substring(0, 5) : '';
        const title = e.title || 'Untitled';
        const shortTitle = title.length > 30 ? title.substring(0, 27) + '...' : title;
        
        if (duration >= rockThreshold) {
            majorEvents.push(`${time ? time + ' ' : ''}${shortTitle} (${duration.toFixed(0)}h)`);
        } else {
            otherEvents.push(`${time ? time + ' ' : ''}${shortTitle}`);
        }
    });
    
    if (majorEvents.length > 0) {
        lines.push('');
        lines.push('● Major:');
        majorEvents.slice(0, 3).forEach(e => lines.push('  ' + e));
        if (majorEvents.length > 3) lines.push(`  +${majorEvents.length - 3} more...`);
    }
    
    if (otherEvents.length > 0 && majorEvents.length < 3) {
        lines.push('');
        lines.push('○ Other:');
        otherEvents.slice(0, 4).forEach(e => lines.push('  ' + e));
        if (otherEvents.length > 4) lines.push(`  +${otherEvents.length - 4} more...`);
    }
    
    return lines.join('\n');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function renderMonthView() {
    const today = new Date();
    const monthStart = new Date(state.weekStart.getFullYear(), state.weekStart.getMonth(), 1);
    const monthEnd = new Date(state.weekStart.getFullYear(), state.weekStart.getMonth() + 1, 0);
    const startDay = (monthStart.getDay() + 6) % 7;
    
    // Set container to not scroll for month view
    const container = document.querySelector('.time-grid-container');
    container.classList.add('month-view');
    container.scrollTop = 0; // Reset scroll position
    document.getElementById('timeGrid').classList.add('month-view');
    
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    document.getElementById('dateTitle').textContent = `${months[state.weekStart.getMonth()]} ${state.weekStart.getFullYear()}`;
    
    // Calculate month stats for summary
    let availableCount = 0, heavyCount = 0, totalRocks = 0, travelCount = 0;
    
    // Legend header (like the plugin)
    const legendItems = [
        { level: 'available', icon: '✓', label: 'Available' },
        { level: 'light', icon: '○', label: 'Light' },
        { level: 'moderate', icon: '◐', label: 'Moderate' },
        { level: 'heavy', icon: '●', label: 'Heavy' },
        { level: 'travel', icon: '✈', label: 'Travel' },
        { level: 'weekend', icon: '☀', label: 'Weekend' }
    ];
    
    document.getElementById('weekHeader').innerHTML = `
        <div class="month-legend">
            ${legendItems.map(item => `
                <div class="legend-item">
                    <span class="legend-box ${item.level}">${item.icon}</span>
                    <span>${item.label}</span>
                </div>
            `).join('')}
        </div>
        <div class="month-header">
            ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d, i) => 
                `<div class="month-weekday ${i >= 5 ? 'weekend' : ''}">${d}</div>`
            ).join('')}
        </div>
    `;
    
    let html = '<div class="month-grid-new">';
    
    // Always render 42 cells (6 rows x 7 cols)
    for (let i = 0; i < 42; i++) {
        const dayNum = i - startDay + 1;
        const isValidDay = dayNum >= 1 && dayNum <= monthEnd.getDate();
        
        if (!isValidDay) {
            html += `<div class="month-cell other-month"></div>`;
            continue;
        }
        
        const date = new Date(state.weekStart.getFullYear(), state.weekStart.getMonth(), dayNum);
        const dateKey = formatDate(date);
        const dayOfWeek = date.getDay();
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
        const events = getEventsForDate(dateKey);
        const isToday = date.toDateString() === today.toDateString();
        const { totalHours, hasTravel, hasCompleted, bigRocks } = calculateDayLoad(events);
        
        // Determine load level
        const heavyThreshold = settings?.heavyThreshold || 6;
        const moderateThreshold = Math.floor(heavyThreshold * 0.5);
        
        let loadClass, loadIcon;
        if (isWeekend && totalHours === 0) {
            loadClass = 'weekend';
            loadIcon = '☀';
        } else if (hasTravel) {
            loadClass = 'travel';
            loadIcon = '✈';
            travelCount++;
        } else if (totalHours >= heavyThreshold) {
            loadClass = 'heavy';
            loadIcon = '●';
            heavyCount++;
        } else if (totalHours >= moderateThreshold) {
            loadClass = 'moderate';
            loadIcon = '◐';
        } else if (totalHours >= 1) {
            loadClass = 'light';
            loadIcon = '○';
        } else {
            loadClass = 'available';
            loadIcon = '✓';
            availableCount++;
        }
        
        totalRocks += bigRocks;
        
        // Big rocks indicator (dots at bottom)
        let rocksHtml = '';
        if (bigRocks > 0) {
            rocksHtml = '<div class="month-rocks">' + 
                Array(Math.min(bigRocks, 3)).fill('<span class="rock-dot"></span>').join('') +
                '</div>';
        }
        
        // Build tooltip content for desktop hover
        const tooltipContent = buildMonthCellTooltip(date, events, totalHours, hasTravel, bigRocks);
        
        html += `
            <div class="month-cell ${loadClass} ${isToday ? 'today' : ''}" 
                 data-date="${dateKey}"
                 data-hours="${totalHours}"
                 data-rocks="${bigRocks}"
                 data-tooltip="${escapeHtml(tooltipContent)}">
                <span class="month-cell-num">${dayNum}</span>
                <span class="month-cell-icon">${loadIcon}</span>
                <span class="month-cell-hours">${totalHours > 0 ? Math.round(totalHours) + 'h' : ''}</span>
                ${rocksHtml}
                ${hasCompleted ? '<span class="month-cell-check">✓</span>' : ''}
            </div>
        `;
    }
    
    html += '</div>';
    
    // Add month summary panel (inspired by QML design)
    html += `
        <div class="month-summary">
            <div class="summary-stat">
                <div class="stat-row">
                    <span class="stat-icon available">✓</span>
                    <span class="stat-value">${availableCount}</span>
                </div>
                <span class="stat-label">Available</span>
            </div>
            <div class="summary-stat clickable" data-filter="heavy" title="Click to see heavy days">
                <div class="stat-row">
                    <span class="stat-icon heavy">●</span>
                    <span class="stat-value">${heavyCount}</span>
                </div>
                <span class="stat-label">Heavy</span>
            </div>
            <div class="summary-stat clickable" data-filter="rocks" title="Click to see big rock events">
                <div class="stat-row">
                    <span class="stat-icon rock">🪨</span>
                    <span class="stat-value">${totalRocks}</span>
                </div>
                <span class="stat-label">Big Rocks</span>
            </div>
            <div class="summary-stat clickable" data-filter="travel" title="Click to see travel days">
                <div class="stat-row">
                    <span class="stat-icon travel">✈</span>
                    <span class="stat-value">${travelCount}</span>
                </div>
                <span class="stat-label">Travel</span>
            </div>
        </div>
    `;
    
    document.getElementById('timeGrid').innerHTML = html;
    
    // Click handlers with single/double click distinction
    document.querySelectorAll('.month-cell:not(.other-month)').forEach(el => {
        let clickTimer = null;
        
        el.addEventListener('click', (e) => {
            // If this is a potential double-click, wait to confirm
            if (clickTimer) {
                clearTimeout(clickTimer);
                clickTimer = null;
                return; // Double-click handler will fire
            }
            
            clickTimer = setTimeout(() => {
                clickTimer = null;
                // Single click: navigate to day view
                state.selectedDate = new Date(el.dataset.date + 'T00:00:00');
                state.viewMode = 'day';
                renderView();
            }, 250);
        });
        
        el.addEventListener('dblclick', (e) => {
            // Clear single-click timer if pending
            if (clickTimer) {
                clearTimeout(clickTimer);
                clickTimer = null;
            }
            
            // Double-click: open quick-add modal for that date
            const dateKey = el.dataset.date;
            showCreateModal(dateKey);
        });
    });
    
    // Click handlers for summary stats
    document.querySelectorAll('.summary-stat.clickable').forEach(stat => {
        stat.addEventListener('click', () => {
            const filter = stat.dataset.filter;
            showMonthFilteredEvents(filter);
        });
    });
}

// Show popup with filtered events from month view
function showMonthFilteredEvents(filterType) {
    const currentMonth = state.weekStart;
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const heavyThreshold = settings?.heavyThreshold || 6;
    
    const filteredEvents = [];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    // Helper to filter out ICS events not included in load calculation
    const filterForLoad = (events) => {
        return events.filter(e => {
            if (e.source !== 'ics') return true;  // Always include org-mode events
            const calName = e.ics_calendar || e.icsCalendar;
            const calendar = (settings?.icsCalendars || []).find(c => c.name === calName);
            return calendar?.includeInLoad === true;
        });
    };
    
    for (let day = 1; day <= daysInMonth; day++) {
        const date = new Date(year, month, day);
        const dateKey = formatDate(date);
        const dayEvents = getEventsForDate(dateKey);
        const loadEvents = filterForLoad(dayEvents);  // Events that count for load
        
        if (filterType === 'travel') {
            // Find travel days (only from load-counted events)
            const travelEvents = loadEvents.filter(e => 
                e.category?.toLowerCase().includes('travel') || 
                e.title?.toLowerCase().includes('travel') ||
                e.title?.toLowerCase().includes('flight') ||
                e.title?.toLowerCase().includes('trip')
            );
            if (travelEvents.length > 0) {
                travelEvents.forEach(e => filteredEvents.push({ ...e, dateKey, date }));
            }
        } else if (filterType === 'heavy') {
            // Find heavy days using same logic as month view (calculateDayLoad)
            const { totalHours, hasTravel } = calculateDayLoad(dayEvents);
            // Skip travel days (they're shown separately)
            if (!hasTravel && totalHours >= heavyThreshold) {
                filteredEvents.push({ 
                    title: `${totalHours.toFixed(1)}h scheduled`, 
                    dateKey, 
                    date,
                    isDay: true,
                    events: loadEvents 
                });
            }
        } else if (filterType === 'rocks') {
            // Find big rock events using same threshold as month view (only from load-counted events)
            const rockThreshold = settings?.rockThreshold || 3;
            loadEvents.filter(e => {
                if (e.bigRock) return true;
                // Calculate duration in hours
                const startMin = parseTime(e.time);
                const endMin = parseTime(e.endTime) || (startMin !== null ? startMin + 60 : null);
                const duration = (startMin !== null && endMin !== null) ? (endMin - startMin) / 60 : 1;
                return duration >= rockThreshold;
            }).forEach(e => filteredEvents.push({ ...e, dateKey, date }));
        }
    }
    
    // Build popup HTML
    const filterLabels = {
        'travel': '✈️ Travel Days',
        'heavy': '🔴 Heavy Days',
        'rocks': '🪨 Big Rocks'
    };
    
    let html = `
        <div class="filtered-events-popup">
            <div class="filtered-events-header">
                <h3>${filterLabels[filterType]} - ${months[month]} ${year}</h3>
                <button class="filtered-events-close" onclick="hideFilteredEventsPopup()">✕</button>
            </div>
            <div class="filtered-events-list">
    `;
    
    if (filteredEvents.length === 0) {
        html += `<div class="filtered-events-empty">No ${filterType} events this month</div>`;
    } else {
        filteredEvents.forEach(e => {
            const dateStr = `${months[e.date.getMonth()]} ${e.date.getDate()}`;
            if (e.isDay) {
                // Heavy day - show day summary
                html += `
                    <div class="filtered-event-item heavy-day" data-date="${e.dateKey}">
                        <div class="filtered-event-date">${dateStr}</div>
                        <div class="filtered-event-info">
                            <div class="filtered-event-title">${e.title}</div>
                            <div class="filtered-event-count">${e.events.length} events</div>
                        </div>
                    </div>
                `;
            } else {
                const time = e.time || 'All day';
                const color = e.color || getColorForCategory(e.category);
                html += `
                    <div class="filtered-event-item" data-date="${e.dateKey}">
                        <div class="filtered-event-date">${dateStr}</div>
                        <div class="filtered-event-color" style="background: ${color}"></div>
                        <div class="filtered-event-info">
                            <div class="filtered-event-title">${e.title}</div>
                            <div class="filtered-event-time">${time}</div>
                        </div>
                    </div>
                `;
            }
        });
    }
    
    html += `
            </div>
        </div>
    `;
    
    // Create or update popup container
    let popup = document.getElementById('filteredEventsPopup');
    if (!popup) {
        popup = document.createElement('div');
        popup.id = 'filteredEventsPopup';
        popup.className = 'filtered-events-overlay';
        document.body.appendChild(popup);
    }
    popup.innerHTML = html;
    popup.hidden = false;
    
    // Click on event to go to that day
    popup.querySelectorAll('.filtered-event-item').forEach(item => {
        item.addEventListener('click', () => {
            const dateKey = item.dataset.date;
            state.selectedDate = new Date(dateKey + 'T00:00:00');
            hideFilteredEventsPopup();
            switchView('day');
        });
    });
    
    // Close on background click
    popup.addEventListener('click', (e) => {
        if (e.target === popup) hideFilteredEventsPopup();
    });
}

function hideFilteredEventsPopup() {
    const popup = document.getElementById('filteredEventsPopup');
    if (popup) popup.hidden = true;
}

// Helper to get event duration in hours
function getEventDuration(e) {
    const startMin = parseTime(e.time);
    const endMin = parseTime(e.end_time || e.endTime);
    if (startMin !== null && endMin !== null) {
        return (endMin - startMin) / 60;
    }
    return e.all_day || e.allDay ? 8 : 1; // all-day events count as 8h, others as 1h default
}

// ==================== Year Glance Filter System ====================

// Parse duration string like "3h", "30m", "1.5h" into hours
function parseDurationValue(str) {
    if (!str) return 0;
    str = str.toString().trim().toLowerCase();
    
    // Handle hours
    if (str.endsWith('h')) {
        return parseFloat(str.slice(0, -1)) || 0;
    }
    // Handle minutes
    if (str.endsWith('m')) {
        return (parseFloat(str.slice(0, -1)) || 0) / 60;
    }
    // Plain number = hours
    return parseFloat(str) || 0;
}

// Parse a list like "(Travel, Holiday, Workshop)" into array
function parseList(str) {
    if (!str) return [];
    // Remove parentheses and split by comma
    str = str.replace(/^\(|\)$/g, '').trim();
    return str.split(',').map(s => s.trim().toLowerCase()).filter(s => s);
}

// Evaluate a single condition against an event
function evaluateCondition(event, field, operator, value) {
    const duration = getEventDuration(event);
    const priority = (event.priority || '').toUpperCase();
    const category = (event.category || '').toLowerCase();
    const title = (event.title || '').toLowerCase();
    const isAllDay = !!(event.all_day || event.allDay || !event.time);
    const tags = (event.tags || '').toLowerCase();
    
    // Normalize value for comparison
    let compareValue = value.toString().toLowerCase().trim();
    
    switch (field.toLowerCase()) {
        case 'duration':
            const durationVal = parseDurationValue(compareValue);
            switch (operator) {
                case '>=': return duration >= durationVal;
                case '>': return duration > durationVal;
                case '<=': return duration <= durationVal;
                case '<': return duration < durationVal;
                case '=': case '==': return Math.abs(duration - durationVal) < 0.1;
                case '!=': return Math.abs(duration - durationVal) >= 0.1;
                default: return false;
            }
        
        case 'priority':
            const prioVal = compareValue.toUpperCase();
            switch (operator) {
                case '=': case '==': return priority === prioVal;
                case '!=': return priority !== prioVal;
                case 'in': return parseList(value).map(s => s.toUpperCase()).includes(priority);
                case 'not in': return !parseList(value).map(s => s.toUpperCase()).includes(priority);
                default: return false;
            }
        
        case 'category':
            switch (operator) {
                case '=': case '==': return category === compareValue;
                case '!=': return category !== compareValue;
                case 'in': return parseList(value).includes(category);
                case 'not in': return !parseList(value).includes(category);
                case 'contains': return category.includes(compareValue);
                default: return false;
            }
        
        case 'title':
            switch (operator) {
                case '=': case '==': return title === compareValue;
                case '!=': return title !== compareValue;
                case 'contains': return title.includes(compareValue);
                case 'starts with': return title.startsWith(compareValue);
                case 'in': return parseList(value).some(v => title.includes(v));
                default: return false;
            }
        
        case 'allday':
            const boolVal = compareValue === 'true' || compareValue === '1' || compareValue === 'yes';
            switch (operator) {
                case '=': case '==': return isAllDay === boolVal;
                case '!=': return isAllDay !== boolVal;
                default: return false;
            }
        
        case 'tag':
        case 'tags':
            switch (operator) {
                case '=': case '==': case 'has': case 'contains': 
                    return tags.includes(compareValue);
                case '!=': 
                    return !tags.includes(compareValue);
                case 'in': 
                    return parseList(value).some(t => tags.includes(t));
                case 'not in': 
                    return !parseList(value).some(t => tags.includes(t));
                default: return false;
            }
        
        default:
            return false;
    }
}

// Parse and evaluate a filter expression
function evaluateFilterExpression(event, expression) {
    if (!expression || expression.trim() === '') return true;
    
    // Tokenize: split by AND/OR while preserving them
    // Handle parentheses in IN clauses by replacing them temporarily
    let expr = expression;
    
    // Split by OR first (lower precedence), then by AND
    const orParts = expr.split(/\s+OR\s+/i);
    
    for (const orPart of orParts) {
        const andParts = orPart.split(/\s+AND\s+/i);
        let andResult = true;
        
        for (const condition of andParts) {
            const trimmed = condition.trim();
            if (!trimmed) continue;
            
            // Parse condition: field operator value
            // Handle operators with spaces: NOT IN, STARTS WITH
            let match = trimmed.match(/^(\w+)\s+(NOT\s+IN|STARTS\s+WITH|CONTAINS|IN|>=|<=|!=|>|<|=)\s*(.+)$/i);
            
            if (match) {
                const field = match[1];
                const operator = match[2].toLowerCase().replace(/\s+/g, ' ');
                const value = match[3].trim();
                
                if (!evaluateCondition(event, field, operator, value)) {
                    andResult = false;
                    break;
                }
            } else {
                // Invalid condition, skip
                console.warn('Invalid filter condition:', trimmed);
                andResult = false;
                break;
            }
        }
        
        // OR: if any andResult is true, return true
        if (andResult) return true;
    }
    
    return false;
}

// Get the filter function based on preset or custom expression
function getYearGlanceFilter() {
    const preset = settings?.yearGlanceFilterPreset || 'bigRocks';
    const customFilter = settings?.yearGlanceCustomFilter || '';
    const rockThreshold = settings?.rockThreshold || 3;
    
    switch (preset) {
        case 'bigRocks':
            // Events >= rockThreshold hours OR all-day events (excluding gcal all-day)
            return (event) => {
                // Exclude deadlines from big rocks unless setting is enabled
                if (event.type === 'deadline' && !settings.deadlinesAsBigRocks) return false;
                const isAllDay = !!(event.all_day || event.allDay || !event.time);
                // gcal all-day events (birthdays, holidays) are not big rocks
                if (isAllDay && (event.type === 'gcal' || event.source === 'ics')) return false;
                const duration = getEventDuration(event);
                return duration >= rockThreshold || isAllDay;
            };
        
        case 'priorityOrRocks':
            // Priority A OR events >= rockThreshold hours
            return (event) => {
                const duration = getEventDuration(event);
                const priority = (event.priority || '').toUpperCase();
                return priority === 'A' || duration >= rockThreshold;
            };
        
        case 'travelHoliday':
            // Category or title contains travel/holiday/vacation/trip keywords
            return (event) => {
                const category = (event.category || '').toLowerCase();
                const title = (event.title || '').toLowerCase();
                const keywords = ['travel', 'holiday', 'vacation', 'trip', 'flight', 'retreat', 'workshop'];
                return keywords.some(kw => category.includes(kw) || title.includes(kw));
            };
        
        case 'allEvents':
            return () => true;
        
        case 'custom':
            // Use custom filter expression
            return (event) => evaluateFilterExpression(event, customFilter);
        
        default:
            return () => true;
    }
}

// ==================== End Filter System ====================

// Render year-at-a-glance spreadsheet view
function renderYearAtGlance(year, months) {
    // Get settings with defaults
    const format = settings?.yearGlanceFormat || 'suffix';
    const columnWidth = settings?.yearGlanceColumnWidth || 'normal';
    const colorStyle = settings?.yearGlanceColorStyle || 'background';
    const rockThreshold = settings?.rockThreshold || 3;
    
    // Get the filter function
    const filterFn = getYearGlanceFilter();
    
    // Column width class
    const widthClass = `glance-width-${columnWidth}`;
    
    // Max text length based on column width
    const maxTextLength = {
        'compact': 15,
        'normal': 22,
        'wide': 35
    }[columnWidth] || 22;
    
    let html = `<div class="year-glance ${widthClass}">`;
    
    // Header row with months
    html += '<div class="glance-header-row">';
    html += '<div class="glance-day-num"></div>'; // Empty corner cell
    months.forEach((m, idx) => {
        html += `<div class="glance-month-header">${m}</div>`;
    });
    html += '</div>';
    
    // 31 rows for days
    for (let day = 1; day <= 31; day++) {
        html += '<div class="glance-row">';
        html += `<div class="glance-day-num">${day}</div>`;
        
        for (let month = 0; month < 12; month++) {
            const daysInMonth = new Date(year, month + 1, 0).getDate();
            
            if (day > daysInMonth) {
                // Invalid day for this month
                html += '<div class="glance-cell invalid"></div>';
            } else {
                const date = new Date(year, month, day);
                const dateKey = formatDate(date);
                const events = state.events[dateKey] || [];
                
                let mainEvent = null;
                let cellClass = 'glance-cell';
                let cellStyle = '';
                let borderColor = '';
                
                if (events.length > 0) {
                    // Filter visible events (category/PARA visibility)
                    const visibleEvents = events.filter(e => {
                        if (state.hiddenCategories.has(e.category)) return false;
                        if (state.hiddenParaCategories?.has(e.para)) return false;
                        return true;
                    });
                    
                    // Apply year glance filter (duration, priority, custom expression, etc.)
                    const qualifyingEvents = visibleEvents.filter(filterFn);
                    
                    if (qualifyingEvents.length > 0) {
                        // Sort by duration (longest first), then priority, then timed events first
                        const sorted = [...qualifyingEvents].sort((a, b) => {
                            const durA = getEventDuration(a);
                            const durB = getEventDuration(b);
                            const prioA = a.priority || 'Z';
                            const prioB = b.priority || 'Z';
                            
                            // Longest duration first
                            if (durA !== durB) return durB - durA;
                            
                            // Then by priority
                            if (prioA !== prioB) return prioA.localeCompare(prioB);
                            
                            // Timed events before all-day (for same duration/priority)
                            if (a.time && !b.time) return -1;
                            if (!a.time && b.time) return 1;
                            
                            return 0;
                        });
                        
                        mainEvent = sorted[0];
                        
                        // Get color
                        const eventColor = mainEvent.color || getColorForCategory(mainEvent.category);
                        
                        // Apply color based on style setting
                        if (colorStyle === 'background') {
                            cellStyle = `background-color: ${eventColor}30;`;
                        } else if (colorStyle === 'border') {
                            cellStyle = `border-left: 3px solid ${eventColor};`;
                            cellClass += ' has-border';
                        }
                        // 'none' = no color styling
                        
                        // Add state class
                        if (mainEvent.state === 'DONE') {
                            cellClass += ' done';
                        } else if (mainEvent.state === 'CANCELLED') {
                            cellClass += ' cancelled';
                        }
                    }
                }
                
                // Check if today
                const today = new Date();
                if (date.toDateString() === today.toDateString()) {
                    cellClass += ' today';
                }
                
                // Check if weekend
                const dayOfWeek = date.getDay();
                if (dayOfWeek === 0 || dayOfWeek === 6) {
                    cellClass += ' weekend';
                }
                
                // Format cell content based on display format setting
                let cellContent = '';
                let tooltipText = '';
                
                if (mainEvent) {
                    const title = mainEvent.title || '';
                    const category = mainEvent.category || '';
                    const duration = getEventDuration(mainEvent);
                    const durationStr = duration >= 1 ? `${Math.round(duration)}h` : `${Math.round(duration * 60)}m`;
                    
                    // Build tooltip (always comprehensive)
                    tooltipText = title;
                    if (category) tooltipText += ` (${category})`;
                    if (mainEvent.time) tooltipText += ` - ${durationStr}`;
                    if (mainEvent.priority) tooltipText += ` [${mainEvent.priority}]`;
                    
                    // Build cell content based on format
                    if (format === 'prefix' && category) {
                        // [Project] Title
                        const prefix = `[${category}] `;
                        const maxTitleLen = Math.max(5, maxTextLength - prefix.length);
                        const truncTitle = title.length > maxTitleLen ? title.substring(0, maxTitleLen - 1) + '…' : title;
                        cellContent = `<span class="glance-category">[${escapeHtml(category)}]</span> ${escapeHtml(truncTitle)}`;
                    } else if (format === 'suffix' && category) {
                        // Title • Project
                        const suffix = ` • ${category}`;
                        const maxTitleLen = Math.max(5, maxTextLength - suffix.length);
                        const truncTitle = title.length > maxTitleLen ? title.substring(0, maxTitleLen - 1) + '…' : title;
                        cellContent = `${escapeHtml(truncTitle)} <span class="glance-category">• ${escapeHtml(category)}</span>`;
                    } else if (format === 'twolines') {
                        // Two line format
                        const truncTitle = title.length > maxTextLength ? title.substring(0, maxTextLength - 1) + '…' : title;
                        cellContent = `<div class="glance-title">${escapeHtml(truncTitle)}</div>`;
                        if (category) {
                            cellContent += `<div class="glance-subtitle">${escapeHtml(category)}</div>`;
                        }
                        cellClass += ' twolines';
                    } else {
                        // tooltip only or no category
                        const truncTitle = title.length > maxTextLength ? title.substring(0, maxTextLength - 1) + '…' : title;
                        cellContent = escapeHtml(truncTitle);
                    }
                }
                
                const styleAttr = cellStyle ? `style="${cellStyle}"` : '';
                const tooltipAttr = tooltipText ? `title="${escapeHtml(tooltipText)}"` : '';
                
                html += `<div class="${cellClass}" data-date="${dateKey}" ${styleAttr} ${tooltipAttr}>${cellContent}</div>`;
            }
        }
        
        html += '</div>';
    }
    
    html += '</div>';
    return html;
}

function renderYearView() {
    // Set container to not scroll for year view
    document.querySelector('.time-grid-container')?.classList.add('month-view');
    document.getElementById('timeGrid')?.classList.add('month-view');
    
    const year = state.weekStart.getFullYear();
    document.getElementById('dateTitle').textContent = `${year} Overview`;
    
    // Calculate year statistics
    let totalHours = 0;
    let availableDays = 0;
    let travelDays = 0;
    let bigRocks = 0;
    const availablePeriods = [];
    let currentPeriodStart = null;
    let consecutiveAvailable = 0;
    
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    // Build heatmap data
    const heatmapData = [];
    const startDate = new Date(year, 0, 1);
    const endDate = new Date(year, 11, 31);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayKey = formatDate(today);
    
    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
        const dateKey = formatDate(d);
        const events = state.events[dateKey] || [];
        const { totalHours: dayHours, hasTravel, bigRocks: dayRocks } = calculateDayLoad(events);
        
        totalHours += dayHours;
        if (dayRocks > 0) bigRocks += dayRocks;
        
        // Use settings thresholds for consistency with month view
        const heavyThreshold = settings?.heavyThreshold || 6;
        const moderateThreshold = Math.floor(heavyThreshold * 0.67);
        
        let level = 0; // available
        if (hasTravel) {
            level = 4; // travel
            travelDays++;
        } else if (dayHours >= heavyThreshold) {
            level = 3; // heavy
        } else if (dayHours >= moderateThreshold) {
            level = 2; // moderate
        } else if (dayHours >= 1) {
            level = 1; // light
        } else {
            availableDays++;
        }
        
        // Track available periods
        // Check if day counts as available for client availability periods
        const dayOfWeek = d.getDay();
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
        const maxHoursThreshold = settings?.availableMaxHours ?? 2;
        const minConsecutiveDays = settings?.availableMinDays ?? 3;
        
        // A day is available if:
        // - It has low hours (≤ threshold), AND
        // - It's either a weekday, OR weekends are available (toggle is ON)
        const hasLowHours = dayHours <= maxHoursThreshold;
        const weekendAllowed = !isWeekend || settings?.weekendsAvailable;
        const isAvailableDay = hasLowHours && weekendAllowed;
        
        if (isAvailableDay) {
            if (!currentPeriodStart) currentPeriodStart = new Date(d);
            consecutiveAvailable++;
        } else {
            if (consecutiveAvailable >= minConsecutiveDays && currentPeriodStart) {
                const periodEnd = new Date(d);
                periodEnd.setDate(periodEnd.getDate() - 1);
                availablePeriods.push({
                    start: new Date(currentPeriodStart),
                    end: periodEnd,
                    days: consecutiveAvailable
                });
            }
            currentPeriodStart = null;
            consecutiveAvailable = 0;
        }
        
        heatmapData.push({
            date: new Date(d),
            dateKey,
            level,
            hours: dayHours,
            isPast: d < today
        });
    }
    
    // Check for period at end of year
    const minConsecutiveDays = settings?.availableMinDays ?? 3;
    if (consecutiveAvailable >= minConsecutiveDays && currentPeriodStart) {
        availablePeriods.push({
            start: currentPeriodStart,
            end: endDate,
            days: consecutiveAvailable
        });
    }
    
    // Filter available periods: remove past, adjust overlapping ones
    const futureAvailablePeriods = [];
    for (const p of availablePeriods) {
        if (p.end < today) continue; // Entirely in the past
        if (p.start < today) {
            // Adjust start to today, recalculate days
            const adjustedStart = new Date(today);
            const daysDiff = Math.round((p.end - adjustedStart) / (1000 * 60 * 60 * 24)) + 1;
            if (daysDiff >= (settings?.availableMinDays ?? 3)) {
                futureAvailablePeriods.push({ start: adjustedStart, end: p.end, days: daysDiff });
            }
        } else {
            futureAvailablePeriods.push(p);
        }
    }

    // Recalculate future available days for stats
    let futureAvailableDays = 0;
    for (const item of heatmapData) {
        if (!item.isPast && item.level === 0) futureAvailableDays++;
    }

    // Initialize year view mode if not set
    if (!state.yearViewMode) state.yearViewMode = 'heatmap';
    
    // Update navbar toggle state
    updateNavYearToggle();
    
    // Build header - just the legend (nav is in main navbar)
    let html = `
        <div class="year-header">
            <div class="year-legend" ${state.yearViewMode === 'glance' ? 'style="display:none"' : ''}>
                <span>Less</span>
                <div class="legend-box level-0"></div>
                <div class="legend-box level-1"></div>
                <div class="legend-box level-2"></div>
                <div class="legend-box level-3"></div>
                <div class="legend-box level-4"></div>
                <span>More</span>
            </div>
        </div>
    `;
    
    document.getElementById('weekHeader').innerHTML = html;
    
    let gridHtml = '<div class="year-view">';
    
    // Render based on view mode
    if (state.yearViewMode === 'glance') {
        gridHtml += renderYearAtGlance(year, months);
    } else {
        gridHtml += '<div class="year-heatmap">';
    
    // Month labels
    gridHtml += '<div class="heatmap-months">';
    months.forEach(m => {
        gridHtml += `<div class="heatmap-month-label">${m}</div>`;
    });
    gridHtml += '</div>';
    
    // Heatmap rows (7 rows for days of week)
    gridHtml += '<div class="heatmap-grid">';
    
    // Organize data by week columns
    const weeks = [];
    let currentWeek = [];
    const firstDayOfYear = new Date(year, 0, 1).getDay();
    
    // Pad first week
    for (let i = 0; i < (firstDayOfYear + 6) % 7; i++) {
        currentWeek.push(null);
    }
    
    heatmapData.forEach((day, idx) => {
        currentWeek.push(day);
        if (currentWeek.length === 7) {
            weeks.push(currentWeek);
            currentWeek = [];
        }
    });
    
    // Pad last week
    while (currentWeek.length > 0 && currentWeek.length < 7) {
        currentWeek.push(null);
    }
    if (currentWeek.length > 0) weeks.push(currentWeek);
    
    // Render by rows (days of week)
    for (let row = 0; row < 7; row++) {
        gridHtml += '<div class="heatmap-row">';
        weeks.forEach(week => {
            const day = week[row];
            if (day) {
                gridHtml += `<div class="heatmap-cell level-${day.level}${day.isPast ? ' past' : ''}" data-date="${day.dateKey}" title="${day.dateKey}: ${Math.round(day.hours)}h"></div>`;
            } else {
                gridHtml += '<div class="heatmap-cell empty"></div>';
            }
        });
        gridHtml += '</div>';
    }
    
    gridHtml += '</div></div>';
    } // end heatmap mode
    
    // Statistics panel
    gridHtml += `
        <div class="year-stats">
            <div class="stat-card">
                <div class="stat-value">${Math.round(totalHours)}</div>
                <div class="stat-label">Total Hours</div>
            </div>
            <div class="stat-card stat-available">
                <div class="stat-value">${futureAvailableDays}</div>
                <div class="stat-label">Available Days</div>
            </div>
            <div class="stat-card stat-travel">
                <div class="stat-value">${travelDays}</div>
                <div class="stat-label">Travel Days</div>
            </div>
            <div class="stat-card stat-rocks">
                <div class="stat-value">${bigRocks}</div>
                <div class="stat-label">Big Rocks</div>
            </div>
        </div>
    `;
    
    // Available periods
    const dispMinDays = settings?.availableMinDays ?? 3;
    const dispMaxHours = settings?.availableMaxHours ?? 2;
    if (futureAvailablePeriods.length > 0) {
        gridHtml += `
            <div class="year-periods">
                <div class="periods-header">
                    <span class="periods-icon">🔍</span>
                    <span>Available Periods (${dispMinDays}+ consecutive days with ≤${dispMaxHours}h/day)</span>
                </div>
                <div class="periods-list">
                    ${futureAvailablePeriods.slice(0, 5).map(p => {
                        const startStr = `${months[p.start.getMonth()]} ${p.start.getDate()}`;
                        const endStr = `${months[p.end.getMonth()]} ${p.end.getDate()}`;
                        return `<button class="period-btn" data-start="${formatDate(p.start)}">${startStr} - ${endStr} (${p.days}d)</button>`;
                    }).join('')}
                </div>
            </div>
        `;
    }
    
    gridHtml += '</div>';
    document.getElementById('timeGrid').innerHTML = gridHtml;
    
    // Event handlers for heatmap cells
    document.querySelectorAll('.heatmap-cell:not(.empty)').forEach(el => {
        el.addEventListener('click', () => {
            state.selectedDate = new Date(el.dataset.date + 'T00:00:00');
            state.viewMode = 'day';
            renderView();
        });
    });
    
    // Click handlers for year-at-a-glance cells
    document.querySelectorAll('.glance-cell:not(.invalid)').forEach(el => {
        el.addEventListener('click', () => {
            if (el.dataset.date) {
                state.selectedDate = new Date(el.dataset.date + 'T00:00:00');
                state.viewMode = 'day';
                renderView();
            }
        });
    });
    
    document.querySelectorAll('.period-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            state.selectedDate = new Date(btn.dataset.start + 'T00:00:00');
            state.weekStart = getWeekStart(state.selectedDate);
            state.viewMode = 'week';
            loadEvents(false, false);  // No spinner for view switching
        });
    });
}

function renderDayView(preserveScroll = true) {
    document.getElementById('dateTitle').textContent = formatDateDisplay(state.selectedDate);
    const dateKey = formatDate(state.selectedDate);
    const allDayEvents = getEventsForDate(dateKey).filter(e => !e.time);
    
    let html = `
        <div class="week-header-row">
            <div class="week-header-spacer"></div>
            <div class="week-day-header today">
                <div class="week-day-name">${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][state.selectedDate.getDay()]}</div>
                <div class="week-day-date">${state.selectedDate.getDate()}</div>
            </div>
        </div>
    `;
    
    // All-day events row for day view
    html += `
        <div class="all-day-row">
            <div class="all-day-label">All day</div>
            <div class="all-day-cell" data-date="${dateKey}">
    `;
    
    allDayEvents.forEach(event => {
        const color = event.color || getColorForCategory(event.category);
        const idx = (state.events[dateKey] || []).indexOf(event);
        const bgColor = getEventBackground(color);
        const textColor = getEventTextColor(color);
        const textStyle = textColor ? `color: ${textColor};` : '';
        const icsClass = event.source === 'ics' ? 'ics-event' : '';
        const icsDoneClass = event.icsDone ? 'ics-done' : '';
        html += `
            <div class="all-day-event ${event.state === 'DONE' ? 'done' : ''} ${icsClass} ${icsDoneClass}"
                 style="background: ${bgColor}; border-left-color: ${color}; ${textStyle}"
                 data-date="${dateKey}" data-event-idx="${idx}">
                ${event.title}
            </div>
        `;
    });
    
    html += '</div></div>';
    
    const header = document.getElementById('weekHeader');
    header.innerHTML = html;

    // Click handlers for all-day events
    header.querySelectorAll('.all-day-event').forEach(el => {
        const dateKey = el.dataset.date;
        const idx = parseInt(el.dataset.eventIdx);

        // Long press detection with movement tolerance
        let pressTimer;
        let touchStartX, touchStartY;
        const MOVE_TOLERANCE = 15;

        el.addEventListener('touchstart', (e) => {
            const touch = e.touches[0];
            touchStartX = touch.clientX;
            touchStartY = touch.clientY;
            pressTimer = setTimeout(() => {
                enterSelectionMode(dateKey, idx);
                if (navigator.vibrate) navigator.vibrate(50);
            }, 500);
        }, { passive: true });

        el.addEventListener('touchend', () => clearTimeout(pressTimer));
        el.addEventListener('touchmove', (e) => {
            const touch = e.touches[0];
            const dx = Math.abs(touch.clientX - touchStartX);
            const dy = Math.abs(touch.clientY - touchStartY);
            if (dx > MOVE_TOLERANCE || dy > MOVE_TOLERANCE) {
                clearTimeout(pressTimer);
            }
        }, { passive: true });

        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            enterSelectionMode(dateKey, idx);
        });

        el.addEventListener('click', (e) => {
            e.stopPropagation();

            if (state.selectionMode) {
                toggleSelection(dateKey, idx);
                return;
            }

            const event = state.events[dateKey][idx];
            showEventPopup(event, dateKey, e.clientX, e.clientY);
        });

        if (state.selectedEvents.has(`${dateKey}:${idx}`)) {
            el.classList.add('selected');
        }
    });

    renderTimeGrid(preserveScroll);
}

function renderView(shouldScroll = false) {
    renderMiniCalendar();
    renderParaFilters();
    renderCategories();
    
    // Ensure viewMode has a value (fallback to settings or week)
    if (!state.viewMode) {
        state.viewMode = settings?.defaultView || 'week';
    }
    
    // Update view switcher active state
    document.querySelectorAll('.view-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === state.viewMode);
    });
    
    // Show/hide year view toggle in navbar
    const navYearToggle = document.getElementById('navYearToggle');
    if (navYearToggle) {
        navYearToggle.hidden = state.viewMode !== 'year';
    }
    
    switch (state.viewMode) {
        case 'week':
            renderWeekHeader();
            renderTimeGrid(!shouldScroll);  // preserveScroll = opposite of shouldScroll
            break;
        case '3day':
            render3DayHeader();
            renderTimeGrid(!shouldScroll);
            break;
        case 'day':
            renderDayView(!shouldScroll);
            break;
        case 'agenda':
            renderAgendaView(shouldScroll);
            break;
        case 'month':
            renderMonthView();
            break;
        case 'year':
            renderYearView();
            break;
    }
}

// ==================== Event Popup ====================

function showEventPopup(event, dateKey, x, y) {
    state.selectedEvent = event;
    state.selectedEventDate = dateKey;
    
    const popup = document.getElementById('eventPopup');
    const color = event.color || getColorForCategory(event.category);
    const isIcs = event.source === 'ics' || event.readOnly;
    
    // Color bar
    document.getElementById('popupColor').style.background = color;
    
    // Source badge
    const sourceBadge = document.getElementById('popupSourceBadge');
    if (sourceBadge) {
        if (isIcs) {
            sourceBadge.textContent = 'External Calendar';
            sourceBadge.className = 'event-popup-source source-ics';
        } else {
            sourceBadge.textContent = 'Org Event';
            sourceBadge.className = 'event-popup-source source-org';
        }
    }
    
    // Title
    const titleEl = document.getElementById('popupTitle');
    titleEl.textContent = event.title;
    
    // Make title a link for ICS events with Google Calendar
    if (isIcs && event.uid) {
        const searchQuery = encodeURIComponent(event.title);
        const gcalUrl = `https://calendar.google.com/calendar/r/search?q=${searchQuery}`;
        titleEl.href = gcalUrl;
        titleEl.style.pointerEvents = 'auto';
        titleEl.style.cursor = 'pointer';
    } else {
        titleEl.removeAttribute('href');
        titleEl.style.pointerEvents = 'none';
        titleEl.style.cursor = 'default';
    }
    
    // Time display
    const eventDate = new Date(dateKey + 'T00:00:00');
    const timeText = event.time 
        ? `${formatDateDisplay(eventDate)}, ${formatTime12(event.time)}${event.endTime ? ' - ' + formatTime12(event.endTime) : ''}`
        : formatDateDisplay(eventDate);
    const timeValueEl = document.querySelector('.event-popup-time-value');
    if (timeValueEl) {
        timeValueEl.textContent = timeText;
    } else {
        // Fallback for old structure
        document.getElementById('popupTime').textContent = timeText;
    }
    
    // Category line
    const categoryLine = document.getElementById('popupCategoryLine');
    const categorySpan = categoryLine?.querySelector('span');
    if (isIcs) {
        const calName = event.ics_calendar || event.icsCalendar || event.category || 'External';
        if (categorySpan) {
            categorySpan.textContent = calName;
        } else {
            categoryLine.textContent = calName;
        }
        categoryLine.style.display = '';
    } else if (event.category) {
        if (categorySpan) {
            categorySpan.textContent = event.category;
        } else {
            categoryLine.textContent = event.category;
        }
        categoryLine.style.display = '';
    } else {
        categoryLine.style.display = 'none';
    }
    
    // Parent/Project line
    const parentLine = document.getElementById('popupParentLine');
    const parentSpan = parentLine?.querySelector('span');
    if (event.parent || event.project) {
        const parentText = event.parent || event.project;
        if (parentSpan) {
            parentSpan.textContent = parentText;
        } else {
            parentLine.textContent = parentText;
        }
        parentLine.style.display = '';
    } else {
        parentLine.style.display = 'none';
    }
    
    // File line and section
    const fileSection = document.getElementById('popupFileSection');
    const fileLine = document.getElementById('popupFileLine');
    const fileSpan = fileLine?.querySelector('span');
    const openEmacsBtn = document.getElementById('popupOpen');
    
    if (event.file && !isIcs) {
        const filename = event.file.split('/').pop();
        const fileText = `${filename}:${event.line || '?'}`;
        if (fileSpan) {
            fileSpan.textContent = fileText;
        } else {
            fileLine.textContent = fileText;
        }
        if (fileSection) fileSection.style.display = '';
        if (openEmacsBtn) openEmacsBtn.style.display = '';
    } else {
        if (fileSection) fileSection.style.display = 'none';
    }
    
    // Priority indicator
    const priorityEl = document.getElementById('popupPriority');
    if (event.priority) {
        priorityEl.textContent = event.priority;
        priorityEl.className = `priority-indicator priority-${event.priority.toLowerCase()}`;
        priorityEl.hidden = false;
    } else {
        priorityEl.hidden = true;
    }
    
    // State badge
    const stateBadge = document.getElementById('popupState');
    if (event.state) {
        stateBadge.textContent = event.state;
        stateBadge.className = `state-badge ${event.state.toLowerCase()}`;
        stateBadge.hidden = false;
    } else if (isIcs && event.icsDone) {
        stateBadge.textContent = 'DONE';
        stateBadge.className = 'state-badge done';
        stateBadge.hidden = false;
    } else {
        stateBadge.hidden = true;
    }
    
    // Notes section with checkboxes
    const notesSection = document.getElementById('popupNotesSection');
    const notesContent = document.getElementById('popupNotes');
    if (notesSection && notesContent) {
        if (event.notes) {
            const notesHtml = renderNotesWithCheckboxes(event.notes, event, isIcs);
            notesContent.innerHTML = notesHtml;
            notesSection.hidden = false;
            
            // Add click handlers for checkboxes (only for org events)
            if (!isIcs) {
                notesContent.querySelectorAll('.notes-checkbox-item input[type="checkbox"]').forEach((checkbox) => {
                    checkbox.addEventListener('change', async (e) => {
                        const item = e.target.closest('.notes-checkbox-item');
                        const index = parseInt(item.dataset.index);
                        const checked = e.target.checked;
                        
                        // Visual feedback
                        item.classList.add('saving');
                        item.classList.toggle('checked', checked);
                        
                        // Update backend
                        const success = await toggleCheckbox(event, index, checked);
                        
                        item.classList.remove('saving');
                        
                        if (!success) {
                            // Revert on failure
                            e.target.checked = !checked;
                            item.classList.toggle('checked', !checked);
                        } else {
                            // Update the event object so re-renders are consistent
                            // Re-fetch events in background
                            loadEvents(false, false);
                        }
                    });
                });
            }
        } else {
            notesSection.hidden = true;
        }
    }
    
    // ICS Notice
    const icsNotice = document.getElementById('popupIcsNotice');
    if (icsNotice) {
        icsNotice.hidden = !isIcs;
    }
    
    // Show/hide action sections based on event type
    const orgActions = document.getElementById('popupActionsOrg');
    const icsActions = document.getElementById('popupActionsIcs');
    
    if (orgActions && icsActions) {
        if (isIcs) {
            orgActions.hidden = true;
            icsActions.hidden = false;
            
            // Update ICS mark done button
            const icsMarkDone = document.getElementById('popupIcsMarkDone');
            if (icsMarkDone) {
                const labelSpan = icsMarkDone.querySelector('span');
                if (event.icsDone) {
                    icsMarkDone.classList.add('done');
                    if (labelSpan) labelSpan.textContent = 'Undo';
                } else {
                    icsMarkDone.classList.remove('done');
                    if (labelSpan) labelSpan.textContent = 'Done';
                }
            }
            
            // Set up Open in Calendar button
            const openCalBtn = document.getElementById('popupOpenCalendar');
            if (openCalBtn && event.uid) {
                const searchQuery = encodeURIComponent(event.title);
                openCalBtn.onclick = () => {
                    window.open(`https://calendar.google.com/calendar/r/search?q=${searchQuery}`, '_blank');
                };
            }
        } else {
            orgActions.hidden = false;
            icsActions.hidden = true;
            
            // Update org mark done button
            const markDoneBtn = document.getElementById('popupMarkDone');
            if (markDoneBtn) {
                const labelSpan = markDoneBtn.querySelector('span');
                if (event.state === 'DONE') {
                    markDoneBtn.classList.add('done');
                    if (labelSpan) labelSpan.textContent = 'Undo';
                } else {
                    markDoneBtn.classList.remove('done');
                    if (labelSpan) labelSpan.textContent = 'Done';
                }
            }
        }
    }
    
    // Position popup - show it first to measure height
    popup.hidden = false;

    // Get the actual content element for positioning
    const popupContent = popup.querySelector('.event-popup-content');

    // On mobile, let CSS handle centering; only do JS positioning on desktop
    if (window.innerWidth <= 768) {
        popupContent.style.left = '';
        popupContent.style.top = '';
        popupContent.style.transform = '';
        popupContent.style.maxHeight = '';
        popupContent.style.overflowY = '';
    } else {
        popupContent.style.visibility = 'hidden';

        const popupRect = popupContent.getBoundingClientRect();
        const popupWidth = popupRect.width || 320;
        const popupHeight = popupRect.height || 400;

        // Calculate position
        let left = x;
        let top = y;

        // Check horizontal bounds
        if (left + popupWidth > window.innerWidth - 16) {
            left = window.innerWidth - popupWidth - 16;
        }
        left = Math.max(16, left);

        // Check vertical bounds - if not enough space below, position above
        if (top + popupHeight > window.innerHeight - 16) {
            // Try positioning above the click point
            top = y - popupHeight - 10;
            if (top < 16) {
                // If still not enough space, position at top with scroll
                top = 16;
            }
        }
        top = Math.max(16, top);

        popupContent.style.left = `${left}px`;
        popupContent.style.top = `${top}px`;
        popupContent.style.transform = 'none'; // Remove centering transform
        popupContent.style.visibility = 'visible';
        popupContent.style.maxHeight = `${window.innerHeight - 32}px`;
        popupContent.style.overflowY = 'auto';
    }
}

function hideEventPopup() {
    const popup = document.getElementById('eventPopup');
    popup.hidden = true;
    // Reset content positioning for next show
    const popupContent = popup.querySelector('.event-popup-content');
    if (popupContent) {
        popupContent.style.left = '';
        popupContent.style.top = '';
        popupContent.style.transform = '';
        popupContent.style.visibility = '';
    }
    document.getElementById('snoozeDropdown').hidden = true;
    state.selectedEvent = null;
}

// Event tooltip
let tooltipTimeout = null;

function showEventTooltip(event, dateKey, x, y) {
    // Remove existing tooltip
    hideEventTooltip();
    
    const tooltip = document.createElement('div');
    tooltip.className = 'event-tooltip';
    tooltip.id = 'eventTooltip';
    
    const color = event.color || getColorForCategory(event.category);
    tooltip.style.borderLeftColor = color;
    
    let html = `<div class="event-tooltip-title">${event.title}</div>`;
    if (event.time) {
        html += `<div class="event-tooltip-time">${formatTime12(event.time)}${event.endTime ? ' - ' + formatTime12(event.endTime) : ''}</div>`;
    }
    if (event.parent || event.project) {
        html += `<div class="event-tooltip-parent">📂 ${event.parent || event.project}</div>`;
    }
    if (event.ics_calendar || event.icsCalendar) {
        html += `<div class="event-tooltip-category">${event.ics_calendar || event.icsCalendar} (External)</div>`;
    } else if (event.category) {
        html += `<div class="event-tooltip-category">${event.category}</div>`;
    }
    if (event.state === 'DONE') {
        html += `<div class="event-tooltip-status">(Completed)</div>`;
    }
    if (event.source === 'ics' || event.readOnly) {
        html += `<div class="event-tooltip-hint">External calendar (read-only)</div>`;
    } else {
        html += `<div class="event-tooltip-hint">Click for options</div>`;
    }
    
    tooltip.innerHTML = html;
    
    // Position
    let left = x + 12;
    let top = y + 12;
    if (left + 280 > window.innerWidth) left = x - 292;
    if (top + 150 > window.innerHeight) top = y - 162;
    
    tooltip.style.left = `${Math.max(8, left)}px`;
    tooltip.style.top = `${Math.max(8, top)}px`;
    
    document.body.appendChild(tooltip);
}

function hideEventTooltip() {
    const existing = document.getElementById('eventTooltip');
    if (existing) existing.remove();
    if (tooltipTimeout) {
        clearTimeout(tooltipTimeout);
        tooltipTimeout = null;
    }
}

// ==================== Modals ====================

function showCreateModal(date = null) {
    const modal = document.getElementById('createModal');
    document.getElementById('eventDate').value = date || formatDate(new Date());
    document.getElementById('eventTitle').value = '';
    document.getElementById('eventTime').value = '';
    document.getElementById('eventEndTime').value = '';
    document.getElementById('eventType').value = 'scheduled';
    document.getElementById('eventPriority').value = '';
    document.getElementById('eventNotes').value = '';
    modal.hidden = false;
    document.getElementById('eventTitle').focus();
}

function hideCreateModal() {
    document.getElementById('createModal').hidden = true;
}

function showEditModal(event, dateKey) {
    // Store the event being edited
    state.selectedEvent = event;
    state.selectedEventDate = dateKey;
    
    const modal = document.getElementById('editModal');
    document.getElementById('editTitle').value = event.title || '';
    document.getElementById('editDate').value = dateKey;
    document.getElementById('editTime').value = event.time || '';
    document.getElementById('editEndTime').value = event.endTime || '';
    document.getElementById('editType').value = event.type || 'scheduled';
    document.getElementById('editRepeat').value = event.repeat || '';
    document.getElementById('editLocation').value = event.location || '';
    document.getElementById('editPriority').value = event.priority || '';
    document.getElementById('editTags').value = event.tags || '';
    document.getElementById('editNotes').value = event.notes || '';
    
    // Set state via chips
    setEditStateChip(event.state || '');
    
    // Populate category dropdown
    populateCategoryDropdown(event.category || '');
    
    // Populate refile dropdown with current location as default
    populateRefileDropdown(event);
    
    // File info
    const fileInfo = document.getElementById('editFileInfo');
    if (event.file) {
        const filename = event.file.split('/').pop();
        document.getElementById('editFileName').textContent = filename;
        document.getElementById('editFileLine').textContent = event.line || '?';
        fileInfo.style.display = '';
    } else {
        fileInfo.style.display = 'none';
    }
    
    // Reset advanced section to collapsed
    const advanced = document.getElementById('editAdvanced');
    const toggle = document.getElementById('editToggleAdvanced');
    if (advanced) advanced.hidden = true;
    if (toggle) {
        toggle.classList.remove('is-expanded');
        const text = toggle.querySelector('.edit-modal__toggle-text');
        if (text) text.textContent = 'More options';
    }
    
    modal.hidden = false;
    document.getElementById('editTitle').focus();
}

// Set state dropdown value in edit modal
function setEditStateChip(stateValue) {
    const select = document.getElementById('editState');
    if (select) select.value = stateValue || '';
}

// Populate category dropdown with existing categories
function populateCategoryDropdown(selectedCategory) {
    const select = document.getElementById('editCategory');
    const categories = new Set();
    
    // Collect all unique categories from events
    Object.values(state.events).forEach(dayEvents => {
        dayEvents.forEach(e => {
            if (e.category) categories.add(e.category);
        });
    });
    
    // Sort categories
    const sortedCategories = Array.from(categories).sort();
    
    // Build options
    let html = '<option value="">No category</option>';
    sortedCategories.forEach(cat => {
        const selected = cat === selectedCategory ? 'selected' : '';
        html += `<option value="${cat}" ${selected}>${cat}</option>`;
    });
    
    // Add option for current category if not in list
    if (selectedCategory && !categories.has(selectedCategory)) {
        html += `<option value="${selectedCategory}" selected>${selectedCategory}</option>`;
    }
    
    select.innerHTML = html;
}

// Refile combobox state
let refileTargets = [];
let refileSelectedIndex = -1;
const REFILE_RECENT_KEY = 'org-calendar-refile-recent';
const MAX_RECENT_REFILE = 5;

// Get recent refile targets from localStorage
function getRecentRefileTargets() {
    try {
        return JSON.parse(localStorage.getItem(REFILE_RECENT_KEY) || '[]');
    } catch {
        return [];
    }
}

// Save a refile target to recent list
function saveRecentRefileTarget(value, heading) {
    if (!value) return;
    const recent = getRecentRefileTargets();
    // Remove if already exists
    const filtered = recent.filter(r => r.value !== value);
    // Add to front
    filtered.unshift({ value, heading });
    // Keep only MAX_RECENT_REFILE
    localStorage.setItem(REFILE_RECENT_KEY, JSON.stringify(filtered.slice(0, MAX_RECENT_REFILE)));
}

// Extract filename from path for display
function getFileName(filePath) {
    return filePath.split('/').pop().replace('.org', '');
}

// Highlight matching text
function highlightMatch(text, query) {
    if (!query) return text;
    const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return text.replace(regex, '<span class="refile-combobox__match">$1</span>');
}

// Match score - returns score (higher is better) or 0 if no match
// Supports: exact substring, orderless words, and fuzzy character matching
function matchScore(text, query) {
    if (!query || query.trim() === '') return 100;

    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase().trim();

    // 1. Exact substring match - highest priority
    if (lowerText.includes(lowerQuery)) {
        // Bonus if match is at word boundary
        const idx = lowerText.indexOf(lowerQuery);
        const atBoundary = idx === 0 || /[\s\/]/.test(lowerText[idx - 1]);
        return atBoundary ? 150 : 100;
    }

    // 2. Orderless word matching - all words must appear
    const words = lowerQuery.split(/[\s\/]+/).filter(w => w.length > 0);
    if (words.length > 1) {
        let allFound = true;
        let score = 0;
        for (const word of words) {
            if (lowerText.includes(word)) {
                score += 80;
            } else {
                // Try fuzzy match for this word
                const fuzzyScore = fuzzyCharMatch(lowerText, word);
                if (fuzzyScore > 0) {
                    score += fuzzyScore;
                } else {
                    allFound = false;
                    break;
                }
            }
        }
        if (allFound) return score / words.length;
    }

    // 3. Fuzzy character match - chars in order
    return fuzzyCharMatch(lowerText, lowerQuery);
}

// Fuzzy character matching - all query chars must appear in order
function fuzzyCharMatch(text, query) {
    let queryIdx = 0;
    let consecutive = 0;
    let maxConsecutive = 0;

    for (let i = 0; i < text.length && queryIdx < query.length; i++) {
        if (text[i] === query[queryIdx]) {
            queryIdx++;
            consecutive++;
            maxConsecutive = Math.max(maxConsecutive, consecutive);
        } else {
            consecutive = 0;
        }
    }

    // All chars matched in order
    if (queryIdx === query.length) {
        return 30 + maxConsecutive * 5;
    }

    return 0;
}

// Render refile dropdown list
function renderRefileList(query = '') {
    const list = document.getElementById('refileList');
    const dropdown = document.getElementById('refileDropdown');
    if (!list || !dropdown) return;

    const recent = getRecentRefileTargets();
    const recentValues = new Set(recent.map(r => r.value));

    // Filter and score targets
    let filtered = refileTargets.map(t => {
        const score = matchScore(t.heading, query);
        return { ...t, score };
    }).filter(t => t.score > 0);

    // Sort by score (highest first)
    filtered.sort((a, b) => b.score - a.score);

    // Limit results for performance
    const maxResults = 100;
    filtered = filtered.slice(0, maxResults);

    let html = '';

    // "Don't refile" option
    html += `<div class="refile-combobox__item refile-combobox__item--none" data-value="" data-index="-1">
        Don't refile
    </div>`;

    // Recent items (only if no query)
    if (!query && recent.length > 0) {
        html += '<div class="refile-combobox__group-label">Recent</div>';
        recent.forEach((r, i) => {
            const target = refileTargets.find(t => `${t.file}|||${t.heading}` === r.value);
            if (target) {
                html += `<div class="refile-combobox__item refile-combobox__item--recent" data-value="${r.value}" data-index="${i}">
                    <span class="refile-combobox__heading">${target.heading}</span>
                    <span class="refile-combobox__file">${getFileName(target.file)}</span>
                </div>`;
            }
        });
        html += '<div class="refile-combobox__separator"></div>';
    }

    // All matching results
    if (filtered.length > 0) {
        if (query) {
            html += `<div class="refile-combobox__group-label">${filtered.length} matches</div>`;
        }
        filtered.forEach((t, i) => {
            const value = `${t.file}|||${t.heading}`;
            const isRecent = recentValues.has(value);
            if (isRecent && !query) return; // Skip recent items in main list when not searching
            const idx = query ? i : (recent.length + i);
            html += `<div class="refile-combobox__item${isRecent ? ' refile-combobox__item--recent' : ''}" data-value="${value}" data-index="${idx}">
                <span class="refile-combobox__heading">${highlightMatch(t.heading, query)}</span>
                <span class="refile-combobox__file">${getFileName(t.file)}</span>
            </div>`;
        });
    } else if (query) {
        html += '<div class="refile-combobox__item refile-combobox__item--none">No matches found</div>';
    }

    list.innerHTML = html;
    refileSelectedIndex = -1;

    // Attach click handlers
    list.querySelectorAll('.refile-combobox__item[data-value]').forEach(item => {
        item.addEventListener('click', () => {
            selectRefileItem(item.dataset.value);
        });
    });

    dropdown.hidden = false;
}

// Select a refile item
function selectRefileItem(value) {
    const input = document.getElementById('editRefileInput');
    const hidden = document.getElementById('editRefile');
    const dropdown = document.getElementById('refileDropdown');

    if (value) {
        const target = refileTargets.find(t => `${t.file}|||${t.heading}` === value);
        if (target) {
            input.value = target.heading;
            saveRecentRefileTarget(value, target.heading);
        }
    } else {
        input.value = '';
    }

    hidden.value = value;
    dropdown.hidden = true;
    refileSelectedIndex = -1;
}

// Handle keyboard navigation in refile combobox
function handleRefileKeydown(e) {
    const dropdown = document.getElementById('refileDropdown');
    const list = document.getElementById('refileList');

    // Open dropdown on arrow keys if hidden
    if (!dropdown || dropdown.hidden) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            renderRefileList(e.target.value);
            e.preventDefault();
            // Select first item after opening
            const items = list.querySelectorAll('.refile-combobox__item[data-value]');
            if (items.length > 0) {
                refileSelectedIndex = 0;
                updateRefileSelection(items);
            }
        }
        return;
    }

    const items = list.querySelectorAll('.refile-combobox__item[data-value]');
    const maxIndex = items.length - 1;

    switch (e.key) {
        case 'ArrowDown':
            e.preventDefault();
            refileSelectedIndex = Math.min(refileSelectedIndex + 1, maxIndex);
            updateRefileSelection(items);
            break;
        case 'ArrowUp':
            e.preventDefault();
            refileSelectedIndex = Math.max(refileSelectedIndex - 1, 0);
            updateRefileSelection(items);
            break;
        case 'Enter':
            e.preventDefault();
            if (refileSelectedIndex >= 0 && items[refileSelectedIndex]) {
                selectRefileItem(items[refileSelectedIndex].dataset.value);
            } else if (items.length > 0) {
                selectRefileItem(items[0].dataset.value);
            }
            break;
        case 'Escape':
            dropdown.hidden = true;
            refileSelectedIndex = -1;
            break;
        case 'Tab':
            // Select current item and allow tab to move focus
            if (refileSelectedIndex >= 0 && items[refileSelectedIndex]) {
                selectRefileItem(items[refileSelectedIndex].dataset.value);
            }
            break;
    }
}

// Update visual selection
function updateRefileSelection(items) {
    items.forEach((item, i) => {
        item.classList.toggle('is-selected', i === refileSelectedIndex);
        if (i === refileSelectedIndex) {
            item.scrollIntoView({ block: 'nearest' });
        }
    });
}

// Build current location string from event (matches refile target format)
function buildCurrentLocation(event) {
    if (!event || !event.file) return null;
    const fileName = event.file.split('/').pop();
    if (event.parent) {
        // Format: filename/outline-path (e.g., areas.org/Others/Friends & family)
        return `${fileName}/${event.parent}`;
    }
    return fileName;
}

// Find matching refile target for current event location
function findCurrentRefileTarget(event) {
    if (!event || !event.file) return null;
    const fileName = event.file.split('/').pop();

    // Build expected heading format: filename/outline-path
    if (event.parent) {
        const expectedHeading = `${fileName}/${event.parent}`;
        // Try exact match first
        let target = refileTargets.find(t =>
            t.file === event.file && t.heading === expectedHeading
        );
        if (target) return target;

        // Try finding target that ends with the parent path (for nested matches)
        target = refileTargets.find(t =>
            t.file === event.file && t.heading.endsWith(event.parent)
        );
        if (target) return target;
    }

    // Fall back to file-level target
    const fileTarget = refileTargets.find(t =>
        t.file === event.file && t.heading === fileName
    );
    return fileTarget;
}

// Store original location to detect if refile is actually needed
let originalRefileLocation = null;

// Populate refile targets from API
async function populateRefileDropdown(event = null) {
    const input = document.getElementById('editRefileInput');
    const hidden = document.getElementById('editRefile');

    if (input) {
        input.value = '';
        input.placeholder = 'Loading...';
    }
    if (hidden) hidden.value = '';
    originalRefileLocation = null;

    try {
        const response = await fetch(`${API_BASE}/api/refile-targets`);
        if (response.ok) {
            const data = await response.json();
            refileTargets = data.targets || [];

            if (input) {
                input.placeholder = refileTargets.length > 0
                    ? `Type to search ${refileTargets.length} targets...`
                    : 'No refile targets available';
            }

            // Set current location as placeholder hint (but don't set as value)
            if (event && event.file) {
                const currentLocation = buildCurrentLocation(event);
                if (currentLocation && input) {
                    input.placeholder = `Current: ${currentLocation}`;
                }

                // Store the current location to compare later
                const matchingTarget = findCurrentRefileTarget(event);
                if (matchingTarget) {
                    originalRefileLocation = `${matchingTarget.file}|||${matchingTarget.heading}`;
                }
            }
        } else {
            console.warn('Refile targets API returned:', response.status, response.statusText);
            if (input) input.placeholder = 'Failed to load targets';
        }
    } catch (e) {
        console.warn('Failed to load refile targets:', e);
        if (input) input.placeholder = 'Failed to load targets';
    }
}

// Initialize refile combobox event listeners
function initRefileCombobox() {
    const input = document.getElementById('editRefileInput');
    const dropdown = document.getElementById('refileDropdown');

    if (!input) return;

    // Filter on input
    input.addEventListener('input', (e) => {
        renderRefileList(e.target.value);
    });

    // Show dropdown on focus
    input.addEventListener('focus', () => {
        renderRefileList(input.value);
    });

    // Keyboard navigation
    input.addEventListener('keydown', handleRefileKeydown);

    // Hide dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#refileCombobox') && dropdown) {
            dropdown.hidden = true;
        }
    });
}

function hideEditModal() {
    document.getElementById('editModal').hidden = true;
}

// ==================== Shortcuts & Command Palette ====================

function showShortcutsModal() {
    document.getElementById('shortcutsModal').hidden = false;
}

function hideShortcutsModal() {
    document.getElementById('shortcutsModal').hidden = true;
}

const commands = [
    // Actions
    { id: 'new-event', title: 'New Event', desc: 'Create a new event', shortcut: 'C', icon: '➕', action: () => showCreateModal() },
    { id: 'today', title: 'Go to Today', desc: 'Jump to current date', shortcut: 'T', icon: '📅', action: () => goToToday() },
    { id: 'refresh', title: 'Refresh Events', desc: 'Reload events from Emacs', shortcut: 'R', icon: '🔄', action: () => { showToast('Refreshing...', 'info'); const btn = document.getElementById('refreshBtn'); btn.classList.add('spinning'); loadEvents(true, false).finally(() => btn.classList.remove('spinning')); } },
    { id: 'search', title: 'Search', desc: 'Search events', shortcut: '/', icon: '🔍', action: () => document.getElementById('searchBtn').click() },
    
    // Views
    { id: 'week-view', title: 'Week View', desc: 'Switch to week view', shortcut: 'W', icon: '📆', action: () => switchView('week') },
    { id: '3day-view', title: '3-Day View', desc: 'Switch to 3-day view', shortcut: '3', icon: '📅', action: () => switchView('3day') },
    { id: 'day-view', title: 'Day View', desc: 'Switch to day view', shortcut: 'D', icon: '📋', action: () => switchView('day') },
    { id: 'month-view', title: 'Month View', desc: 'Switch to month view', shortcut: 'M', icon: '🗓️', action: () => switchView('month') },
    { id: 'year-view', title: 'Year View', desc: 'Switch to year heatmap', shortcut: 'Y', icon: '📊', action: () => switchView('year') },
    { id: 'agenda-view', title: 'Agenda View', desc: 'Switch to agenda view', shortcut: 'A', icon: '📝', action: () => { state.selectedDate = new Date(); switchView('agenda'); } },
    
    // Navigation
    { id: 'next-period', title: 'Next Period', desc: 'Go to next week/month/day', shortcut: 'N / →', icon: '▶', action: () => navigate(1) },
    { id: 'prev-period', title: 'Previous Period', desc: 'Go to previous week/month/day', shortcut: 'P / ←', icon: '◀', action: () => navigate(-1) },
    
    // UI
    { id: 'toggle-sidebar', title: 'Toggle Sidebar', desc: 'Show/hide the sidebar', shortcut: 'B', icon: '📌', action: () => toggleSidebar() },
    { id: 'settings', title: 'Settings', desc: 'Open settings', shortcut: ',', icon: '⚙️', action: () => showSettingsModal() },
    { id: 'shortcuts', title: 'Keyboard Shortcuts', desc: 'Show all shortcuts', shortcut: '?', icon: '⌨️', action: () => showShortcutsModal() },
    
    // Data
    { id: 'reset', title: 'Reset Local Data', desc: 'Clear cache and reload from server', shortcut: '', icon: '🗑️', action: () => resetLocalData() },
];

let commandSelectedIndex = 0;
let filteredCommands = [...commands];

function showCommandPalette() {
    const palette = document.getElementById('commandPalette');
    const input = document.getElementById('commandInput');
    
    palette.hidden = false;
    input.value = '';
    commandSelectedIndex = 0;
    filteredCommands = [...commands];
    renderCommandList();
    input.focus();
}

function hideCommandPalette() {
    document.getElementById('commandPalette').hidden = true;
}

function renderCommandList() {
    const list = document.getElementById('commandList');
    list.innerHTML = filteredCommands.map((cmd, i) => `
        <div class="command-item ${i === commandSelectedIndex ? 'selected' : ''}" data-index="${i}">
            <div class="command-item-icon">${cmd.icon}</div>
            <div class="command-item-text">
                <div class="command-item-title">${cmd.title}</div>
                <div class="command-item-desc">${cmd.desc}</div>
            </div>
            ${cmd.shortcut ? `<div class="command-item-shortcut">${cmd.shortcut}</div>` : ''}
        </div>
    `).join('');
    
    // Add click handlers
    list.querySelectorAll('.command-item').forEach(item => {
        item.addEventListener('click', () => {
            const index = parseInt(item.dataset.index);
            executeCommand(filteredCommands[index]);
        });
    });
}

function executeCommand(cmd) {
    hideCommandPalette();
    if (cmd && cmd.action) {
        cmd.action();
    }
}

function initCommandPalette() {
    const input = document.getElementById('commandInput');
    const palette = document.getElementById('commandPalette');
    
    input.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        filteredCommands = commands.filter(cmd => 
            cmd.title.toLowerCase().includes(query) || 
            cmd.desc.toLowerCase().includes(query)
        );
        commandSelectedIndex = 0;
        renderCommandList();
    });
    
    input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            commandSelectedIndex = Math.min(commandSelectedIndex + 1, filteredCommands.length - 1);
            renderCommandList();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            commandSelectedIndex = Math.max(commandSelectedIndex - 1, 0);
            renderCommandList();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            executeCommand(filteredCommands[commandSelectedIndex]);
        }
    });
    
    // Close on background click
    palette.addEventListener('click', (e) => {
        if (e.target === palette) {
            hideCommandPalette();
        }
    });
    
    // Shortcuts modal close
    document.getElementById('shortcutsModalClose').addEventListener('click', hideShortcutsModal);
    document.getElementById('shortcutsModal').addEventListener('click', (e) => {
        if (e.target.id === 'shortcutsModal') {
            hideShortcutsModal();
        }
    });
}

// ==================== Event Loading ====================

async function loadEvents(refresh = false, showSpinner = true) {
    if (showSpinner) showLoading(true);
    try {
        let startDate, endDate;
        
        if (state.viewMode === 'year') {
            // Load entire year
            startDate = new Date(state.weekStart.getFullYear(), 0, 1);
            endDate = new Date(state.weekStart.getFullYear(), 11, 31);
            prefetchedYears.add(state.weekStart.getFullYear());
        } else if (state.viewMode === 'month') {
            startDate = new Date(state.weekStart.getFullYear(), state.weekStart.getMonth(), 1);
            endDate = new Date(state.weekStart.getFullYear(), state.weekStart.getMonth() + 1, 0);
        } else if (state.viewMode === 'agenda') {
            // Load events from 7 days before to 30 days after selected date
            startDate = new Date(state.selectedDate || new Date());
            startDate.setDate(startDate.getDate() - 7);
            endDate = new Date(state.selectedDate || new Date());
            endDate.setDate(endDate.getDate() + 30);
        } else if (state.viewMode === 'day') {
            // Preload adjacent days for smooth navigation
            startDate = new Date(state.selectedDate);
            startDate.setDate(startDate.getDate() - 3);
            endDate = new Date(state.selectedDate);
            endDate.setDate(endDate.getDate() + 3);
        } else if (state.viewMode === '3day') {
            // Preload extra days for smooth navigation
            startDate = new Date(state.selectedDate);
            startDate.setDate(startDate.getDate() - 3);
            endDate = new Date(state.selectedDate);
            endDate.setDate(endDate.getDate() + 5);
        } else {
            startDate = state.weekStart;
            endDate = new Date(state.weekStart);
            endDate.setDate(endDate.getDate() + 6);
        }
        
        // Show cached data immediately while fetching (stale-while-revalidate pattern)
        const cachedEvents = loadEventsFromCache();
        if (Object.keys(cachedEvents).length > 0) {
            // Merge cached events with current state for immediate display
            state.events = { ...state.events, ...cachedEvents };
            renderView();
            // If we have cached data and showing spinner, hide it since we have something to show
            if (showSpinner) showLoading(false);
        }

        const events = await fetchEvents(formatDate(startDate), formatDate(endDate), refresh);
        
        if (refresh) {
            // When refreshing, clear events for the date range before merging
            // This prevents duplicates when events are updated
            const newEvents = { ...state.events };
            Object.keys(events || {}).forEach(dateKey => {
                newEvents[dateKey] = events[dateKey];
            });
            state.events = newEvents;
        } else {
            // Merge new events with existing state
            state.events = { ...state.events, ...(events || {}) };
        }
        renderView();

        // Prefetch adjacent years in background when viewing year
        if (state.viewMode === 'year') {
            prefetchAdjacentYears(state.weekStart.getFullYear());
        }
    } catch (error) {
        console.error('Error loading events:', error);
        showToast('Failed to load events', 'error');
    } finally {
        if (showSpinner) showLoading(false);
    }
}

// ==================== Adjacent Year Prefetch ====================

// Track which years have been prefetched this session to avoid redundant fetches
const prefetchedYears = new Set();

function prefetchAdjacentYears(currentYear) {
    if (!isOnline()) return;

    const years = [currentYear - 1, currentYear + 1];
    const toPrefetch = years.filter(y => !prefetchedYears.has(y));
    if (toPrefetch.length === 0) return;

    const schedule = typeof requestIdleCallback === 'function'
        ? (fn) => requestIdleCallback(fn, { timeout: 5000 })
        : (fn) => setTimeout(fn, 1000);

    toPrefetch.forEach(year => {
        schedule(async () => {
            // Check again in case conditions changed
            if (prefetchedYears.has(year) || !isOnline()) return;
            prefetchedYears.add(year);

            const start = formatDate(new Date(year, 0, 1));
            const end = formatDate(new Date(year, 11, 31));
            console.log(`Prefetching year ${year} in background`);

            try {
                const events = await fetchEvents(start, end, false);
                if (events && Object.keys(events).length > 0) {
                    // Merge into state silently (no re-render — user hasn't navigated there yet)
                    state.events = { ...state.events, ...events };
                }
            } catch (e) {
                // Silent failure — prefetch is best-effort
                prefetchedYears.delete(year);
                console.warn(`Prefetch year ${year} failed:`, e);
            }
        });
    });
}

// ==================== Navigation ====================

function navigate(direction) {
    if (state.viewMode === 'year') {
        state.weekStart.setFullYear(state.weekStart.getFullYear() + direction);
    } else if (state.viewMode === 'month') {
        state.weekStart.setMonth(state.weekStart.getMonth() + direction);
    } else if (state.viewMode === 'day') {
        state.selectedDate.setDate(state.selectedDate.getDate() + direction);
    } else if (state.viewMode === '3day') {
        // Navigate by 3 days
        state.selectedDate = state.selectedDate || new Date();
        state.selectedDate.setDate(state.selectedDate.getDate() + (direction * 3));
    } else if (state.viewMode === 'agenda') {
        // Navigate by week in agenda view
        state.selectedDate = state.selectedDate || new Date();
        state.selectedDate.setDate(state.selectedDate.getDate() + (direction * 7));
    } else {
        state.weekStart.setDate(state.weekStart.getDate() + (direction * 7));
    }
    syncMiniCalendarToView();  // Keep mini calendar in sync
    renderView(true);  // Scroll to today on navigation
    loadEvents(false, false);
}

function goToToday() {
    const today = new Date();
    state.selectedDate = new Date(today);
    state.weekStart = getWeekStart(today);
    syncMiniCalendarToView();  // Keep mini calendar in sync
    renderView(true);  // Scroll to today
    loadEvents(false, false);
}

function switchView(viewMode) {
    const viewNames = {
        'week': 'Week',
        '3day': '3-Day',
        'day': 'Day',
        'agenda': 'Agenda',
        'month': 'Month',
        'year': 'Year'
    };
    
    // Close any open popups and tooltips when switching views
    hideEventPopup();
    hideEventTooltip();
    
    state.viewMode = viewMode;
    renderView(true);  // Scroll to today on view switch
    showToast(`${viewNames[viewMode] || viewMode} view`, 'info');
    loadEvents(false, false);
}

// ==================== Initialize ====================

function init() {
    // Navigation
    document.getElementById('prevBtn').addEventListener('click', () => navigate(-1));
    document.getElementById('nextBtn').addEventListener('click', () => navigate(1));
    document.getElementById('todayBtn').addEventListener('click', goToToday);
    document.getElementById('refreshBtn').addEventListener('click', () => {
        showToast('Refreshing...', 'info');
        const btn = document.getElementById('refreshBtn');
        btn.classList.add('spinning');
        loadEvents(true, false).finally(() => btn.classList.remove('spinning'));
    });
    
    // View menu dropdown
    document.getElementById('viewMenuBtn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const menu = document.getElementById('viewMenu');
        menu.hidden = !menu.hidden;
        
        // Update active state
        menu.querySelectorAll('.view-menu-item[data-view]').forEach(item => {
            item.classList.toggle('active', item.dataset.view === state.viewMode);
        });
    });
    
    document.querySelectorAll('.view-menu-item[data-view]').forEach(item => {
        item.addEventListener('click', () => {
            // Reset selectedDate to today when switching to agenda view
            if (item.dataset.view === 'agenda') {
                state.selectedDate = new Date();
            }
            document.getElementById('viewMenu').hidden = true;
            switchView(item.dataset.view);
        });
    });
    
    document.getElementById('showShortcutsBtn')?.addEventListener('click', () => {
        document.getElementById('viewMenu').hidden = true;
        showShortcutsModal();
    });
    
    // Close menu on outside click
    document.addEventListener('click', (e) => {
        const menu = document.getElementById('viewMenu');
        const btn = document.getElementById('viewMenuBtn');
        if (menu && !menu.hidden && !menu.contains(e.target) && !btn?.contains(e.target)) {
            menu.hidden = true;
        }
    });
    
    // Mini calendar navigation
    document.getElementById('miniPrevBtn').addEventListener('click', () => {
        if (!state.miniCalendarMonth) state.miniCalendarMonth = new Date();
        state.miniCalendarMonth = new Date(state.miniCalendarMonth.getFullYear(), state.miniCalendarMonth.getMonth() - 1, 1);
        renderMiniCalendar();
    });
    document.getElementById('miniNextBtn').addEventListener('click', () => {
        if (!state.miniCalendarMonth) state.miniCalendarMonth = new Date();
        state.miniCalendarMonth = new Date(state.miniCalendarMonth.getFullYear(), state.miniCalendarMonth.getMonth() + 1, 1);
        renderMiniCalendar();
    });
    
    // Menu button (mobile sidebar toggle)
    document.getElementById('menuBtn').addEventListener('click', toggleSidebar);
    
    // Categories collapse toggle
    document.getElementById('categoriesHeader')?.addEventListener('click', () => {
        const section = document.getElementById('categoriesSection');
        section.classList.toggle('collapsed');
        // Save preference
        localStorage.setItem('categoriesCollapsed', section.classList.contains('collapsed'));
    });
    
    // Restore categories collapsed state
    if (localStorage.getItem('categoriesCollapsed') === 'true') {
        document.getElementById('categoriesSection')?.classList.add('collapsed');
    }
    
    // PARA section collapse toggles
    document.querySelectorAll('.para-header').forEach(header => {
        header.addEventListener('click', () => {
            const paraType = header.dataset.para;
            const section = header.closest('.para-section');
            section.classList.toggle('collapsed');
            localStorage.setItem(`para${paraType}Collapsed`, section.classList.contains('collapsed'));
        });
    });
    
    // Restore PARA sections collapsed state
    ['Inbox', 'Projects', 'Subprojects', 'Areas', 'Resources', 'Archives'].forEach(paraType => {
        if (localStorage.getItem(`para${paraType}Collapsed`) === 'true') {
            document.getElementById(`${paraType.toLowerCase()}Section`)?.classList.add('collapsed');
        }
    });
    
    // Search
    document.getElementById('searchBtn').addEventListener('click', () => {
        const searchBar = document.getElementById('searchBar');
        searchBar.hidden = !searchBar.hidden;
        if (!searchBar.hidden) searchBar.querySelector('input').focus();
    });
    
    document.getElementById('searchInput')?.addEventListener('input', (e) => {
        state.searchQuery = e.target.value;
        if (state.searchQuery.length >= 2) {
            renderSearchResults();
        } else if (state.searchQuery.length === 0) {
            renderView();
        }
    });
    
    // Search back button - close search and return to calendar
    document.getElementById('searchBackBtn')?.addEventListener('click', closeSearch);
    
    // Escape key in search input - close search
    document.getElementById('searchInput')?.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeSearch();
        }
    });
    
    // FAB - add both click and touchend for reliable mobile support
    const fabBtn = document.getElementById('fabAdd');
    fabBtn.addEventListener('click', () => showCreateModal());
    // Mobile touch support - prevent double-firing with click
    let fabTouchHandled = false;
    fabBtn.addEventListener('touchend', (e) => {
        e.preventDefault();  // Prevent click from also firing
        fabTouchHandled = true;
        showCreateModal();
        setTimeout(() => { fabTouchHandled = false; }, 300);
    }, { passive: false });
    
    // Event popup actions
    document.getElementById('popupClose').addEventListener('click', hideEventPopup);
    document.getElementById('popupOpen')?.addEventListener('click', async () => {
        if (state.selectedEvent) {
            await openInEmacs(state.selectedEvent);
        }
    });
    document.getElementById('popupEdit').addEventListener('click', () => {
        // Store event before hiding popup (which clears state.selectedEvent)
        const event = state.selectedEvent;
        const dateKey = state.selectedEventDate;
        hideEventPopup();
        showEditModal(event, dateKey);
    });
    document.getElementById('popupMarkDone')?.addEventListener('click', async () => {
        const event = state.selectedEvent;
        const dateKey = state.selectedEventDate;
        if (event) {
            if (event.source === 'ics') {
                // Toggle local done state for ICS events
                const isDone = toggleIcsEventDone(event, dateKey);
                hideEventPopup();
                showToast(isDone ? 'Marked as not done' : 'Marked as done', 'success');
            } else {
                // Optimistic update for org events
                const newState = event.state === 'DONE' ? 'TODO' : 'DONE';
                const oldState = event.state;
                
                // Update UI immediately
                event.state = newState;
                hideEventPopup();
                renderView();
                showToast(newState === 'DONE' ? 'Marking as done...' : 'Marking as todo...', 'info');
                
                // Sync with backend in background
                const success = await updateEventState(event, newState);
                if (success) {
                    showToast(newState === 'DONE' ? 'Marked as done' : 'Marked as todo', 'success');
                    // Refresh to get latest data from server (no spinner since UI already updated)
                    loadEvents(true, false);
                } else {
                    // Revert on failure
                    event.state = oldState;
                    renderView();
                    showToast('Failed to update - reverted', 'error');
                }
            }
        }
    });
    document.getElementById('popupCopy')?.addEventListener('click', (e) => {
        const event = state.selectedEvent;
        const text = `${event.title}${event.time ? ' ' + event.time : ''}${event.category ? ' (' + event.category + ')' : ''}`;
        navigator.clipboard.writeText(text).then(() => {
            // Visual feedback on button
            const btn = e.target.closest('.action-btn');
            btn.classList.add('copied');
            const span = btn.querySelector('span');
            const originalText = span?.textContent;
            if (span) span.textContent = 'Copied!';
            setTimeout(() => {
                btn.classList.remove('copied');
                if (span) span.textContent = originalText;
            }, 1500);
            showToast('Copied to clipboard', 'success');
        });
    });
    
    // ICS event actions
    document.getElementById('popupIcsMarkDone')?.addEventListener('click', () => {
        const event = state.selectedEvent;
        const dateKey = state.selectedEventDate;
        if (event) {
            const isDone = toggleIcsEventDone(event, dateKey);
            hideEventPopup();
            showToast(isDone ? 'Marked as done' : 'Marked as not done', 'success');
            renderView();
        }
    });
    
    document.getElementById('popupIcsCopy')?.addEventListener('click', (e) => {
        const event = state.selectedEvent;
        const text = `${event.title}${event.time ? ' ' + event.time : ''}${event.category ? ' (' + event.category + ')' : ''}`;
        navigator.clipboard.writeText(text).then(() => {
            const btn = e.target.closest('.action-btn');
            btn.classList.add('copied');
            const span = btn.querySelector('span');
            const originalText = span?.textContent;
            if (span) span.textContent = 'Copied!';
            setTimeout(() => {
                btn.classList.remove('copied');
                if (span) span.textContent = originalText;
            }, 1500);
            showToast('Copied to clipboard', 'success');
        });
    });
    
    // Snooze dropdown
    document.getElementById('popupSnooze')?.addEventListener('click', (e) => {
        const dropdown = document.getElementById('snoozeDropdown');
        const rect = e.target.closest('.action-btn').getBoundingClientRect();
        dropdown.style.left = `${rect.left}px`;
        dropdown.style.top = `${rect.bottom + 4}px`;
        dropdown.hidden = !dropdown.hidden;
    });
    
    document.querySelectorAll('.snooze-option').forEach(btn => {
        btn.addEventListener('click', () => {
            const days = parseInt(btn.dataset.days);
            const newDate = new Date(state.selectedEventDate + 'T00:00:00');
            newDate.setDate(newDate.getDate() + days);
            const event = state.selectedEvent;
            const dateKey = state.selectedEventDate;

            // Optimistic update: remove event from view immediately
            if (state.events[dateKey]) {
                state.events[dateKey] = state.events[dateKey].filter(e => e !== event);
            }
            hideEventPopup();
            document.getElementById('snoozeDropdown').hidden = true;
            renderView();

            // API call in background
            rescheduleEvent(event, formatDate(newDate)).then(success => {
                if (success) {
                    loadEvents(true, false);  // Sync with server
                } else {
                    // Restore event on failure
                    if (!state.events[dateKey]) state.events[dateKey] = [];
                    state.events[dateKey].push(event);
                    renderView();
                }
            });
        });
    });

    document.getElementById('popupDelete').addEventListener('click', () => {
        if (confirm('Archive this event?')) {
            const event = state.selectedEvent;
            const dateKey = state.selectedEventDate;

            // Optimistic update: remove event from view immediately
            if (state.events[dateKey]) {
                state.events[dateKey] = state.events[dateKey].filter(e => e !== event);
            }
            hideEventPopup();
            renderView();

            // API call in background
            deleteEvent(event).then(success => {
                if (success) {
                    loadEvents(true, false);  // Sync with server
                } else {
                    // Restore event on failure
                    if (!state.events[dateKey]) state.events[dateKey] = [];
                    state.events[dateKey].push(event);
                    renderView();
                }
            });
        }
    });
    
    // Create modal
    document.getElementById('createModalClose').addEventListener('click', hideCreateModal);
    document.getElementById('createCancel').addEventListener('click', hideCreateModal);
    document.getElementById('createForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const data = {
            title: document.getElementById('eventTitle').value,
            date: document.getElementById('eventDate').value,
            time: document.getElementById('eventTime').value || null,
            end_time: document.getElementById('eventEndTime').value || null,
            type: document.getElementById('eventType').value,
            priority: document.getElementById('eventPriority').value || null,
            notes: document.getElementById('eventNotes').value || null,
            capture_file: settings.captureFile || null,
            capture_headline: settings.captureHeadline || 'Inbox'
        };
        showToast('Creating event...', 'info');
        hideCreateModal();
        if (await createEvent(data)) {
            await loadEvents(true, false);
        }
    });
    
    // Edit modal
    document.getElementById('editModalClose').addEventListener('click', hideEditModal);
    document.getElementById('editOpen')?.addEventListener('click', async () => {
        if (state.selectedEvent) {
            await openInEmacs(state.selectedEvent);
        }
    });
    
    // Toggle advanced section
    document.getElementById('editToggleAdvanced')?.addEventListener('click', () => {
        const advanced = document.getElementById('editAdvanced');
        const toggle = document.getElementById('editToggleAdvanced');
        const text = toggle?.querySelector('.edit-modal__toggle-text');
        
        if (advanced.hidden) {
            advanced.hidden = false;
            toggle.classList.add('is-expanded');
            if (text) text.textContent = 'Less options';
            advanced.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } else {
            advanced.hidden = true;
            toggle.classList.remove('is-expanded');
            if (text) text.textContent = 'More options';
        }
    });
    
    document.getElementById('editForm').addEventListener('submit', async (e) => {
        e.preventDefault();

        // Check if refile is requested (and location actually changed)
        const refileTarget = document.getElementById('editRefile').value;
        const refileLocationChanged = refileTarget && refileTarget !== originalRefileLocation;

        if (refileLocationChanged && state.selectedEvent?.file && state.selectedEvent?.line) {
            const [targetFile, targetHeading] = refileTarget.split('|||');
            showToast('Refiling...', 'info');
            hideEditModal();
            try {
                const response = await fetch(`${API_BASE}/api/events/refile`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        source_file: state.selectedEvent.file,
                        source_line: state.selectedEvent.line,
                        target_file: targetFile,
                        target_heading: targetHeading
                    })
                });
                if (response.ok) {
                    showToast('Refiled successfully', 'success');
                    await loadEvents(true, false);
                } else {
                    const data = await response.json();
                    showToast(`Refile failed: ${data.detail}`, 'error');
                }
            } catch (err) {
                showToast(`Refile error: ${err.message}`, 'error');
            }
            return;
        }
        
        // Normal update
        // For gcal events, preserve the original type so backend knows not to add SCHEDULED
        const originalType = state.selectedEvent?.type;
        const dropdownType = document.getElementById('editType').value || null;
        const eventType = originalType === 'gcal' ? 'gcal' : dropdownType;
        
        const updates = {
            title: document.getElementById('editTitle').value,
            date: document.getElementById('editDate').value,
            time: document.getElementById('editTime').value || null,
            end_time: document.getElementById('editEndTime').value || null,
            type: eventType,
            state: document.getElementById('editState').value || null,
            priority: document.getElementById('editPriority').value || null,
            category: document.getElementById('editCategory').value || null,
            notes: document.getElementById('editNotes').value || null
        };
        showToast('Saving...', 'info');
        hideEditModal();
        if (await updateEvent(state.selectedEvent, updates)) {
            await loadEvents(true, false);
        }
    });
    
    // Close popups on outside click
    document.addEventListener('click', (e) => {
        const popup = document.getElementById('eventPopup');
        if (!popup.hidden && !popup.contains(e.target) && !e.target.closest('.event, .agenda-event')) {
            hideEventPopup();
        }
    });
    
    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        // Command palette
        if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
            e.preventDefault();
            showCommandPalette();
            return;
        }
        if (e.altKey && e.key === 'x') {
            e.preventDefault();
            showCommandPalette();
            return;
        }
        
        // Escape closes everything
        if (e.key === 'Escape') {
            hideEventPopup();
            hideCreateModal();
            hideEditModal();
            hideSettingsModal();
            hideShortcutsModal();
            hideCommandPalette();
            // Also hide search bar
            const searchBar = document.getElementById('searchBar');
            if (searchBar && !searchBar.hidden) {
                searchBar.hidden = true;
                document.getElementById('searchInput').value = '';
            }
            // Exit timeline mode if active
            if (state.timelineMode) {
                closeProjectTimeline();
            }
            return;
        }
        
        // Don't trigger shortcuts when typing in inputs
        if (e.target.closest('input, textarea, select')) return;
        
        // Shortcuts help
        if (e.key === '?') { showShortcutsModal(); return; }
        
        // Search
        if (e.key === '/') {
            e.preventDefault();
            document.getElementById('searchBtn').click();
            return;
        }
        
        // Refresh
        if (e.key === 'r') { showToast('Refreshing...', 'info'); loadEvents(true, false); return; }
        
        // Navigation and views
        if (e.key === 'c') showCreateModal(); // c for create
        if (e.key === 't') goToToday();
        if (e.key === 'n' || e.key === 'ArrowRight') navigate(1);  // n for next
        if (e.key === 'p' || e.key === 'ArrowLeft') navigate(-1);  // p for previous
        if (e.key === 'w') { switchView('week'); }
        if (e.key === '3') { switchView('3day'); }
        if (e.key === 'd') { switchView('day'); }
        if (e.key === 'a') { state.selectedDate = new Date(); switchView('agenda'); }
        if (e.key === 'm') { switchView('month'); }
        if (e.key === 'y') { switchView('year'); }
        if (e.key === 'b') { toggleSidebar(); }
        if (e.key === ',') { showSettingsModal(); }
    });
    
    // Touch gestures
    let touchStartX = 0;
    document.querySelector('.calendar-main').addEventListener('touchstart', (e) => {
        touchStartX = e.touches[0].clientX;
    }, { passive: true });
    document.querySelector('.calendar-main').addEventListener('touchend', (e) => {
        const diff = e.changedTouches[0].clientX - touchStartX;
        if (Math.abs(diff) > 100) navigate(diff > 0 ? -1 : 1);
    }, { passive: true });
    
    // Update time indicator every minute
    setInterval(() => {
        if (state.viewMode === 'week' || state.viewMode === '3day' || state.viewMode === 'day') renderTimeGrid();
    }, 60000);
    
    // Auto-refresh based on settings (default 5 minutes)
    // Auto-refresh without blocking spinner
    setInterval(async () => {
        await loadIcsDoneFromServer();  // Sync ICS done status from server
        loadEvents(false, false);
    }, (settings?.refreshInterval || 5) * 60 * 1000);
    
    // Online/offline event handlers
    window.addEventListener('online', async () => {
        showToast('Back online', 'success');
        showConnectionStatus(true);
        // Sync any pending changes first
        await syncPendingChanges();
        // Sync ICS done status from server
        await loadIcsDoneFromServer();
        // Then refresh from server without blocking
        loadEvents(true, false);
    });

    window.addEventListener('offline', () => {
        showToast('You are offline', 'warning');
        showConnectionStatus(false, 'Offline - showing cached data');
    });
    
    // Connection status close button
    document.getElementById('connectionStatusClose')?.addEventListener('click', () => {
        document.getElementById('connectionStatus').hidden = true;
    });
    
    // Initialize command palette
    initCommandPalette();
    
    // Initial load - try to show cached data first, then refresh in background
    const cachedEvents = loadEventsFromCache();
    if (cachedEvents && Object.keys(cachedEvents).length > 0) {
        console.log('Loading from cache:', Object.keys(cachedEvents).length, 'dates');
        state.events = cachedEvents;
        renderView(true);  // Scroll to today on initial load

        // If online, refresh from server in background
        if (isOnline()) {
            loadEvents(true, false);
        } else {
            showConnectionStatus(false, 'Offline - showing cached data');
            showToast('Offline mode - using cached events', 'info');
        }
    } else {
        // No cache
        if (!isOnline()) {
            showConnectionStatus(false, 'Offline - no cached data available');
            showToast('Offline and no cached data. Connect to load events.', 'warning');
            renderView(true);
        } else {
            // Online, show spinner for initial load
            loadEvents();
        }
    }
}

// ==================== Settings ====================

const defaultSettings = {
    // Appearance
    theme: 'system',  // 'system', 'dark', 'light'
    
    // View settings
    timeFormat: '12',
    defaultView: 'week',
    fontScale: '1.0',
    showRelativeTime: true,
    
    // Week/Day view
    startHour: 6,
    endHour: 22,
    density: 'comfortable',
    eventColorStyle: 'solid',  // 'solid' or 'transparent'
    
    // Event filtering
    showCompleted: false,
    showScheduled: true,
    showDeadlines: true,
    showTimestamps: true,
    showGcal: true,
    
    // Big Rocks / Availability
    rockThreshold: 3,
    heavyThreshold: 6,
    deadlinesAsBigRocks: false,
    weekendsAvailable: false,
    availableMinDays: 3,        // Minimum consecutive days for available period
    availableMaxHours: 2,       // Maximum hours per day to count as available
    
    // Zoom levels (numeric, set by Ctrl+scroll)
    hourHeightPx: null,         // null = use density preset; number = custom px value (30-120)
    glanceColWidthPx: null,     // null = use column width preset; number = custom px value (80-300)
    glanceRowHeightPx: null,    // null = auto; number = custom px value (14-40)
    heatmapCellSizePx: null,    // null = use default 14px; number = custom px value (8-24)

    // Year at a Glance settings
    yearGlanceFormat: 'suffix',        // 'prefix' ([Project] Title), 'suffix' (Title • Project), 'tooltip' (Title only), 'twolines'
    yearGlanceColumnWidth: 'normal',   // 'compact' (120px), 'normal' (160px), 'wide' (200px)
    yearGlanceFilterPreset: 'bigRocks', // 'bigRocks', 'priorityOrRocks', 'travelHoliday', 'allEvents', 'custom'
    yearGlanceCustomFilter: '',        // Custom filter expression when preset is 'custom'
    yearGlanceColorStyle: 'background', // 'background', 'border', 'none'
    
    // Refresh
    refreshInterval: 5,
    
    // Event Creation
    captureFile: '',  // Empty = use org-default-notes-file
    captureHeadline: 'Inbox',
    
    // Category colors
    categoryColors: {},
    
    // ICS Calendars
    icsCalendars: [],  // Array of {id, name, url, color, enabled, includeInLoad}
    icsTimezone: 'local',
    icsRefreshInterval: 15  // minutes
};

let settings = { ...defaultSettings };

// Settings that should be synced across devices (stored on server)
const syncedSettingKeys = ['icsCalendars', 'icsTimezone', 'icsRefreshInterval', 'categoryColors'];

async function loadSettings() {
    // First load from localStorage for immediate display
    try {
        const saved = localStorage.getItem('orgCalendarSettings');
        if (saved) {
            settings = { ...defaultSettings, ...JSON.parse(saved) };
        }
    } catch (e) {
        console.error('Failed to load local settings:', e);
    }
    applySettings();
    
    // Then fetch server settings and merge (server wins for synced keys)
    // Use timeout to avoid hanging when server is unreachable
    try {
        const response = await fetchWithTimeout(`${API_BASE}/api/settings`, {}, 5000);
        if (response.ok) {
            const serverSettings = await response.json();
            if (serverSettings && Object.keys(serverSettings).length > 0) {
                // Merge server settings (they take precedence for synced keys)
                for (const key of syncedSettingKeys) {
                    if (serverSettings[key] !== undefined) {
                        settings[key] = serverSettings[key];
                    }
                }
                // Save merged settings to localStorage
                localStorage.setItem('orgCalendarSettings', JSON.stringify(settings));
                applySettings();
                console.log('Settings synced from server');
            }
        }
    } catch (e) {
        console.warn('Failed to fetch server settings (offline?):', e);
    }
}

function saveSettings() {
    try {
        localStorage.setItem('orgCalendarSettings', JSON.stringify(settings));
    } catch (e) {
        console.error('Failed to save settings:', e);
    }
    
    // Also sync to server (async, don't wait)
    syncSettingsToServer();
}

// Auto-save helper - collects, saves, applies, and re-renders
function autoSaveSettings() {
    collectSettingsFromForm();
    saveSettings();
    applySettings();
    renderView();
}

async function syncSettingsToServer() {
    // Only sync the synced keys to server
    const toSync = {};
    for (const key of syncedSettingKeys) {
        if (settings[key] !== undefined) {
            toSync[key] = settings[key];
        }
    }
    
    try {
        await fetch(`${API_BASE}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(toSync)
        });
        console.log('Settings synced to server');
    } catch (e) {
        console.warn('Failed to sync settings to server:', e);
    }
}

function applySettings() {
    // Apply theme — resolve "system" to actual light/dark for reliable switching
    const themePref = settings.theme || 'system';
    let resolvedTheme = themePref;
    if (themePref === 'system') {
        resolvedTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', resolvedTheme);

    // Update meta theme-color
    const metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor) {
        metaThemeColor.setAttribute('content', resolvedTheme === 'dark' ? '#1e1e2e' : '#faf9f7');
    }
    
    // Apply density (hour height) - custom zoom overrides presets
    const densityMap = {
        'compact': 40,
        'comfortable': 60,
        'spacious': 80
    };
    const hourHeight = settings.hourHeightPx || densityMap[settings.density] || 60;
    document.documentElement.style.setProperty('--hour-height', `${hourHeight}px`);

    // Apply glance column width (custom zoom overrides presets)
    if (settings.glanceColWidthPx) {
        document.documentElement.style.setProperty('--glance-col-width', `${settings.glanceColWidthPx}px`);
    } else {
        // Remove variable so CSS class-based fallback values apply (120/160/200px per preset)
        document.documentElement.style.removeProperty('--glance-col-width');
    }

    // Apply glance row height (custom zoom)
    if (settings.glanceRowHeightPx) {
        document.documentElement.style.setProperty('--glance-row-height', `${settings.glanceRowHeightPx}px`);
    } else {
        document.documentElement.style.removeProperty('--glance-row-height');
    }

    // Apply heatmap cell size (custom zoom)
    const heatmapSize = settings.heatmapCellSizePx || 14;
    document.documentElement.style.setProperty('--heatmap-cell-size', `${heatmapSize}px`);
    
    // Apply font scale
    document.documentElement.style.setProperty('--font-scale', settings.fontScale);
    document.body.style.fontSize = `${14 * parseFloat(settings.fontScale)}px`;
    
    // Apply default view on first load
    if (!state.viewMode) {
        state.viewMode = settings.defaultView;
    }
    
    // Update category colors
    Object.assign(categoryColors, settings.categoryColors);
}

function showSettingsModal() {
    const modal = document.getElementById('settingsModal');
    
    // Populate current values
    // Appearance
    document.getElementById('settingTheme').value = settings.theme || 'system';
    
    // View settings
    document.getElementById('settingTimeFormat').value = settings.timeFormat;
    document.getElementById('settingDefaultView').value = settings.defaultView;
    document.getElementById('settingFontScale').value = settings.fontScale;
    document.getElementById('settingShowRelativeTime').checked = settings.showRelativeTime;
    
    // Week/Day view
    document.getElementById('settingStartHour').value = settings.startHour;
    document.getElementById('startHourValue').textContent = `${settings.startHour}:00`;
    document.getElementById('settingEndHour').value = settings.endHour;
    document.getElementById('endHourValue').textContent = `${settings.endHour}:00`;
    document.getElementById('settingDensity').value = settings.density;
    document.getElementById('settingEventColorStyle').value = settings.eventColorStyle || 'solid';
    
    // Event filtering
    document.getElementById('settingShowCompleted').checked = settings.showCompleted;
    document.getElementById('settingShowScheduled').checked = settings.showScheduled;
    document.getElementById('settingShowDeadlines').checked = settings.showDeadlines;
    document.getElementById('settingShowTimestamps').checked = settings.showTimestamps;
    document.getElementById('settingShowGcal').checked = settings.showGcal;
    
    // Big Rocks / Availability
    document.getElementById('settingRockThreshold').value = settings.rockThreshold;
    document.getElementById('rockThresholdValue').textContent = `${settings.rockThreshold}h`;
    document.getElementById('settingHeavyThreshold').value = settings.heavyThreshold;
    document.getElementById('heavyThresholdValue').textContent = `${settings.heavyThreshold}h`;
    document.getElementById('settingDeadlinesAsBigRocks').checked = settings.deadlinesAsBigRocks;
    document.getElementById('settingWeekendsAvailable').checked = settings.weekendsAvailable;
    document.getElementById('settingAvailableMinDays').value = settings.availableMinDays;
    document.getElementById('settingAvailableMaxHours').value = settings.availableMaxHours;
    
    // Year at a Glance
    document.getElementById('settingYearGlanceFormat').value = settings.yearGlanceFormat || 'suffix';
    document.getElementById('settingYearGlanceColumnWidth').value = settings.yearGlanceColumnWidth || 'normal';
    document.getElementById('settingYearGlanceFilterPreset').value = settings.yearGlanceFilterPreset || 'bigRocks';
    document.getElementById('settingYearGlanceCustomFilter').value = settings.yearGlanceCustomFilter || '';
    document.getElementById('settingYearGlanceColorStyle').value = settings.yearGlanceColorStyle || 'background';
    
    // Show/hide custom filter input based on preset
    const customFilterContainer = document.getElementById('yearGlanceCustomFilterContainer');
    if (customFilterContainer) {
        customFilterContainer.style.display = settings.yearGlanceFilterPreset === 'custom' ? 'flex' : 'none';
    }
    
    // Refresh
    document.getElementById('settingRefreshInterval').value = settings.refreshInterval;
    document.getElementById('refreshIntervalValue').textContent = `${settings.refreshInterval} min`;
    
    // Event Creation
    document.getElementById('settingCaptureFile').value = settings.captureFile || '';
    document.getElementById('settingCaptureHeadline').value = settings.captureHeadline || 'Inbox';
    
    // Populate category colors
    renderCategoryColorSettings();
    
    // Populate ICS calendars
    renderIcsCalendarsList();
    
    // ICS settings
    const timezoneSelect = document.getElementById('settingTimezone');
    if (timezoneSelect) timezoneSelect.value = settings.icsTimezone || 'local';
    
    const icsRefreshSlider = document.getElementById('settingIcsRefreshInterval');
    const icsRefreshValue = document.getElementById('icsRefreshIntervalValue');
    if (icsRefreshSlider && icsRefreshValue) {
        icsRefreshSlider.value = settings.icsRefreshInterval || 15;
        icsRefreshValue.textContent = `${icsRefreshSlider.value} min`;
    }
    
    modal.hidden = false;
}

function hideSettingsModal() {
    document.getElementById('settingsModal').hidden = true;
    // Close any open color pickers
    document.querySelectorAll('.color-picker-popup').forEach(p => p.remove());
}

function renderCategoryColorSettings() {
    const container = document.getElementById('categoryColorList');
    const cats = new Set();
    
    // Collect all categories from events
    Object.values(state.events).forEach(dayEvents => {
        dayEvents.forEach(e => { if (e.category) cats.add(e.category); });
    });
    
    // Also add any saved custom colors
    Object.keys(settings.categoryColors).forEach(cat => cats.add(cat));
    
    const sortedCats = Array.from(cats).sort();
    
    if (sortedCats.length === 0) {
        container.innerHTML = '<p class="settings-description">No categories found yet. Add events to see categories here.</p>';
        return;
    }
    
    container.innerHTML = sortedCats.map(cat => {
        const color = settings.categoryColors[cat] || getColorForCategory(cat);
        return `
            <div class="category-color-item" data-category="${cat}">
                <div class="category-color-swatch" style="background: ${color}" data-color="${color}"></div>
                <span class="category-color-name">${cat}</span>
                <input type="text" class="category-color-input" value="${color}" placeholder="#RRGGBB">
            </div>
        `;
    }).join('');
    
    // Add click handlers for color swatches
    container.querySelectorAll('.category-color-swatch').forEach(swatch => {
        swatch.addEventListener('click', (e) => {
            e.stopPropagation();
            showColorPicker(swatch);
        });
    });
    
    // Add input handlers
    container.querySelectorAll('.category-color-input').forEach(input => {
        input.addEventListener('change', (e) => {
            const item = e.target.closest('.category-color-item');
            const cat = item.dataset.category;
            const color = e.target.value;
            if (/^#[0-9A-Fa-f]{6}$/.test(color)) {
                item.querySelector('.category-color-swatch').style.background = color;
                item.querySelector('.category-color-swatch').dataset.color = color;
                // Auto-save and apply the color change
                autoSaveSettings();
            }
        });
    });
}

function showColorPicker(swatch) {
    // Remove existing color pickers
    document.querySelectorAll('.color-picker-popup').forEach(p => p.remove());
    
    const colors = [
        '#E57373', '#F06292', '#BA68C8', '#9575CD', '#7986CB', '#64B5F6',
        '#4FC3F7', '#4DD0E1', '#4DB6AC', '#81C784', '#AED581', '#DCE775',
        '#FFD54F', '#FFB74D', '#FF8A65', '#A1887F', '#90A4AE', '#F44336',
        '#E91E63', '#9C27B0', '#673AB7', '#3F51B5', '#2196F3', '#00BCD4',
        '#009688', '#4CAF50', '#8BC34A', '#CDDC39', '#FFC107', '#FF9800'
    ];
    
    const currentColor = swatch.dataset.color;
    
    const picker = document.createElement('div');
    picker.className = 'color-picker-popup';
    picker.innerHTML = `
        <div class="color-picker-grid">
            ${colors.map(c => `
                <div class="color-picker-color ${c === currentColor ? 'selected' : ''}" 
                     style="background: ${c}" data-color="${c}"></div>
            `).join('')}
        </div>
    `;
    
    // Position near the swatch
    const rect = swatch.getBoundingClientRect();
    picker.style.left = `${Math.min(rect.left, window.innerWidth - 220)}px`;
    picker.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - 200)}px`;
    
    document.body.appendChild(picker);
    
    // Handle color selection
    picker.querySelectorAll('.color-picker-color').forEach(colorEl => {
        colorEl.addEventListener('click', () => {
            const color = colorEl.dataset.color;
            swatch.style.background = color;
            swatch.dataset.color = color;
            
            const item = swatch.closest('.category-color-item');
            item.querySelector('.category-color-input').value = color;
            
            picker.remove();
            
            // Auto-save and apply the color change
            autoSaveSettings();
        });
    });
    
    // Close on outside click
    setTimeout(() => {
        document.addEventListener('click', function closeColorPicker(e) {
            if (!picker.contains(e.target) && e.target !== swatch) {
                picker.remove();
                document.removeEventListener('click', closeColorPicker);
            }
        });
    }, 0);
}

function collectSettingsFromForm() {
    // Appearance
    settings.theme = document.getElementById('settingTheme').value;
    
    // View settings
    settings.timeFormat = document.getElementById('settingTimeFormat').value;
    settings.defaultView = document.getElementById('settingDefaultView').value;
    settings.fontScale = document.getElementById('settingFontScale').value;
    settings.showRelativeTime = document.getElementById('settingShowRelativeTime').checked;
    
    // Week/Day view
    settings.startHour = parseInt(document.getElementById('settingStartHour').value);
    settings.endHour = parseInt(document.getElementById('settingEndHour').value);
    settings.density = document.getElementById('settingDensity').value;
    settings.eventColorStyle = document.getElementById('settingEventColorStyle').value;
    
    // Event filtering
    settings.showCompleted = document.getElementById('settingShowCompleted').checked;
    settings.showScheduled = document.getElementById('settingShowScheduled').checked;
    settings.showDeadlines = document.getElementById('settingShowDeadlines').checked;
    settings.showTimestamps = document.getElementById('settingShowTimestamps').checked;
    settings.showGcal = document.getElementById('settingShowGcal').checked;
    
    // Big Rocks / Availability
    settings.rockThreshold = parseInt(document.getElementById('settingRockThreshold').value);
    settings.heavyThreshold = parseInt(document.getElementById('settingHeavyThreshold').value);
    settings.deadlinesAsBigRocks = document.getElementById('settingDeadlinesAsBigRocks').checked;
    settings.weekendsAvailable = document.getElementById('settingWeekendsAvailable').checked;
    settings.availableMinDays = parseInt(document.getElementById('settingAvailableMinDays').value);
    settings.availableMaxHours = parseInt(document.getElementById('settingAvailableMaxHours').value);
    
    // Year at a Glance
    settings.yearGlanceFormat = document.getElementById('settingYearGlanceFormat').value;
    settings.yearGlanceColumnWidth = document.getElementById('settingYearGlanceColumnWidth').value;
    settings.yearGlanceFilterPreset = document.getElementById('settingYearGlanceFilterPreset').value;
    settings.yearGlanceCustomFilter = document.getElementById('settingYearGlanceCustomFilter').value;
    settings.yearGlanceColorStyle = document.getElementById('settingYearGlanceColorStyle').value;
    
    // Refresh
    settings.refreshInterval = parseInt(document.getElementById('settingRefreshInterval').value);
    
    // Event Creation
    settings.captureFile = document.getElementById('settingCaptureFile').value.trim();
    settings.captureHeadline = document.getElementById('settingCaptureHeadline').value.trim() || 'Inbox';
    
    // Collect category colors
    settings.categoryColors = {};
    document.querySelectorAll('.category-color-item').forEach(item => {
        const cat = item.dataset.category;
        const color = item.querySelector('.category-color-input').value;
        if (/^#[0-9A-Fa-f]{6}$/.test(color)) {
            settings.categoryColors[cat] = color;
        }
    });
}

// ==================== ICS Calendar Management ====================

function renderIcsCalendarsList() {
    const container = document.getElementById('icsCalendarsList');
    if (!container) return;
    
    const calendars = settings.icsCalendars || [];
    
    if (calendars.length === 0) {
        container.innerHTML = '';  // Let CSS :empty pseudo-class show "No calendars" message
        return;
    }
    
    container.innerHTML = calendars.map(cal => `
        <div class="ics-calendar-item ${cal.enabled === false ? 'disabled' : ''}" data-id="${cal.id}">
            <div class="ics-calendar-color" style="background: ${cal.color}"></div>
            <div class="ics-calendar-info">
                <div class="ics-calendar-name">${escapeHtml(cal.name)}</div>
                <div class="ics-calendar-url">${escapeHtml(cal.url)}</div>
            </div>
            <div class="ics-calendar-actions">
                <button class="ics-calendar-load ${cal.includeInLoad ? 'active' : ''}" title="${cal.includeInLoad ? 'Included in load calc' : 'Not in load calc'}">
                    <span class="load-icon">${cal.includeInLoad ? '⏱' : '⏱'}</span>
                </button>
                <button class="ics-calendar-toggle" title="${cal.enabled === false ? 'Enable' : 'Disable'}">
                    ${cal.enabled === false ? '◯' : '●'}
                </button>
                <button class="ics-calendar-delete" title="Remove">✕</button>
            </div>
        </div>
    `).join('');
    
    // Add event listeners
    container.querySelectorAll('.ics-calendar-load').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const item = e.target.closest('.ics-calendar-item');
            const id = item.dataset.id;
            toggleIcsCalendarLoad(id);
        });
    });
    
    container.querySelectorAll('.ics-calendar-toggle').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const item = e.target.closest('.ics-calendar-item');
            const id = item.dataset.id;
            toggleIcsCalendar(id);
        });
    });
    
    container.querySelectorAll('.ics-calendar-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const item = e.target.closest('.ics-calendar-item');
            const id = item.dataset.id;
            deleteIcsCalendar(id);
        });
    });
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function addIcsCalendar(name, url, color) {
    if (!name || !url) {
        showToast('Name and URL are required', 'error');
        return false;
    }
    
    // Validate URL
    try {
        new URL(url);
    } catch (e) {
        showToast('Invalid URL format', 'error');
        return false;
    }
    
    // Check for duplicates
    if (settings.icsCalendars.some(c => c.url === url)) {
        showToast('This calendar URL is already added', 'warning');
        return false;
    }
    
    const newCalendar = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        name: name.trim(),
        url: url.trim(),
        color: color || '#89b4fa',
        enabled: true,
        includeInLoad: false  // Don't include in load calculation by default
    };
    
    settings.icsCalendars.push(newCalendar);
    saveSettings();
    renderIcsCalendarsList();
    showToast(`Added ${name}`, 'success');
    
    // Trigger refresh to fetch new calendar
    // fetchIcsEvents();  // Will implement when backend is ready
    
    return true;
}

function toggleIcsCalendar(id) {
    const calendar = settings.icsCalendars.find(c => c.id === id);
    if (calendar) {
        calendar.enabled = calendar.enabled === false ? true : false;
        saveSettings();
        renderIcsCalendarsList();
        renderView();  // Re-render to show/hide events
    }
}

function toggleIcsCalendarLoad(id) {
    const calendar = settings.icsCalendars.find(c => c.id === id);
    if (calendar) {
        calendar.includeInLoad = !calendar.includeInLoad;
        saveSettings();
        renderIcsCalendarsList();
        renderView();  // Re-render to update load calculations
        showToast(`${calendar.name}: ${calendar.includeInLoad ? 'Included' : 'Excluded'} from load`, 'success');
    }
}

function deleteIcsCalendar(id) {
    const calendar = settings.icsCalendars.find(c => c.id === id);
    if (!calendar) return;
    
    if (confirm(`Remove "${calendar.name}"?`)) {
        settings.icsCalendars = settings.icsCalendars.filter(c => c.id !== id);
        saveSettings();
        renderIcsCalendarsList();
        renderView();  // Re-render to remove events
        showToast(`Removed ${calendar.name}`, 'success');
    }
}

function initIcsCalendarHandlers() {
    // Add calendar button
    const addBtn = document.getElementById('addIcsCalendarBtn');
    if (addBtn) {
        addBtn.addEventListener('click', () => {
            const name = document.getElementById('icsCalendarName').value;
            const url = document.getElementById('icsCalendarUrl').value;
            const color = document.getElementById('icsCalendarColor').value;
            
            if (addIcsCalendar(name, url, color)) {
                // Clear form
                document.getElementById('icsCalendarName').value = '';
                document.getElementById('icsCalendarUrl').value = '';
                document.getElementById('icsCalendarColor').value = '#89b4fa';
            }
        });
    }
    
    // Timezone selector
    const timezoneSelect = document.getElementById('settingTimezone');
    if (timezoneSelect) {
        timezoneSelect.value = settings.icsTimezone || 'local';
        timezoneSelect.addEventListener('change', (e) => {
            settings.icsTimezone = e.target.value;
            saveSettings();
        });
    }
    
    // ICS refresh interval slider
    const refreshSlider = document.getElementById('settingIcsRefreshInterval');
    const refreshValue = document.getElementById('icsRefreshIntervalValue');
    if (refreshSlider && refreshValue) {
        refreshSlider.value = settings.icsRefreshInterval || 15;
        refreshValue.textContent = `${refreshSlider.value} min`;
        
        refreshSlider.addEventListener('input', (e) => {
            refreshValue.textContent = `${e.target.value} min`;
            settings.icsRefreshInterval = parseInt(e.target.value);
            saveSettings();
        });
    }
    
}

function initSettingsHandlers() {
    // Settings button
    document.getElementById('settingsBtn').addEventListener('click', showSettingsModal);

    // Mobile sidebar action buttons (mirrors of header buttons)
    document.getElementById('mobileSearchBtn')?.addEventListener('click', () => {
        toggleSidebar();
        const searchBar = document.getElementById('searchBar');
        searchBar.hidden = false;
        searchBar.querySelector('input').focus();
    });
    document.getElementById('mobileRefreshBtn')?.addEventListener('click', () => {
        toggleSidebar();
        showToast('Refreshing...', 'info');
        loadEvents(true, false);
    });
    document.getElementById('mobileSettingsBtn')?.addEventListener('click', () => {
        toggleSidebar();
        showSettingsModal();
    });

    // Close buttons
    document.getElementById('settingsModalClose').addEventListener('click', hideSettingsModal);

    // Show Notifications tab when running inside Android WebView
    if (window.Android) {
        const notifTab = document.getElementById('settingsNotificationsTab');
        if (notifTab) notifTab.style.display = '';
        document.getElementById('openAndroidNotificationSettings')?.addEventListener('click', () => {
            window.Android.openNotificationSettings();
        });
    }

    // Tab navigation
    document.querySelectorAll('.settings-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.settings-tab-content').forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById(`settings-${tab.dataset.tab}`).classList.add('active');
        });
    });
    
    // Auto-save helper - collects, saves, applies, and re-renders
    // (Uses module-level autoSaveSettings function)
    
    // Slider handlers with live preview AND auto-save
    document.getElementById('settingStartHour').addEventListener('input', (e) => {
        document.getElementById('startHourValue').textContent = `${e.target.value}:00`;
        autoSaveSettings();
    });
    document.getElementById('settingEndHour').addEventListener('input', (e) => {
        document.getElementById('endHourValue').textContent = `${e.target.value}:00`;
        autoSaveSettings();
    });
    document.getElementById('settingRockThreshold').addEventListener('input', (e) => {
        document.getElementById('rockThresholdValue').textContent = `${e.target.value}h`;
        autoSaveSettings();
    });
    document.getElementById('settingHeavyThreshold').addEventListener('input', (e) => {
        document.getElementById('heavyThresholdValue').textContent = `${e.target.value}h`;
        autoSaveSettings();
    });
    document.getElementById('settingRefreshInterval').addEventListener('input', (e) => {
        document.getElementById('refreshIntervalValue').textContent = `${e.target.value} min`;
        autoSaveSettings();
    });
    
    // Select dropdowns - auto-save on change
    ['settingTheme', 'settingDefaultView', 'settingFontScale', 'settingTimeFormat', 'settingDensity', 'settingEventColorStyle',
     'settingYearGlanceFormat', 'settingYearGlanceColumnWidth', 'settingYearGlanceColorStyle'].forEach(id => {
        document.getElementById(id)?.addEventListener('change', autoSaveSettings);
    });
    
    // Year Glance filter preset - show/hide custom filter input
    document.getElementById('settingYearGlanceFilterPreset')?.addEventListener('change', (e) => {
        const customFilterContainer = document.getElementById('yearGlanceCustomFilterContainer');
        if (customFilterContainer) {
            customFilterContainer.style.display = e.target.value === 'custom' ? 'flex' : 'none';
        }
        autoSaveSettings();
    });
    
    // Custom filter input - auto-save on blur (when user finishes typing)
    document.getElementById('settingYearGlanceCustomFilter')?.addEventListener('blur', autoSaveSettings);
    // Also save on Enter key
    document.getElementById('settingYearGlanceCustomFilter')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            autoSaveSettings();
        }
    });
    
    // Checkboxes/toggles - auto-save on change
    ['settingShowRelativeTime', 'settingShowCompleted', 'settingShowScheduled',
     'settingShowDeadlines', 'settingShowTimestamps', 'settingShowGcal',
     'settingDeadlinesAsBigRocks', 'settingWeekendsAvailable'].forEach(id => {
        document.getElementById(id).addEventListener('change', autoSaveSettings);
    });
    
    // Text inputs - auto-save on blur (when user leaves the field)
    ['settingCaptureFile', 'settingCaptureHeadline'].forEach(id => {
        document.getElementById(id).addEventListener('blur', autoSaveSettings);
    });
    
    // Reset button
    document.getElementById('settingsReset').addEventListener('click', () => {
        if (confirm('Reset all settings to defaults?')) {
            settings = { ...defaultSettings };
            showSettingsModal(); // Refresh form
            saveSettings();
            applySettings();
            renderView();
            showToast('Settings reset to defaults', 'success');
        }
    });

    // Reload all data button
    document.getElementById('reloadAllData').addEventListener('click', async () => {
        showToast('Reloading all calendar data...', 'info');
        hideSettingsModal();

        // Clear cached events
        state.events = {};
        localStorage.removeItem('orgCalendarEvents');
        localStorage.removeItem('orgCalendarEventsTime');

        // Force refresh from server with spinner
        await loadEvents(true, true);
        showToast('All calendar data reloaded', 'success');
    });

    // Close modal on background click
    document.getElementById('settingsModal').addEventListener('click', (e) => {
        if (e.target.id === 'settingsModal') {
            hideSettingsModal();
        }
    });
}

// ==================== Offline Handling ====================

function initOfflineHandling() {
    // Start as offline until we verify server connection
    state.isOffline = true;
    state.serverOnline = false;
    updateOfflineUI();

    // Check actual server connectivity (async, will update UI when done)
    checkServerConnection();

    // Listen for network online/offline events
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Periodically check server connectivity (every 30 seconds when online, every 10 when offline)
    setInterval(() => {
        if (navigator.onLine) {
            checkServerConnection();
        }
    }, state.serverOnline ? 30000 : 10000);

    // Listen for messages from service worker
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.addEventListener('message', (event) => {
            if (event.data.type === 'SYNC_COMPLETE') {
                const { synced, failed } = event.data.results;
                if (synced > 0) {
                    showToast(`Synced ${synced} offline event(s)`, 'success');
                    loadEvents(true, false);  // Refresh events
                }
                if (failed > 0) {
                    showToast(`${failed} event(s) failed to sync`, 'error');
                }
                updatePendingCount();
            }
        });
    }

    // Check pending events count
    updatePendingCount();

    // Sync button handler
    document.getElementById('offlineSyncBtn')?.addEventListener('click', syncOfflineEvents);
}

async function handleOnline() {
    // Network came back - but check if server is actually reachable
    const serverUp = await checkServerConnection();
    if (serverUp) {
        // Server is reachable, refresh data
        loadEvents(true, false);
    }
    // If server not reachable, checkServerConnection already updated UI
}

function handleOffline() {
    // Network disconnected - definitely offline
    setServerStatus(false, 'No network connection');
}

function updateOfflineUI() {
    const banner = document.getElementById('offlineBanner');
    const syncBtn = document.getElementById('offlineSyncBtn');
    const pendingEl = document.getElementById('offlinePending');
    const fabBadge = document.getElementById('fabBadge');
    
    if (banner) {
        banner.hidden = !state.isOffline && state.pendingEventsCount === 0;
    }
    
    // Show sync button and pending count only when online with pending events
    if (syncBtn) {
        syncBtn.hidden = state.isOffline || state.pendingEventsCount === 0;
    }
    if (pendingEl) {
        pendingEl.hidden = state.pendingEventsCount === 0;
    }
    
    // Update FAB badge for pending events
    if (fabBadge) {
        if (state.pendingEventsCount > 0) {
            fabBadge.textContent = state.pendingEventsCount;
            fabBadge.hidden = false;
        } else {
            fabBadge.hidden = true;
        }
    }
}

async function updatePendingCount() {
    if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) {
        state.pendingEventsCount = 0;
        updateOfflineUI();
        return;
    }
    
    try {
        const messageChannel = new MessageChannel();
        const response = await new Promise((resolve) => {
            messageChannel.port1.onmessage = (event) => resolve(event.data);
            navigator.serviceWorker.controller.postMessage(
                { type: 'GET_QUEUE_COUNT' },
                [messageChannel.port2]
            );
            // Timeout after 1 second
            setTimeout(() => resolve({ count: 0 }), 1000);
        });
        
        state.pendingEventsCount = response.count || 0;
        document.getElementById('pendingCount').textContent = state.pendingEventsCount;
        updateOfflineUI();
    } catch (err) {
        console.warn('Failed to get pending count:', err);
        state.pendingEventsCount = 0;
        updateOfflineUI();
    }
}

async function syncOfflineEvents() {
    if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) {
        return;
    }
    
    showToast('Syncing offline events...', 'info');
    
    try {
        const messageChannel = new MessageChannel();
        const response = await new Promise((resolve, reject) => {
            messageChannel.port1.onmessage = (event) => resolve(event.data);
            navigator.serviceWorker.controller.postMessage(
                { type: 'SYNC_NOW' },
                [messageChannel.port2]
            );
            // Timeout after 30 seconds
            setTimeout(() => reject(new Error('Sync timeout')), 30000);
        });
        
        if (response.synced > 0) {
            showToast(`Synced ${response.synced} event(s)`, 'success');
            loadEvents(true, false);
        } else if (response.failed > 0) {
            showToast(`${response.failed} event(s) failed to sync`, 'error');
        } else {
            showToast('Nothing to sync', 'info');
        }
        
        updatePendingCount();
    } catch (err) {
        showToast('Sync failed: ' + err.message, 'error');
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    loadSettings();
    loadFilterState();  // Load saved category/PARA filter state
    initSettingsHandlers();
    initIcsCalendarHandlers();
    initOfflineHandling();  // Initialize offline support
    initSidebarResize();  // Initialize sidebar resize
    initPinchToZoom();  // Initialize pinch-to-zoom for view switching
    initCtrlScrollZoom();  // Initialize Ctrl+scroll zoom for cell widths
    initNavYearToggle();  // Initialize year view toggle in navbar
    initRefileCombobox();  // Initialize searchable refile combobox
    cleanupOldIcsDoneEvents();  // Clean up old done markers
    await loadIcsDoneFromServer();  // Sync ICS done status from server
    invalidateIcsDoneCache();  // Ensure fresh cache after server sync
    await fetchTodoKeywords();  // Fetch org-todo-keywords from Emacs
    updatePendingChangesIndicator();  // Show pending changes if any
    init();

    // Listen for system theme changes — event listener + polling fallback
    const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
    let lastKnownDark = darkMq.matches;

    function onSystemThemeChange() {
        const nowDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        if (nowDark === lastKnownDark) return;
        lastKnownDark = nowDark;
        if (settings.theme !== 'system') return;
        applySettings();
    }

    // Primary: matchMedia change event
    darkMq.addEventListener('change', onSystemThemeChange);

    // Fallback: poll every 2s for environments where change events are unreliable
    setInterval(() => {
        if (settings.theme !== 'system') return;
        const nowDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        if (nowDark !== lastKnownDark) {
            onSystemThemeChange();
        }
    }, 2000);

    // Handle PWA shortcuts and URL parameters
    handleUrlParameters();
});

// ==================== Ctrl+Scroll Zoom ====================

function initCtrlScrollZoom() {
    let saveTimeout = null;

    function debouncedSave() {
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(() => {
            saveSettings();
        }, 300);
    }

    document.querySelector('.calendar-main')?.addEventListener('wheel', (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();

        const delta = e.deltaY > 0 ? -1 : 1; // scroll up = zoom in, scroll down = zoom out
        const viewMode = state.viewMode;

        if (viewMode === 'week' || viewMode === '3day' || viewMode === 'day') {
            // Zoom hour height
            const densityMap = { 'compact': 40, 'comfortable': 60, 'spacious': 80 };
            const current = settings.hourHeightPx || densityMap[settings.density] || 60;
            const step = 5;
            const newVal = Math.max(30, Math.min(120, current + delta * step));
            settings.hourHeightPx = newVal;
            document.documentElement.style.setProperty('--hour-height', `${newVal}px`);
            renderView();
            debouncedSave();
        } else if (viewMode === 'year' && state.yearViewMode === 'glance') {
            if (e.shiftKey) {
                // Ctrl+Shift+scroll: vertical zoom (row height)
                const current = settings.glanceRowHeightPx || 24; // default ~24px (padding + font)
                const step = 2;
                const newVal = Math.max(14, Math.min(40, current + delta * step));
                settings.glanceRowHeightPx = newVal;
                document.documentElement.style.setProperty('--glance-row-height', `${newVal}px`);
            } else {
                // Ctrl+scroll: horizontal zoom (column width)
                const glanceWidthMap = { 'compact': 120, 'normal': 160, 'wide': 200 };
                const current = settings.glanceColWidthPx || glanceWidthMap[settings.yearGlanceColumnWidth] || 160;
                const step = 10;
                const newVal = Math.max(80, Math.min(300, current + delta * step));
                settings.glanceColWidthPx = newVal;
                document.documentElement.style.setProperty('--glance-col-width', `${newVal}px`);
            }
            debouncedSave();
        } else if (viewMode === 'year' && state.yearViewMode !== 'glance') {
            // Zoom heatmap cell size
            const current = settings.heatmapCellSizePx || 14;
            const step = 1;
            const newVal = Math.max(8, Math.min(24, current + delta * step));
            settings.heatmapCellSizePx = newVal;
            document.documentElement.style.setProperty('--heatmap-cell-size', `${newVal}px`);
            debouncedSave();
        }
    }, { passive: false });
}

// ==================== Sidebar Resize ====================

function initSidebarResize() {
    const sidebar = document.getElementById('sidebar');
    const handle = document.getElementById('sidebarResizeHandle');
    if (!sidebar || !handle) return;
    
    let isResizing = false;
    let startX = 0;
    let startWidth = 0;
    
    // Load saved width
    const savedWidth = localStorage.getItem('sidebarWidth');
    if (savedWidth) {
        sidebar.style.width = savedWidth + 'px';
    }
    
    handle.addEventListener('mousedown', (e) => {
        isResizing = true;
        startX = e.clientX;
        startWidth = sidebar.offsetWidth;
        sidebar.classList.add('resizing');
        handle.classList.add('active');
        document.body.style.cursor = 'col-resize';
        e.preventDefault();
    });
    
    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        
        const diff = e.clientX - startX;
        const newWidth = Math.min(400, Math.max(160, startWidth + diff));
        sidebar.style.width = newWidth + 'px';
    });
    
    document.addEventListener('mouseup', () => {
        if (!isResizing) return;
        
        isResizing = false;
        sidebar.classList.remove('resizing');
        handle.classList.remove('active');
        document.body.style.cursor = '';
        
        // Save width
        localStorage.setItem('sidebarWidth', sidebar.offsetWidth);
    });
    
    // Touch support for mobile
    handle.addEventListener('touchstart', (e) => {
        isResizing = true;
        startX = e.touches[0].clientX;
        startWidth = sidebar.offsetWidth;
        sidebar.classList.add('resizing');
        handle.classList.add('active');
    });
    
    document.addEventListener('touchmove', (e) => {
        if (!isResizing) return;
        
        const diff = e.touches[0].clientX - startX;
        const newWidth = Math.min(400, Math.max(160, startWidth + diff));
        sidebar.style.width = newWidth + 'px';
    });
    
    document.addEventListener('touchend', () => {
        if (!isResizing) return;
        
        isResizing = false;
        sidebar.classList.remove('resizing');
        handle.classList.remove('active');
        
        // Save width
        localStorage.setItem('sidebarWidth', sidebar.offsetWidth);
    });
}

// ==================== Pinch to Zoom ====================

function initPinchToZoom() {
    const container = document.querySelector('.time-grid-container');
    if (!container) return;
    
    let initialDistance = 0;
    let isPinching = false;
    
    // View hierarchy for zoom levels
    const viewHierarchy = ['year', 'month', 'week', '3day', 'day'];
    
    function getDistance(touches) {
        const dx = touches[0].clientX - touches[1].clientX;
        const dy = touches[0].clientY - touches[1].clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }
    
    container.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
            isPinching = true;
            initialDistance = getDistance(e.touches);
            e.preventDefault();
        }
    }, { passive: false });
    
    container.addEventListener('touchmove', (e) => {
        if (!isPinching || e.touches.length !== 2) return;
        e.preventDefault();
    }, { passive: false });
    
    container.addEventListener('touchend', (e) => {
        if (!isPinching) return;
        
        if (e.touches.length < 2 && e.changedTouches.length > 0) {
            // Reconstruct final distance from remaining touch + changed touch
            const allTouches = [...e.touches, ...e.changedTouches];
            if (allTouches.length >= 2) {
                const finalDistance = getDistance(allTouches);
                const ratio = finalDistance / initialDistance;
                
                const currentIdx = viewHierarchy.indexOf(state.viewMode);
                if (currentIdx === -1) {
                    isPinching = false;
                    return;
                }
                
                // Pinch out (zoom in) = more detail = day view
                // Pinch in (zoom out) = less detail = year view
                if (ratio > 1.3 && currentIdx < viewHierarchy.length - 1) {
                    // Zoom in - go to more detailed view
                    const newView = viewHierarchy[currentIdx + 1];
                    showToast(`Zooming to ${newView} view`, 'info');
                    switchView(newView);
                } else if (ratio < 0.7 && currentIdx > 0) {
                    // Zoom out - go to less detailed view
                    const newView = viewHierarchy[currentIdx - 1];
                    showToast(`Zooming to ${newView} view`, 'info');
                    switchView(newView);
                }
            }
        }
        
        isPinching = false;
    });
}

// Handle URL parameters from PWA shortcuts or direct links
function handleUrlParameters() {
    const params = new URLSearchParams(window.location.search);
    let handled = false;
    
    // Handle view parameter (e.g., ?view=agenda)
    const viewParam = params.get('view');
    if (viewParam && ['week', '3day', 'day', 'agenda', 'month', 'year'].includes(viewParam)) {
        if (viewParam === 'agenda') {
            state.selectedDate = new Date();  // Reset to today for agenda
        }
        switchView(viewParam);
        handled = true;
    }
    
    // Handle action parameter (e.g., ?action=create or ?action=add_task)
    const actionParam = params.get('action');
    if (actionParam === 'create' || actionParam === 'add_task') {
        // Small delay to ensure everything is initialized
        setTimeout(() => showCreateModal(), 100);
        handled = true;
    }
    
    // Handle date parameter (e.g., ?date=2025-01-15)
    const dateParam = params.get('date');
    if (dateParam) {
        const date = new Date(dateParam + 'T00:00:00');
        if (!isNaN(date.getTime())) {
            state.selectedDate = date;
            state.currentDate = date;
            state.weekStart = getWeekStart(date);
            renderView();
            handled = true;
        }
    }
    
    // Clean up URL to avoid re-triggering on refresh (but keep history clean)
    if (handled && window.history.replaceState) {
        window.history.replaceState({}, document.title, window.location.pathname);
    }
}

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
        .then(reg => {
            console.log('Service worker registered:', reg.scope);
            // Check for updates periodically
            setInterval(() => reg.update(), 60 * 60 * 1000); // Every hour
        })
        .catch(err => console.error('Service worker registration failed:', err));
}
