// ==========================================
// WATER QUALITY ANALYTICS SCRIPT
//
// KEY FEATURES:
//   • Each tab (Trends, Correlation, Forecast) has its own independent
//     time range filter and data store — changing one does not affect others.
//   • OPTIMAL_RANGES built dynamically from Firebase 'thresholds' node.
//   • All Firebase queries fetch ALL records and filter client-side —
//     fixes mixed string/number 'time' field bug.
//   • Timestamps normalised from both numeric and string representations.
//   • Summary date grouping uses LOCAL time (fixes UTC+8 off-by-one-day bug).
// ==========================================

// ---------------------------------------------------------------------------
// HARDCODED FALLBACK RANGES
// ---------------------------------------------------------------------------

const FALLBACK_RANGES = {
  do:          { min: 5,    max: 8,    critical: 3,    unit: 'mg/L', label: 'Dissolved Oxygen' },
  salinity:    { min: 10,   max: 25,   critical: 35,   unit: 'ppt',  label: 'Salinity'         },
  temperature: { min: 26,   max: 32,   critical: 35,   unit: '°C',   label: 'Temperature'      },
  ph:          { min: 7.5,  max: 8.5,  critical: 6.0,  unit: '',     label: 'pH Level'         },
  turbidity:   { min: 30,   max: 60,   critical: 20,   unit: 'NTU',  label: 'Turbidity'        }
};

let OPTIMAL_RANGES = JSON.parse(JSON.stringify(FALLBACK_RANGES));

// ---------------------------------------------------------------------------
// FIREBASE THRESHOLD LOADER
// ---------------------------------------------------------------------------

function buildOptimalRangesFromFirebase(snapshot) {
  const data = snapshot.val();
  if (!data) return;

  Object.keys(FALLBACK_RANGES).forEach(param => {
    const node = data[param];
    if (!node) return;

    const safeMin  = parseFloat(node.safeMin);
    const safeMax  = parseFloat(node.safeMax);
    const alertMin = parseFloat(node.alertMin);

    if (!isNaN(safeMin))  OPTIMAL_RANGES[param].min      = safeMin;
    if (!isNaN(safeMax))  OPTIMAL_RANGES[param].max      = safeMax;
    if (!isNaN(alertMin)) OPTIMAL_RANGES[param].critical = alertMin;
  });

  console.log('[Analytics] Thresholds loaded from Firebase:', JSON.stringify(OPTIMAL_RANGES, null, 2));
}

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

const SMOOTH_WINDOW = 5;

// Offset (in seconds) applied to raw timestamps to correct for clock drift.
const TIMESTAMP_OFFSET = 554193;

const TIME_RANGE_HOURS = { '24h': 24, '7d': 168, '30d': 720, '90d': 2160 };


// ---------------------------------------------------------------------------
// INDEPENDENT PER-TAB DATA STORES
// Each tab loads and owns its own data — no cross-tab contamination.
// ---------------------------------------------------------------------------

let correlationData = [];   // Correlation tab
let forecastData    = [];   // Forecast tab

// analyticsData kept as an alias so any legacy helper that still references
// it will read the correct dataset depending on context.
let analyticsData = [];

// ---------------------------------------------------------------------------
// CHART INSTANCES
// ---------------------------------------------------------------------------

let correlationChartInst = null;  // single correlation chart

// ---------------------------------------------------------------------------
// TIMESTAMP NORMALISER
// ---------------------------------------------------------------------------

function normaliseTimestamp(rawTime) {
  if (rawTime === undefined || rawTime === null) return NaN;

  let ms;
  if (typeof rawTime === 'number') {
    ms = rawTime;
  } else if (typeof rawTime === 'string') {
    const asNum = Number(rawTime);
    ms = isNaN(asNum) ? new Date(rawTime).getTime() : asNum;
  } else {
    return NaN;
  }

  // If the value is suspiciously small it was stored in SECONDS, not ms.
  // A Unix timestamp in seconds for year 2020+ is ~1,580,000,000 (10 digits).
  // A Unix timestamp in ms  for year 2020+ is ~1,580,000,000,000 (13 digits).
  // Threshold: anything under 10,000,000,000 (year 2286 in seconds / year 1973 in ms)
  // is treated as seconds and converted.
  if (ms < 10_000_000_000) {
    ms = ms * 1000;
  }

  // Apply offset to correct for device clock drift (offset is in seconds → convert to ms).
  ms += TIMESTAMP_OFFSET * 1000;

  return ms;
}

// ---------------------------------------------------------------------------
// SHARED FIREBASE ROW PARSER
// Returns a normalised record object or null if the row is invalid.
// ---------------------------------------------------------------------------

function parseFirebaseRow(child) {
  const d  = child.val();
  const ts = normaliseTimestamp(d.timestamp);
  if (isNaN(ts)) return null;

  if (
    d.Temp === undefined ||
    d.pH   === undefined ||
    d.Sal  === undefined ||
    d.Turb === undefined ||
    d.DO   === undefined
  ) return null;

  return {
    timestamp:   new Date(ts),
    do:          parseFloat(d.DO),
    salinity:    parseFloat(d.Sal),
    temperature: parseFloat(d.Temp),
    ph:          parseFloat(d.pH),
    turbidity:   parseFloat(d.Turb)
  };
}

// ---------------------------------------------------------------------------
// SHARED FIREBASE FETCHER
// Fetches all history records, filters to the given startTime, sorts, and
// resolves with the resulting array.
// ---------------------------------------------------------------------------

function fetchFilteredHistory(startTime) {
  return firebase.database().ref('WaterQ_history')
    .once('value')
    .then(snapshot => {
      const rows      = [];
      let   totalSeen = 0;
      let   skipped   = 0;

      snapshot.forEach(child => {
        totalSeen++;
        const row = parseFirebaseRow(child);
        if (!row) { skipped++; return; }

        if (row.timestamp.getTime() < startTime) {
          skipped++;
          return;
        }
        rows.push(row);
      });

      rows.sort((a, b) => a.timestamp - b.timestamp);

      console.log(
        `[Firebase] total=${totalSeen} | passed=${rows.length} | skipped=${skipped}` +
        ` | cutoff=${new Date(startTime).toLocaleString()}` +
        (rows.length > 0
          ? ` | first=${rows[0].timestamp.toLocaleString()} | last=${rows[rows.length-1].timestamp.toLocaleString()}`
          : ' | (no rows passed)')
      );

      return rows;
    });
}

// ---------------------------------------------------------------------------
// INIT
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// EXPOSE ON WINDOW  (Primary registration — runs as soon as script parses)
// Uses the bridge in reports.html when available; falls back to direct
// window assignment so analytics.js also works standalone.
// All steps logged to Console tab for debugging.
// ---------------------------------------------------------------------------
(function() {
  console.group('%c[Analytics] Registering functions on window (PRIMARY)', 'color:#6366f1;font-weight:bold');
  console.log('  analytics.js has loaded and is executing. Registering all functions now…');

  var fnMap = {
    switchPageTab:       switchPageTab,
    loadSummaryData:     loadSummaryData,
    renderSummaryCharts: renderSummaryCharts,
    loadTrendsData:      loadTrendsData,
    onTrendParamChange:  onTrendParamChange,
    onTrendSmoothChange: onTrendSmoothChange,
    resetTrendsZoom:     resetTrendsZoom,
    loadCorrelationData: loadCorrelationData,
    changeChartType:     changeChartType,
    resetZoom:           resetZoom,
    updateAnalytics:     updateAnalytics,
    onParamFilterChange: onParamFilterChange
  };

  var useBridge = typeof window._registerAnalyticsFn === 'function';
  console.log('  Bridge available: ' + (useBridge ? '✅ YES — using _registerAnalyticsFn' : '⚠️ NO — falling back to direct window assignment'));

  Object.keys(fnMap).forEach(function(name) {
    if (useBridge) {
      window._registerAnalyticsFn(name, fnMap[name]);
    } else {
      window[name] = fnMap[name];
      console.log('  ✅ window.' + name + ' = ' + typeof fnMap[name]);
    }
  });

  console.log('%c  All analytics functions registered ✔', 'color:#10b981;font-weight:bold');
  console.groupEnd();
})();

window.addEventListener('load', () => {

  // ── STARTUP DIAGNOSTICS ──────────────────────────────────────────────────
  console.group('[Analytics] Startup diagnostics');

  const requiredIds = [
    'correlationChart', 'forecastContent',
    'correlationInsightsList', 'summaryChartsContainer',
    'tabBtnSummary', 'tabBtnTrends', 'tabBtnCorrelation', 'tabBtnForecast',
    'tabPanelSummary', 'tabPanelTrends', 'tabPanelCorrelation', 'tabPanelForecast',
    'corrTimeRange', 'summaryStartDate', 'summaryEndDate'
  ];
  console.log('  -- DOM elements --');
  requiredIds.forEach(id => {
    const el = document.getElementById(id);
    if (!el) console.error('  MISSING DOM #' + id);
    else     console.log('  OK #' + id);
  });

  const requiredFns = [
    'switchPageTab','loadSummaryData','renderSummaryCharts',
    'loadCorrelationData','changeChartType',
    'resetZoom','updateAnalytics','onParamFilterChange'
  ];
  console.log('  -- window functions (must be reachable from onclick) --');
  requiredFns.forEach(name => {
    if (typeof window[name] === 'function') console.log('  OK window.' + name);
    else console.error('  MISSING window.' + name + ' -- onclick="' + name + '()" will throw ReferenceError');
  });

  console.log('  -- Libraries --');
  if (typeof firebase === 'undefined')      console.error('  MISSING firebase -- no data will load');
  else if (typeof firebase.database !== 'function') console.error('  MISSING firebase.database -- check firebase-database.js is loaded');
  else                                       console.log('  OK firebase');
  if (typeof Chart === 'undefined')         console.error('  MISSING Chart.js -- charts will not render');
  else                                       console.log('  OK Chart.js v' + Chart.version);
  if (typeof ss === 'undefined')            console.error('  MISSING simple-statistics (ss) -- analysis will fail');
  else                                       console.log('  OK simple-statistics');

  console.groupEnd();
  // ── END DIAGNOSTICS ──────────────────────────────────────────────────────

  firebase.database().ref('thresholds')
    .once('value')
    .then(snapshot => {
      console.log('[Analytics] Thresholds fetched OK');
      buildOptimalRangesFromFirebase(snapshot);

      firebase.database().ref('thresholds').on('value', snap => {
        buildOptimalRangesFromFirebase(snap);
        if (correlationData.length > 0) runCorrelationAnalysis();
        if (forecastData.length    > 0) runForecastAnalysis();
      });
    })
    .catch(err => {
      console.warn('[Analytics] Could not load thresholds, using fallback values.', err);
    })
    .finally(() => {
      initializeAnalytics();
      initSummaryDefaults();
      initTrendsDefaults();
    });
});


function initializeAnalytics() {
  // Trends tab intentionally left empty — new chart implementation pending
  loadCorrelationData();
  loadForecastData();
}

// ---------------------------------------------------------------------------
// PER-TAB TIME RANGE READERS
// Each reads only its own dropdown — no shared state.
// ---------------------------------------------------------------------------

function getCorrelationTimeRange() {
  return document.getElementById('corrTimeRange')?.value || '7d';
}

function getForecastTimeRange() {
  return document.getElementById('forecastTimeRange')?.value || '7d';
}

// ---------------------------------------------------------------------------
// LEGACY COMPAT — onTimeRangeChange()
// Kept so any existing HTML onchange="onTimeRangeChange(event)" attributes
// continue to work. Routes to the correct tab loader based on which dropdown
// fired. Does NOT cross-sync dropdowns (that was the old shared-state bug).
// ---------------------------------------------------------------------------

function onTimeRangeChange(e) {
  const id = e?.target?.id || '';
  if (id === 'corrTimeRange')     { loadCorrelationData(); return; }
  if (id === 'forecastTimeRange') { loadForecastData();    return; }
  // Fallback: reload correlation and forecast
  loadCorrelationData();
  loadForecastData();
}

// ---------------------------------------------------------------------------
// LOADING STATE HELPER
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// TEMPLATE HELPERS
// All DOM building goes through HTML <template> elements defined in reports.html.
// No innerHTML, no inline styles — JS only sets textContent and classNames.
// ---------------------------------------------------------------------------

function cloneTemplate(id) {
  return document.getElementById(id).content.cloneNode(true);
}

function clearContainer(id) {
  const el = document.getElementById(id);
  if (el) el.replaceChildren();
  return el;
}

// ---------------------------------------------------------------------------
// LOADING / EMPTY STATE HELPERS
// ---------------------------------------------------------------------------

function showLoadingState(containerId, message) {
  const el = clearContainer(containerId);
  if (!el) return;
  const tpl = cloneTemplate('tpl-loading');
  tpl.querySelector('.tpl-message').textContent = message;
  el.appendChild(tpl);
}

function showNoDataState(containerId, icon, message) {
  const el = clearContainer(containerId);
  if (!el) return;
  const tpl = cloneTemplate('tpl-insight-item');
  tpl.querySelector('.tpl-icon').textContent       = icon;
  tpl.querySelector('.tpl-message').textContent    = message;
  tpl.querySelector('.tpl-severity').textContent   = 'No Data';
  tpl.querySelector('.tpl-severity').classList.add('info');
  tpl.querySelector('.tpl-detail').remove();
  tpl.querySelector('.tpl-timestamp').remove();
  el.appendChild(tpl);
}

function showErrorState(containerId, errorMessage) {
  const el = clearContainer(containerId);
  if (!el) return;
  const tpl = cloneTemplate('tpl-insight-item');
  tpl.querySelector('.tpl-icon').textContent       = '⚠️';
  tpl.querySelector('.tpl-message').textContent    = 'Error loading data: ' + errorMessage;
  tpl.querySelector('.tpl-severity').textContent   = 'Error';
  tpl.querySelector('.tpl-severity').classList.add('danger');
  tpl.querySelector('.tpl-detail').remove();
  tpl.querySelector('.tpl-timestamp').remove();
  el.appendChild(tpl);
}

function showForecastEmpty(containerId, iconClass, title, message) {
  const el = clearContainer(containerId);
  if (!el) return;
  const tpl = cloneTemplate('tpl-forecast-empty');
  tpl.querySelector('.tpl-icon').className  = iconClass;
  tpl.querySelector('.tpl-title').textContent   = title;
  tpl.querySelector('.tpl-message').textContent = message;
  el.appendChild(tpl);
}

// ---------------------------------------------------------------------------
// CANVAS CLEAR HELPER
// Chart.destroy() removes the JS instance but leaves pixels on screen.
// This wipes the canvas so no stale chart is ever visible.
// ---------------------------------------------------------------------------

function clearCanvas(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// ---------------------------------------------------------------------------
// CORRELATION TAB — DATA LOADING
// ---------------------------------------------------------------------------

function loadCorrelationData() {
  const timeRange = getCorrelationTimeRange();
  const hours     = TIME_RANGE_HOURS[timeRange] ?? 168;
  const startTime = Date.now() - hours * 3_600_000;

  console.log(`[Correlation] Loading | range: ${timeRange} | from: ${new Date(startTime).toLocaleString()}`);

  // Immediately wipe all correlation charts before fetching
  if (correlationChartInst) { correlationChartInst.destroy(); correlationChartInst = null; }
  clearCanvas('correlationChart');

  showLoadingState('correlationInsightsList', 'Analyzing correlations…');

  fetchFilteredHistory(startTime)
    .then(rows => {
      correlationData = rows;

      console.log(`[Correlation] ${rows.length} records loaded`);

      if (rows.length === 0) {
        showNoDataState('correlationInsightsList', '🔗', 'No data available for the selected time range.');
        if (correlationChartInst) { correlationChartInst.destroy(); correlationChartInst = null; }
        return;
      }

      runCorrelationAnalysis();
      createCorrelationCharts();
    })
    .catch(err => {
      console.error('[Correlation] Firebase error:', err);
      showNoDataState('correlationInsightsList', '⚠️', `Error loading data: ${err.message}`);
    });
}

// ---------------------------------------------------------------------------
// FORECAST TAB — DATA LOADING
// ---------------------------------------------------------------------------

function loadForecastData() {
  const timeRange = getForecastTimeRange();
  const hours     = TIME_RANGE_HOURS[timeRange] ?? 168;
  const startTime = Date.now() - hours * 3_600_000;

  console.log(`[Forecast] Loading | range: ${timeRange} | from: ${new Date(startTime).toLocaleString()}`);

  // Immediately wipe forecast content before fetching
  clearContainer('forecastContent');

  showLoadingState('forecastContent', 'Loading forecast data…');

  fetchFilteredHistory(startTime)
    .then(rows => {
      forecastData = rows;

      console.log(`[Forecast] ${rows.length} records loaded`);

      if (rows.length === 0) {
        showForecastEmpty('forecastContent', 'fas fa-database', 'No Data Available', 'No data found for the selected time range.');
        return;
      }

      runForecastAnalysis();
    })
    .catch(err => {
      console.error('[Forecast] Firebase error:', err);
      showForecastEmpty('forecastContent', 'fas fa-exclamation-triangle', 'Error Loading Data', err.message);
    });
}

// ---------------------------------------------------------------------------
// LEGACY COMPAT — loadAnalyticsData() now loads correlation and forecast only
// ---------------------------------------------------------------------------

function loadAnalyticsData() {
  loadCorrelationData();
  loadForecastData();
}

// ---------------------------------------------------------------------------
// TRENDS TAB — WaterQ_history chart
// ---------------------------------------------------------------------------

let trendsChartInst = null;
let trendsData      = [];

const TREND_PARAM_CONFIG = {
  do:          { label: 'DO',          unit: 'mg/L', color: '#0ea5e9', yAxis: 'y'  },
  ph:          { label: 'pH',          unit: '',     color: '#10b981', yAxis: 'y1' },
  salinity:    { label: 'Salinity',    unit: 'ppt',  color: '#ef4444', yAxis: 'y2' },
  turbidity:   { label: 'Turbidity',   unit: 'NTU',  color: '#8b5cf6', yAxis: 'y3' },
  temperature: { label: 'Temperature', unit: '°C',   color: '#f59e0b', yAxis: 'y4' }
};

function initTrendsDefaults() {
  const today   = new Date();
  const weekAgo = new Date(today);
  weekAgo.setDate(today.getDate() - 6);
  const fmt = d => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  const sd = document.getElementById('trendsStartDate');
  const ed = document.getElementById('trendsEndDate');
  if (sd && !sd.value) sd.value = fmt(weekAgo);
  if (ed && !ed.value) ed.value = fmt(today);
}

function showTrendsStatus(message, type) {
  const el = document.getElementById('trendsStatusMsg');
  if (!el) return;
  el.className = 'summary-status-info';
  if (type === 'warn') el.classList.add('summary-status-warn');
  el.textContent = message;
  el.style.display = 'flex';
}

function hideTrendsStatus() {
  const el = document.getElementById('trendsStatusMsg');
  if (el) el.style.display = 'none';
}

function getTrendActiveParams() {
  return Object.keys(TREND_PARAM_CONFIG).filter(p => {
    const idMap = {
      do: 'trendParamDO', ph: 'trendParamPH',
      salinity: 'trendParamSalinity', turbidity: 'trendParamTurbidity',
      temperature: 'trendParamTemperature'
    };
    const el = document.getElementById(idMap[p]);
    return !el || el.checked;
  });
}

function loadTrendsData() {
  const startDateVal = document.getElementById('trendsStartDate')?.value;
  const startTimeVal = document.getElementById('trendsStartTime')?.value;
  const endDateVal   = document.getElementById('trendsEndDate')?.value;
  const endTimeVal   = document.getElementById('trendsEndTime')?.value;

  if (!startDateVal || !endDateVal) {
    showTrendsStatus('Please select a start and end date.', 'warn');
    return;
  }

  // Build timestamps using local time
  const [sy, sm, sd_] = startDateVal.split('-').map(Number);
  const [sh, smin]    = (startTimeVal || '00:00').split(':').map(Number);
  const startTs       = new Date(sy, sm - 1, sd_, sh, smin, 0, 0).getTime();

  const [ey, em, ed_] = endDateVal.split('-').map(Number);
  const [eh, emin]    = (endTimeVal || '23:59').split(':').map(Number);
  const endTs         = new Date(ey, em - 1, ed_, eh, emin, 59, 999).getTime();

  if (startTs > endTs) {
    showTrendsStatus('Start date/time must be before end date/time.', 'warn');
    return;
  }

  hideTrendsStatus();

  // Show loading state
  const placeholder = document.getElementById('trendsPlaceholder');
  const canvas      = document.getElementById('trendsChart');
  if (placeholder) {
    placeholder.innerHTML = '<div class="loading-spinner"></div><p>Loading data from Firebase…</p>';
    placeholder.style.display = 'flex';
  }
  if (canvas) canvas.style.display = 'none';

  // Destroy old chart
  if (trendsChartInst) { trendsChartInst.destroy(); trendsChartInst = null; }

  console.log(`[Trends] Loading | from: ${new Date(startTs).toLocaleString()} | to: ${new Date(endTs).toLocaleString()}`);

  firebase.database().ref('WaterQ_history')
    .once('value')
    .then(snapshot => {
      const rows = [];
      let totalSeen = 0, skipped = 0;

      snapshot.forEach(child => {
        totalSeen++;
        const d  = child.val();
        const ts = normaliseTimestamp(d.timestamp);
        if (isNaN(ts)) { skipped++; return; }
        if (ts < startTs || ts > endTs) { skipped++; return; }
        if (d.DO === undefined || d.pH === undefined ||
            d.Sal === undefined || d.Turb === undefined || d.Temp === undefined) {
          skipped++; return;
        }
        rows.push({
          timestamp:   new Date(ts),
          do:          parseFloat(d.DO),
          ph:          parseFloat(d.pH),
          salinity:    parseFloat(d.Sal),
          turbidity:   parseFloat(d.Turb),
          temperature: parseFloat(d.Temp)
        });
      });

      rows.sort((a, b) => a.timestamp - b.timestamp);

      console.log(`[Trends] total=${totalSeen} | passed=${rows.length} | skipped=${skipped}`);

      trendsData = rows;

      if (rows.length === 0) {
        if (placeholder) {
          placeholder.innerHTML =
            '<i class="fas fa-inbox" style="font-size:2rem;color:#cbd5e1;margin-bottom:0.5rem;"></i>' +
            '<p style="color:#94a3b8;">No readings found for the selected date range.</p>';
          placeholder.style.display = 'flex';
        }
        if (canvas) canvas.style.display = 'none';
        return;
      }

      // Update subtitle
      const subtitle = document.getElementById('trendsChartSubtitle');
      if (subtitle) {
        subtitle.textContent = `${rows.length.toLocaleString()} readings · ` +
          `${rows[0].timestamp.toLocaleDateString()} – ${rows[rows.length - 1].timestamp.toLocaleDateString()}`;
      }

      renderTrendsChart();
    })
    .catch(err => {
      console.error('[Trends] Firebase error:', err);
      if (placeholder) {
        placeholder.innerHTML =
          '<i class="fas fa-exclamation-triangle" style="font-size:2rem;color:#f87171;margin-bottom:0.5rem;"></i>' +
          `<p style="color:#94a3b8;">Error loading data: ${err.message}</p>`;
        placeholder.style.display = 'flex';
      }
    });
}

function renderTrendsChart() {
  const canvas = document.getElementById('trendsChart');
  const placeholder = document.getElementById('trendsPlaceholder');
  if (!canvas || trendsData.length === 0) return;

  if (trendsChartInst) { trendsChartInst.destroy(); trendsChartInst = null; }

  const isSmooth     = document.getElementById('trendSmoothToggle')?.checked ?? true;
  const activeParams = getTrendActiveParams();

  // Downsample for performance
  const plotData = downsample(trendsData, 400);

  // Build time labels
  const spanMs   = plotData[plotData.length - 1].timestamp - plotData[0].timestamp;
  const spanDays = spanMs / 86_400_000;
  const labelOpts = spanDays <= 1
    ? { hour: '2-digit', minute: '2-digit', hour12: true }
    : spanDays <= 8
      ? { month: 'short', day: 'numeric', hour: '2-digit', hour12: true }
      : spanDays <= 32
        ? { month: 'short', day: 'numeric' }
        : { month: 'short', day: 'numeric', year: '2-digit' };
  const labels = plotData.map(d => d.timestamp.toLocaleString('en-US', labelOpts));

  // Build datasets
  const datasets = Object.entries(TREND_PARAM_CONFIG).map(([key, cfg]) => {
    const raw    = plotData.map(d => d[key]);
    const data   = isSmooth ? movingAverage(raw, SMOOTH_WINDOW) : raw;
    return {
      label:            `${cfg.label}${cfg.unit ? ' (' + cfg.unit + ')' : ''}`,
      data,
      borderColor:      cfg.color,
      backgroundColor:  cfg.color + '14',
      borderWidth:      2,
      pointRadius:      0,
      pointHoverRadius: 4,
      tension:          isSmooth ? 0.4 : 0.1,
      fill:             false,
      yAxisID:          cfg.yAxis,
      paramKey:         key,
      hidden:           !activeParams.includes(key)
    };
  });



  // Build scales — one per parameter
  const scales = {
    x: { grid: { display: false }, ticks: { maxRotation: 45, minRotation: 45, font: { family: 'Inter', size: 10 } } }
  };
  const axisPositions = { y: 'left', y1: 'left', y2: 'right', y3: 'right', y4: 'right' };
  const axisOffsets   = { y: false, y1: false, y2: false, y3: true, y4: true };
  const axisOffsetPx  = { y: 0, y1: 0, y2: 0, y3: 60, y4: 120 };

  Object.entries(TREND_PARAM_CONFIG).forEach(([key, cfg]) => {
    const visible = activeParams.includes(key);
    scales[cfg.yAxis] = {
      type:     'linear',
      display:  visible,
      position: axisPositions[cfg.yAxis],
      offset:   axisOffsets[cfg.yAxis],
      ticks:    { color: cfg.color, font: { family: 'Inter', size: 10 } },
      grid:     cfg.yAxis === 'y' ? { color: 'rgba(226,232,240,0.5)' } : { drawOnChartArea: false },
      title:    { display: visible, text: cfg.unit ? `${cfg.label} (${cfg.unit})` : cfg.label, color: cfg.color, font: { family: 'Inter', size: 11, weight: '600' } }
    };
    if (axisOffsets[cfg.yAxis]) scales[cfg.yAxis].ticks.padding = axisOffsetPx[cfg.yAxis] - 60;
  });

  // Show canvas, hide placeholder
  if (placeholder) placeholder.style.display = 'none';
  canvas.style.display = 'block';

  const resetBtn = document.getElementById('trendsResetZoomBtn');
  if (resetBtn) resetBtn.style.display = '';

  trendsChartInst = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive:          true,
      maintainAspectRatio: true,
      aspectRatio:         2.4,
      animation:           { duration: 350 },
      interaction:         { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'bottom',
          onClick:  () => {},
          labels: {
            usePointStyle: false,
            boxWidth:  14,
            boxHeight: 14,
            padding:   18,
            font:      { family: 'Inter', size: 12 },
            generateLabels: chart => chart.data.datasets
              .map((ds, i) => ({
                text:        ds.label,
                fillStyle:   ds.borderColor,
                strokeStyle: ds.borderColor,
                hidden:      ds.hidden,
                datasetIndex: i
              }))
              .filter((_, i) => !chart.data.datasets[i].hidden),
            filter: (item, data) => !data.datasets[item.datasetIndex].hidden
          }
        },
        tooltip: {
          backgroundColor: 'rgba(15,23,42,0.93)',
          padding:         12,
          titleFont:       { family: 'Inter', size: 13, weight: '600' },
          bodyFont:        { family: 'Inter', size: 12 },
          callbacks: {
            label: ctx => {
              const cfg = Object.values(TREND_PARAM_CONFIG)[ctx.datasetIndex];
              return `${ctx.dataset.label.split(' (')[0]}: ${ctx.parsed.y.toFixed(2)}${cfg?.unit ? ' ' + cfg.unit : ''}`;
            }
          }
        },
        annotation: {},
        zoom: {
          pan:    { enabled: true, mode: 'x', modifierKey: null },
          zoom:   { wheel: { enabled: true, speed: 0.1 }, pinch: { enabled: true }, mode: 'x' },
          limits: { x: { min: 'original', max: 'original' } }
        }
      },
      scales
    }
  });
}

function onTrendParamChange() {
  if (!trendsChartInst) return;
  const active = getTrendActiveParams();
  const axisMap = {};
  Object.entries(TREND_PARAM_CONFIG).forEach(([key, cfg]) => { axisMap[key] = cfg.yAxis; });

  trendsChartInst.data.datasets.forEach(ds => {
    ds.hidden = !active.includes(ds.paramKey);
  });

  // Toggle axes and annotation lines
  Object.entries(TREND_PARAM_CONFIG).forEach(([key, cfg]) => {
    const axis = trendsChartInst.options.scales[cfg.yAxis];
    if (axis) {
      axis.display = active.includes(key);
      axis.title   = { ...axis.title, display: active.includes(key) };
    }
  });

  trendsChartInst.update('none');
}

function onTrendSmoothChange() {
  if (trendsData.length > 0) renderTrendsChart();
}

function resetTrendsZoom() {
  trendsChartInst?.resetZoom?.();
}


// ---------------------------------------------------------------------------
// DATA SMOOTHING
// ---------------------------------------------------------------------------

function movingAverage(values, window = SMOOTH_WINDOW) {
  if (window <= 1 || values.length < window) return values;
  const half   = Math.floor(window / 2);
  const result = [];
  for (let i = 0; i < values.length; i++) {
    const lo  = Math.max(0, i - half);
    const hi  = Math.min(values.length - 1, i + half);
    const sum = values.slice(lo, hi + 1).reduce((a, b) => a + b, 0);
    result.push(sum / (hi - lo + 1));
  }
  return result;
}

// ---------------------------------------------------------------------------
// PARAMETER FILTER HELPERS
// ---------------------------------------------------------------------------

const PARAM_CHECKBOX_IDS = {
  do:          'paramDO',
  salinity:    'paramSalinity',
  temperature: 'paramTemperature',
  ph:          'paramPH',
  turbidity:   'paramTurbidity'
};

function getActiveParams() {
  const active = [];
  Object.entries(PARAM_CHECKBOX_IDS).forEach(([param, id]) => {
    const el = document.getElementById(id);
    if (!el || el.checked) active.push(param);
  });
  return active;
}

function onParamFilterChange() {
  if (correlationData.length === 0) return;
  const activeParams = getActiveParams();

  // Toggle dataset visibility and corresponding y-axis — no rebuild, no flicker
  if (correlationChartInst) {
    // Map each paramKey to its yAxisID
    const axisMap = { do:'y', salinity:'y1', temperature:'y2', ph:'y3', turbidity:'y4' };

    correlationChartInst.data.datasets.forEach(ds => {
      ds.hidden = !activeParams.includes(ds.paramKey);
    });

    // Show/hide each y-axis based on whether its parameter is active.
    // For the DO axis (y, left side): keep the border/grid visible but hide
    // ticks and title so there's no hanging line when DO is deselected.
    Object.entries(axisMap).forEach(([param, axisId]) => {
      const axis = correlationChartInst.options.scales[axisId];
      if (!axis) return;
      const visible = activeParams.includes(param);
      if (axisId === 'y') {
        // Always keep left axis present to anchor the chart border
        axis.display   = true;
        axis.ticks     = { ...axis.ticks,  display: visible };
        axis.title     = { ...axis.title,  display: visible };
        axis.grid      = visible
          ? { color: 'rgba(226,232,240,0.5)' }
          : { color: 'rgba(226,232,240,0.5)', drawTicks: false };
      } else {
        axis.display = visible;
      }
    });

    correlationChartInst.update('none');
  }

  const correlationInsights = analyzeSensorCorrelations(activeParams);
  displayCorrelationInsights(correlationInsights, activeParams);
}



// ---------------------------------------------------------------------------
// CORRELATION ANALYSIS
// ---------------------------------------------------------------------------

function runCorrelationAnalysis() {
  const activeParams        = getActiveParams();
  const correlationInsights = analyzeSensorCorrelations(activeParams);
  displayCorrelationInsights(correlationInsights, activeParams);
}

// ---------------------------------------------------------------------------
// FORECAST ANALYSIS
// ---------------------------------------------------------------------------

function runForecastAnalysis() {
  const forecastInsights = generatePredictions(forecastData, getForecastTimeRange());
  displayForecastInsights(forecastInsights);
}

// ---------------------------------------------------------------------------
// LEGACY runStatisticalAnalysis() — runs correlation and forecast independently
// ---------------------------------------------------------------------------

function runStatisticalAnalysis() {
  if (correlationData.length > 0) runCorrelationAnalysis();
  if (forecastData.length    > 0) runForecastAnalysis();
}


function analyzeSensorCorrelations(activeParams) {
  // Uses correlationData (Correlation tab's own dataset)
  const data      = correlationData;
  const insights  = [];
  const threshold = parseFloat(document.getElementById('correlationThreshold')?.value || 0.5);
  if (!activeParams) activeParams = Object.keys(OPTIMAL_RANGES);
  if (!data || data.length === 0) return insights;

  const sensorPairs = [
    { param1:'temperature', param2:'do',        positiveExplanation:'When water temperature rises, dissolved oxygen levels also increase',   negativeExplanation:'When water temperature rises, dissolved oxygen levels decrease',   positiveImpact:'Unusual for this pair — monitor closely as aerator activity or algae photosynthesis may be elevating DO despite warming water', negativeImpact:'This is critical for fish health — warm water naturally holds less dissolved oxygen'       },
    { param1:'salinity',    param2:'do',        positiveExplanation:'Higher salinity correlates with higher dissolved oxygen',               negativeExplanation:'Higher salinity correlates with lower dissolved oxygen',               positiveImpact:'Unusual pattern — biological activity or aeration may be compensating for salt-induced oxygen reduction',              negativeImpact:'Salt water holds less oxygen — high salinity can reduce oxygen availability for fish'    },
    { param1:'ph',          param2:'do',        positiveExplanation:'Higher pH correlates with higher dissolved oxygen',                     negativeExplanation:'Higher pH correlates with lower dissolved oxygen',                     positiveImpact:'Likely driven by algae photosynthesis — algae consume CO₂ (raising pH) and produce oxygen simultaneously',          negativeImpact:'May indicate decomposition activity — organic breakdown can lower both pH and oxygen levels' },
    { param1:'turbidity',   param2:'do',        positiveExplanation:'Cloudier water correlates with higher dissolved oxygen',               negativeExplanation:'Cloudier water correlates with lower dissolved oxygen',               positiveImpact:'Suspended algae or plankton may be producing oxygen through photosynthesis',                                         negativeImpact:'High turbidity may be blocking sunlight, reducing photosynthesis and depleting oxygen'  },
    { param1:'temperature', param2:'ph',        positiveExplanation:'Higher temperatures correlate with higher pH',                         negativeExplanation:'Higher temperatures correlate with lower pH',                         positiveImpact:'Warm water can accelerate algae photosynthesis, which consumes CO₂ and raises pH',                                  negativeImpact:'Warmer water speeds up decomposition, producing CO₂ and lowering pH'                    },
    { param1:'temperature', param2:'salinity',  positiveExplanation:'Warmer water correlates with higher salinity',                         negativeExplanation:'Warmer water correlates with lower salinity',                         positiveImpact:'Evaporation in warmer conditions may be concentrating salt levels',                                                  negativeImpact:'Could indicate freshwater inflow or rainfall diluting salinity as temperatures drop'     },
    { param1:'temperature', param2:'turbidity', positiveExplanation:'Higher temperatures correlate with cloudier water',                    negativeExplanation:'Higher temperatures correlate with clearer water',                    positiveImpact:'Warm water promotes algae and plankton growth, increasing water cloudiness',                                         negativeImpact:'May indicate sediment settling or reduced biological activity in cooler periods'         },
    { param1:'salinity',    param2:'ph',        positiveExplanation:'Higher salinity correlates with higher pH',                            negativeExplanation:'Higher salinity correlates with lower pH',                            positiveImpact:'Saltwater buffering capacity can help maintain or raise alkalinity',                                                 negativeImpact:'High salt concentrations may introduce acidic ions that lower pH'                        },
    { param1:'salinity',    param2:'turbidity', positiveExplanation:'Higher salinity correlates with cloudier water',                       negativeExplanation:'Higher salinity correlates with clearer water',                       positiveImpact:'Salt may be causing flocculation, clumping particles and increasing cloudiness',                                     negativeImpact:'Higher salinity may be causing particles to settle, improving water clarity'             },
    { param1:'ph',          param2:'turbidity', positiveExplanation:'Higher pH correlates with cloudier water',                             negativeExplanation:'Higher pH correlates with clearer water',                             positiveImpact:'Algae blooms raise pH through photosynthesis while also increasing turbidity',                                       negativeImpact:'Clear, alkaline water may indicate low biological activity and good filtration'           }
  ];

  sensorPairs.forEach(pair => {
    if (!activeParams.includes(pair.param1) || !activeParams.includes(pair.param2)) return;

    const values1     = data.map(d => d[pair.param1]);
    const values2     = data.map(d => d[pair.param2]);
    const correlation = ss.sampleCorrelation(values1, values2);

    if (Math.abs(correlation) > threshold) {
      const cv1 = (ss.standardDeviation(values1) / ss.mean(values1)) * 100;
      const cv2 = (ss.standardDeviation(values2) / ss.mean(values2)) * 100;
      if (cv1 < 2 || cv2 < 2) return;

      const strength   = Math.abs(correlation) > 0.8 ? 'Very Strong'
                       : Math.abs(correlation) > 0.7 ? 'Strong'
                       : Math.abs(correlation) > 0.5 ? 'Moderate'
                       : 'Weak';
      const percentage = Math.abs(correlation * 100).toFixed(0);
      const direction  = correlation > 0 ? 'positive' : 'inverse';
      const message    = correlation > 0
        ? `${strength} relationship: ${pair.positiveExplanation}`
        : `${strength} relationship: ${pair.negativeExplanation}`;

      let detail = `${percentage}% ${direction} correlation. ${correlation > 0 ? pair.positiveImpact : pair.negativeImpact}`;
      if (cv1 < 5 || cv2 < 5) {
        const lowVarParam = cv1 < cv2 ? OPTIMAL_RANGES[pair.param1].label : OPTIMAL_RANGES[pair.param2].label;
        detail += ` Note: ${lowVarParam} has limited variation in this period, which may affect accuracy.`;
      }

      insights.push({
        type:             'correlation',
        icon:             '🔗',
        message,
        severity:         'info',
        detail,
        correlationValue: Math.abs(correlation),
        insightType:      'correlation'
      });
    }
  });

  return insights.sort((a, b) => b.correlationValue - a.correlationValue);
}

function generatePredictions(data, timeRange) {
  // Uses the passed-in data (forecastData)
  if (!data) data = forecastData;
  const insights          = [];
  const hoursAhead        = parseInt(document.getElementById('predictionWindow')?.value || 6);
  const dataRangeHours    = TIME_RANGE_HOURS[timeRange] ?? 168;
  const minimumDataPoints = Math.min(24, dataRangeHours);

  if (data.length < minimumDataPoints) {
    return [{
      type:     'info',
      icon:     'ℹ️',
      message:  `Need at least ${minimumDataPoints} data points for predictions. Currently have ${data.length}.`,
      severity: 'info',
      detail:   'Predictions will become available as more data is collected.',
      priority: 3
    }];
  }

  Object.keys(OPTIMAL_RANGES).forEach(param => {
    const dataPointsToUse = Math.min(data.length, dataRangeHours);
    const recent          = data.slice(-dataPointsToUse);
    const values          = recent.map((d, i) => [i, d[param]]);
    const regression      = ss.linearRegression(values);
    const futureIndex     = values.length + (hoursAhead * (values.length / dataRangeHours));
    const predictedValue  = regression.m * futureIndex + regression.b;
    const config          = OPTIMAL_RANGES[param];
    const currentValue    = data[data.length - 1][param];
    const change          = predictedValue - currentValue;
    const percentChange   = Math.abs((change / currentValue) * 100);
    const residuals       = values.map(p => Math.abs(p[1] - (regression.m * p[0] + regression.b)));
    const avgError        = ss.mean(residuals);
    const confidence      = Math.max(0, Math.min(100, 100 - (avgError / currentValue * 100)));
    const accuracyNote    = hoursAhead <= 6  ? `High confidence`
                          : hoursAhead <= 12 ? `Medium confidence`
                          : `Lower confidence — longer forecasts are less certain`;

    if (Math.abs(regression.m) > 0.005 || predictedValue < config.critical || predictedValue > config.critical * 1.5) {
      if (predictedValue < config.critical || predictedValue > config.critical * 1.5) {
        insights.push({ type:'prediction-critical', icon:'🚨', message:`CRITICAL: ${config.label} forecasted to reach ${predictedValue.toFixed(1)} ${config.unit} in ${hoursAhead}h`, severity:'danger',  detail:`${change > 0 ? 'Increasing' : 'Decreasing'} and may become dangerous for fish.`, priority:1 });
      } else if (predictedValue < config.min || predictedValue > config.max) {
        insights.push({ type:'prediction-warning',  icon:'⚠️', message:`${config.label} expected to reach ${predictedValue.toFixed(1)} ${config.unit} in ${hoursAhead}h`, severity:'warning', detail:`Trending ${change > 0 ? 'upward' : 'downward'} and may leave optimal range.`, priority:2 });
      } else if (percentChange > 3) {
        insights.push({ type:'prediction-info',     icon:'🔮', message:`${config.label} forecasted to ${change > 0 ? 'increase' : 'decrease'} to ${predictedValue.toFixed(1)} ${config.unit} in ${hoursAhead}h`, severity:'info', detail:`A ${percentChange.toFixed(1)}% ${change > 0 ? 'increase' : 'decrease'} from current level. Expected to remain within optimal range.`, priority:3 });
      }
    }
  });

  return insights.sort((a, b) => (a.priority || 999) - (b.priority || 999));
}

// ---------------------------------------------------------------------------
// DISPLAY — Correlation tab
// ---------------------------------------------------------------------------

function displayCorrelationInsights(insights, activeParams) {
  const list = document.getElementById('correlationInsightsList');
  if (!list) return;

  const paramLabels   = activeParams.map(p => OPTIMAL_RANGES[p].label);
  const selectionNote = activeParams.length === Object.keys(OPTIMAL_RANGES).length
    ? 'All parameters selected'
    : 'Showing: ' + paramLabels.join(', ');

  list.replaceChildren();

  if (insights.length === 0) {
    const noteTpl = cloneTemplate('tpl-corr-note');
    noteTpl.querySelector('.tpl-note').textContent = '🔍 ' + selectionNote;
    list.appendChild(noteTpl);

    const itemTpl = cloneTemplate('tpl-insight-item');
    itemTpl.querySelector('.tpl-icon').textContent    = '🔗';
    itemTpl.querySelector('.tpl-message').textContent = activeParams.length < 2
      ? 'Select at least 2 parameters to see correlation insights.'
      : 'No significant correlations detected between the selected parameters.';
    itemTpl.querySelector('.tpl-severity').textContent = 'No Correlations';
    itemTpl.querySelector('.tpl-severity').classList.add('info');
    itemTpl.querySelector('.tpl-detail').remove();
    itemTpl.querySelector('.tpl-timestamp').remove();
    list.appendChild(itemTpl);
    return;
  }

  const barTpl = cloneTemplate('tpl-corr-found-bar');
  barTpl.querySelector('.tpl-count').textContent = `🔗 ${insights.length} correlation${insights.length !== 1 ? 's' : ''} found`;
  barTpl.querySelector('.tpl-note').textContent  = selectionNote;
  list.appendChild(barTpl);

  insights.forEach(insight => {
    const tpl = cloneTemplate('tpl-insight-item');
    tpl.querySelector('.tpl-icon').textContent    = insight.icon;
    tpl.querySelector('.tpl-message').textContent = insight.message;
    const sev = tpl.querySelector('.tpl-severity');
    sev.textContent = insight.severity;
    sev.classList.add(insight.severity);

    const detailEl = tpl.querySelector('.tpl-detail');
    if (insight.detail) {
      detailEl.textContent = insight.detail;
    } else {
      detailEl.remove();
    }
    tpl.querySelector('.tpl-timestamp').remove();
    list.appendChild(tpl);
  });
}

// ---------------------------------------------------------------------------
// DISPLAY — Forecast tab
// ---------------------------------------------------------------------------

function displayForecastInsights(insights) {
  const forecastContent = document.getElementById('forecastContent');
  const forecastBadge   = document.getElementById('forecastBadge');

  if (!forecastContent) return;

  if (forecastBadge) {
    const dangerCount  = insights.filter(i => i.severity === 'danger').length;
    const warningCount = insights.filter(i => i.severity === 'warning').length;
    forecastBadge.textContent = insights.length;
    forecastBadge.className   = 'tab-badge';
    if (dangerCount > 0)       forecastBadge.classList.add('badge-danger');
    else if (warningCount > 0) forecastBadge.classList.add('badge-warning');
  }

  forecastContent.replaceChildren();

  if (insights.length === 0) {
    const tpl = cloneTemplate('tpl-forecast-empty');
    tpl.querySelector('.tpl-icon').className    = 'fas fa-check-circle forecast-allclear-icon';
    tpl.querySelector('.tpl-title').textContent   = 'No Forecasted Issues';
    tpl.querySelector('.tpl-message').textContent = 'All parameters are predicted to remain stable within their optimal ranges.';
    forecastContent.appendChild(tpl);
    return;
  }

  const hoursAhead = document.getElementById('predictionWindow')?.value || 6;
  const groups = {
    danger:  insights.filter(i => i.severity === 'danger'),
    warning: insights.filter(i => i.severity === 'warning'),
    info:    insights.filter(i => i.severity === 'info')
  };

  if (groups.danger.length)  forecastContent.appendChild(buildForecastSection('danger',  `Critical Alerts — Forecasted in ${hoursAhead}h (dangerous levels)`,    'fa-skull-crossbones',     groups.danger));
  if (groups.warning.length) forecastContent.appendChild(buildForecastSection('warning', `Warnings — Forecasted in ${hoursAhead}h (may leave optimal range)`,     'fa-exclamation-triangle', groups.warning));
  if (groups.info.length)    forecastContent.appendChild(buildForecastSection('info',    `Informational — Forecasted in ${hoursAhead}h (within safe range)`,       'fa-info-circle',          groups.info));
}

function buildForecastSection(severity, title, faIcon, items) {
  const tpl      = cloneTemplate('tpl-forecast-section');
  const labelEl  = tpl.querySelector('.tpl-label');
  labelEl.classList.add(`label-${severity === 'danger' ? 'critical' : severity}`);
  tpl.querySelector('.tpl-icon').classList.add(faIcon);
  tpl.querySelector('.tpl-title').textContent = title;
  const cardsEl = tpl.querySelector('.tpl-cards');
  items.forEach(insight => cardsEl.appendChild(buildForecastCard(insight)));
  // Unwrap the DocumentFragment's first element for appendChild
  return tpl.querySelector('.forecast-severity-section');
}

function buildForecastCard(insight) {
  const tpl  = cloneTemplate('tpl-forecast-card');
  const card = tpl.querySelector('.tpl-card-severity');
  card.classList.add(`forecast-card-${insight.severity}`);

  const iconEl = tpl.querySelector('.tpl-icon');
  iconEl.textContent = insight.icon;
  iconEl.classList.add(`forecast-icon-${insight.severity}`);

  tpl.querySelector('.tpl-message').textContent = insight.message;

  const sev = tpl.querySelector('.tpl-severity');
  sev.textContent = insight.severity;
  sev.classList.add(insight.severity);

  const detailEl = tpl.querySelector('.tpl-detail');
  if (insight.detail) {
    detailEl.textContent = insight.detail;
  } else {
    detailEl.remove();
  }

  return tpl.querySelector('.insight-item');
}

// Keep renderForecastSection / renderForecastCard as aliases for legacy callers
function renderForecastSection(severity, title, faIcon, items) {
  return buildForecastSection(severity, title, faIcon, items).outerHTML;
}
function renderForecastCard(insight) {
  return buildForecastCard(insight).outerHTML;
}

// ---------------------------------------------------------------------------
// LEGACY COMPAT
// ---------------------------------------------------------------------------

function displayInsights(insights) {
  const forecastTypes       = ['prediction-critical', 'prediction-warning', 'prediction-info', 'info'];
  const correlationInsights = insights.filter(i => i.insightType === 'correlation');
  const forecastInsights    = insights.filter(i =>  forecastTypes.includes(i.type));
  displayCorrelationInsights(correlationInsights, getActiveParams());
  displayForecastInsights(forecastInsights);
}

// ---------------------------------------------------------------------------
// SHARED CHART HELPERS
// (buildTimeLabels and downsample kept — used by correlation chart)
// ---------------------------------------------------------------------------

function buildTimeLabels(data, timeRange) {
  const opts = timeRange === '24h'
    ? { hour: '2-digit', minute: '2-digit', hour12: true }
    : timeRange === '7d'
      ? { month: 'short', day: 'numeric', hour: '2-digit', hour12: true }
      : timeRange === '30d'
        ? { month: 'short', day: 'numeric' }
        : { month: 'short', day: 'numeric', year: '2-digit' };
  return data.map(d => d.timestamp.toLocaleString('en-US', opts));
}

function downsample(data, targetPoints = 200) {
  if (data.length <= targetPoints) return data;
  const step = Math.ceil(data.length / targetPoints);
  return data.filter((_, i) => i % step === 0);
}

// ---------------------------------------------------------------------------
// CHART — Correlation
// Explicitly uses correlationData.
// ---------------------------------------------------------------------------

function createCorrelationCharts() {
  createCorrelationChart(getActiveParams());
}

function createCorrelationChart(activeParams) {
  if (!activeParams) activeParams = getActiveParams();

  const timeRange  = getCorrelationTimeRange();
  const hours      = TIME_RANGE_HOURS[timeRange] ?? 168;
  const labelText  = { '24h':'Last 24 Hours', '7d':'Last 7 Days', '30d':'Last 30 Days', '90d':'Last 90 Days' }[timeRange] ?? `Last ${timeRange}`;

  // Update heading and ensure section is visible before touching canvas
  const titleEl = document.getElementById('corrChartTitle');
  if (titleEl) titleEl.textContent = labelText;

  const section = document.getElementById('sectionCorr');
  if (section) section.style.display = '';

  const canvas = document.getElementById('correlationChart');
  if (!canvas) { console.error('Canvas correlationChart not found'); return; }
  const ctx = canvas.getContext('2d');
  if (!ctx)  { console.error('Could not get context for correlationChart'); return; }

  // Destroy previous instance
  if (correlationChartInst) { correlationChartInst.destroy(); correlationChartInst = null; }

  // Anchor cutoff to latest record so old datasets still render
  const latestTime = correlationData.length > 0
    ? Math.max(...correlationData.map(d => d.timestamp.getTime()))
    : Date.now();
  const cutoff     = latestTime - hours * 3_600_000;
  const windowData = correlationData.filter(d => d.timestamp.getTime() >= cutoff);


  const plotData = downsample(windowData, 300);
  const labels   = buildTimeLabels(plotData, timeRange);

  const smooth = param => movingAverage(plotData.map(d => d[param]), 3);

  const allDatasets = [
    { paramKey:'do',          label:'DO',          data:smooth('do'),          borderColor:'#0ea5e9', yAxisID:'y'  },
    { paramKey:'salinity',    label:'Salinity',    data:smooth('salinity'),    borderColor:'#ef4444', yAxisID:'y1' },
    { paramKey:'temperature', label:'Temperature', data:smooth('temperature'), borderColor:'#f59e0b', yAxisID:'y2' },
    { paramKey:'ph',          label:'pH',          data:smooth('ph'),          borderColor:'#10b981', yAxisID:'y3' },
    { paramKey:'turbidity',   label:'Turbidity',   data:smooth('turbidity'),   borderColor:'#8b5cf6', yAxisID:'y4' }
  ];

  const datasets = allDatasets.map(ds => ({
    paramKey:         ds.paramKey,
    label:            ds.label,
    data:             ds.data,
    borderColor:      ds.borderColor,
    backgroundColor:  ds.borderColor.replace(')', ', 0.08)').replace('rgb', 'rgba'),
    borderWidth:      2,
    pointRadius:      0,
    pointHoverRadius: 4,
    tension:          0.3,
    yAxisID:          ds.yAxisID,
    hidden:           !activeParams.includes(ds.paramKey)
  }));

  correlationChartInst = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive:          true,
      maintainAspectRatio: true,
      aspectRatio:         2.2,
      animation:           { duration: 300 },
      interaction:         { mode:'index', intersect:false },
      plugins: {
        legend: {
          position: 'bottom',
          onClick:  () => {},   // disable click-to-toggle; use parameter pills instead
          labels:   {
            usePointStyle:  false,
            boxWidth:       14,
            boxHeight:      14,
            padding:        15,
            font:           { family:'Inter', size:11 },
            cursor:         'default',
                        generateLabels: (chart) => {
              return chart.data.datasets
                .map((ds, i) => ({
                  text:        ds.label,
                  fillStyle:   ds.borderColor,
                  strokeStyle: ds.borderColor,
                  hidden:      ds.hidden,
                  datasetIndex: i
                }))
                .filter((_, i) => !chart.data.datasets[i].hidden);
            },
            filter: (item, data) => !data.datasets[item.datasetIndex].hidden
          }
        },
        tooltip: {
          backgroundColor: 'rgba(15,23,42,0.95)',
          padding:         12,
          titleFont:       { family:'Inter', size:13 },
          bodyFont:        { family:'Inter', size:12 },
          displayColors:   true,
          callbacks: {
            label: ctx => {
              const units = { DO:' mg/L', Salinity:' ppt', Temperature:' °C', pH:'', Turbidity:' NTU' };
              return `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(2)}${units[ctx.dataset.label] ?? ''}`;
            }
          }
        },
        zoom: {
          pan:    { enabled:true, mode:'x', modifierKey:null },
          zoom:   { wheel:{ enabled:true, speed:0.1 }, pinch:{ enabled:true }, mode:'x' },
          limits: { x:{ min:'original', max:'original' } }
        }
      },
      scales: {
        y:  { position:'left',  title:{ display:true, text:'DO (mg/L)',      font:{ family:'Inter', size:11 } }, grid:{ color:'rgba(226,232,240,0.5)' } },
        y1: { position:'right', title:{ display:true, text:'Salinity (ppt)', font:{ family:'Inter', size:11 } }, grid:{ drawOnChartArea:false } },
        y2: { position:'right', title:{ display:true, text:'Temp (°C)',      font:{ family:'Inter', size:11 } }, grid:{ drawOnChartArea:false } },
        y3: { position:'right', title:{ display:true, text:'pH',             font:{ family:'Inter', size:11 } }, grid:{ drawOnChartArea:false } },
        y4: { position:'right', title:{ display:true, text:'Turbidity (NTU)', font:{ family:'Inter', size:11 } }, grid:{ drawOnChartArea:false } },
        x:  { grid:{ display:false }, ticks:{ maxRotation:45, minRotation:45, font:{ family:'Inter', size:10 } } }
      }
    }
  });
}

function resetZoom() {
  correlationChartInst?.resetZoom?.();
}

// ---------------------------------------------------------------------------
// USER INTERACTIONS
// ---------------------------------------------------------------------------

function changeChartType() {
  // Stub — to be implemented with new Trends chart
}

function updateAnalytics() {
  if (correlationData.length > 0) runCorrelationAnalysis();
  if (forecastData.length    > 0) runForecastAnalysis();
}

// ---------------------------------------------------------------------------
// SUMMARY TAB
// Fully independent — has its own data pipeline, unaffected by any of above.
// ---------------------------------------------------------------------------

const summaryCharts = {};

const SUMMARY_COLORS = {
  do:          { border:'#0ea5e9', min:'rgba(14,165,233,0.35)',  avg:'rgba(14,165,233,0.75)',  max:'rgba(14,165,233,1)'  },
  salinity:    { border:'#ef4444', min:'rgba(239,68,68,0.35)',   avg:'rgba(239,68,68,0.75)',   max:'rgba(239,68,68,1)'   },
  temperature: { border:'#f59e0b', min:'rgba(245,158,11,0.35)',  avg:'rgba(245,158,11,0.75)',  max:'rgba(245,158,11,1)'  },
  ph:          { border:'#10b981', min:'rgba(16,185,129,0.35)',  avg:'rgba(16,185,129,0.75)',  max:'rgba(16,185,129,1)'  },
  turbidity:   { border:'#8b5cf6', min:'rgba(139,92,246,0.35)', avg:'rgba(139,92,246,0.75)',  max:'rgba(139,92,246,1)'  }
};

const SUMMARY_CHECKBOX_IDS = {
  do:          'summaryParamDO',
  salinity:    'summaryParamSalinity',
  temperature: 'summaryParamTemperature',
  ph:          'summaryParamPH',
  turbidity:   'summaryParamTurbidity'
};

function getSummaryActiveParams() {
  return Object.entries(SUMMARY_CHECKBOX_IDS)
    .filter(([, id]) => document.getElementById(id)?.checked)
    .map(([param]) => param);
}

function initSummaryDefaults() {
  const today   = new Date();
  const weekAgo = new Date(today);
  weekAgo.setDate(today.getDate() - 6);
  const fmt = d => {
    const y   = d.getFullYear();
    const m   = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  const sd = document.getElementById('summaryStartDate');
  const ed = document.getElementById('summaryEndDate');
  if (sd && !sd.value) sd.value = fmt(weekAgo);
  if (ed && !ed.value) ed.value = fmt(today);
}

// ---------------------------------------------------------------------------
// LOCAL-TIME DATE HELPERS
// ---------------------------------------------------------------------------

function localDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseLocalDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// ---------------------------------------------------------------------------
// SUMMARY DATA LOADING
// ---------------------------------------------------------------------------

function loadSummaryData() {
  const startDateVal = document.getElementById('summaryStartDate')?.value;
  const endDateVal   = document.getElementById('summaryEndDate')?.value;
  const startTimeVal = document.getElementById('summaryStartTime')?.value || '';
  const endTimeVal   = document.getElementById('summaryEndTime')?.value   || '';
  const container    = document.getElementById('summaryChartsContainer');

  if (!startDateVal || !endDateVal) {
    showSummaryStatus('Please select both a start and end date.', 'warn');
    return;
  }

  let startTs, endTs;

  if (startTimeVal) {
    const [sh, sm]      = startTimeVal.split(':').map(Number);
    const [sy, smo, sd] = startDateVal.split('-').map(Number);
    startTs = new Date(sy, smo - 1, sd, sh, sm, 0, 0).getTime();
  } else {
    const [sy, smo, sd] = startDateVal.split('-').map(Number);
    startTs = new Date(sy, smo - 1, sd, 0, 0, 0, 0).getTime();
  }

  if (endTimeVal) {
    const [eh, em]      = endTimeVal.split(':').map(Number);
    const [ey, emo, ed] = endDateVal.split('-').map(Number);
    endTs = new Date(ey, emo - 1, ed, eh, em, 59, 999).getTime();
  } else {
    const [ey, emo, ed] = endDateVal.split('-').map(Number);
    endTs = new Date(ey, emo - 1, ed, 23, 59, 59, 999).getTime();
  }

  if (startTs > endTs) {
    showSummaryStatus('Start date/time must be before end date/time.', 'warn');
    return;
  }

  const statusEl = document.getElementById('summaryStatusMsg');
  if (statusEl) statusEl.classList.add('js-hidden');
  showLoadingState('summaryChartsContainer', 'Loading summary data…');

  firebase.database().ref('WaterQ_history')
    .once('value')
    .then(snapshot => {
      const rawRows = [];

      snapshot.forEach(child => {
        const d = child.val();

        const ts = normaliseTimestamp(d.timestamp);
        if (isNaN(ts)) return;
        if (ts < startTs || ts > endTs) return;

        if (
          d.DO   === undefined ||
          d.Sal  === undefined ||
          d.Temp === undefined ||
          d.pH   === undefined ||
          d.Turb === undefined
        ) return;

        rawRows.push({
          timestamp:   new Date(ts),
          do:          parseFloat(d.DO),
          salinity:    parseFloat(d.Sal),
          temperature: parseFloat(d.Temp),
          ph:          parseFloat(d.pH),
          turbidity:   parseFloat(d.Turb)
        });
      });

      console.log(`[Summary] ${rawRows.length} records matched the selected date range`);

      if (rawRows.length === 0) {
        if (container) container.replaceChildren();
        const startLabel = startTimeVal ? `${startDateVal} ${startTimeVal}` : startDateVal;
        const endLabel   = endTimeVal   ? `${endDateVal} ${endTimeVal}`     : endDateVal;
        showSummaryStatus(`No readings found between ${startLabel} and ${endLabel}.`, 'info');
        return;
      }

      const byDate = {};
      rawRows.forEach(row => {
        const dk = localDateKey(row.timestamp);
        if (!byDate[dk]) byDate[dk] = { do:[], salinity:[], temperature:[], ph:[], turbidity:[] };
        Object.keys(OPTIMAL_RANGES).forEach(param => byDate[dk][param].push(row[param]));
      });

      const allDates = [];
      const cur = parseLocalDate(startDateVal);
      const end = parseLocalDate(endDateVal);
      while (cur <= end) {
        allDates.push(localDateKey(cur));
        cur.setDate(cur.getDate() + 1);
      }

      const summaryData = {};
      Object.keys(OPTIMAL_RANGES).forEach(param => {
        summaryData[param] = allDates.map(date => {
          const vals = byDate[date]?.[param];
          if (!vals || vals.length === 0) return null;
          return {
            min: Math.min(...vals),
            avg: parseFloat((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(3)),
            max: Math.max(...vals)
          };
        });
      });

      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const labels = allDates.map(d => {
        const [, m, day] = d.split('-');
        return `${months[parseInt(m) - 1]} ${parseInt(day)}`;
      });

      const startLabel = startTimeVal ? `${startDateVal} ${startTimeVal}` : startDateVal;
      const endLabel   = endTimeVal   ? `${endDateVal} ${endTimeVal}`     : endDateVal;
      showSummaryStatus(
        `Showing ${rawRows.length} readings from ${startLabel} to ${endLabel} across ${allDates.length} day${allDates.length !== 1 ? 's' : ''}.`,
        'info'
      );

      window._summaryState = { labels, summaryData, allDates };
      renderSummaryCharts();
    })
    .catch(err => {
      console.error('[Summary] Firebase error:', err);
      showSummaryStatus(`Error loading data: ${err.message}`, 'warn');
    });
}

// ---------------------------------------------------------------------------
// SUMMARY CHART RENDERING
// ---------------------------------------------------------------------------

function renderSummaryCharts() {
  const state     = window._summaryState;
  const container = document.getElementById('summaryChartsContainer');
  if (!container) return;

  if (!state) {
    container.replaceChildren();
    const tpl = cloneTemplate('tpl-summary-nodata');
    tpl.querySelector('.tpl-message').textContent = 'Select a date range and click Refresh to load summary data.';
    container.appendChild(tpl);
    return;
  }

  const { labels, summaryData } = state;
  const activeParams = getSummaryActiveParams();

  if (activeParams.length === 0) {
    container.replaceChildren();
    const tpl = cloneTemplate('tpl-summary-nodata');
    tpl.querySelector('.tpl-message').textContent = 'No parameters selected. Check at least one parameter above.';
    container.appendChild(tpl);
    return;
  }

  // Destroy charts for params no longer active
  Object.keys(summaryCharts).forEach(param => {
    if (!activeParams.includes(param)) { summaryCharts[param]?.destroy(); delete summaryCharts[param]; }
  });

  // Build one card per active parameter using the template
  container.replaceChildren();
  activeParams.forEach(param => {
    const tpl    = cloneTemplate('tpl-summary-card');
    const card   = tpl.querySelector('.analytics-card');
    card.id      = `summaryCard_${param}`;

    // Colour dot
    const dot    = tpl.querySelector('.tpl-dot');
    dot.style.background = SUMMARY_COLORS[param].border; // only data-driven colour, not layout

    // Labels
    tpl.querySelector('.tpl-label').textContent = OPTIMAL_RANGES[param].label;
    tpl.querySelector('.tpl-unit').textContent  = `(${OPTIMAL_RANGES[param].unit || 'unitless'})`;
    tpl.querySelector('.tpl-range').textContent =
      `Min / Avg / Max per day · Safe range: ${OPTIMAL_RANGES[param].min}–${OPTIMAL_RANGES[param].max} ${OPTIMAL_RANGES[param].unit}`;

    // Canvas — assign unique id so Chart.js can find it
    const canvas   = tpl.querySelector('.tpl-canvas');
    canvas.id      = `summaryChart_${param}`;

    container.appendChild(tpl);
  });

  // Now that all canvases are in the DOM, build charts
  activeParams.forEach(param => {
    const ctx = document.getElementById(`summaryChart_${param}`)?.getContext('2d');
    if (!ctx) return;
    summaryCharts[param]?.destroy(); delete summaryCharts[param];

    const data   = summaryData[param];
    const colors = SUMMARY_COLORS[param];
    const cfg    = OPTIMAL_RANGES[param];
    const noData = data.map(d => d === null);

    summaryCharts[param] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label:'Min', data:data.map(d => d === null ? 0 : d.min), backgroundColor:colors.min, borderColor:colors.border, borderWidth:1, borderRadius:4 },
          { label:'Avg', data:data.map(d => d === null ? 0 : d.avg), backgroundColor:colors.avg, borderColor:colors.border, borderWidth:1, borderRadius:4 },
          { label:'Max', data:data.map(d => d === null ? 0 : d.max), backgroundColor:colors.max, borderColor:colors.border, borderWidth:1, borderRadius:4 }
        ]
      },
      options: {
        responsive:          true,
        maintainAspectRatio: true,
        aspectRatio:         2.8,
        interaction:         { mode:'index', intersect:false },
        plugins: {
          legend: {
            position: 'bottom',
            labels:   { usePointStyle:true, padding:18, font:{ family:'Inter', size:12 } }
          },
          tooltip: {
            backgroundColor: 'rgba(15,23,42,0.93)',
            padding:         12,
            titleFont:       { family:'Inter', size:13, weight:'600' },
            bodyFont:        { family:'Inter', size:12 },
            callbacks: {
              label: ctx => {
                if (noData[ctx.dataIndex]) return `${ctx.dataset.label}: No data`;
                return `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(2)}${cfg.unit ? ' ' + cfg.unit : ''}`;
              }
            }
          },
          annotation: {
            annotations: {
              safeMin: {
                type: 'line', yMin:cfg.min, yMax:cfg.min, borderColor:'#10b981', borderWidth:2, borderDash:[6,4],
                label:{ display:true, content:`Safe Min: ${cfg.min}${cfg.unit ? ' '+cfg.unit : ''}`, position:'start', backgroundColor:'rgba(16,185,129,0.12)', color:'#047857', font:{ family:'Inter', size:11, weight:'600' }, padding:{ x:8, y:4 }, borderRadius:4 }
              },
              safeMax: {
                type: 'line', yMin:cfg.max, yMax:cfg.max, borderColor:'#f59e0b', borderWidth:2, borderDash:[6,4],
                label:{ display:true, content:`Safe Max: ${cfg.max}${cfg.unit ? ' '+cfg.unit : ''}`, position:'start', backgroundColor:'rgba(245,158,11,0.12)', color:'#b45309', font:{ family:'Inter', size:11, weight:'600' }, padding:{ x:8, y:4 }, borderRadius:4 }
              },
              critical: {
                type: 'line', yMin:cfg.critical, yMax:cfg.critical, borderColor:'#dc2626', borderWidth:2, borderDash:[4,3],
                label:{ display:true, content:`Critical: ${cfg.critical}${cfg.unit ? ' '+cfg.unit : ''}`, position:'end', backgroundColor:'rgba(220,38,38,0.12)', color:'#b91c1c', font:{ family:'Inter', size:11, weight:'600' }, padding:{ x:8, y:4 }, borderRadius:4 }
              }
            }
          }
        },
        scales: {
          y: { beginAtZero:false, grid:{ color:'rgba(226,232,240,0.5)' }, ticks:{ font:{ family:'Inter', size:11 } }, title:{ display:true, text:cfg.unit || param, font:{ family:'Inter', size:11 } } },
          x: { grid:{ display:false }, ticks:{ font:{ family:'Inter', size:11 }, maxRotation:45 } }
        }
      }
    });
  });
}

// ---------------------------------------------------------------------------
// SUMMARY STATUS MESSAGE
// ---------------------------------------------------------------------------

function showSummaryStatus(message, type) {
  const el = document.getElementById('summaryStatusMsg');
  if (!el) return;
  el.className = 'summary-status-info';
  if (type === 'warn') el.classList.add('summary-status-warn');
  el.textContent   = message;
  el.classList.remove('js-hidden');
  el.classList.add('js-flex');
}

// ---------------------------------------------------------------------------
// TAB SWITCHING
// ---------------------------------------------------------------------------

function switchPageTab(tab) {
  document.querySelectorAll('.page-tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.remove('active'));

  const cap = tab.charAt(0).toUpperCase() + tab.slice(1);
  document.getElementById(`tabBtn${cap}`)?.classList.add('active');
  document.getElementById(`tabPanel${cap}`)?.classList.add('active');

  console.log('[Analytics] switchPageTab ->', tab);
  // Trends tab chart resize hook removed — chart will be re-implemented
}

// ---------------------------------------------------------------------------
// SECOND SAFETY NET — re-registers at end of file in case any error above
// prevented the first block from completing. Also logged to Console.
// ---------------------------------------------------------------------------
(function() {
  console.group('%c[Analytics] Registering functions on window (SAFETY NET — end of file)', 'color:#64748b;font-weight:bold');

  var fnMap = {
    switchPageTab:       switchPageTab,
    loadSummaryData:     loadSummaryData,
    renderSummaryCharts: renderSummaryCharts,
    loadTrendsData:      loadTrendsData,
    onTrendParamChange:  onTrendParamChange,
    onTrendSmoothChange: onTrendSmoothChange,
    resetTrendsZoom:     resetTrendsZoom,
    loadCorrelationData: loadCorrelationData,
    changeChartType:     changeChartType,
    resetZoom:           resetZoom,
    updateAnalytics:     updateAnalytics,
    onParamFilterChange: onParamFilterChange
  };

  var useBridge = typeof window._registerAnalyticsFn === 'function';
  console.log('  Bridge available: ' + (useBridge ? '✅ YES' : '⚠️ NO — direct assignment'));

  Object.keys(fnMap).forEach(function(name) {
    if (useBridge) {
      window._registerAnalyticsFn(name, fnMap[name]);
    } else {
      window[name] = fnMap[name];
      console.log('  ✅ window.' + name + ' assigned');
    }
  });

  console.log('%c  Safety-net registration complete ✔', 'color:#10b981;font-weight:bold');
  console.groupEnd();
})();