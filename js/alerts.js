// ========================================
// ALERTS PAGE JAVASCRIPT
// FKRI-Based Alert System
// ========================================
//
// Active alert:  alerts/active/fkri_status  (single fixed entry, written by server)
// History alerts: alerts/history            (pushed when acknowledged or dismissed)
//
// The server (server.js on Render) is the sole writer of alerts/active/fkri_status.
// This browser file only DISPLAYS and manages (acknowledge/dismiss) alerts.
// ========================================

// Global state
let currentAlert  = null;   // The single active FKRI alert (or null if none)
let historyAlerts = [];
let currentTab    = 'active';
let listenerSetup = false;

// ========================================
// INIT
// ========================================
document.addEventListener('DOMContentLoaded', function () {
  initializeAlertsPage();
  setupDateFilters();
});

// ========================================
// ROLE HELPER
// ========================================
function canManageAlerts() {
  try {
    const userSession = localStorage.getItem('userSession');
    if (!userSession) return false;
    const session = JSON.parse(userSession);
    return session.role === 'admin';
  } catch (e) {
    return false;
  }
}

// ========================================
// INITIALIZE
// ========================================
function initializeAlertsPage() {
  // Show Acknowledge All button only for admins
  const acknowledgeAllBtn = document.getElementById('acknowledgeAllBtn');
  if (acknowledgeAllBtn) {
    acknowledgeAllBtn.style.display = canManageAlerts() ? '' : 'none';
  }

  // Check Firebase
  if (typeof firebase === 'undefined' || !firebase.database) {
    console.error('Firebase is required for this application');
    showFirebaseError();
    return;
  }

  loadActiveAlert();
  loadHistoryAlerts();
}

// ========================================
// FIREBASE ERROR
// ========================================
function showFirebaseError() {
  const alertsList = document.getElementById('activeAlertsList');
  const historyList = document.getElementById('historyAlertsList');
  const errorMessage = `
    <div class="no-alerts">
      <i class="fas fa-exclamation-triangle" style="color: #e74c3c;"></i>
      <p>Firebase Connection Required</p>
      <span>Please ensure Firebase is properly configured and connected</span>
    </div>
  `;
  if (alertsList) alertsList.innerHTML = errorMessage;
  if (historyList) historyList.innerHTML = errorMessage;
}

// ========================================
// TAB SWITCHING
// ========================================
function switchTab(tabName) {
  currentTab = tabName;

  const tabButtons = document.querySelectorAll('.alerts-tab-btn');
  tabButtons.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });

  const activeTabContent  = document.getElementById('activeTab');
  const historyTabContent = document.getElementById('alertsHistoryTab');

  if (tabName === 'active') {
    if (activeTabContent)  { activeTabContent.classList.add('active');     activeTabContent.style.display  = 'block'; }
    if (historyTabContent) { historyTabContent.classList.remove('active'); historyTabContent.style.display = 'none';  }
  } else if (tabName === 'alertsHistory') {
    if (activeTabContent)  { activeTabContent.classList.remove('active');  activeTabContent.style.display  = 'none';  }
    if (historyTabContent) { historyTabContent.classList.add('active');    historyTabContent.style.display = 'block'; }
    displayHistoryAlerts();
  }
}

// ========================================
// LOAD ACTIVE ALERT
// Watches the single fixed key: alerts/active/fkri_status
// ========================================
function loadActiveAlert() {
  if (listenerSetup) return;
  listenerSetup = true;

  const alertRef   = firebase.database().ref('alerts/active/fkri_status');
  const alertsList = document.getElementById('activeAlertsList');

  alertRef.on('value', (snapshot) => {
    if (!alertsList) return;

    if (snapshot.exists()) {
      currentAlert = { id: 'fkri_status', ...snapshot.val() };
      alertsList.innerHTML = createActiveAlertCard(currentAlert);
      updateActiveAlertsCount(1);

      const acknowledgeBtn = document.getElementById('acknowledgeAllBtn');
      if (acknowledgeBtn) acknowledgeBtn.disabled = false;

    } else {
      // Alert was removed (FKRI dropped below Very High)
      currentAlert = null;
      showNoActiveAlerts(alertsList);
      updateActiveAlertsCount(0);
    }
  }, (error) => {
    console.error('[alerts.js] Error listening to active alert:', error);
  });
}

// ========================================
// EMPTY STATE
// ========================================
function showNoActiveAlerts(alertsList) {
  alertsList.innerHTML = `
    <div class="no-alerts">
      <i class="fas fa-check-circle"></i>
      <p>No active alerts at this time</p>
      <span>Your pond water quality is within normal parameters</span>
    </div>
  `;
  const acknowledgeBtn = document.getElementById('acknowledgeAllBtn');
  if (acknowledgeBtn) acknowledgeBtn.disabled = true;
}

// ========================================
// CREATE ACTIVE ALERT CARD
// Displays: FKRI value, risk level, dominant parameter, level changed time
// ========================================
function createActiveAlertCard(alert) {
  const riskLevel     = alert.riskLevel     || 'Unknown';
  const fkri          = typeof alert.fkri === 'number' ? alert.fkri.toFixed(4) : '--';
  const dominantParam = alert.dominantParam || 'Unknown';
  const levelChangedAt = formatTimestamp(alert.levelChangedAt);
  const updatedAt      = formatTimestamp(alert.updatedAt);

  const riskClass  = getRiskLevelClass(riskLevel);
  const riskIcon   = getRiskLevelIcon(riskLevel);
  const paramLabel = getParamLabel(dominantParam);
  const paramIcon  = getParamIcon(dominantParam);

  const footerActions = canManageAlerts() ? `
    <div class="alert-actions">
      <button class="alert-btn alert-btn-acknowledge" onclick="acknowledgeAlert()">
        <i class="fas fa-check"></i> Acknowledge
      </button>
      <button class="alert-btn alert-btn-dismiss" onclick="dismissAlert()">
        <i class="fas fa-times"></i> Dismiss
      </button>
    </div>` : '';

  return `
    <div class="alert-card ${riskClass}" data-alert-id="fkri_status">
      <div class="alert-header">
        <div class="alert-title-group">
          <div class="alert-icon">
            <i class="${riskIcon}"></i>
          </div>
          <div class="alert-title-text">
            <h3 class="alert-title">${riskLevel} Risk — Bangus Pond</h3>
            <p class="alert-parameter">FISH KILL RISK INDEX</p>
          </div>
        </div>
        <span class="alert-severity-badge ${riskClass}">${riskLevel}</span>
      </div>

      <div class="alert-body">
        <div class="alert-info-item">
          <span class="alert-info-label">FKRI Value</span>
          <span class="alert-info-value ${riskClass}-value">${fkri}</span>
        </div>
        <div class="alert-info-item">
          <span class="alert-info-label">Risk Level</span>
          <span class="alert-info-value">${riskLevel}</span>
        </div>
        <div class="alert-info-item">
          <span class="alert-info-label">Dominant Parameter</span>
          <span class="alert-info-value">
            <i class="${paramIcon}"></i> ${paramLabel}
          </span>
        </div>
        <div class="alert-info-item">
          <span class="alert-info-label">Level Since</span>
          <span class="alert-info-value">${levelChangedAt}</span>
        </div>
      </div>

      <div class="alert-footer">
        <div class="alert-timestamp">
          <i class="fas fa-clock"></i> Updated ${updatedAt}
        </div>
        ${footerActions}
      </div>
    </div>
  `;
}

// ========================================
// CREATE HISTORY ALERT CARD
// ========================================
function createHistoryAlertCard(alert) {
  const riskLevel     = alert.riskLevel     || 'Unknown';
  const fkri          = typeof alert.fkri === 'number' ? alert.fkri.toFixed(4) : '--';
  const dominantParam = alert.dominantParam || 'Unknown';
  const paramLabel    = getParamLabel(dominantParam);
  const paramIcon     = getParamIcon(dominantParam);
  const levelChangedAt = formatTimestamp(alert.levelChangedAt);

  let actionLabel = '';
  let actionTime  = '';
  if (alert.dismissed) {
    actionLabel = '<i class="fas fa-times-circle"></i> Dismissed';
    actionTime  = formatTimestamp(alert.dismissedAt);
  } else if (alert.acknowledged) {
    actionLabel = '<i class="fas fa-check-circle"></i> Acknowledged';
    actionTime  = formatTimestamp(alert.acknowledgedAt);
  }

  let statusBadge = '';
  if (alert.dismissed) {
    statusBadge = '<span class="alert-severity-badge dismissed">Dismissed</span>';
  } else if (alert.acknowledged) {
    statusBadge = '<span class="alert-severity-badge resolved">Acknowledged</span>';
  }

  return `
    <div class="alert-card resolved" data-alert-id="${alert.id}">
      <div class="alert-header">
        <div class="alert-title-group">
          <div class="alert-icon">
            <i class="fas fa-fish"></i>
          </div>
          <div class="alert-title-text">
            <h3 class="alert-title">${riskLevel} Risk — Bangus Pond</h3>
            <p class="alert-parameter">FISH KILL RISK INDEX</p>
          </div>
        </div>
        ${statusBadge}
      </div>

      <div class="alert-body">
        <div class="alert-info-item">
          <span class="alert-info-label">FKRI Value</span>
          <span class="alert-info-value">${fkri}</span>
        </div>
        <div class="alert-info-item">
          <span class="alert-info-label">Risk Level</span>
          <span class="alert-info-value">${riskLevel}</span>
        </div>
        <div class="alert-info-item">
          <span class="alert-info-label">Dominant Parameter</span>
          <span class="alert-info-value">
            <i class="${paramIcon}"></i> ${paramLabel}
          </span>
        </div>
        <div class="alert-info-item">
          <span class="alert-info-label">Level Since</span>
          <span class="alert-info-value">${levelChangedAt}</span>
        </div>
        <div class="alert-info-item">
          <span class="alert-info-label">Action</span>
          <span class="alert-info-value">
            ${actionLabel} <span class="action-timestamp">${actionTime}</span>
          </span>
        </div>
      </div>

      <div class="alert-footer">
        <div class="alert-timestamp">
          <i class="fas fa-clock"></i> ${formatTimestamp(alert.timestamp)}
        </div>
      </div>
    </div>
  `;
}

// ========================================
// ACKNOWLEDGE ALERT
// ========================================
function acknowledgeAlert() {
  if (!currentAlert) return;

  const card = document.querySelector('[data-alert-id="fkri_status"]');
  if (card) {
    card.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
    card.style.opacity    = '0';
    card.style.transform  = 'translateX(20px)';
  }

  const historyData = {
    fkri:           currentAlert.fkri,
    riskLevel:      currentAlert.riskLevel,
    dominantParam:  currentAlert.dominantParam,
    hls:            currentAlert.hls || {},
    levelChangedAt: currentAlert.levelChangedAt,
    timestamp:      currentAlert.updatedAt || Date.now(),
    acknowledged:   true,
    acknowledgedAt: Date.now(),
  };

  firebase.database().ref('alerts/history').push(historyData)
    .then(() => firebase.database().ref('alerts/active/fkri_status').remove())
    .catch(error => {
      console.error('[alerts.js] Error acknowledging alert:', error);
      if (card) { card.style.opacity = '1'; card.style.transform = 'translateX(0)'; }
      alert('Failed to acknowledge alert. Please try again.');
    });
}

// ========================================
// DISMISS ALERT
// ========================================
function dismissAlert() {
  if (!currentAlert) return;

  if (!confirm('Are you sure you want to dismiss this alert without acknowledging it?')) return;

  const card = document.querySelector('[data-alert-id="fkri_status"]');
  if (card) {
    card.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
    card.style.opacity    = '0';
    card.style.transform  = 'translateX(-20px)';
  }

  const historyData = {
    fkri:           currentAlert.fkri,
    riskLevel:      currentAlert.riskLevel,
    dominantParam:  currentAlert.dominantParam,
    hls:            currentAlert.hls || {},
    levelChangedAt: currentAlert.levelChangedAt,
    timestamp:      currentAlert.updatedAt || Date.now(),
    acknowledged:   false,
    dismissed:      true,
    dismissedAt:    Date.now(),
  };

  firebase.database().ref('alerts/history').push(historyData)
    .then(() => firebase.database().ref('alerts/active/fkri_status').remove())
    .catch(error => {
      console.error('[alerts.js] Error dismissing alert:', error);
      if (card) { card.style.opacity = '1'; card.style.transform = 'translateX(0)'; }
      alert('Failed to dismiss alert. Please try again.');
    });
}

// ========================================
// ACKNOWLEDGE ALL (same as single — there's only one)
// ========================================
function acknowledgeAll() {
  acknowledgeAlert();
}

// ========================================
// LOAD HISTORY ALERTS
// ========================================
function loadHistoryAlerts() {
  const historyRef = firebase.database().ref('alerts/history');

  historyRef.orderByChild('timestamp').limitToLast(100).on('value', (snapshot) => {
    historyAlerts = [];

    if (snapshot.exists()) {
      snapshot.forEach((childSnapshot) => {
        historyAlerts.push({ id: childSnapshot.key, ...childSnapshot.val() });
      });
      historyAlerts.sort((a, b) => b.timestamp - a.timestamp);
    }

    displayHistoryAlerts();
  }, (error) => {
    console.error('[alerts.js] Error loading history:', error);
  });
}

// ========================================
// DISPLAY HISTORY ALERTS
// ========================================
function displayHistoryAlerts() {
  const historyList = document.getElementById('historyAlertsList');
  if (!historyList) return;

  const filtered = filterHistoryAlerts();

  if (filtered.length === 0) {
    historyList.innerHTML = `
      <div class="no-alerts">
        <i class="fas fa-inbox"></i>
        <p>No alert history available</p>
        <span>Past alerts will appear here once they are acknowledged or dismissed</span>
      </div>
    `;
    return;
  }

  historyList.innerHTML = filtered.map(alert => createHistoryAlertCard(alert)).join('');
}

// ========================================
// FILTER HISTORY ALERTS
// (date range, risk level)
// ========================================
function filterHistoryAlerts() {
  const dateFromFilter   = document.getElementById('dateFromFilter');
  const dateToFilter     = document.getElementById('dateToFilter');
  const riskLevelFilter  = document.getElementById('historySeverityFilter'); // reusing existing element id
  const parameterFilter  = document.getElementById('historyParameterFilter');

  const dateFrom  = dateFromFilter  ? dateFromFilter.value  : '';
  const dateTo    = dateToFilter    ? dateToFilter.value    : '';
  const riskLevel = riskLevelFilter ? riskLevelFilter.value : 'all';
  const parameter = parameterFilter ? parameterFilter.value : 'all';

  return historyAlerts.filter(alert => {
    if (dateFrom) {
      const fromDate = new Date(dateFrom).setHours(0, 0, 0, 0);
      if (alert.timestamp < fromDate) return false;
    }
    if (dateTo) {
      const toDate = new Date(dateTo).setHours(23, 59, 59, 999);
      if (alert.timestamp > toDate) return false;
    }
    if (riskLevel !== 'all' && alert.riskLevel !== riskLevel) return false;
    if (parameter !== 'all' && alert.dominantParam !== parameter) return false;
    return true;
  });
}

function filterHistory() {
  displayHistoryAlerts();
}

// ========================================
// EXPORT HISTORY TO CSV
// ========================================
function exportHistory() {
  const filtered = filterHistoryAlerts();

  if (filtered.length === 0) {
    alert('No alerts to export');
    return;
  }

  const headers = ['Timestamp', 'FKRI Value', 'Risk Level', 'Dominant Parameter', 'Action'];
  const rows = filtered.map(alert => {
    let action = 'Unknown';
    if (alert.acknowledged) action = 'Acknowledged';
    else if (alert.dismissed) action = 'Dismissed';
    return [
      new Date(alert.timestamp).toLocaleString(),
      typeof alert.fkri === 'number' ? alert.fkri.toFixed(4) : '--',
      alert.riskLevel || '--',
      getParamLabel(alert.dominantParam || '--'),
      action,
    ];
  });

  let csvContent = headers.join(',') + '\n';
  rows.forEach(row => {
    csvContent += row.map(cell => `"${cell}"`).join(',') + '\n';
  });

  const blob = new Blob([csvContent], { type: 'text/csv' });
  const url  = window.URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `fkri_alerts_history_${new Date().toISOString().split('T')[0]}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(url);
}

// ========================================
// ACTIVE ALERTS COUNT BADGE
// ========================================
function updateActiveAlertsCount(count) {
  const badge = document.getElementById('activeAlertsCount');
  if (badge) {
    badge.textContent    = count;
    badge.style.display  = count > 0 ? 'inline-block' : 'none';
  }
}

// ========================================
// DATE FILTERS — default to last 7 days
// ========================================
function setupDateFilters() {
  const today      = new Date();
  const oneWeekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

  const dateToFilter   = document.getElementById('dateToFilter');
  const dateFromFilter = document.getElementById('dateFromFilter');

  if (dateToFilter)   dateToFilter.value   = today.toISOString().split('T')[0];
  if (dateFromFilter) dateFromFilter.value = oneWeekAgo.toISOString().split('T')[0];
}

// ========================================
// RISK LEVEL HELPERS
// ========================================
function getRiskLevelClass(riskLevel) {
  const map = {
    'Extreme':   'critical',
    'Very High': 'critical',
    'High':      'warning',
    'Moderate':  'warning',
    'Low':       'safe',
  };
  return map[riskLevel] || 'warning';
}

function getRiskLevelIcon(riskLevel) {
  const map = {
    'Extreme':   'fas fa-skull-crossbones',
    'Very High': 'fas fa-exclamation-triangle',
    'High':      'fas fa-exclamation-circle',
    'Moderate':  'fas fa-exclamation',
    'Low':       'fas fa-check-circle',
  };
  return map[riskLevel] || 'fas fa-exclamation-triangle';
}

// ========================================
// PARAMETER HELPERS
// ========================================
function getParamLabel(key) {
  const map = {
    DO:       'Dissolved Oxygen',
    Temp:     'Temperature',
    pH:       'pH',
    Turb:     'Turbidity',
    Salinity: 'Salinity',
  };
  return map[key] || key || 'Unknown';
}

function getParamIcon(key) {
  const map = {
    DO:       'fas fa-wind',
    Temp:     'fas fa-thermometer-half',
    pH:       'fas fa-flask',
    Turb:     'fas fa-eye',
    Salinity: 'fas fa-tint',
  };
  return map[key] || 'fas fa-exclamation-triangle';
}

// ========================================
// TIMESTAMP FORMATTER
// ========================================
function formatTimestamp(timestamp) {
  if (!timestamp) return 'Unknown';

  const date = new Date(timestamp);
  const now  = new Date();
  const diff = now - date;

  if (diff < 60000)    return 'Just now';
  if (diff < 3600000)  { const m = Math.floor(diff / 60000);   return `${m} minute${m > 1 ? 's' : ''} ago`; }
  if (diff < 86400000) { const h = Math.floor(diff / 3600000); return `${h} hour${h > 1 ? 's' : ''} ago`;   }
  if (diff < 604800000){ const d = Math.floor(diff / 86400000);return `${d} day${d > 1 ? 's' : ''} ago`;    }

  return date.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

console.log('[alerts.js] FKRI-based alerts loaded successfully.');