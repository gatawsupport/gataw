// =============================================================================
// fkri-engine.js — GATAW Fish Kill Risk Index Hazard Computation Engine
// =============================================================================
//
// Responsibilities (and ONLY these):
//   1. Receive { Pi, Si } per parameter from buffer-engine.js
//   2. Compute Hlevel  — from Pi only         (real-time)
//   3. Compute Srisk   — from Pi + Si
//   4. Compute Hslope  — from Srisk
//   5. Compute HLS     — from Hlevel + Hslope
//   6. Compute FKRI    — from all five HLS scores
//   7. Write WaterQ_cycle_calc  (current computed snapshot)
//   8. Write WaterQ_history     (data log — P + S per cycle)
//
// Exposed as: window.fkriEngine.compute(payload, timestamp)
//
// Firebase paths written:
//   WaterQ_cycle_calc/
//     DO/       { PDO,   SDO,   HLDO,   HSDO,   HLSDO   }
//     Temp/     { PTemp, STemp, HLTemp, HSTemp, HLSTemp  }
//     pH/       { PpH,   SpH,   HLpH,   HSpH,   HLSpH   }
//     Turb/     { PTurb, STurb, HLTurb, HSTurb, HLSTurb  }
//     Salinity/ { PSal,  SSal,  HLSal,  HSSal,  HLSSal  }
//     FKRI
//     timestamp
//
//   WaterQ_history/
//     -pushkey/
//       timestamp
//       DO:       { P, S }
//       Temp:     { P, S }
//       pH:       { P, S }
//       Turb:     { P, S }
//       Salinity: { P, S }
// =============================================================================

(function () {
  'use strict';

  // ── Guard ──────────────────────────────────────────────────────────────────
  if (typeof window.database === 'undefined') {
    console.warn('[fkri-engine] window.database not found. Engine will not run.');
    return;
  }

  const db = window.database;

  // ===========================================================================
  // CONSTANTS
  // ===========================================================================

  // Level thresholds { AL, SL, SU, AU }
  // Source: firmware constants — Default Parameter Threshold Values
  const LEVEL_THRESH = {
    DO:       { AL:  3.0, SL:  4.0, SU: 15.0, AU: 18.0  },
    Temp:     { AL: 22.0, SL: 26.0, SU: 30.0, AU: 34.0  },
    pH:       { AL:  7.0, SL:  7.5, SU:  8.5, AU:  9.0  },
    Turb:     { AL: 10.0, SL: 20.0, SU: 80.0, AU: 120.0 },
    Salinity: { AL:  5.0, SL: 10.0, SU: 30.0, AU: 35.0  },
  };

  // Slope thresholds { Smax, Amax }
  const SLOPE_THRESH = {
    DO:       { Smax: 0.7, Amax: 2.0  },
    Temp:     { Smax: 0.7, Amax: 2.0  },
    pH:       { Smax: 0.2, Amax: 0.5  },
    Turb:     { Smax: 5.0, Amax: 20.0 },
    Salinity: { Smax: 0.2, Amax: 1.0  },
  };

  // AHP weights (sum = 1)
  const AHP_WEIGHTS = {
    DO:       0.570,
    Temp:     0.219,
    pH:       0.116,
    Turb:     0.057,
    Salinity: 0.038,
  };

  // Firebase field name mappings per parameter
  const PARAM_MAP = {
    DO:       { writeKey: 'DO',       piOut: 'PDO',   siOut: 'SDO',   hlOut: 'HLDO',   hsOut: 'HSDO',   hlsOut: 'HLSDO',   histPath: 'DO'       },
    Temp:     { writeKey: 'Temp',     piOut: 'PTemp', siOut: 'STemp', hlOut: 'HLTemp', hsOut: 'HSTemp', hlsOut: 'HLSTemp',  histPath: 'Temp'     },
    pH:       { writeKey: 'pH',       piOut: 'PpH',   siOut: 'SpH',   hlOut: 'HLpH',   hsOut: 'HSpH',   hlsOut: 'HLSpH',   histPath: 'pH'       },
    Turb:     { writeKey: 'Turb',     piOut: 'PTurb', siOut: 'STurb', hlOut: 'HLTurb', hsOut: 'HSTurb', hlsOut: 'HLSTurb', histPath: 'Turb'     },
    Salinity: { writeKey: 'Salinity', piOut: 'PSal',  siOut: 'SSal',  hlOut: 'HLSal',  hsOut: 'HSSal',  hlsOut: 'HLSSal',  histPath: 'Salinity' },
  };

  const PARAM_KEYS = Object.keys(PARAM_MAP);

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  function round(v, decimals) {
    return parseFloat(v.toFixed(decimals !== undefined ? decimals : 6));
  }

  // ===========================================================================
  // HAZARD COMPUTATION FUNCTIONS
  // ===========================================================================

  /**
   * Hlevel — Level Hazard Score
   * Depends on: Pi only (real-time)
   * Range: [0, 1]
   */
  function computeHlevel(Pi, T) {
    const WL = T.SL - T.AL;
    const WU = T.AU - T.SU;
    let H;

    if      (Pi >= T.SL && Pi <= T.SU) H = 0.0;                              // Safe
    else if (Pi >= T.AL && Pi <  T.SL) H = 0.5 * (T.SL - Pi) / WL;          // Lower Alert
    else if (Pi >  T.SU && Pi <= T.AU) H = 0.5 * (Pi - T.SU) / WU;          // Upper Alert
    else if (Pi <  T.AL)               H = 0.5 + 0.5 * (T.AL - Pi) / WL;    // Lower Critical
    else                               H = 0.5 + 0.5 * (Pi - T.AU) / WU;    // Upper Critical

    return Math.min(H, 1.0);
  }

  /**
   * Srisk — Directional Deterioration Slope
   * Depends on: Pi (real-time) + Si (from OLS)
   * Only counts slope as hazardous when moving toward critical boundary
   */
  function computeSrisk(Pi, Si, T) {
    if      (Pi < T.SL) return Math.max(0, -Si);   // below safe → falling is bad
    else if (Pi > T.SU) return Math.max(0,  Si);   // above safe → rising is bad
    else                return Math.abs(Si);         // inside safe → both directions
  }

  /**
   * Hslope — Slope Hazard Score
   * Depends on: Srisk (Mi)
   * Range: [0, 1]
   */
  function computeHslope(Mi, S) {
    const Ws = S.Amax - S.Smax;
    let H;

    if      (Mi <= S.Smax) H = 0.0;                                          // Safe slope
    else if (Mi <= S.Amax) H = 0.5 * (Mi - S.Smax) / Ws;                    // Alert slope
    else                   H = 0.5 + 0.5 * (Mi - S.Amax) / Ws;              // Critical slope

    return Math.min(H, 1.0);
  }

  /**
   * HLS — Level-Slope Integrated Hazard Score
   * HLS = Hlevel + WSI × Hslope
   * WSI = (1 - Hlevel)²
   * Slope amplifies risk but never reduces it
   * Range: [0, 1]
   */
  function computeHLS(Hlevel, Hslope) {
    const WSI = (1.0 - Hlevel) * (1.0 - Hlevel);
    return Math.min(Hlevel + WSI * Hslope, 1.0);
  }

  /**
   * FKRI — Fish Kill Risk Index
   * FKRI = FKRIw + (1 - FKRIw) × Hmax
   * FKRIw = Σ(wi × HLSi) — weighted aggregate
   * Hmax  = max(HLSi)    — dominant hazard amplification
   * Range: [0, 1]
   */
  function computeFKRI(hlsMap) {
    let FKRIw = 0;
    let Hmax  = 0;

    for (const key of PARAM_KEYS) {
      const hls = hlsMap[key] || 0;
      FKRIw += AHP_WEIGHTS[key] * hls;
      if (hls > Hmax) Hmax = hls;
    }

    return FKRIw + (1 - FKRIw) * Hmax;
  }

  // ===========================================================================
  // COMPUTE — called by buffer-engine.js on every cycle
  // ===========================================================================

  /**
   * Main entry point. Receives payload from buffer-engine.js.
   *
   * @param {Object} payload   - { DO: { Pi, Si, flag, phase, n }, Temp: {...}, ... }
   * @param {number} rawTs     - raw timestamp from WaterQ_cycle (ms or s)
   */
  async function compute(payload, t_now, rawTs) {
    const hlsMap      = {};
    const calcData    = {};   // → WaterQ_cycle_calc
    const sUpdate     = {};   // → WaterQ_history (S siblings appended to ESP32 node)

    // ── Per-parameter computation ───────────────────────────────────────────
    for (const key of PARAM_KEYS) {
      const map    = PARAM_MAP[key];
      const data   = payload[key];

      // Skip if parameter was missing from WaterQ_cycle
      if (!data || data.Pi === null || data.Pi === undefined) {
        hlsMap[key] = 0;
        continue;
      }

      const { Pi, Si } = data;
      const LT = LEVEL_THRESH[key];
      const ST = SLOPE_THRESH[key];

      // Compute hazard scores
      const Hlevel = computeHlevel(Pi, LT);
      const Srisk  = computeSrisk(Pi, Si, LT);
      const Hslope = computeHslope(Srisk, ST);
      const HLS    = computeHLS(Hlevel, Hslope);

      hlsMap[key] = HLS;

      // Stage WaterQ_cycle_calc fields for this parameter
      calcData[map.writeKey] = {
        [map.piOut]:  round(Pi,     6),
        [map.siOut]:  round(Si,     6),
        [map.hlOut]:  round(Hlevel, 6),
        [map.hsOut]:  round(Hslope, 6),
        [map.hlsOut]: round(HLS,    6),
      };

      // Stage WaterQ_history S sibling field for this parameter
      sUpdate[`${map.histPath}_S`] = round(Si, 6);

      console.log(
        `[fkri-engine] ${key.padEnd(8)} ` +
        `Hl=${Hlevel.toFixed(4)} Hs=${Hslope.toFixed(4)} HLS=${HLS.toFixed(4)} ` +
        `(Si=${Si.toFixed(4)} flag=${data.flag})`
      );
    }

    // ── FKRI ────────────────────────────────────────────────────────────────
    const FKRI = computeFKRI(hlsMap);
    calcData.FKRI      = round(FKRI, 6);
    // Use Firebase server timestamp so WaterQ_cycle_calc always reflects
    // the real current time — not the (potentially stale) rawTs from the device.
    calcData.timestamp = firebase.database.ServerValue.TIMESTAMP;

    // ── Write WaterQ_cycle_calc (overwrite each cycle) ───────────────────────
    try {
      await db.ref('WaterQ_cycle_calc').set(calcData);
    } catch (err) {
      console.error('[fkri-engine] Failed to write WaterQ_cycle_calc:', err);
    }

    // ── Write WaterQ_history (update ESP32 node — append S siblings only) ──────
    // rawTs matches the unix timestamp key the ESP32 used when it pushed this cycle.
    try {
      await db.ref(`WaterQ_history/${rawTs}`).update(sUpdate);
    } catch (err) {
      console.error('[fkri-engine] Failed to write WaterQ_history S values:', err);
    }

    console.log(`[fkri-engine] ── FKRI = ${FKRI.toFixed(6)} ────────────────────`);
  }

  // ===========================================================================
  // EXPOSE PUBLIC API
  // buffer-engine.js calls window.fkriEngine.compute()
  // ===========================================================================

  window.fkriEngine = { compute };

  console.log('[fkri-engine] Ready. Waiting for buffer-engine.js...');

})();