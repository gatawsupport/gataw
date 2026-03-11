// ========================================
// PUSH ALERTS - Firebase Cloud Messaging
// Bangus Pond Water Quality Monitor
// ========================================
// HOW IT WORKS:
//   1. Watches Firebase alerts/active independently (separate from smsAlerts.js)
//   2. When a new alert appears   → sends push to all FCM tokens
//   3. When severity changes      → sends push immediately
//   4. When alert is resolved     → sends recovery push
//
// ALERT RULES (mirrors smsAlerts.js logic):
//   WARNING entered        → push immediately
//   CRITICAL entered       → push immediately
//   WARNING → CRITICAL     → push immediately (escalation)
//   CRITICAL → WARNING     → push immediately (downgrade)
//   SAFE reached           → push once (recovery)
//
// SETUP:
//   1. Place this file in your /js/ folder
//   2. Add to alerts.html AFTER notifications.js and auth.js:
//      <script src="../js/pushAlerts.js"></script>
//   3. Call initPushAlerts() after user is authenticated
//      (auth.js already calls initPushNotifications — add initPushAlerts there)
// ========================================


// ── CONFIG ───────────────────────────────────────────────────────────────────
const PUSH_ALERTS_CONFIG = {
  // Firebase path where FCM tokens are stored (set by notifications.js)
  fcmTokensPath: 'fcmTokens',

  // Firebase path to watch for active alerts
  activeAlertsPath: 'alerts/active',

  // Send a push when a parameter returns to safe range
  sendRecoveryPush: true,

  // Minimum ms between pushes for the SAME parameter at the SAME severity
  // Prevents push spam if Firebase keeps firing child_changed rapidly
  minPushIntervalMs: 30 * 1000, // 30 seconds
};
// ─────────────────────────────────────────────────────────────────────────────


// ── STATE ─────────────────────────────────────────────────────────────────────
/*
  _pushParamState tracks per-parameter push state:
  {
    [parameter]: {
      severity:   'warning' | 'critical' | null,
      alertId:    string,
      lastPushAt: number,   // timestamp of last push sent
    }
  }
*/
const _pushParamState = {};

let _pushAlertsInitialized = false;
let _currentUid = null;
// ─────────────────────────────────────────────────────────────────────────────


// ── INIT ──────────────────────────────────────────────────────────────────────
/**
 * Call this after a user/admin logs in (same place initPushNotifications is called).
 * Starts watching alerts/active and sends push notifications on changes.
 *
 * @param {string} uid - The Firebase Auth user ID (used to avoid self-exclusion if needed)
 */
function initPushAlerts(uid) {
  if (_pushAlertsInitialized) return;
  _pushAlertsInitialized = true;
  _currentUid = uid;

  if (typeof firebase === 'undefined' || !firebase.database) {
    console.warn('[PushAlerts] Firebase not available. Push alerts disabled.');
    return;
  }

  console.log('[PushAlerts] Initializing push alert watcher for uid:', uid);
  _watchActiveAlerts();
  console.log('[PushAlerts] ✅ Push alert watcher ready.');
}
// ─────────────────────────────────────────────────────────────────────────────


// ── FIREBASE LISTENER ────────────────────────────────────────────────────────
function _watchActiveAlerts() {
  const activeRef = firebase.database().ref(PUSH_ALERTS_CONFIG.activeAlertsPath);

  // child_added fires for existing nodes on first listen, then for new ones.
  // We use _pushParamState to detect if this is a fresh alert or a reload.
  activeRef.on('child_added', (snapshot) => {
    const alert = { id: snapshot.key, ...snapshot.val() };
    _onAlertAddedOrChanged(alert, false);
  });

  // child_changed fires when severity or value updates on an existing alert
  activeRef.on('child_changed', (snapshot) => {
    const alert = { id: snapshot.key, ...snapshot.val() };
    _onAlertAddedOrChanged(alert, true);
  });

  // child_removed fires when an alert is acknowledged, dismissed, or auto-resolved
  activeRef.on('child_removed', (snapshot) => {
    const alert = { id: snapshot.key, ...snapshot.val() };
    _onAlertRemoved(alert);
  });
}
// ─────────────────────────────────────────────────────────────────────────────


// ── CORE ALERT HANDLER ───────────────────────────────────────────────────────
/**
 * Decides whether to send a push based on what changed.
 */
function _onAlertAddedOrChanged(alert, isUpdate) {
  const { id, parameter, severity, value, threshold, message } = alert;
  const prev = _pushParamState[parameter];

  const prevSeverity   = prev ? prev.severity : null;
  const severityChanged = prevSeverity !== severity;
  const now            = Date.now();

  // ── Case 1: Page reload — alert already existed ─────────────────────────
  // Restore state silently without sending a push (user already got one).
  if (prev && prev.alertId === id && !severityChanged) {
    console.log(`[PushAlerts] Skipping push for "${parameter}" (${severity}) — already notified.`);
    return;
  }

  // ── Case 2: Same severity, but rapid value update — throttle ───────────
  if (prev && !severityChanged) {
    const timeSinceLast = now - (prev.lastPushAt || 0);
    if (timeSinceLast < PUSH_ALERTS_CONFIG.minPushIntervalMs) {
      console.log(`[PushAlerts] Throttling push for "${parameter}" — sent ${Math.round(timeSinceLast / 1000)}s ago.`);
      return;
    }
  }

  // ── Case 3: New alert or severity changed — send immediately ───────────
  const reason = !prev
    ? `entered ${severity}`
    : `changed ${prevSeverity} → ${severity}`;

  console.log(`[PushAlerts] "${parameter}" ${reason}. Sending push notification.`);

  // Update state
  _pushParamState[parameter] = {
    severity,
    alertId: id,
    lastPushAt: now,
  };

  // Build and send
  const { title, body } = _buildAlertPayload(parameter, severity, value, threshold, message, reason);
  _sendPushToAllTokens(title, body);
}

/**
 * Called when an alert is removed (resolved, acknowledged, or dismissed).
 */
function _onAlertRemoved(alert) {
  const { parameter } = alert;

  delete _pushParamState[parameter];

  if (!PUSH_ALERTS_CONFIG.sendRecoveryPush) return;

  // Wait 3s to confirm the parameter isn't immediately re-alerting
  setTimeout(() => {
    firebase.database()
      .ref(PUSH_ALERTS_CONFIG.activeAlertsPath)
      .orderByChild('parameter')
      .equalTo(parameter)
      .once('value')
      .then((snap) => {
        if (!snap.exists()) {
          console.log(`[PushAlerts] "${parameter}" returned to safe range. Sending recovery push.`);
          const { title, body } = _buildRecoveryPayload(parameter);
          _sendPushToAllTokens(title, body);
        } else {
          console.log(`[PushAlerts] "${parameter}" re-alerted immediately — skipping recovery push.`);
        }
      });
  }, 3000);
}
// ─────────────────────────────────────────────────────────────────────────────


// ── FCM TOKEN FETCH & SEND ────────────────────────────────────────────────────
/**
 * Reads ALL FCM tokens from Firebase and sends the push to each one
 * using the browser-side Firebase Messaging API.
 *
 * NOTE: Browser-side FCM can only send to the CURRENT browser's token.
 * To send to ALL users' tokens, you need a server. This function sends
 * a local push to THIS browser and logs other tokens for server use.
 *
 * For full multi-user push, see the server-side note at the bottom of this file.
 */
async function _sendPushToAllTokens(title, body) {
  try {
    // ── Show local foreground toast immediately (works in all cases) ───────
    if (typeof _showToastNotification === 'function') {
      _showToastNotification(title, body);
    }

    // ── Show browser system notification via Service Worker ────────────────
    // This works even when the tab is minimized
    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.ready;
      if (registration && Notification.permission === 'granted') {
        await registration.showNotification(title, {
          body:    body,
          icon:    '../images/gataw.png',
          badge:   '../images/gataw.png',
          tag:     'bangus-pond-alert',
          renotify: true,
          data:    { url: '/html/alerts.html' },
        });
        console.log('[PushAlerts] ✅ System notification shown via service worker.');
      }
    }

    // ── Log all tokens (for future server-side sending) ────────────────────
    const tokensSnapshot = await firebase.database()
      .ref(PUSH_ALERTS_CONFIG.fcmTokensPath)
      .once('value');

    if (tokensSnapshot.exists()) {
      let tokenCount = 0;
      tokensSnapshot.forEach((userNode) => {
        userNode.forEach((tokenNode) => {
          tokenCount++;
        });
      });
      console.log(`[PushAlerts] ${tokenCount} FCM token(s) found in database (server-side send would reach all).`);
    }

  } catch (error) {
    console.error('[PushAlerts] Error sending push notification:', error);
  }
}
// ─────────────────────────────────────────────────────────────────────────────


// ── MESSAGE BUILDERS ──────────────────────────────────────────────────────────
function _buildAlertPayload(parameter, severity, value, threshold, message, reason) {
  const paramLabel = _getPushParamLabel(parameter);
  const unit       = _getPushParamUnit(parameter);
  const sevEmoji   = severity === 'critical' ? '🚨' : '⚠️';
  const sevLabel   = severity.toUpperCase();

  let contextLine = '';
  if (reason && reason.includes('→')) {
    contextLine = `Escalated: ${reason}`;
  } else if (reason && reason.startsWith('still')) {
    contextLine = `Still ${severity} — situation ongoing`;
  } else {
    contextLine = `Alert triggered`;
  }

  return {
    title: `${sevEmoji} ${sevLabel}: ${paramLabel}`,
    body:  `${contextLine} | ${value} ${unit} (${threshold})`,
  };
}

function _buildRecoveryPayload(parameter) {
  const paramLabel = _getPushParamLabel(parameter);
  return {
    title: `✅ RESOLVED: ${paramLabel}`,
    body:  `${paramLabel} has returned to safe range.`,
  };
}

function _getPushParamLabel(parameter) {
  const labels = {
    do:          'Dissolved Oxygen',
    temperature: 'Temperature',
    salinity:    'Salinity',
    turbidity:   'Turbidity',
    ph:          'pH Level',
  };
  return labels[parameter?.toLowerCase()] || parameter?.toUpperCase() || 'Unknown';
}

function _getPushParamUnit(parameter) {
  const units = {
    do:          'mg/L',
    temperature: '°C',
    salinity:    'ppt',
    turbidity:   'NTU',
    ph:          '',
  };
  return units[parameter?.toLowerCase()] || '';
}
// ─────────────────────────────────────────────────────────────────────────────


// ── PUBLIC API ────────────────────────────────────────────────────────────────
/**
 * Send a test push notification to verify setup.
 * Call from browser console: testPushAlert()
 */
function testPushAlert() {
  console.log('[PushAlerts] Sending test push...');
  _sendPushToAllTokens(
    '🔔 Test Alert - Bangus Pond',
    'Push alert system is working correctly!'
  );
}

/**
 * View current per-parameter push state (for debugging).
 * Call from browser console: getPushState()
 */
function getPushState() {
  console.table(
    Object.entries(_pushParamState).map(([param, s]) => ({
      parameter:   param,
      severity:    s.severity,
      lastPushAgo: s.lastPushAt
        ? Math.round((Date.now() - s.lastPushAt) / 1000) + 's ago'
        : 'never',
    }))
  );
}
// ─────────────────────────────────────────────────────────────────────────────


// ── SERVER-SIDE NOTE ─────────────────────────────────────────────────────────
// To send push notifications to ALL registered users (not just the current browser),
// you need a server-side component that:
//   1. Reads all tokens from fcmTokens/ in Firebase
//   2. Calls the FCM HTTP v1 API with each token
//   3. Can be triggered by Firebase Cloud Functions or a Node.js backend
//
// This browser-side file handles:
//   ✅ Push to the current active browser (foreground toast + system notification)
//   ✅ Correct alert detection logic (new, severity change, recovery)
//   ✅ Token logging for future server-side use
// ─────────────────────────────────────────────────────────────────────────────


// ── AUTO-START ────────────────────────────────────────────────────────────────
// pushAlerts.js does NOT auto-start — it must be triggered by auth.js
// after the user is authenticated, via: initPushAlerts(uid)
// ─────────────────────────────────────────────────────────────────────────────

console.log('[PushAlerts] pushAlerts.js loaded.');