// ===== Global App State & Configuration =====
const API = 'http://localhost:3000/api';
const STORE_ID = localStorage.getItem('storeId') || 'default';
const API_TIMEOUT_MS = 15000;
const HEALTH_CHECK_INTERVAL_MS = 10000;
const HEALTH_CHECK_FAST_INTERVAL_MS = 3000;
const HEALTH_CHECK_SLOW_INTERVAL_MS = 30000;
const OFFLINE_QUEUE_KEY = 'swiftpos_offline_queue';
const OFFLINE_QUEUE_MAX = 100;

// ===== Polyfill: AbortSignal.timeout for legacy POS terminals =====
if (typeof AbortSignal !== 'undefined' && !AbortSignal.timeout) {
  AbortSignal.timeout = function(ms) {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(new DOMException('TimeoutError', 'TimeoutError')), ms);
    return ctrl.signal;
  };
}

// ===== Offline Queue (IndexedDB-backed for durability) =====
const OfflineQueue = {
  db: null,
  dbName: 'SwiftPOS_OfflineQueue',
  storeName: 'requests',
  version: 1,

  async init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, this.version);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => { this.db = req.result; resolve(); };
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: 'id', autoIncrement: true });
        }
      };
    });
  },

  async enqueue(request) {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      if (request.idempotencyKey) {
        const idxReq = store.openCursor();
        idxReq.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            if (cursor.value.idempotencyKey === request.idempotencyKey) {
              resolve();
              return;
            }
            cursor.continue();
          } else {
            const addReq = store.add(request);
            addReq.onsuccess = () => resolve();
            addReq.onerror = () => reject(addReq.error);
          }
        };
      } else {
        const addReq = store.add(request);
        addReq.onsuccess = () => resolve();
        addReq.onerror = () => reject(addReq.error);
      }
    });
  },

  async dequeue() {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const req = store.openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        resolve(cursor ? cursor.value : null);
      };
      req.onerror = () => reject(req.error);
    });
  },

  async remove(id) {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },

  async count() {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const req = store.count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
};

// ===== Circuit Breaker for Health Checks =====
const CircuitBreaker = {
  state: 'CLOSED',
  failures: 0,
  threshold: 5,
  resetTimeout: 30000,
  lastFailureTime: null,

  recordSuccess() {
    this.failures = 0;
    if (this.state === 'HALF_OPEN' || this.state === 'OPEN') {
      this.state = 'CLOSED';
      console.log('[CircuitBreaker] CLOSED — backend healthy');
    }
  },

  recordFailure() {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.failures >= this.threshold && this.state === 'CLOSED') {
      this.state = 'OPEN';
      console.warn('[CircuitBreaker] OPEN — backend considered down');
    }
  },

  canAttempt() {
    if (this.state === 'CLOSED') return true;
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime >= this.resetTimeout) {
        this.state = 'HALF_OPEN';
        console.log('[CircuitBreaker] HALF_OPEN — probing backend...');
        return true;
      }
      return false;
    }
    return true;
  }
};

// ===== Socket.IO — Resilient, Authenticated, Storm-Protected =====
let socket = null;
let isSocketConnected = false;
let isBackendHealthy = false;
let authFailureCount = 0;
const MAX_AUTH_FAILURES = 3;

function createSocket() {
  const token = localStorage.getItem('authToken') || '';

  socket = io('http://localhost:3000', {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    randomizationFactor: 0.5,
    timeout: 20000,
    auth: { token, storeId: STORE_ID },
    query: { storeId: STORE_ID }
  });

  socket.on('connect', () => {
    isSocketConnected = true;
    authFailureCount = 0;
    updateConnStatus(true);
    console.log('[Socket] Connected:', socket.id);
    syncOfflineQueue();
  });

  socket.on('disconnect', (reason) => {
    isSocketConnected = false;
    updateConnStatus(false);
    console.warn('[Socket] Disconnected:', reason);
  });

  socket.on('connect_error', (err) => {
    isSocketConnected = false;
    updateConnStatus(false);

    if (err.message && (
      err.message.includes('Authentication required') ||
      err.message.includes('jwt') ||
      err.message.includes('auth')
    )) {
      authFailureCount++;
      console.error(`[Socket] Auth failure ${authFailureCount}/${MAX_AUTH_FAILURES}:`, err.message);
      if (authFailureCount >= MAX_AUTH_FAILURES) {
        console.error('[Socket] Stopping reconnection — auth token invalid. Triggering re-auth...');
        socket.disconnect();
        toast('Session expired. Please log in again.', 'error');
      }
      return;
    }

    console.error('[Socket] Connection error:', err.message);
  });

  socket.on('error', (err) => {
    console.error('[Socket] Server error:', err);
  });
}

createSocket();

// ===== Connection Status UI =====
function updateConnStatus(connected) {
  const actualStatus = connected && isBackendHealthy;
  const dots = document.querySelectorAll('.conn-dot');
  const labels = document.querySelectorAll('.conn-label');
  const banner = document.getElementById('offline-banner');

  dots.forEach(dot => {
    dot.className = 'conn-dot ' + (actualStatus ? 'connected' : 'disconnected');
  });
  labels.forEach(el => {
    el.textContent = actualStatus ? 'Live' : 'Offline';
  });

  if (banner) {
    if (actualStatus) {
      banner.classList.add('hidden');
    } else {
      banner.classList.remove('hidden');
      const msg = document.getElementById('offline-message');
      if (msg) msg.textContent = isBackendHealthy
        ? 'Real-time sync unavailable. Sales will queue locally.'
        : 'Connection lost. Working in offline mode...';
    }
  }
}

// ===== Health Check — Circuit-Breaker Protected =====
async function checkHealth() {
  if (!CircuitBreaker.canAttempt()) {
    return;
  }

  try {
    const res = await fetch(`${API}/health`, {
      method: 'GET',
      headers: {
        'x-store-id': STORE_ID,
        'Cache-Control': 'no-cache'
      },
      signal: createAbortSignal(5000)
    });

    const wasHealthy = isBackendHealthy;
    isBackendHealthy = res.ok;

    if (res.ok) {
      CircuitBreaker.recordSuccess();
      if (!wasHealthy) {
        updateConnStatus(isSocketConnected);
        toast('Connection restored.', 'success');
        syncOfflineQueue();
      }
    } else {
      CircuitBreaker.recordFailure();
      if (wasHealthy) {
        updateConnStatus(isSocketConnected);
        toast('Server connection unstable. Some features may be unavailable.', 'warning');
      }
    }
  } catch (err) {
    CircuitBreaker.recordFailure();
    if (isBackendHealthy) {
      isBackendHealthy = false;
      updateConnStatus(isSocketConnected);
      toast('Lost connection to server. Retrying...', 'error');
    }
  }
}

function createAbortSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
    return AbortSignal.timeout(ms);
  }
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

let healthCheckTimer = null;
function scheduleHealthCheck() {
  clearTimeout(healthCheckTimer);
  let interval = HEALTH_CHECK_INTERVAL_MS;
  if (!isBackendHealthy) {
    interval = CircuitBreaker.state === 'OPEN'
      ? HEALTH_CHECK_SLOW_INTERVAL_MS
      : HEALTH_CHECK_FAST_INTERVAL_MS;
  }
  healthCheckTimer = setTimeout(() => {
    checkHealth().then(scheduleHealthCheck);
  }, interval);
}

checkHealth();
scheduleHealthCheck();

// ===== API Helper — Timeout, Retry, Offline Queue =====
async function apiFetch(url, options = {}) {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    const offlineErr = new Error('You are offline. This request has been queued for sync.');
    offlineErr.name = 'OfflineError';
    offlineErr.status = 0;
    offlineErr.queued = true;
    throw offlineErr;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  const defaultHeaders = {
    'Content-Type': 'application/json',
    'x-store-id': STORE_ID
  };

  const token = localStorage.getItem('authToken');
  if (token) defaultHeaders['Authorization'] = `Bearer ${token}`;

  const config = {
    ...options,
    headers: {
      ...defaultHeaders,
      ...(options.headers || {})
    },
    signal: controller.signal
  };

  if (
    ['GET', 'HEAD', 'DELETE'].includes(config.method?.toUpperCase()) &&
    !options.body
  ) {
    delete config.headers['Content-Type'];
  }

  try {
    const res = await fetch(API + url, config);
    clearTimeout(timeoutId);

    let data;
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      data = await res.json();
    } else {
      const text = await res.text();
      data = { message: text };
    }

    if (!res.ok) {
      const error = new Error(data.message || `HTTP ${res.status}`);
      error.status = res.status;
      error.data = data;
      throw error;
    }

    return data;
  } catch (err) {
    clearTimeout(timeoutId);

    if (err.name === 'AbortError') {
      const timeoutError = new Error('Request timed out. Please check your connection and try again.');
      timeoutError.name = 'TimeoutError';
      timeoutError.status = 408;
      throw timeoutError;
    }

    if (err.name === 'TypeError' || (err.message && err.message.includes('fetch'))) {
      const networkError = new Error('Network error. Please check your internet connection.');
      networkError.name = 'NetworkError';
      networkError.status = 0;
      throw networkError;
    }

    throw err;
  }
}

// ===== Retry Wrapper — Exponential Backoff =====
async function apiFetchWithRetry(url, options = {}, maxRetries = 2) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await apiFetch(url, options);
    } catch (err) {
      lastError = err;

      if (err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) {
        throw err;
      }

      if (err.name === 'OfflineError') throw err;

      if (attempt <= maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
        console.warn(`[apiFetch] Retry ${attempt}/${maxRetries} in ${delay}ms: ${url}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

// ===== Offline-Aware API Wrapper =====
async function apiFetchWithOfflineQueue(url, options = {}) {
  try {
    return await apiFetchWithRetry(url, options);
  } catch (err) {
    const method = (options.method || 'GET').toUpperCase();
    const isMutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

    if (isMutating && (err.name === 'OfflineError' || err.name === 'NetworkError' || err.name === 'TimeoutError')) {
      const queueItem = {
        url,
        method,
        headers: options.headers || {},
        body: options.body,
        idempotencyKey: options.headers?.['idempotency-key'] || generateIdempotencyKey(),
        timestamp: Date.now(),
        retryCount: 0
      };

      await OfflineQueue.enqueue(queueItem);
      toast('Sale queued. Will sync when connection is restored.', 'warning');

      return {
        queued: true,
        success: true,
        message: 'Request queued for offline sync'
      };
    }

    throw err;
  }
}

// ===== Offline Queue Sync =====
let isSyncing = false;
async function syncOfflineQueue() {
  if (isSyncing || !isBackendHealthy || !navigator.onLine) return;
  isSyncing = true;

  try {
    const count = await OfflineQueue.count();
    if (count === 0) {
      isSyncing = false;
      return;
    }

    console.log(`[OfflineQueue] Syncing ${count} pending requests...`);
    toast(`Syncing ${count} offline transactions...`, 'info');

    let processed = 0;
    let failed = 0;

    while (true) {
      const item = await OfflineQueue.dequeue();
      if (!item) break;

      try {
        await apiFetch(item.url, {
          method: item.method,
          headers: {
            ...item.headers,
            'idempotency-key': item.idempotencyKey
          },
          body: item.body
        });
        await OfflineQueue.remove(item.id);
        processed++;
      } catch (err) {
        if (err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) {
          console.error('[OfflineQueue] Permanent failure, removing:', err.message);
          await OfflineQueue.remove(item.id);
          failed++;
        } else {
          console.warn('[OfflineQueue] Temporary failure, will retry:', err.message);
          break;
        }
      }
    }

    if (processed > 0) {
      toast(`Synced ${processed} offline transactions.`, 'success');
    }
    if (failed > 0) {
      toast(`${failed} transactions failed permanently. Check logs.`, 'error');
    }
  } catch (err) {
    console.error('[OfflineQueue] Sync error:', err);
  } finally {
    isSyncing = false;
  }
}

function generateIdempotencyKey() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// ===== Toast =====
function toast(msg, type = 'info') {
  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  const container = document.getElementById('toast-container') || createToastContainer();
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-icon">${icons[type]}</span><span class="toast-msg">${msg}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.style.animation = 'none';
    el.style.opacity = '0';
    el.style.transform = 'translateX(100%)';
    el.style.transition = '0.3s';
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

function createToastContainer() {
  const c = document.createElement('div');
  c.id = 'toast-container';
  c.className = 'toast-container';
  document.body.appendChild(c);
  return c;
}

// ===== Modal =====
function openModal(id) {
  document.getElementById(id)?.classList.add('open');
}
function closeModal(id) {
  document.getElementById(id)?.classList.remove('open');
}

document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-overlay')) closeModal(e.target.id);
  if (e.target.classList.contains('modal-close')) {
    closeModal(e.target.closest('.modal-overlay').id);
  }
});

// ===== Format Helpers =====
const fmt = {
  currency: (n) => '$' + (Number(n) || 0).toFixed(2),
  date: (d) => new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }),
  datetime: (d) => new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
  number: (n) => Number(n).toLocaleString()
};

// ===== Clock =====
function startClock() {
  const el = document.querySelector('.topbar-time');
  if (!el) return;
  const update = () => {
    const now = new Date();
    el.textContent = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };
  update();
  setInterval(update, 1000);
}

// ===== Active Nav =====
function setActiveNav() {
  const path = window.location.pathname;
  document.querySelectorAll('.nav-item[data-path]').forEach(item => {
    const itemPath = item.dataset.path;
    if (path === itemPath || (path === '/' && itemPath === '/')) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });
}

// ===== Global Error Handler =====
window.addEventListener('unhandledrejection', event => {
  const err = event.reason;
  if (err && (err.name === 'TimeoutError' || err.name === 'NetworkError' || err.name === 'OfflineError')) {
    toast(err.message, 'error');
    event.preventDefault();
  }
});

// ===== Online/Offline Event Listeners =====
window.addEventListener('online', () => {
  console.log('[Network] Browser reports online');
  checkHealth();
  syncOfflineQueue();
});

window.addEventListener('offline', () => {
  console.log('[Network] Browser reports offline');
  isBackendHealthy = false;
  updateConnStatus(false);
  toast('You are offline. Sales will be queued locally.', 'warning');
});

// ===== Bootstrap =====
document.addEventListener('DOMContentLoaded', () => {
  OfflineQueue.init().catch(err => console.error('IndexedDB init failed:', err));
  startClock();
  setActiveNav();
});