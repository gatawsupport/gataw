// app.js - Dashboard Logic and Firebase Data


// =========================
// DOM ELEMENTS
// =========================
const tempEl = document.getElementById("temp");
const phEl = document.getElementById("ph");
const salinityEl = document.getElementById("salinity");
const turbidityEl = document.getElementById("turbidity");
const doEl = document.getElementById("do");

const espEl = document.getElementById("espStatus");
const batteryEl = document.getElementById("battery");
const aeratorEl = document.getElementById("aeratorStatusText");
const lastUpdateEl = document.getElementById("lastUpdate");


// =========================
// CHECK DATABASE
// =========================
if (typeof window.database === 'undefined') {
  // Fallback: Use mock data for testing navigation
  useMockDataForNavigation();
} else {
}

// =========================
// MOCK DATA FOR NAVIGATION TESTING
// =========================
function useMockDataForNavigation() {
  
  const mockData = {
    temp: 28.5,
    ph: 7.2,
    salinity: 32.8,
    turbidity: 3.5,
    do: 6.8,
    battery: 85,
    aerator: "ON",
    lastUpdate: new Date().toLocaleTimeString()
  };
  
  // Update dashboard with mock data
  setTimeout(() => {
    if (tempEl) {
      tempEl.textContent = mockData.temp.toFixed(2);
      tempEl.className = "card-value safe";
      setStatusText('tempStatus', 'safe');
      setSlopeArrow('tempSlope', 0.3, 'safe');
    }
    if (phEl) {
      phEl.textContent = mockData.ph.toFixed(2);
      phEl.className = "card-value safe";
      setStatusText('phStatus', 'safe');
      setSlopeArrow('phSlope', -0.1, 'safe');
    }
    if (salinityEl) {
      salinityEl.textContent = mockData.salinity.toFixed(2);
      salinityEl.className = "card-value safe";
      setStatusText('salinityStatus', 'safe');
      setSlopeArrow('salinitySlope', 0, 'safe');
    }
    if (turbidityEl) {
      turbidityEl.textContent = mockData.turbidity.toFixed(2);
      turbidityEl.className = "card-value alert";
      setStatusText('turbidityStatus', 'alert');
      setSlopeArrow('turbiditySlope', 0.2, 'alert');
    }
    if (doEl) {
      doEl.textContent = mockData.do.toFixed(2);
      doEl.className = "card-value safe";
      setStatusText('doStatus', 'safe');
      setSlopeArrow('doSlope', -0.5, 'safe');
    }
    if (batteryEl) {
      batteryEl.textContent = mockData.battery + "%";
      updateBatteryColor(mockData.battery);
    }
    if (aeratorEl) {
      aeratorEl.textContent = mockData.aerator;
      aeratorEl.style.color = mockData.aerator === "ON" ? "#22c55e" : "#ef4444";
    }
    if (lastUpdateEl) {
      lastUpdateEl.textContent = mockData.lastUpdate;
    }
    if (espEl) {
      espEl.classList.add("online");
      espEl.classList.remove("offline");
    }
  }, 500);
}

// =========================
// SENSOR DATA
// Reads from sensors/{type}/pi (reading), si (slope), hlsi (health index)
// =========================
if (typeof window.database !== 'undefined') {
  window.database.ref("sensors").on("value", snapshot => {
    const data = snapshot.val();

    if (!data) {
      return;
    }

    // Helper to extract pi/si/hlsi/hs/hl from a sensor node
    function getSensorFields(node) {
      if (!node) return { pi: undefined, si: undefined, hlsi: undefined, hs: undefined, hl: undefined };
      return {
        pi:   node.pi   !== undefined ? Number(node.pi)   : undefined,
        si:   node.si   !== undefined ? Number(node.si)   : undefined,
        hlsi: node.hlsi !== undefined ? Number(node.hlsi) : undefined,
        hs:   node.hs   !== undefined ? Number(node.hs)   : undefined,
        hl:   node.hl   !== undefined ? Number(node.hl)   : undefined,
      };
    }

    const temp     = getSensorFields(data.temperature);
    const ph       = getSensorFields(data.ph);
    const salinity = getSensorFields(data.salinity);
    const turb     = getSensorFields(data.turbidity);
    const dox      = getSensorFields(data.do);

    // Update each card:
    //   pi    → real-time reading value
    //   hl    → color class for the reading value
    //   hlsi  → status text label (Safe / Alert / Critical)
    //   si    → slope arrow direction (positive = up, negative = down)
    //   hs    → color class for the slope/si value
    if (tempEl) {
      tempEl.textContent = temp.pi !== undefined ? temp.pi.toFixed(2) : "--";
      tempEl.className = 'card-value ' + getHlsiStatusClass(temp.hl);
      setStatusText('tempStatus', getHlsiStatusClass(temp.hlsi));
      setSlopeArrow('tempSlope', temp.si, getHlsiStatusClass(temp.hs));
    }

    if (phEl) {
      phEl.textContent = ph.pi !== undefined ? ph.pi.toFixed(2) : "--";
      phEl.className = 'card-value ' + getHlsiStatusClass(ph.hl);
      setStatusText('phStatus', getHlsiStatusClass(ph.hlsi));
      setSlopeArrow('phSlope', ph.si, getHlsiStatusClass(ph.hs));
    }

    if (salinityEl) {
      salinityEl.textContent = salinity.pi !== undefined ? salinity.pi.toFixed(2) : "--";
      salinityEl.className = 'card-value ' + getHlsiStatusClass(salinity.hl);
      setStatusText('salinityStatus', getHlsiStatusClass(salinity.hlsi));
      setSlopeArrow('salinitySlope', salinity.si, getHlsiStatusClass(salinity.hs));
    }

    if (turbidityEl) {
      turbidityEl.textContent = turb.pi !== undefined ? turb.pi.toFixed(2) : "--";
      turbidityEl.className = 'card-value ' + getHlsiStatusClass(turb.hl);
      setStatusText('turbidityStatus', getHlsiStatusClass(turb.hlsi));
      setSlopeArrow('turbiditySlope', turb.si, getHlsiStatusClass(turb.hs));
    }

    if (doEl) {
      doEl.textContent = dox.pi !== undefined ? dox.pi.toFixed(2) : "--";
      doEl.className = 'card-value ' + getHlsiStatusClass(dox.hl);
      setStatusText('doStatus', getHlsiStatusClass(dox.hlsi));
      setSlopeArrow('doSlope', dox.si, getHlsiStatusClass(dox.hs));
    }

    // Fish Kill Risk Index
    const fkri = data.fkri !== undefined ? Number(data.fkri) : undefined;
    updateFkri(fkri);

    // Update last update time from sensor data
    if (lastUpdateEl && data.lastUpdate) {
      const date = new Date(data.lastUpdate);
      lastUpdateEl.textContent = date.toLocaleString();
    } else if (lastUpdateEl) {
      lastUpdateEl.textContent = new Date().toLocaleTimeString();
    }

    // Track lastUpdate for heartbeat check
    window._lastSensorUpdate = data.lastUpdate ? Number(data.lastUpdate) : Date.now();
  });
}

// =========================
// SYSTEM STATUS (battery, aerator, esp32Online from /system)
// =========================
if (typeof window.database !== 'undefined') {
  window.database.ref("system").on("value", snapshot => {
    const system = snapshot.val();

    if (!system) {
      return;
    }

    // Battery percentage
    try {
      if (batteryEl && system.battery !== undefined) {
        updateBatteryColor(Number(system.battery));
      }
    } catch (e) {}

    // Aerator status
    try {
      const aeratorLive = document.getElementById("aeratorStatusText");
      if (aeratorLive) {
        const isOn = !!system.aerator;
        aeratorLive.textContent = isOn ? "ON" : "OFF";
        aeratorLive.style.color = isOn ? "#22c55e" : "#ef4444";
      }
    } catch (e) {}

    // esp32Online flag from /system (immediate flag set by device)
    if (espEl) {
      if (system.esp32Online) {
        espEl.classList.add("online");
        espEl.classList.remove("offline");
      } else {
        espEl.classList.add("offline");
        espEl.classList.remove("online");
      }
    }
  });
}

// =========================
// ESP32 HEARTBEAT CHECK
// Verifies every 60 seconds that /sensors.lastUpdate
// has been updated within the last 60 seconds.
// If not → mark ESP32 offline on the dashboard.
// =========================
window._lastSensorUpdate = null;

function checkEsp32Heartbeat() {
  if (window._lastSensorUpdate === null) {
    // No data received yet — mark offline
    if (espEl) {
      espEl.classList.add("offline");
      espEl.classList.remove("online");
    }
    return;
  }

  const now     = Date.now();
  const elapsed = now - window._lastSensorUpdate;   // ms
  const isAlive = elapsed <= 60000;                  // within 1 minute


  if (espEl) {
    if (isAlive) {
      espEl.classList.add("online");
      espEl.classList.remove("offline");
    } else {
      espEl.classList.add("offline");
      espEl.classList.remove("online");
    }
  }
}

// Run every 60 seconds
setInterval(checkEsp32Heartbeat, 60000);

// =========================
// AERATOR DOM-READY REAPPLY
// If the system listener fired before the DOM was fully painted,
// re-read /system once on DOMContentLoaded to guarantee the aerator shows.
// =========================
document.addEventListener("DOMContentLoaded", () => {
  if (typeof window.database === 'undefined') return;
  window.database.ref("system").once("value", snapshot => {
    const system = snapshot.val();
    if (!system) return;

    const aeratorLive = document.getElementById("aeratorStatusText");
    if (aeratorLive) {
      const isOn = !!system.aerator;
      aeratorLive.textContent = isOn ? "ON" : "OFF";
      aeratorLive.style.color = isOn ? "#22c55e" : "#ef4444";
    }

    const batteryLive = document.getElementById("battery");
    if (batteryLive && system.battery !== undefined) {
      if (typeof updateBatteryColor === 'function') updateBatteryColor(Number(system.battery));
    }

    const espLive = document.getElementById("espStatus");
    if (espLive) {
      if (system.esp32Online) {
        espLive.classList.add("online");
        espLive.classList.remove("offline");
      } else {
        espLive.classList.add("offline");
        espLive.classList.remove("online");
      }
    }
  });
});

// =========================
// HELPER FUNCTIONS
// =========================

/**
 * Determine status class from hlsi value:
 *   hlsi === 0              → "safe"
 *   0 < hlsi ≤ 0.5          → "alert"
 *   0.5 < hlsi ≤ 1          → "critical"
 *   anything else           → "unknown"
 */
function getHlsiStatusClass(hlsi) {
  if (hlsi === undefined || hlsi === null || isNaN(hlsi)) return "unknown";
  const v = Number(hlsi);
  if (v === 0)              return "safe";
  if (v > 0 && v <= 0.5)   return "alert";
  if (v > 0.5 && v <= 1)   return "critical";
  return "unknown";
}

// Set the status text pill below a metric value
function setStatusText(elementId, statusClass) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const mapping = { safe: 'Safe', alert: 'Alert', critical: 'Critical', unknown: '--' };
  el.textContent = mapping[statusClass] || '--';
  el.className = 'status-text ' + (statusClass || 'unknown');
}

/**
 * Render slope row: arrow (up/down) + absolute value + unit/hr
 * Arrow direction is driven by si sign (positive = up, negative = down).
 * Color of the arrow and value is driven by hsClass (hs threshold status).
 *   hsClass "safe"     → green
 *   hsClass "alert"    → amber/yellow
 *   hsClass "critical" → red
 *   si === 0 or undefined → neutral dash
 */
function setSlopeArrow(elementId, si, hsClass) {
  const el = document.getElementById(elementId);
  if (!el) return;

  const unit = el.getAttribute('data-unit') || '';
  // Resolve color from hs status class
  const colorMap = {
    safe:     'var(--slope-safe,     #22c55e)',
    alert:    'var(--slope-alert,    #f59e0b)',
    critical: 'var(--slope-critical, #ef4444)',
    unknown:  'var(--slope-neutral,  #94a3b8)',
  };
  const color = colorMap[hsClass] || colorMap['unknown'];

  if (si === undefined || si === null || isNaN(si)) {
    el.innerHTML = `<span class="slope-neutral">– <span class="slope-value">-- ${unit}/hr</span></span>`;
    return;
  }

  const absVal = Math.abs(Number(si)).toFixed(4);

  if (Number(si) > 0) {
    el.innerHTML = `
      <i class="fas fa-arrow-up" style="color:${color}"></i>
      <span class="slope-value" style="color:${color}">${absVal} ${unit}/hr</span>`;
  } else if (Number(si) < 0) {
    el.innerHTML = `
      <i class="fas fa-arrow-down" style="color:${color}"></i>
      <span class="slope-value" style="color:${color}">${absVal} ${unit}/hr</span>`;
  } else {
    el.innerHTML = `<span class="slope-neutral">– <span class="slope-value">0 ${unit}/hr</span></span>`;
  }
}

// =========================
// BATTERY COLOR UPDATE
// =========================
function updateBatteryColor(percentage) {
  const batteryIndicator = document.getElementById('batteryIndicator');
  if (!batteryIndicator) return;

  const batteryIcon = batteryIndicator.querySelector('i');
  const batteryText = document.getElementById('battery');

  const pct = Math.min(100, Math.max(0, Number(percentage)));
  const isLow = pct <= 20;

  // Toggle low class on indicator
  batteryIndicator.classList.toggle('low', isLow);

  // Update icon to always be full
  if (batteryIcon) {
    batteryIcon.className = 'fas fa-battery-full';
  }

  // Update percentage text with color coding
  if (batteryText) {
    batteryText.textContent = pct.toFixed(0) + '%';
    // Green (safe) > 50%, Yellow (caution) 20-50%, Red (critical) ≤ 20%
    if (pct > 50) {
      batteryText.style.color = '#22c55e'; // Green
    } else if (pct > 20) {
      batteryText.style.color = '#f59e0b'; // Yellow
    } else {
      batteryText.style.color = '#ef4444'; // Red
    }
  }
}

// =========================
// ROLE-BASED MENU VISIBILITY
// =========================
function hideMenuItemsForRole() {
  
  // Get current user session
  const userSession = localStorage.getItem('userSession');
  let isGuest = false;
  let isAdmin = false;
  
  if (userSession) {
    try {
      const session = JSON.parse(userSession);
      isGuest = session.isGuest === true;
      isAdmin = session.role === 'admin';
    } catch (error) {
    }
  }
  
  // Menu items to hide for guests
  const guestHideItems = [
    'historyTab',      // Monitor
    'alertsTab',       // Alerts
    'reportsTab',      // Reports
    'userSystemTab'    // User & System
  ];
  
  // Hide restricted items for guests
  if (isGuest) {
    guestHideItems.forEach(itemId => {
      const element = document.getElementById(itemId);
      if (element) {
        element.style.display = 'none';
      }
    });
    // Hide admin dashboard for guests
    const adminDashboard = document.getElementById('adminDashboardTab');
    if (adminDashboard) {
      adminDashboard.style.display = 'none';
    }
  } else {
    guestHideItems.forEach(itemId => {
      const element = document.getElementById(itemId);
      if (element) {
        element.style.display = '';
      }
    });
  }
  
  // Show admin dashboard only for admins
  const adminDashboardTab = document.getElementById('adminDashboardTab');
  if (adminDashboardTab) {
    if (isAdmin) {
      adminDashboardTab.style.display = '';
    } else {
      adminDashboardTab.style.display = 'none';
    }
  }
}

// =========================
// TOAST NOTIFICATION SYSTEM
// =========================

// Inject toast styles once into the page
(function injectToastStyles() {
  if (document.getElementById('threshold-toast-styles')) return;
  const style = document.createElement('style');
  style.id = 'threshold-toast-styles';
  style.textContent = `
    #threshold-toast-container {
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 999999;
      display: flex;
      flex-direction: column;
      gap: 10px;
      pointer-events: none;
      max-width: calc(100vw - 40px);
    }
    .threshold-toast {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 14px 16px;
      border-radius: 10px;
      width: 340px;
      max-width: 100%;
      box-shadow: 0 8px 28px rgba(0,0,0,0.35);
      font-family: Inter, sans-serif;
      font-size: 13.5px;
      color: #f1f5f9;
      pointer-events: all;
      animation: toastSlideIn 0.35s cubic-bezier(0.21, 1.02, 0.73, 1) forwards;
      background: #1e293b;
      border-left: 4px solid #e74c3c;
      box-sizing: border-box;
    }
    /* ── Small phones (≤ 480px) ── */
    @media (max-width: 480px) {
      #threshold-toast-container {
        top: 12px;
        right: 12px;
        max-width: calc(100vw - 24px);
      }
      .threshold-toast {
        width: calc(100vw - 24px);
        font-size: 12px;
        padding: 10px 12px;
        gap: 9px;
        border-radius: 8px;
      }
      .toast-title { font-size: 12px; }
      .toast-detail { font-size: 11.5px; }
      .toast-icon { font-size: 16px; }
      .toast-close { font-size: 13px; }
    }

    /* ── Large phones (481px – 768px) ── */
    @media (min-width: 481px) and (max-width: 768px) {
      #threshold-toast-container {
        top: 16px;
        right: 16px;
        max-width: calc(100vw - 32px);
      }
      .threshold-toast {
        width: 320px;
        font-size: 13px;
        padding: 12px 14px;
      }
      .toast-icon { font-size: 18px; }
    }

    /* ── Tablets (769px – 1024px) ── */
    @media (min-width: 769px) and (max-width: 1024px) {
      #threshold-toast-container {
        top: 18px;
        right: 18px;
      }
      .threshold-toast {
        width: 340px;
        font-size: 13.5px;
      }
    }

    /* ── Desktop & TV (1025px+) — default styles apply, no override needed ── */
    /* ── Large TV / 4K (1920px+) ── */
    @media (min-width: 1920px) {
      #threshold-toast-container {
        top: 32px;
        right: 32px;
        gap: 14px;
      }
      .threshold-toast {
        width: 420px;
        font-size: 15px;
        padding: 18px 20px;
        gap: 16px;
        border-radius: 12px;
        border-left-width: 5px;
      }
      .toast-title { font-size: 15px; }
      .toast-detail { font-size: 14px; }
      .toast-icon { font-size: 24px; }
      .toast-close { font-size: 18px; }
    }
    .threshold-toast.warning  { border-left-color: #f39c12; }
    .threshold-toast.critical { border-left-color: #e74c3c; }
    .threshold-toast.toast-exit {
      animation: toastSlideOut 0.35s ease forwards;
    }
    .toast-icon {
      font-size: 20px;
      line-height: 1;
      margin-top: 2px;
      flex-shrink: 0;
    }
    .toast-icon.warning  { color: #f39c12; }
    .toast-icon.critical { color: #e74c3c; }
    .toast-body { flex: 1; line-height: 1.45; }
    .toast-title {
      font-weight: 700;
      font-size: 13px;
      margin-bottom: 3px;
      letter-spacing: 0.01em;
    }
    .toast-title.critical { color: #fca5a5; }
    .toast-title.warning  { color: #fcd34d; }
    .toast-detail { opacity: 0.85; font-size: 12.5px; }
    .toast-close {
      background: none;
      border: none;
      color: #64748b;
      cursor: pointer;
      font-size: 15px;
      padding: 0;
      line-height: 1;
      flex-shrink: 0;
      margin-top: 1px;
      transition: color 0.15s;
    }
    .toast-close:hover { color: #f1f5f9; }
    @keyframes toastSlideIn {
      from { opacity: 0; transform: translateX(110%); }
      to   { opacity: 1; transform: translateX(0);    }
    }
    @keyframes toastSlideOut {
      from { opacity: 1; transform: translateX(0);    max-height: 120px; }
      to   { opacity: 0; transform: translateX(110%); max-height: 0;     }
    }
  `;
  document.head.appendChild(style);
})();

// Ensure the toast container exists
function getToastContainer() {
  let container = document.getElementById('threshold-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'threshold-toast-container';
    document.body.appendChild(container);
  }
  return container;
}

// Track active toasts per parameter (used to replace on severity change)
window._activeToastParams = window._activeToastParams || {};

// Parameter display config
const TOAST_PARAM_CONFIG = {
  temperature: { label: 'Temperature',      unit: '°C'    },
  ph:          { label: 'pH Level',         unit: ''      },
  salinity:    { label: 'Salinity',         unit: ' ppt'  },
  turbidity:   { label: 'Turbidity',        unit: ' NTU'  },
  do:          { label: 'Dissolved Oxygen', unit: ' mg/L' }
};

// ── SESSION SUPPRESSION HELPERS ──────────────────────────────────────────────
// Stores param:severity pairs in sessionStorage so navigation doesn't re-trigger
// the same toast. Cleared automatically when value returns to safe.

function _getSuppressed() {
  try {
    return JSON.parse(sessionStorage.getItem('_toastSuppressed') || '{}');
  } catch (_) { return {}; }
}

function _isSuppressed(param, severity) {
  return _getSuppressed()[param] === severity;
}

function _suppress(param, severity) {
  const map = _getSuppressed();
  map[param] = severity;
  sessionStorage.setItem('_toastSuppressed', JSON.stringify(map));
}

function _clearSuppression(param) {
  const map = _getSuppressed();
  if (map[param]) {
    delete map[param];
    sessionStorage.setItem('_toastSuppressed', JSON.stringify(map));
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Show a slide-in toast for a threshold breach.
 * One toast per parameter at a time — refreshed if severity changes.
 * Suppressed across page navigation via sessionStorage.
 */
function showThresholdToast(param, value, severity) {
  const config  = TOAST_PARAM_CONFIG[param] || { label: param, unit: '' };
  const toastId = `toast-param-${param}`;
  const existing = document.getElementById(toastId);

  // Already shown and suppressed for this severity (survives page navigation)
  if (_isSuppressed(param, severity)) return;

  // If same severity toast is already visible in DOM, skip
  if (existing && existing.dataset.severity === severity) return;

  // Severity changed — remove old one instantly before adding new
  if (existing) dismissToast(toastId, true);

  const isCritical = severity === 'critical';
  const titleText  = isCritical ? 'Critical Alert' : 'Warning Alert';
  const displayVal = typeof value === 'number' ? value.toFixed(2) : value;
  const detailText = `${config.label} is ${displayVal}${config.unit} — ${
    isCritical ? 'outside critical range' : 'outside safe range'
  }`;

  const toast = document.createElement('div');
  toast.id = toastId;
  toast.className = `threshold-toast ${severity}`;
  toast.dataset.severity = severity;
  toast.innerHTML = `
    <i class="fas fa-exclamation-triangle toast-icon ${severity}"></i>
    <div class="toast-body">
      <div class="toast-title ${severity}">${titleText}</div>
      <div class="toast-detail">${detailText}</div>
    </div>
    <button class="toast-close" onclick="dismissToast('${toastId}')" title="Dismiss">✕</button>
  `;

  getToastContainer().appendChild(toast);
  window._activeToastParams[param] = toastId;

  // Auto-dismiss after 5 seconds and suppress so navigation won't re-show it
  setTimeout(() => {
    dismissToast(toastId);
    _suppress(param, severity);
  }, 5000);
}

/**
 * Dismiss a toast by ID with slide-out animation.
 * Suppresses the param+severity so navigating away won't re-trigger it.
 * @param {string}  id      - Toast element ID
 * @param {boolean} instant - Skip animation (used when replacing on severity change)
 */
function dismissToast(id, instant = false) {
  const toast = document.getElementById(id);
  if (!toast) return;

  // Suppress this param+severity when manually closed or auto-dismissed
  const param    = id.replace('toast-param-', '');
  const severity = toast.dataset.severity;
  if (param && severity) _suppress(param, severity);

  if (instant) {
    toast.remove();
    return;
  }

  toast.classList.add('toast-exit');
  setTimeout(() => { if (toast.parentElement) toast.remove(); }, 380);
}

// checkThresholdsAndToast removed — status is now driven by hlsi, not thresholds.

// =========================
// FISH KILL RISK INDEX
// =========================

/**
 * Map fkri value → risk level config
 *   0 – 0.05        → Low
 *   > 0.05 – 0.275  → Moderate
 *   > 0.275 – 0.50  → High
 *   > 0.50 – 0.75   → Very High
 *   > 0.75 – 1.00   → Extreme
 */
function getFkriLevel(fkri) {
  if (fkri === undefined || fkri === null || isNaN(fkri)) {
    return { label: '--', cssClass: 'fkri-unknown' };
  }
  const v = Number(fkri);
  if (v <= 0.05)                 return { label: 'Low Risk',       cssClass: 'fkri-low'      };
  if (v > 0.05  && v <= 0.275)  return { label: 'Moderate Risk',  cssClass: 'fkri-moderate' };
  if (v > 0.275 && v <= 0.50)   return { label: 'High Risk',      cssClass: 'fkri-high'     };
  if (v > 0.50  && v <= 0.75)   return { label: 'Very High Risk', cssClass: 'fkri-veryhigh' };
  return                                { label: 'Extreme Risk',   cssClass: 'fkri-extreme'  };
}

/**
 * Build a recommendation based solely on the fkri risk level.
 * No individual parameter names are mentioned.
 */
function buildRecommendation(fkriLabel) {
  const recommendations = {
    'Low Risk':       'All parameters are within safe range. Continue routine monitoring.',
    'Moderate Risk':  'Water quality is showing early signs of stress. Increase monitoring frequency and activate aerators as a precaution.',
    'High Risk':      'Water quality is deteriorating. Activate aerators immediately, reduce feeding, and prepare for emergency intervention.',
    'Very High Risk': 'Critical water conditions detected. Maximize aeration, stop feeding, and consider partial water exchange immediately.',
    'Extreme Risk':   'Fish kill is imminent. Emergency response required — maximize all aerators, halt feeding, initiate water exchange, and contact aquaculture support.'
  };
  return recommendations[fkriLabel] || 'Monitor closely and take corrective action.';
}

/**
 * Update the FKRI card on the dashboard.
 */
function updateFkri(fkri) {
  const ARC_LENGTH = Math.PI * 80; // semicircle r=80

  const level      = getFkriLevel(fkri);
  const recEl      = document.getElementById('fkriRecommendation');
  const sectionEl  = document.getElementById('fkriSection');
  const valueEl    = document.getElementById('fkriValue');
  const gaugeArc   = document.getElementById('gaugeArc');
  const gaugeNeedle= document.getElementById('gaugeNeedle');
  const gaugeText  = document.getElementById('gaugeValueText');

  const fkriNum = (fkri !== undefined && !isNaN(fkri)) ? Number(fkri) : null;

  if (valueEl) {
    valueEl.textContent = fkriNum !== null ? fkriNum.toFixed(4) : '--';
  }

  // Section border colour class
  if (sectionEl) {
    sectionEl.className = 'fkri-card ' + level.cssClass;
  }

  // Recommendation
  if (recEl) {
    recEl.innerHTML = buildRecommendation(level.label);
  }

  // Gauge animation
  const pct = fkriNum !== null ? Math.min(1, Math.max(0, fkriNum)) : 0;

  if (gaugeArc) {
    const offset = ARC_LENGTH - (pct * ARC_LENGTH);
    gaugeArc.style.transition       = 'stroke-dashoffset 1s cubic-bezier(0.4,0,0.2,1)';
    gaugeArc.style.strokeDashoffset = offset;
  }

  if (gaugeNeedle) {
    const angle = -90 + (pct * 180);
    gaugeNeedle.style.transition = 'transform 1s cubic-bezier(0.4,0,0.2,1)';
    gaugeNeedle.setAttribute('transform', `rotate(${angle}, 90, 90)`);
  }

  if (gaugeText) {
    gaugeText.textContent = level.label !== '--' ? level.label : '--';
    const textColors = {
      'fkri-low':      '#16a34a',
      'fkri-moderate': '#84cc16',
      'fkri-high':     '#d97706',
      'fkri-veryhigh': '#dc2626',
      'fkri-extreme':  '#7f1d1d'
    };
    gaugeText.style.color = textColors[level.cssClass] || '#475569';
  }
}

// =========================
// DOM READY
// =========================
document.addEventListener("DOMContentLoaded", () => {

  // Hide menu items based on role
  hideMenuItemsForRole();

  // Add card click handlers for visual feedback
  const cards = document.querySelectorAll('.card');
  cards.forEach(card => {
    card.onclick = null;
    
    card.addEventListener('click', function(e) {
      this.style.transform = 'scale(0.98)';
      setTimeout(() => {
        this.style.transform = '';
      }, 150);
    });
  });

});