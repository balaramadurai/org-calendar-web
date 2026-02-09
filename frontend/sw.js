// Service Worker for Org Calendar PWA
const CACHE_NAME = 'org-calendar-v13';
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/styles.css',
    '/app.js',
    '/manifest.json',
    '/sw.js'
];

// Debug logging
const DEBUG = true;
function log(...args) {
    if (DEBUG) console.log('[SW]', ...args);
}

// IndexedDB for offline queue
const DB_NAME = 'org-calendar-offline';
const DB_VERSION = 1;
const QUEUE_STORE = 'pending-events';

function openDB() {
    return new Promise((resolve, reject) => {
        if (!indexedDB) {
            reject(new Error('IndexedDB not available'));
            return;
        }
        
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => {
            console.error('IndexedDB open error:', request.error);
            reject(request.error);
        };
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(QUEUE_STORE)) {
                db.createObjectStore(QUEUE_STORE, { keyPath: 'id', autoIncrement: true });
            }
        };
        request.onblocked = () => {
            console.warn('IndexedDB blocked - close other tabs');
        };
    });
}

// Install - cache static assets
self.addEventListener('install', (event) => {
    log('Installing service worker, cache:', CACHE_NAME);
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                log('Caching static assets:', STATIC_ASSETS);
                return cache.addAll(STATIC_ASSETS);
            })
            .then(() => {
                log('Installation complete');
                return self.skipWaiting();
            })
            .catch(err => {
                console.error('[SW] Installation failed:', err);
            })
    );
});

// Activate - clean up old caches
self.addEventListener('activate', (event) => {
    log('Activating service worker');
    event.waitUntil(
        caches.keys().then(keys => {
            const oldCaches = keys.filter(key => key !== CACHE_NAME);
            if (oldCaches.length > 0) {
                log('Removing old caches:', oldCaches);
            }
            return Promise.all(oldCaches.map(key => caches.delete(key)));
        }).then(() => {
            log('Claiming clients');
            return self.clients.claim();
        })
    );
});

// Fetch - improved offline handling
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    
    // Only handle http/https requests
    if (!url.protocol.startsWith('http')) {
        return;
    }
    
    // API calls for creating events - queue if offline
    if (url.pathname === '/api/events' && event.request.method === 'POST') {
        event.respondWith(handleCreateEvent(event.request.clone()));
        return;
    }
    
    // Other API calls - network with timeout, return offline response if failed
    if (url.pathname.startsWith('/api') || url.pathname.startsWith('/events') || 
        url.pathname.startsWith('/status') || url.pathname.startsWith('/refile')) {
        event.respondWith(
            fetchWithTimeout(event.request, 5000)
                .catch(() => {
                    // Return a proper offline response
                    return new Response(
                        JSON.stringify({ offline: true, error: 'Network unavailable' }), 
                        { 
                            status: 503, 
                            headers: { 'Content-Type': 'application/json' }
                        }
                    );
                })
        );
        return;
    }
    
    // For JS files, use network-first to ensure fresh code
    if (url.pathname.endsWith('.js')) {
        event.respondWith(
            fetchWithTimeout(event.request, 3000)
                .then(response => {
                    if (response.ok) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME)
                            .then(cache => cache.put(event.request, clone));
                    }
                    return response;
                })
                .catch(() => {
                    // Network failed, use cache
                    return caches.match(event.request);
                })
        );
        return;
    }

    // Other static assets - cache first for speed, update cache in background
    event.respondWith(
        caches.match(event.request)
            .then(cached => {
                // Return cached immediately if available
                if (cached) {
                    // Update cache in background
                    fetch(event.request)
                        .then(response => {
                            if (response.ok) {
                                caches.open(CACHE_NAME)
                                    .then(cache => cache.put(event.request, response));
                            }
                        })
                        .catch(() => {}); // Ignore network errors for background update
                    return cached;
                }

                // No cache, try network
                return fetch(event.request)
                    .then(response => {
                        if (response.ok) {
                            const clone = response.clone();
                            caches.open(CACHE_NAME)
                                .then(cache => cache.put(event.request, clone));
                        }
                        return response;
                    });
            })
    );
});

// Fetch with timeout
function fetchWithTimeout(request, timeout) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timeout')), timeout);
        fetch(request)
            .then(response => {
                clearTimeout(timer);
                resolve(response);
            })
            .catch(err => {
                clearTimeout(timer);
                reject(err);
            });
    });
}

// Handle event creation - queue if offline
async function handleCreateEvent(request) {
    // Clone request immediately and read the body before any async operations
    // This ensures we can access the body even if the original request is consumed
    let eventData;
    try {
        eventData = await request.clone().json();
    } catch (parseErr) {
        console.error('Failed to parse request body:', parseErr);
        return new Response(
            JSON.stringify({ error: 'Invalid request body', detail: parseErr.message }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
    }
    
    try {
        // Try network first
        const response = await fetchWithTimeout(request, 5000);
        return response;
    } catch (err) {
        // Network failed - queue the event for later
        console.log('Network unavailable, queuing event offline:', eventData.title);
        try {
            await queueEvent(eventData);
            
            // Return success response so UI knows it was queued
            return new Response(
                JSON.stringify({ 
                    status: 'queued', 
                    offline: true,
                    message: 'Event saved offline. Will sync when connected.' 
                }),
                { 
                    status: 202, 
                    headers: { 'Content-Type': 'application/json' }
                }
            );
        } catch (queueErr) {
            console.error('Failed to queue event:', queueErr);
            return new Response(
                JSON.stringify({ error: 'Failed to queue event offline', detail: queueErr.message }),
                { status: 500, headers: { 'Content-Type': 'application/json' } }
            );
        }
    }
}

// Queue event to IndexedDB
async function queueEvent(eventData) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(QUEUE_STORE, 'readwrite');
        const store = tx.objectStore(QUEUE_STORE);
        const request = store.add({
            ...eventData,
            queuedAt: new Date().toISOString()
        });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// Get all queued events
async function getQueuedEvents() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(QUEUE_STORE, 'readonly');
        const store = tx.objectStore(QUEUE_STORE);
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// Remove event from queue
async function removeFromQueue(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(QUEUE_STORE, 'readwrite');
        const store = tx.objectStore(QUEUE_STORE);
        const request = store.delete(id);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// Sync queued events when online
async function syncQueuedEvents() {
    const events = await getQueuedEvents();
    const results = { synced: 0, failed: 0 };
    
    for (const event of events) {
        try {
            const { id, queuedAt, ...eventData } = event;
            const response = await fetch('/api/events', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(eventData)
            });
            
            if (response.ok) {
                await removeFromQueue(id);
                results.synced++;
            } else {
                results.failed++;
            }
        } catch (err) {
            results.failed++;
        }
    }
    
    // Notify all clients about sync results
    const clients = await self.clients.matchAll();
    clients.forEach(client => {
        client.postMessage({
            type: 'SYNC_COMPLETE',
            results
        });
    });
    
    return results;
}

// Listen for sync event (Background Sync API)
self.addEventListener('sync', (event) => {
    if (event.tag === 'sync-events') {
        event.waitUntil(syncQueuedEvents());
    }
});

// Listen for messages from the main app
self.addEventListener('message', (event) => {
    if (event.data.type === 'SYNC_NOW') {
        syncQueuedEvents().then(results => {
            event.ports[0].postMessage(results);
        });
    }
    
    if (event.data.type === 'GET_QUEUE_COUNT') {
        getQueuedEvents().then(events => {
            event.ports[0].postMessage({ count: events.length });
        });
    }
});
