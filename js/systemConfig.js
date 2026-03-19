// ===================================
// SYSTEM CONFIGURATION JAVASCRIPT
// ===================================

// Firebase references
let database;
let systemRef;

let smsNumbersRef;

// Current configuration state
let currentConfig = {
  wifi: {
    connected: false
  },
  aerator: {
    mode: 'manual',
    command: 'off',
    failsafe: false,
    schedules: []
  },

};

// In-memory list of SMS recipients (rendered in the UI)
// Each entry: { id: String, name: String, number: String }
let smsRecipients = [];
let smsIdCounter = 0;


// -----------------------------------------------------------------------
// WiFi connection monitoring
// -----------------------------------------------------------------------
let wifiStatusListener = null;


// ===================================
// INIT
// ===================================

document.addEventListener('DOMContentLoaded', function () {
  console.log('System Configuration page loaded');

  // Initialize Firebase references
  database      = firebase.database();
  systemRef     = database.ref('config');
  smsNumbersRef = database.ref('config/sms-numbers');
  // Setup tab navigation
  setupTabs();

  // Load current configuration
  loadConfiguration();

  // Setup form handlers (no wifi form anymore, kept for future extensibility)
  setupFormHandlers();

  // Listen for real-time updates
  listenForUpdates();

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
  loadAeratorConfig();
  loadSmsNumbers();
}

function loadAeratorConfig() {
  systemRef.child('aerator').once('value', (snapshot) => {
    const aeratorData = snapshot.val();
    if (!aeratorData) return;

    Object.assign(currentConfig.aerator, aeratorData);

    const autoToggle = document.getElementById('aeratorAutoToggle');
    const isAuto     = aeratorData.mode === 'automatic';
    autoToggle.checked = isAuto;
    toggleAeratorMode(false);

    // Reflect current command on the manual toggle
    const manualToggle = document.getElementById('aeratorManualToggle');
    if (manualToggle) {
      const isOn = aeratorData.command === 'on';
      manualToggle.checked = isOn;
      updateManualToggleUI(isOn);
    }

    // Apply failsafe lock if active
    applyFailsafeUI(aeratorData.failsafe === true);


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
      // Data is stored as { number_1: "+63...", number_2: "+63...", ... }
      Object.keys(data)
        .sort((a, b) => {
          const numA = parseInt(a.replace('number_', ''), 10);
          const numB = parseInt(b.replace('number_', ''), 10);
          return numA - numB;
        })
        .forEach(key => {
          smsIdCounter++;
          smsRecipients.push({
            id:     'sms-' + smsIdCounter,
            name:   '',
            number: data[key]
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
      smsRecipients.forEach((r, index) => {
        payload['number_' + (index + 1)] = r.number;
      });
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
        console.log('✓ SMS numbers saved to Firebase /config/sms-numbers as number_1, number_2, ...:', payload);
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

function toggleAeratorMode(saveToFirebase) {
  const autoToggle    = document.getElementById('aeratorAutoToggle');
  const autoSettings  = document.getElementById('aeratorAutoSettings');
  const manualControl = document.getElementById('aeratorManualControl');
  const modeLabel     = document.getElementById('aeratorModeLabel');
  const modeDesc      = document.getElementById('aeratorModeDescription');

  const isAutoMode = autoToggle.checked;
  const modeString = isAutoMode ? 'automatic' : 'manual';

  // ── If switching TO manual, show warning confirmation modal ──────────────
  if (saveToFirebase === true && modeString === 'manual') {
    // Revert toggle visually until the user confirms
    autoToggle.checked = true;

    showConfirmModal(
      'Switch to Manual Mode?',
      'In manual mode, the aerator will <strong>not</strong> respond automatically to pond conditions. ' +
      'If water quality deteriorates, the aerator will stay off until you turn it on manually. ' +
      'Are you sure you want to switch to manual mode?',
      () => {
        autoToggle.checked = false;
        applyAeratorModeUI(false);
        persistAeratorMode('manual');
      }
    );
    return;
  }

  applyAeratorModeUI(isAutoMode);

  if (saveToFirebase === true) {
    persistAeratorMode(modeString);
  }
}

function applyAeratorModeUI(isAutoMode) {
  const autoSettings  = document.getElementById('aeratorAutoSettings');
  const manualControl = document.getElementById('aeratorManualControl');
  const modeLabel     = document.getElementById('aeratorModeLabel');
  const modeDesc      = document.getElementById('aeratorModeDescription');

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
}

function persistAeratorMode(modeString) {
  const autoToggle = document.getElementById('aeratorAutoToggle');
  systemRef.child('aerator/mode').set(modeString)
    .then(() => {
      currentConfig.aerator.mode = modeString;
      showNotification(
        `Aerator mode changed to ${modeString === 'automatic' ? 'Automatic' : 'Manual'}`,
        'success'
      );
    })
    .catch(err => {
      showNotification('Error saving aerator mode: ' + err.message, 'error');
      // Revert toggle on failure
      autoToggle.checked = modeString !== 'automatic';
      applyAeratorModeUI(modeString !== 'automatic');
    });
}

function setAeratorManual() {
  const toggle   = document.getElementById('aeratorManualToggle');
  const isOn     = toggle.checked;
  const failsafe = currentConfig.aerator.failsafe === true;

  // Block if failsafe is active
  if (failsafe) {
    toggle.checked = !isOn;          // revert the toggle visually
    showNotification(
      'Failsafe is active — the aerator command cannot be changed right now.',
      'error'
    );
    return;
  }

  const command = isOn ? 'on' : 'off';

  systemRef.child('aerator/command').set(command)
    .then(() => {
      currentConfig.aerator.command = command;
      updateManualToggleUI(isOn);
      showNotification(`Aerator command set to ${command.toUpperCase()}`, 'success');
      console.log(`✓ config/aerator/command set to "${command}"`);
    })
    .catch(err => {
      showNotification('Error updating aerator command: ' + err.message, 'error');
      toggle.checked = !isOn;
    });
}

// Updates the icon/text next to the manual toggle based on isOn state
function updateManualToggleUI(isOn) {
  const icon = document.getElementById('aeratorManualIcon');
  const text = document.getElementById('aeratorManualStatusText');
  if (icon) icon.style.color = isOn ? '#10b981' : '';
  if (text) text.textContent = isOn ? 'Aerator is ON ' : 'Aerator is OFF ';
}

// Locks / unlocks the manual toggle based on failsafe flag
function applyFailsafeUI(isFailsafe) {
  const toggle    = document.getElementById('aeratorManualToggle');
  const container = document.getElementById('aeratorManualControl');
  const badge     = document.getElementById('aeratorFailsafeBadge');

  if (!toggle) return;

  if (isFailsafe) {
    toggle.disabled = true;
    if (container) container.classList.add('failsafe-locked');
    if (badge)     badge.style.display = 'flex';
  } else {
    toggle.disabled = false;
    if (container) container.classList.remove('failsafe-locked');
    if (badge)     badge.style.display = 'none';
  }
}







// ===================================
// REAL-TIME UPDATES
// ===================================

function listenForUpdates() {
  systemRef.on('value', () => {
    console.log('System configuration updated');
  });

  // Real-time listener for aerator/command (user-sent command)
  systemRef.child('aerator/command').on('value', (snapshot) => {
    const cmd  = snapshot.val();
    const isOn = cmd === 'on';
    currentConfig.aerator.command = cmd || 'off';

    const toggle = document.getElementById('aeratorManualToggle');
    if (!toggle) return;
    toggle.checked = isOn;
    updateManualToggleUI(isOn);
  });

  // Real-time listener for aerator/failsafe
  systemRef.child('aerator/failsafe').on('value', (snapshot) => {
    const isFailsafe = snapshot.val() === true;
    currentConfig.aerator.failsafe = isFailsafe;
    applyFailsafeUI(isFailsafe);
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

window.testFirebaseWrite    = testFirebaseWrite;