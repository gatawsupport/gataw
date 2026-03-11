// ===================================
// SYSTEM CONFIGURATION JAVASCRIPT
// ===================================

// Firebase references
let database;
let systemRef;
let thresholdsRef;
let sensorsRef;
let smsNumbersRef;
let wifiLoadRef;

// Current configuration state
let currentConfig = {
  wifi: {
    connected: false
  },
  aerator: {
    mode: 'manual',
    doThreshold: 5.0,
    doStopThreshold: 6.5,
    aerator: false,
    schedules: []
  },
  sampling: {
    mode: 'manual',
    interval: 300000,
    criticalInterval: 0
  }
};

// In-memory list of SMS recipients (rendered in the UI)
// Each entry: { id: String, name: String, number: String }
let smsRecipients = [];
let smsIdCounter = 0;

let scheduleCounter = 0;

// -----------------------------------------------------------------------
// WiFi connection monitoring
// -----------------------------------------------------------------------
let wifiStatusListener = null;


// Default thresholds
const defaultThresholds = {
  do: {
    safeMin:  5.0,
    safeMax:  9.0,
    alertMin: 4.0,
    alertMax: 10.0
  },
  temperature: {
    safeMin:  26.0,
    safeMax:  32.0,
    alertMin: 24.0,
    alertMax: 34.0
  },
  ph: {
    safeMin:  7.5,
    safeMax:  8.5,
    alertMin: 7.0,
    alertMax: 9.0
  },
  salinity: {
    safeMin:  15.0,
    safeMax:  25.0,
    alertMin: 12.0,
    alertMax: 28.0
  },
  turbidity: {
    safeMin:  20.0,
    safeMax:  50.0,
    alertMin: 10.0,
    alertMax: 70.0
  }
};

// ===================================
// INIT
// ===================================

document.addEventListener('DOMContentLoaded', function () {
  console.log('System Configuration page loaded');

  // Initialize Firebase references
  database      = firebase.database();
  systemRef     = database.ref('config');
  thresholdsRef = database.ref('thresholds');
  sensorsRef    = database.ref('sensors');
  smsNumbersRef = database.ref('config/sms-numbers');
  wifiLoadRef   = database.ref('config/wifi/loadLog');

  // Setup tab navigation
  setupTabs();

  // Load current configuration
  loadConfiguration();

  // Setup form handlers (no wifi form anymore, kept for future extensibility)
  setupFormHandlers();

  // Listen for real-time updates
  listenForUpdates();

  // Update interval preview
  updateIntervalPreview();

  // Start watching ESP32 WiFi connection status immediately
  watchWifiConnectionStatus();
});

// ===================================
// TAB NAVIGATION
// ===================================

function setupTabs() {
  const tabs   = document.querySelectorAll('.config-tab');
  const panels = document.querySelectorAll('.tab-panel');

  tabs.forEach(tab => {
    tab.addEventListener('click', function () {
      const tabName = this.getAttribute('data-tab');
      tabs.forEach(t => t.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));
      this.classList.add('active');
      document.getElementById(tabName + '-panel').classList.add('active');
    });
  });
}

// ===================================
// LOAD CONFIGURATION
// ===================================

function loadConfiguration() {
  console.log('Loading configuration from Firebase...');
  loadThresholds();
  loadAeratorConfig();
  loadSamplingConfig();
  loadSmsNumbers();
  loadWifiLoadLog();
}

function loadThresholds() {
  thresholdsRef.once('value', (snapshot) => {
    const thresholds = snapshot.val() || defaultThresholds;
    console.log('Loading thresholds from Firebase:', thresholds);

    Object.keys(defaultThresholds).forEach(sensor => {
      const st = thresholds[sensor] || defaultThresholds[sensor];
      console.log(`Loading ${sensor} thresholds:`, st);

      document.getElementById(`${sensor}_safeMin`).value  = st.safeMin;
      document.getElementById(`${sensor}_safeMax`).value  = st.safeMax;
      document.getElementById(`${sensor}_alertMin`).value = st.alertMin;
      document.getElementById(`${sensor}_alertMax`).value = st.alertMax;
    });
  }).catch(err => {
    console.error('Error loading thresholds:', err);
    showNotification('Error loading thresholds: ' + err.message, 'error');
  });
}

function loadAeratorConfig() {
  systemRef.child('aerator').once('value', (snapshot) => {
    const aeratorData = snapshot.val();
    if (aeratorData) {
      currentConfig.aerator = aeratorData;
      const autoToggle = document.getElementById('aeratorAutoToggle');
      const isAuto = aeratorData.mode === 'automatic' || aeratorData.autoMode === true;
      autoToggle.checked = isAuto;
      toggleAeratorMode(false);
      document.getElementById('aeratorDOThreshold').value     = aeratorData.doThreshold     || 5.0;
      document.getElementById('aeratorDOStopThreshold').value = aeratorData.doStopThreshold || 6.5;

      if (aeratorData.schedules && aeratorData.schedules.length > 0) {
        aeratorData.schedules.forEach(s => addSchedule(s.startTime, s.stopTime));
      }
    }
  });
}

// ===================================
// LOAD SAMPLING CONFIG
// ===================================

function loadSamplingConfig() {
  systemRef.child('sampling').once('value', (snapshot) => {
    const samplingData = snapshot.val();

    if (samplingData) {
      const mode = samplingData.mode || 'manual';
      currentConfig.sampling.mode = mode;

      const modeToggle = document.getElementById('samplingModeToggle');
      if (modeToggle) {
        modeToggle.checked = (mode === 'auto');
      }
      applySamplingModeUI(mode);

      if (samplingData.interval) {
        const intervalSeconds = Math.floor(samplingData.interval / 1000);
        currentConfig.sampling.interval = samplingData.interval;

        const selectElement  = document.getElementById('samplingInterval');
        const matchingOption = Array.from(selectElement.options).find(
          option => parseInt(option.value) === intervalSeconds
        );

        if (matchingOption) {
          selectElement.value = intervalSeconds;
          document.getElementById('customIntervalSection').style.display = 'none';
        } else {
          selectElement.value = 'custom';
          document.getElementById('customIntervalSection').style.display = 'block';

          const hours   = Math.floor(intervalSeconds / 3600);
          const minutes = Math.floor((intervalSeconds % 3600) / 60);
          const seconds = intervalSeconds % 60;

          document.getElementById('customHours').value   = hours;
          document.getElementById('customMinutes').value = minutes;
          document.getElementById('customSeconds').value = seconds;
        }
      }

      updateIntervalPreview();
    }
  });
}

// ===================================
// SMS NUMBERS — LOAD / RENDER / SAVE
// ===================================

function loadSmsNumbers() {
  smsNumbersRef.once('value', (snapshot) => {
    smsRecipients = [];
    smsIdCounter  = 0;

    const data = snapshot.val();
    if (data) {
      Object.keys(data).forEach(fullNumber => {
        smsIdCounter++;
        smsRecipients.push({
          id:     'sms-' + smsIdCounter,
          name:   '',
          number: fullNumber
        });
      });
    }

    renderSmsNumbers();
  }).catch(err => {
    console.error('Error loading SMS numbers:', err);
    showNotification('Error loading SMS recipients: ' + err.message, 'error');
  });
}

function renderSmsNumbers() {
  const list  = document.getElementById('smsNumbersList');
  const empty = document.getElementById('smsNumbersEmpty');

  list.querySelectorAll('.sms-recipient-item').forEach(el => el.remove());

  if (smsRecipients.length === 0) {
    empty.style.display = 'flex';
    return;
  }

  empty.style.display = 'none';

  smsRecipients.forEach(recipient => {
    const item = document.createElement('div');
    item.className = 'sms-recipient-item';
    item.id = recipient.id;

    const displayNumber = recipient.number.startsWith('+63') ? recipient.number : '+63' + recipient.number;

    item.innerHTML = `
      <div class="sms-recipient-info">
        <div class="sms-recipient-icon">
          <i class="fas fa-mobile-alt"></i>
        </div>
        <div class="sms-recipient-details">
          <span class="sms-recipient-name">${recipient.name ? escapeHtml(recipient.name) : '<em class="no-name">No name</em>'}</span>
          <span class="sms-recipient-number">${escapeHtml(displayNumber)}</span>
        </div>
      </div>
      <button
        type="button"
        class="sms-remove-btn"
        onclick="removeSmsNumber('${recipient.id}')"
        title="Remove recipient"
        aria-label="Remove ${escapeHtml(recipient.number)}"
      >
        <i class="fas fa-trash-alt"></i>
      </button>
    `;

    list.appendChild(item);
  });
}

function addSmsNumber() {
  const nameInput   = document.getElementById('smsRecipientName');
  const numberInput = document.getElementById('smsRecipientNumber');

  const name = nameInput.value.trim();
  const raw  = numberInput.value.trim().replace(/\s+/g, '');

  const phMobileRegex = /^9\d{9}$/;
  if (!raw) {
    showNotification('Please enter a mobile number.', 'error');
    numberInput.focus();
    return;
  }
  if (!phMobileRegex.test(raw)) {
    showNotification('Invalid number. Enter 10 digits starting with 9 (e.g. 9171234567).', 'error');
    numberInput.focus();
    return;
  }

  const fullNumber = '+63' + raw;

  const duplicate = smsRecipients.find(r => r.number === fullNumber);
  if (duplicate) {
    showNotification('This number is already in the list.', 'error');
    numberInput.focus();
    return;
  }

  smsIdCounter++;
  smsRecipients.push({
    id:     'sms-' + smsIdCounter,
    name:   name,
    number: fullNumber
  });

  nameInput.value   = '';
  numberInput.value = '';

  renderSmsNumbers();
  showNotification('Number added. Click "Save SMS Recipients" to apply.', 'info');
}

function removeSmsNumber(id) {
  smsRecipients = smsRecipients.filter(r => r.id !== id);
  renderSmsNumbers();
  showNotification('Number removed. Click "Save SMS Recipients" to apply.', 'info');
}

function saveSmsNumbers() {
  if (smsRecipients.length === 0) {
    showConfirmModal(
      'Clear All SMS Recipients?',
      'There are no numbers in the list. This will clear all existing SMS recipients from Firebase. Continue?',
      () => writeSmsToFirebase(null)
    );
    return;
  }

  showConfirmModal(
    'Save SMS Recipients?',
    `Save ${smsRecipients.length} SMS recipient${smsRecipients.length > 1 ? 's' : ''} to Firebase?`,
    () => {
      const payload = {};
      smsRecipients.forEach(r => { payload[r.number] = true; });
      writeSmsToFirebase(payload);
    }
  );
}

function writeSmsToFirebase(payload) {
  smsNumbersRef.remove()
    .then(() => {
      if (!payload || Object.keys(payload).length === 0) {
        showNotification('SMS recipients cleared.', 'success');
        return;
      }
      return smsNumbersRef.set(payload);
    })
    .then(() => {
      if (payload && Object.keys(payload).length > 0) {
        showNotification('SMS recipients saved successfully!', 'success');
        console.log('✓ SMS numbers saved to Firebase /config/sms-numbers:', payload);
      }
    })
    .catch(err => {
      showNotification('Error saving SMS recipients: ' + err.message, 'error');
      console.error('✗ Error saving SMS numbers:', err);
    });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ===================================
// FORM HANDLERS
// ===================================

function setupFormHandlers() {
  // No WiFi form to bind anymore
}

// ===================================
// POCKET WIFI RESTART
// ===================================

/**
 * Shows a confirmation modal before triggering the Pocket WiFi restart.
 */
function confirmRestartPocketWifi() {
  showConfirmModal(
    'Restart Pocket WiFi?',
    'This will restart the Pocket WiFi. The ESP32 may briefly lose its connection. Continue?',
    () => restartPocketWifi()
  );
}

/**
 * Triggers a Pocket WiFi restart by writing true to /config/wifi/optoRestart,
 * then setting it back to false after a short delay so the MCU can detect the edge.
 */
function restartPocketWifi() {
  const btn = document.getElementById('optoRestartBtn');
  const statusText = document.getElementById('optoStatusText');

  // Disable button while restarting
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Restarting…';
  }
  if (statusText) statusText.textContent = 'Restarting Pocket WiFi…';

  database.ref('config/wifi/optoRestart').set(true)
    .then(() => {
      console.log('✓ config/wifi/optoRestart → true');
      showNotification('Pocket WiFi restart triggered.', 'success');

      // Reset the flag after 3 s so the MCU can pick it up as a one-shot trigger
      return new Promise(resolve => setTimeout(resolve, 10000));
    })
    .then(() => database.ref('config/wifi/optoRestart').set(false))
    .then(() => {
      console.log('✓ config/wifi/optoRestart → false (reset)');
      if (statusText) statusText.textContent = 'Press the button to restart the Pocket WiFi';
    })
    .catch(err => {
      showNotification('Error triggering restart: ' + err.message, 'error');
      console.error('✗ optoRestart error:', err);
      if (statusText) statusText.textContent = 'Press the button to restart the Pocket WiFi';
    })
    .finally(() => {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-sync-alt"></i> Restart';
      }
    });
}

// ===================================
// ESP32 WIFI CONNECTION STATUS
// ===================================

function watchWifiConnectionStatus() {
  if (wifiStatusListener) {
    systemRef.child('wifi').off('value', wifiStatusListener);
  }

  wifiStatusListener = systemRef.child('wifi').on('value', (snapshot) => {
    const wifiData = snapshot.val();
    if (!wifiData) {
      setWifiStatusChecking('No WiFi data available');
      return;
    }

    const isConnected   = wifiData.connected === true;
    const connectedSSID = wifiData.ssid || '';

    if (isConnected) {
      setWifiStatusConnected(connectedSSID);
    } else {
      setWifiStatusDisconnected(
        connectedSSID
          ? `Failed to connect to "${connectedSSID}"`
          : 'ESP32 is not connected to WiFi'
      );
    }
  });
}

// ── Inline status helpers ─────────────────────────────────────────────────────

function setWifiStatusChecking(message) {
  const icon  = document.getElementById('wifiStatusIcon');
  const label = document.getElementById('wifiStatusLabel');
  if (icon)  { icon.className = 'fas fa-circle-notch fa-spin'; icon.style.color = '#94a3b8'; }
  if (label) { label.textContent = message || 'Checking connection…'; label.style.color = '#94a3b8'; }
}

function setWifiStatusConnected(ssid) {
  const icon  = document.getElementById('wifiStatusIcon');
  const label = document.getElementById('wifiStatusLabel');
  if (icon)  { icon.className = 'fas fa-check-circle'; icon.style.color = '#10b981'; }
  if (label) { label.textContent = 'ESP32 is connected'; label.style.color = '#10b981'; }
}

function setWifiStatusDisconnected(reason) {
  const icon  = document.getElementById('wifiStatusIcon');
  const label = document.getElementById('wifiStatusLabel');
  if (icon)  { icon.className = 'fas fa-times-circle'; icon.style.color = '#ef4444'; }
  if (label) { label.textContent = 'ESP32 is not connected'; label.style.color = '#ef4444'; }
}

// ===================================
// MODAL & NOTIFICATION FUNCTIONS
// ===================================

function showConfirmModal(title, message, onConfirm) {
  const modal      = document.getElementById('confirmModal');
  const modalTitle = document.getElementById('confirmModalTitle');
  const modalMsg   = document.getElementById('confirmModalMessage');
  const cancelBtn  = document.getElementById('confirmModalCancelBtn');
  const confirmBtn = document.getElementById('confirmModalConfirmBtn');

  if (!modal) return;

  modalTitle.textContent = title;
  modalMsg.innerHTML     = message;

  modal.classList.add('show');
  modal.style.display = 'flex';

  const newCancelBtn  = cancelBtn.cloneNode(true);
  const newConfirmBtn = confirmBtn.cloneNode(true);
  cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
  confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);

  newCancelBtn.addEventListener('click', () => {
    modal.classList.remove('show');
    setTimeout(() => modal.style.display = 'none', 150);
  });

  const clickOutsideHandler = (e) => {
    if (e.target === modal) {
      modal.classList.remove('show');
      setTimeout(() => modal.style.display = 'none', 150);
      modal.removeEventListener('click', clickOutsideHandler);
    }
  };
  modal.addEventListener('click', clickOutsideHandler);

  newConfirmBtn.addEventListener('click', async () => {
    modal.classList.remove('show');
    setTimeout(() => modal.style.display = 'none', 150);
    modal.removeEventListener('click', clickOutsideHandler);
    await onConfirm();
  });
}

function showNotification(message, type = 'success') {
  const notification = document.getElementById('statusNotification');
  const icon         = document.getElementById('statusNotificationIcon');
  const text         = document.getElementById('statusNotificationText');

  if (!notification || !icon || !text) return;

  const iconClass = type === 'success' ? 'fa-check-circle'
                  : type === 'error'   ? 'fa-exclamation-circle'
                  : 'fa-info-circle';

  icon.className         = `fas ${iconClass}`;
  notification.className = `status-notification ${type}`;
  text.textContent       = message;

  notification.style.display = 'flex';
  setTimeout(() => notification.classList.add('show'), 10);

  setTimeout(() => {
    notification.classList.remove('show');
    setTimeout(() => notification.style.display = 'none', 300);
  }, 5000);
}

// ===================================
// SAVE / RESET FUNCTIONS
// ===================================

function saveThresholds() {
  console.log('saveThresholds() called');

  const thresholds = {};

  for (const sensor of Object.keys(defaultThresholds)) {
    const safeMinEl  = document.getElementById(`${sensor}_safeMin`);
    const safeMaxEl  = document.getElementById(`${sensor}_safeMax`);
    const alertMinEl = document.getElementById(`${sensor}_alertMin`);
    const alertMaxEl = document.getElementById(`${sensor}_alertMax`);

    if (!safeMinEl || !safeMaxEl || !alertMinEl || !alertMaxEl) {
      showNotification(`Error: Could not find input fields for ${sensor}`, 'error');
      return;
    }

    const safeMin  = parseFloat(safeMinEl.value);
    const safeMax  = parseFloat(safeMaxEl.value);
    const alertMin = parseFloat(alertMinEl.value);
    const alertMax = parseFloat(alertMaxEl.value);

    if (isNaN(safeMin) || isNaN(safeMax) || isNaN(alertMin) || isNaN(alertMax)) {
      showNotification(`Invalid ${sensor} thresholds: All values must be numbers`, 'error');
      return;
    }

    if (safeMin >= safeMax) {
      showNotification(`Invalid ${sensor} thresholds: Safe Min must be less than Safe Max`, 'error');
      return;
    }
    if (alertMin >= alertMax) {
      showNotification(`Invalid ${sensor} thresholds: Alert Min must be less than Alert Max`, 'error');
      return;
    }

    thresholds[sensor] = { safeMin, safeMax, alertMin, alertMax };
  }

  showConfirmModal(
    'Save Sensor Thresholds?',
    'Are you sure you want to save all sensor threshold changes?',
    () => {
      thresholdsRef.update(thresholds)
        .then(() => {
          showNotification('All sensor thresholds saved successfully!', 'success');
          console.log('✓ Thresholds saved to Firebase:', thresholds);
        })
        .catch(err => {
          showNotification('Error saving thresholds: ' + err.message, 'error');
          console.error('✗ Error saving thresholds:', err);
        });
    }
  );
}

function resetThresholds() {
  showConfirmModal(
    'Reset to Default Values?',
    'Are you sure you want to reset all thresholds to default values?',
    () => {
      Object.keys(defaultThresholds).forEach(sensor => {
        const d = defaultThresholds[sensor];
        document.getElementById(`${sensor}_safeMin`).value  = d.safeMin;
        document.getElementById(`${sensor}_safeMax`).value  = d.safeMax;
        document.getElementById(`${sensor}_alertMin`).value = d.alertMin;
        document.getElementById(`${sensor}_alertMax`).value = d.alertMax;
      });

      showNotification('Thresholds reset to default values. Click "Save" to apply.', 'info');
    }
  );
}

function toggleAeratorMode(saveToFirebase) {
  const autoToggle    = document.getElementById('aeratorAutoToggle');
  const autoSettings  = document.getElementById('aeratorAutoSettings');
  const manualControl = document.getElementById('aeratorManualControl');
  const modeLabel     = document.getElementById('aeratorModeLabel');
  const modeDesc      = document.getElementById('aeratorModeDescription');

  const isAutoMode = autoToggle.checked;
  const modeString = isAutoMode ? 'automatic' : 'manual';

  if (isAutoMode) {
    autoSettings.style.display  = 'block';
    manualControl.style.display = 'none';
    modeLabel.textContent = 'Automatic Mode';
    modeDesc.textContent  = 'Aerator is controlled automatically based on DO levels and schedule';
  } else {
    autoSettings.style.display  = 'none';
    manualControl.style.display = 'block';
    modeLabel.textContent = 'Manual Mode';
    modeDesc.textContent  = 'Aerator is controlled manually';
  }

  const manualToggle = document.getElementById('aeratorManualToggle');
  if (manualToggle && manualToggle.checked) {
    manualToggle.checked = false;
    systemRef.child('aerator/aerator').set(false)
      .catch(err => console.error('Error turning off aerator on mode change:', err));
  }

  if (saveToFirebase === true) {
    systemRef.child('aerator/mode').set(modeString)
      .then(() => {
        currentConfig.aerator.mode = modeString;
        showNotification(
          `Aerator mode changed to ${isAutoMode ? 'Automatic' : 'Manual'}`,
          'success'
        );
      })
      .catch(err => {
        showNotification('Error saving aerator mode: ' + err.message, 'error');
        autoToggle.checked = !isAutoMode;
      });
  }
}

function setAeratorManual() {
  const toggle = document.getElementById('aeratorManualToggle');
  const isOn   = toggle.checked;

  systemRef.child('aerator/aerator').set(isOn)
    .then(() => {
      showNotification(`Aerator turned ${isOn ? 'ON' : 'OFF'}`, 'success');
      console.log(`✓ config/aerator/aerator set to ${isOn}`);
    })
    .catch(err => {
      showNotification('Error updating aerator: ' + err.message, 'error');
      toggle.checked = !isOn;
    });
}

function saveAeratorConfig() {
  const isAuto          = document.getElementById('aeratorAutoToggle').checked;
  const doThreshold     = parseFloat(document.getElementById('aeratorDOThreshold').value);
  const doStopThreshold = parseFloat(document.getElementById('aeratorDOStopThreshold').value);

  if (isAuto && (isNaN(doThreshold) || isNaN(doStopThreshold))) {
    showNotification('Please enter valid DO threshold values', 'error');
    return;
  }
  if (isAuto && doThreshold >= doStopThreshold) {
    showNotification('Stop threshold must be higher than start threshold', 'error');
    return;
  }

  const schedules = [];
  document.querySelectorAll('.schedule-item').forEach(item => {
    const startTime = item.querySelector('.schedule-start').value;
    const stopTime  = item.querySelector('.schedule-stop').value;
    if (startTime && stopTime) schedules.push({ startTime, stopTime });
  });

  showConfirmModal(
    'Save Aerator Configuration?',
    'Are you sure you want to save the aerator configuration changes?',
    () => {
      const aeratorConfig = {
        mode:             isAuto ? 'automatic' : 'manual',
        doThreshold,
        doStopThreshold,
        aerator:          false,
        schedules,
        updatedAt:        firebase.database.ServerValue.TIMESTAMP
      };

      systemRef.child('aerator').set(aeratorConfig)
        .then(() => {
          currentConfig.aerator = aeratorConfig;
          showNotification('Aerator configuration saved successfully!', 'success');
        })
        .catch(err => showNotification('Error saving aerator configuration: ' + err.message, 'error'));
    }
  );
}

function addSchedule(startTime = '06:00', stopTime = '18:00') {
  scheduleCounter++;
  const container   = document.getElementById('scheduleContainer');
  const scheduleDiv = document.createElement('div');
  scheduleDiv.className = 'schedule-item';
  scheduleDiv.id = `schedule-${scheduleCounter}`;

  scheduleDiv.innerHTML = `
    <div class="schedule-item-header">Schedule #${scheduleCounter}</div>
    <div style="display:flex;gap:12px;align-items:flex-end;width:100%;">
      <div class="form-group" style="flex:1;margin:0;">
        <label>Start Time</label>
        <input type="time" class="schedule-start" value="${startTime}">
      </div>
      <div class="form-group" style="flex:1;margin:0;">
        <label>Stop Time</label>
        <input type="time" class="schedule-stop" value="${stopTime}">
      </div>
      <button type="button" class="btn-remove" onclick="removeSchedule(${scheduleCounter})">
        <i class="fas fa-trash"></i>
      </button>
    </div>
  `;

  container.appendChild(scheduleDiv);
}

function removeSchedule(id) {
  const el = document.getElementById(`schedule-${id}`);
  if (el) el.remove();
}

// ===================================
// SAMPLING MODE TOGGLE
// ===================================

function toggleSamplingMode() {
  const toggle = document.getElementById('samplingModeToggle');
  const mode   = toggle.checked ? 'auto' : 'manual';
  applySamplingModeUI(mode);
  updateIntervalPreview();
}

function applySamplingModeUI(mode) {
  const modeLabel       = document.getElementById('samplingModeLabel');
  const modeDesc        = document.getElementById('samplingModeDescription');
  const manualSection   = document.getElementById('samplingManualSection');
  const autoInfoSection = document.getElementById('samplingAutoInfoSection');

  if (mode === 'auto') {
    modeLabel.textContent = 'Automatic Mode';
    modeDesc.textContent  = 'Sampling rate adjusts automatically based on sensor thresholds';
    manualSection.style.display   = 'block';
    autoInfoSection.style.display = 'block';
  } else {
    modeLabel.textContent = 'Manual Mode';
    modeDesc.textContent  = 'Sampling occurs at a fixed interval set below';
    manualSection.style.display   = 'block';
    autoInfoSection.style.display = 'none';
  }
}

// ===================================
// SAMPLING INTERVAL — SAVE
// ===================================

function saveSamplingInterval() {
  let intervalSeconds;

  const selectedValue = document.getElementById('samplingInterval').value;

  if (selectedValue === 'custom') {
    const hours   = parseInt(document.getElementById('customHours').value)   || 0;
    const minutes = parseInt(document.getElementById('customMinutes').value) || 0;
    const seconds = parseInt(document.getElementById('customSeconds').value) || 0;

    intervalSeconds = (hours * 3600) + (minutes * 60) + seconds;

    if (intervalSeconds < 60) {
      showNotification('Sampling interval must be at least 1 minute (60 seconds)', 'error');
      return;
    }
    if (intervalSeconds > 86400) {
      showNotification('Sampling interval cannot exceed 24 hours', 'error');
      return;
    }
  } else {
    intervalSeconds = parseInt(selectedValue);
  }

  const modeToggle = document.getElementById('samplingModeToggle');
  const mode       = modeToggle.checked ? 'auto' : 'manual';

  showConfirmModal(
    'Save Sampling Configuration?',
    `Save sampling in <strong>${mode === 'auto' ? 'Automatic' : 'Manual'}</strong> mode with a${mode === 'auto' ? ' normal (safe)' : ''} interval of <strong>${formatSecondsToHuman(intervalSeconds)}</strong>?`,
    () => {
      const intervalMs = intervalSeconds * 1000;

      const samplingConfig = {
        mode:             mode,
        interval:         intervalMs,
        criticalInterval: 0,
        updatedAt:        firebase.database.ServerValue.TIMESTAMP
      };

      systemRef.child('sampling').set(samplingConfig)
        .then(() => {
          currentConfig.sampling.mode     = mode;
          currentConfig.sampling.interval = intervalMs;
          showNotification('Sampling configuration saved successfully!', 'success');
          updateIntervalPreview();
        })
        .catch(err => showNotification('Error saving sampling configuration: ' + err.message, 'error'));
    }
  );
}

// ===================================
// SAMPLING INTERVAL — UI HELPERS
// ===================================

function updateIntervalPreview() {
  const selectedValue = document.getElementById('samplingInterval').value;
  const preview       = document.getElementById('samplingIntervalPreview');
  const modeToggle    = document.getElementById('samplingModeToggle');
  const isAuto        = modeToggle && modeToggle.checked;

  let intervalSeconds;

  if (selectedValue === 'custom') {
    const hours   = parseInt(document.getElementById('customHours').value)   || 0;
    const minutes = parseInt(document.getElementById('customMinutes').value) || 0;
    const seconds = parseInt(document.getElementById('customSeconds').value) || 0;
    intervalSeconds = (hours * 3600) + (minutes * 60) + seconds;
  } else {
    intervalSeconds = parseInt(selectedValue);
  }

  const timeText = formatSecondsToHuman(intervalSeconds);

  if (isAuto) {
    preview.textContent = `Normal (safe) interval: every ${timeText}. Continuous sampling when warning or critical thresholds are breached.`;
  } else {
    preview.textContent = `Data will be recorded every ${timeText}`;
  }
}

function toggleCustomInterval() {
  const selectedValue = document.getElementById('samplingInterval').value;
  const customSection = document.getElementById('customIntervalSection');
  customSection.style.display = selectedValue === 'custom' ? 'block' : 'none';
  updateIntervalPreview();
}

function formatSecondsToHuman(totalSeconds) {
  const hours   = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  let parts = [];
  if (hours   > 0) parts.push(hours   + ' hour'   + (hours   > 1 ? 's' : ''));
  if (minutes > 0) parts.push(minutes + ' minute' + (minutes > 1 ? 's' : ''));
  if (seconds > 0 || parts.length === 0) parts.push(seconds + ' second' + (seconds !== 1 ? 's' : ''));

  return parts.join(', ');
}

// ===================================
// REAL-TIME UPDATES
// ===================================

function listenForUpdates() {
  systemRef.on('value', () => {
    console.log('System configuration updated');
  });

  // Real-time listener for /config/aerator/aerator (on/off state)
  systemRef.child('aerator/aerator').on('value', (snapshot) => {
    const isOn   = snapshot.val() === true;
    const toggle = document.getElementById('aeratorManualToggle');
    const icon   = document.getElementById('aeratorManualIcon');
    const text   = document.getElementById('aeratorManualStatusText');
    if (!toggle) return;
    toggle.checked = isOn;
    if (isOn) {
      icon.style.color = '#10b981';
      text.textContent = 'Aerator is ON';
    } else {
      icon.style.color = '';
      text.textContent = 'Aerator is OFF';
    }
  });

  // Real-time listener for /config/wifi/optoRestart — reflects restart state in status text
  database.ref('config/wifi/optoRestart').on('value', (snapshot) => {
    const isRestarting = snapshot.val() === true;
    const icon         = document.getElementById('optoIcon');
    const text         = document.getElementById('optoStatusText');
    const btn          = document.getElementById('optoRestartBtn');

    if (isRestarting) {
      if (icon) icon.style.color = '#f59e0b';
      if (text) text.textContent = 'Restarting Pocket WiFi…';
      if (btn)  { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Restarting…'; }
    } else {
      if (icon) icon.style.color = '';
      if (text) text.textContent = 'Press the button to restart the Pocket WiFi';
      if (btn)  { btn.disabled = false; btn.innerHTML = '<i class="fas fa-sync-alt"></i> Restart'; }
    }
  });
}

// ===================================
// UTILITY FUNCTIONS
// ===================================

function formatTimestamp(timestamp) {
  if (!timestamp) return '--';
  const date      = new Date(timestamp);
  const diffMs    = Date.now() - date;
  const diffMins  = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays  = Math.floor(diffMs / 86400000);

  if (diffMins  < 1)  return 'Just now';
  if (diffMins  < 60) return `${diffMins} min${diffMins  > 1 ? 's' : ''} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  if (diffDays  < 7)  return `${diffDays} day${diffDays  > 1 ? 's' : ''} ago`;
  return date.toLocaleString();
}

console.log('System Configuration script loaded successfully');

// ===================================
// POCKET WIFI LOAD LOG
// ===================================

function loadWifiLoadLog() {
  // Set today's date as default on the load date input
  const loadDateInput = document.getElementById('loadDate');
  if (loadDateInput) {
    const today = new Date();
    loadDateInput.value = today.toISOString().split('T')[0];
  }

  wifiLoadRef.once('value', (snapshot) => {
    const data = snapshot.val();
    // Single record — wrap in array for updateLoadSummaryBanner
    const entries = data ? [data] : [];
    updateLoadSummaryBanner(entries);
  }).catch(err => {
    console.error('Error loading WiFi load log:', err);
    showNotification('Error loading load history: ' + err.message, 'error');
  });
}

function logWifiLoad() {
  const dateVal     = document.getElementById('loadDate').value.trim();
  const amount      = document.getElementById('loadAmount').value.trim();
  const validityEl  = document.getElementById('loadValidity');
  const validityRaw = validityEl.value.trim();
  const validity    = parseInt(validityRaw);

  if (!dateVal) {
    showNotification('Please enter the date of load.', 'error');
    document.getElementById('loadDate').focus();
    return;
  }
  if (!amount) {
    showNotification('Please enter the amount or plan name.', 'error');
    document.getElementById('loadAmount').focus();
    return;
  }
  if (!validityRaw) {
    showNotification('Validity (days) is required.', 'error');
    validityEl.focus();
    return;
  }
  if (isNaN(validity) || validity < 1) {
    showNotification('Validity must be a valid number (minimum 1 day).', 'error');
    validityEl.focus();
    return;
  }

  // Compute expiry date from load date + validity
  const loadDate = new Date(dateVal + 'T00:00:00');
  loadDate.setDate(loadDate.getDate() + validity);
  const expiryTimestamp = loadDate.getTime();
  const loadDateMs = new Date(dateVal + 'T00:00:00').getTime();

  showConfirmModal(
    'Save Load Entry?',
    `Log a load of <strong>${escapeHtml(amount)}</strong> on <strong>${formatDateDisplay(dateVal)}</strong> with <strong>${validity} day${validity > 1 ? 's' : ''}</strong> validity?`,
    () => {
      const entry = {
        date:            dateVal,
        amount,
        validity,
        expiryTimestamp,
        timestamp:       loadDateMs,
        loggedAt:        firebase.database.ServerValue.TIMESTAMP
      };

      wifiLoadRef.set(entry)
        .then(() => {
          showNotification('Load entry saved successfully!', 'success');
          document.getElementById('loadAmount').value   = '';
          document.getElementById('loadValidity').value = '';
          loadWifiLoadLog();
        })
        .catch(err => {
          showNotification('Error saving load entry: ' + err.message, 'error');
          console.error('✗ Error saving load entry:', err);
        });
    }
  );
}

function deleteLoadEntry(key) {
  showConfirmModal(
    'Delete Load Entry?',
    'Are you sure you want to delete this load entry? This cannot be undone.',
    () => {
      wifiLoadRef.child(key).remove()
        .then(() => {
          showNotification('Load entry deleted.', 'success');
          loadWifiLoadLog();
        })
        .catch(err => {
          showNotification('Error deleting entry: ' + err.message, 'error');
        });
    }
  );
}

function renderLoadHistory(entries) {
  const emptyEl = document.getElementById('wifiLoadHistoryEmpty');
  const tableEl = document.getElementById('wifiLoadHistoryTable');
  const tbody   = document.getElementById('wifiLoadHistoryBody');

  if (!entries || entries.length === 0) {
    emptyEl.style.display = 'flex';
    tableEl.style.display = 'none';
    return;
  }

  emptyEl.style.display = 'none';
  tableEl.style.display = 'block';
  tbody.innerHTML = '';

  entries.forEach(entry => {
    const status     = getLoadStatus(entry);
    const validityTx = entry.validity ? `${entry.validity} day${entry.validity > 1 ? 's' : ''}` : '—';
    const notesTx    = entry.notes ? escapeHtml(entry.notes) : '<em class="no-name">—</em>';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${formatDateDisplay(entry.date)}</td>
      <td><strong>${escapeHtml(entry.amount)}</strong></td>
      <td>${validityTx}</td>
      <td>${notesTx}</td>
      <td><span class="load-status-badge load-status-${status.cls}">${status.label}</span></td>
      <td>
        <button
          type="button"
          class="sms-remove-btn"
          onclick="deleteLoadEntry('${entry.key}')"
          title="Delete this entry"
        ><i class="fas fa-trash-alt"></i></button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function updateLoadSummaryBanner(entries) {
  const summaryEl    = document.getElementById('wifiLoadSummary');
  const labelEl      = document.getElementById('loadSummaryLabel');
  const subEl        = document.getElementById('loadSummarySub');
  const badgeEl      = document.getElementById('loadSummaryBadge');
  const badgeTextEl  = document.getElementById('loadSummaryBadgeText');
  const iconEl       = document.getElementById('loadSummaryIcon');

  if (!entries || entries.length === 0) {
    summaryEl.className = 'wifi-load-summary no-data';
    labelEl.textContent = 'No load recorded yet';
    subEl.textContent   = '';
    badgeTextEl.textContent = '—';
    badgeEl.className   = 'load-summary-badge';
    return;
  }

  const latest = entries[0]; // already sorted newest first
  const status = getLoadStatus(latest);

  labelEl.textContent = `Last loaded: ${formatDateDisplay(latest.date)} — ${escapeHtml(latest.amount)}`;
  subEl.textContent   = latest.notes ? latest.notes : '';
  badgeTextEl.textContent = status.label;

  summaryEl.className = `wifi-load-summary ${status.cls}`;
  badgeEl.className   = `load-summary-badge load-status-${status.cls}`;
  iconEl.className    = status.icon;
}

function getLoadStatus(entry) {
  if (!entry.expiryTimestamp) {
    return { cls: 'unknown', label: 'No Expiry Set', icon: 'fas fa-question-circle' };
  }

  const now      = Date.now();
  const diffMs   = entry.expiryTimestamp - now;
  const diffDays = Math.ceil(diffMs / 86400000);

  if (diffMs < 0) {
    return { cls: 'expired', label: 'Expired', icon: 'fas fa-times-circle' };
  } else if (diffDays <= 3) {
    return { cls: 'expiring', label: `Expires in ${diffDays}d`, icon: 'fas fa-exclamation-circle' };
  } else {
    return { cls: 'active', label: `${diffDays}d left`, icon: 'fas fa-check-circle' };
  }
}

function formatDateDisplay(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
}

// ===================================
// DEBUG / TEST FUNCTIONS
// ===================================

function testFirebaseWrite() {
  console.log('Testing Firebase write access...');
  thresholdsRef.child('_test').set({ testWrite: true, timestamp: firebase.database.ServerValue.TIMESTAMP })
    .then(() => {
      console.log('✓ Firebase write test SUCCESSFUL');
      return thresholdsRef.child('_test').remove();
    })
    .then(() => console.log('✓ Test data cleaned up'))
    .catch(err => console.error('✗ Firebase write test FAILED:', err));
}

function debugThresholdInputs() {
  console.log('=== Current Threshold Input Values ===');
  Object.keys(defaultThresholds).forEach(sensor => {
    console.log(`${sensor}:`, {
      safeMin:  document.getElementById(`${sensor}_safeMin`)?.value,
      safeMax:  document.getElementById(`${sensor}_safeMax`)?.value,
      alertMin: document.getElementById(`${sensor}_alertMin`)?.value,
      alertMax: document.getElementById(`${sensor}_alertMax`)?.value
    });
  });
}

window.testFirebaseWrite    = testFirebaseWrite;
window.debugThresholdInputs = debugThresholdInputs;