// =============================================================================
// buffer-engine.js — OLS Slope Buffer Engine
// =============================================================================
//
// Responsibilities (and ONLY these):
//   1. On page open  → seed each parameter buffer from WaterQ_history (.once)
//   2. On new cycle  → append new { t, P } to each buffer, evict old samples
//   3. Compute OLS slope Si per parameter (units/hour)
//   4. Pass { Pi, Si, flag, phase } per parameter to fkri-engine.js
//
// Firebase paths:
//   WaterQ_cycle     (read  — .on()  — sole trigger)
//   WaterQ_history   (read  — .once() — startup seed only)
//
// Does NOT write to Firebase.
// Does NOT compute Hlevel, Hslope, HLS, or FKRI.
// =============================================================================

(function () {
  'use strict';

  // ── Guard ──────────────────────────────────────────────────────────────────
  if (typeof window.database === 'undefined') {
    console.warn('[buffer-engine] window.database not found. Engine will not run.');
    return;
  }

  if (typeof window.fkriEngine === 'undefined' || typeof window.fkriEngine.compute !== 'function') {
    console.warn('[buffer-engine] window.fkriEngine.compute not found. Load fkri-engine.js first.');
    return;
  }

  const db = window.database;

  // ===========================================================================
  // CONSTANTS
  // ===========================================================================
  const WINDOW_SECONDS      = 3600;    // 1-hour OLS window
  const MIN_SAMPLES         = 2;       // minimum samples required for valid Si
  const EPSILON             = 1e-10;   // degeneracy guard for Sxx
  const SLOPE_CLAMP         = 1e6;     // prevent extreme numerical output

  // ESP32 does not use NTP — its clock is a free-running uptime counter (seconds).
  // Add this offset to convert raw ESP32 seconds → real unix seconds.
  // Calibrated: 2026-03-19 11:23 AM PH (UTC+8). Recalibrate after every ESP32 reboot.
  const TIMESTAMP_OFFSET_S  = 554193;

  // Parameter map: internal key → Firebase field names
  // piField   — field name in WaterQ_cycle
  // histPath  — sub-path in WaterQ_history
  const PARAM_MAP = {
    DO:       { piField: 'DO',   histPath: 'DO'       },
    Temp:     { piField: 'Temp', histPath: 'Temp'     },
    pH:       { piField: 'pH',   histPath: 'pH'       },
    Turb:     { piField: 'Turb', histPath: 'Turb'     },
    Salinity: { piField: 'Sal',  histPath: 'Salinity' },
  };

  const PARAM_KEYS = Object.keys(PARAM_MAP);

  // ===========================================================================
  // IN-MEMORY BUFFERS
  // One array per parameter: [{ t: unix_seconds, P: number }, ...]
  // Seeded from WaterQ_history on startup, then maintained in memory
  // ===========================================================================
  const buffers = {};
  PARAM_KEYS.forEach(key => { buffers[key] = []; });

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  // Normalise Firebase timestamp → unix seconds
  function toSeconds(ts) {
    const n = Number(ts);
    return n > 1e10 ? n / 1000 : n;
  }

  // ===========================================================================
  // OLS SLOPE COMPUTATION
  // ===========================================================================

  /**
   * Append a new sample to the buffer, evict samples older than 1 hour,
   * then compute OLS slope in units/hour.
   *
   * @param {string} key     - parameter key ('DO', 'Temp', etc.)
   * @param {number} t_now   - unix timestamp in seconds
   * @param {number} P_now   - sensor reading
   * @returns {{ Si: number, phase: string, flag: string, n: number }}
   */
  function updateAndCompute(key, t_now, P_now) {
    const buf = buffers[key];

    // Step 1 — Append new sample unconditionally
    buf.push({ t: t_now, P: P_now });

    // Step 2 — Evict samples older than 1 hour
    const cutoff = t_now - WINDOW_SECONDS;
    while (buf.length > 0 && buf[0].t < cutoff) {
      buf.shift();
    }

    const n = buf.length;

    // Validity check — minimum 2 samples required
    if (n < MIN_SAMPLES) {
      return { Si: 0, phase: 'BOOT', flag: 'INSUFFICIENT', n };
    }

    // Window phase classification
    const span  = buf[n - 1].t - buf[0].t;
    const phase = span >= WINDOW_SECONDS ? 'FULL' : 'WARM';

    // Centroid
    let t_sum = 0, P_sum = 0;
    for (const s of buf) { t_sum += s.t; P_sum += s.P; }
    const t_bar = t_sum / n;
    const P_bar = P_sum / n;

    // Covariance and variance terms
    let Sxy = 0, Sxx = 0;
    for (const s of buf) {
      const dt = s.t - t_bar;
      Sxy += dt * (s.P - P_bar);
      Sxx += dt * dt;
    }

    // Degeneracy guard — all timestamps identical
    if (Sxx < EPSILON) {
      return { Si: 0, phase, flag: 'DEGENERATE', n };
    }

    // Raw OLS coefficient (per second) → convert to per hour
    const beta = Sxy / Sxx;
    let Si = beta * WINDOW_SECONDS;

    // Clamp to prevent extreme output
    Si = Math.max(-SLOPE_CLAMP, Math.min(SLOPE_CLAMP, Si));

    return { Si, phase, flag: 'OK', n };
  }

  // ===========================================================================
  // STARTUP — SEED BUFFERS FROM WaterQ_history
  // Called once on page open using .once() — never re-triggers the engine
  // ===========================================================================

  async function seedBuffersFromHistory() {
    console.log('[buffer-engine] Seeding buffers from WaterQ_history...');

    // Compute cutoff in ESP32-space (raw seconds) so startAt matches stored timestamps
    const nowEsp32S = Math.floor(Date.now() / 1000) - TIMESTAMP_OFFSET_S;
    const cutoff    = nowEsp32S - WINDOW_SECONDS;

    await Promise.all(PARAM_KEYS.map(async (key) => {
      const map = PARAM_MAP[key];

      try {
        // Read last 1 hour of entries.
        // startAt uses ESP32 raw seconds — matches what the ESP32 wrote as timestamp
        const snap = await db
          .ref('WaterQ_history')
          .orderByChild('timestamp')
          .startAt(cutoff)
          .once('value');

        const samples = [];

        snap.forEach(child => {
          const entry = child.val();
          if (!entry || typeof entry.timestamp !== 'number') return;

          // paramData is a direct number, not a nested { P } object
          const paramData = entry[map.histPath];
          if (paramData === undefined || paramData === null || isNaN(Number(paramData))) return;

          // Convert ESP32 raw seconds → real unix seconds for OLS buffer
          const realTs = entry.timestamp + TIMESTAMP_OFFSET_S;
          samples.push({ t: realTs, P: Number(paramData) });
        });

        // Sort by timestamp ascending (Firebase orderByChild should already do this)
        samples.sort((a, b) => a.t - b.t);

        // Load into buffer
        buffers[key] = samples;

        console.log(`[buffer-engine] ${key}: seeded ${samples.length} sample(s) from history`);
      } catch (err) {
        console.error(`[buffer-engine] Failed to seed ${key} from history:`, err);
        buffers[key] = [];
      }
    }));

    console.log('[buffer-engine] Buffer seeding complete.');
  }

  // ===========================================================================
  // MAIN CYCLE — triggered by WaterQ_cycle .on()
  // ===========================================================================

  function onNewCycle(cycleData) {
    // Convert ESP32 raw seconds → real unix seconds
    // Fallback: if timestamp missing, derive ESP32-equivalent from Date.now()
    const rawTs = cycleData.timestamp !== undefined
      ? cycleData.timestamp
      : Math.floor(Date.now() / 1000) - TIMESTAMP_OFFSET_S;

    const t_now = rawTs + TIMESTAMP_OFFSET_S;

    // Build payload: { Pi, Si, flag, phase, n } per parameter
    const payload = {};

    for (const key of PARAM_KEYS) {
      const map  = PARAM_MAP[key];
      const rawP = cycleData[map.piField];

      // Skip if reading is missing or invalid
      if (rawP === undefined || rawP === null || isNaN(Number(rawP))) {
        payload[key] = { Pi: null, Si: 0, flag: 'MISSING', phase: 'BOOT', n: 0 };
        continue;
      }

      const Pi            = Number(rawP);
      const { Si, phase, flag, n } = updateAndCompute(key, t_now, Pi);

      payload[key] = { Pi, Si, phase, flag, n };

      console.log(
        `[buffer-engine] ${key.padEnd(8)} ` +
        `Pi=${Pi.toFixed(3)} Si=${Si.toFixed(4)} ` +
        `n=${n} phase=${phase} flag=${flag}`
      );
    }

    // Hand off to fkri-engine — pass real unix seconds (offset-corrected)
    window.fkriEngine.compute(payload, t_now);
  }

  // ===========================================================================
  // INITIALISE
  // 1. Seed buffers from history
  // 2. Then start listening to WaterQ_cycle
  // ===========================================================================

  let _busy = false;

  seedBuffersFromHistory().then(() => {
    // Start listening AFTER seed is complete so first cycle has history data
    db.ref('WaterQ_cycle').on('value', snapshot => {
      const data = snapshot.val();
      if (!data) return;

      if (_busy) {
        console.warn('[buffer-engine] Previous cycle still running — skipping.');
        return;
      }

      _busy = true;
      try {
        onNewCycle(data);
      } catch (err) {
        console.error('[buffer-engine] Cycle error:', err);
      } finally {
        _busy = false;
      }
    });

    console.log('[buffer-engine] Listening to WaterQ_cycle...');
  });

})();