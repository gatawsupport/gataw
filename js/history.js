// history.js - Historical Data and Export Functionality
// ADMIN-ONLY DELETE: Delete functions now check user role before executing

const historyBody   = document.getElementById("historyBody");
const dateFromInput = document.getElementById("dateFromInput");
const dateToInput   = document.getElementById("dateToInput");
const timeFromInput = document.getElementById("timeFromInput");
const timeToInput   = document.getElementById("timeToInput");
const sortSelect    = document.getElementById("sortSelect");

console.log("history.js loading...");

let historyData = [];
// Hardcoded firmware clock offset in seconds (firmware is behind by this amount)
const TIMESTAMP_OFFSET_S = 554193;
const timestampOffset    = TIMESTAMP_OFFSET_S * 1000; // convert to ms for Date arithmetic
let currentSensorData = null;
let minDate = null;
let maxDate = null;

// Pagination variables
let currentPage    = 1;
let recordsPerPage = 50;
let filteredData   = [];

// ============== RENDER LOCK (prevents race condition / row stacking) ===============
let isRendering = false;

// ============== DELETION STATE ===============
// Tracks which Firebase keys are selected for deletion
let selectedKeys = new Set();

// Check if database is available
if (typeof window.database === 'undefined') {
  console.error("Firebase database not initialized!");
} else {
  console.log("Firebase database available in history.js");
}

// ============== ROLE CHECK FOR DELETE OPERATIONS ===============
async function canUserDelete() {
  // Check if user is admin using the global function from rolemanager.js
  if (typeof window.isAdmin === 'function') {
    const isAdminUser = window.isAdmin();
    console.log("🔒 Delete permission check: isAdmin =", isAdminUser);
    return isAdminUser;
  }
  
  // Fallback: check session directly
  const userSession = localStorage.getItem('userSession');
  if (userSession) {
    try {
      const session = JSON.parse(userSession);
      const canDelete = session.role === 'admin';
      console.log("🔒 Delete permission check (fallback): role =", session.role, "canDelete =", canDelete);
      return canDelete;
    } catch (error) {
      console.error("Error checking user role:", error);
    }
  }
  
  console.warn("🔒 Delete permission check: DENIED (no valid session)");
  return false;
}

// ============== HELPER FUNCTION: GET COLOR BASED ON THRESHOLD ===============
function getColorClass(parameter, value) {
  if (!window.thresholds || !window.thresholds[parameter] || value === undefined || value === null) {
    return '';
  }
  const threshold = window.thresholds[parameter];
  const { safeMin, safeMax, alertMin, alertMax } = threshold;

  if (value >= safeMin && value <= safeMax)                                            return 'status-safe';
  if ((value >= alertMin && value < safeMin) || (value > safeMax && value <= alertMax)) return 'status-caution';
  if (value < alertMin || value > alertMax)                                            return 'status-critical';
  return '';
}

// ============== LOAD CURRENT SENSOR DATA ===============
window.database.ref("sensors").on("value", snapshot => {
  currentSensorData = snapshot.val();
});

// ============== INITIALIZE NATIVE DATE INPUTS ===============
// No min/max restrictions — user can freely select any date, past or future
function initializeDatePickers() {
  dateFromInput.removeAttribute('min');
  dateFromInput.removeAttribute('max');
  dateToInput.removeAttribute('min');
  dateToInput.removeAttribute('max');
  console.log("Native date inputs initialized — no date restrictions applied.");
}

// ============== INITIALIZE DATE INPUTS ON PAGE LOAD ===============
initializeDatePickers();

// Date inputs are intentionally left empty on load.
// The table will show "please select a date range" until the user fills them.

// ============== LOAD HISTORICAL DATA ===============
// NOTE: We now also store the Firebase key on each record so we can delete it later.
// AUTO-REFRESH: The .on("value") listener automatically triggers when data changes
window.database.ref("WaterQ_history").on("value", snapshot => {
  historyData = [];

  // TIMESTAMP_OFFSET_S is a hardcoded constant — update this value whenever
  // the firmware clock drift changes (e.g. after a device reboot with a new bad time).
  console.log(`Applying hardcoded firmware offset: ${TIMESTAMP_OFFSET_S}s (${(TIMESTAMP_OFFSET_S/86400).toFixed(2)} days)`);

  snapshot.forEach(child => {
    const data = child.val();

    // Push key is the unix timestamp itself (e.g. "1742389930000")
    // Timestamp is also stored as data.timestamp — use it with fallback to the key
    const rawTs = data.timestamp !== undefined ? Number(data.timestamp) : null;
    const rawTimestamp = rawTs === null ? null
      : rawTs > 1e10 ? rawTs        // already ms
      : rawTs * 1000;               // convert seconds → ms

    if (!rawTimestamp || isNaN(rawTimestamp)) {
      console.warn("Record has no valid timestamp:", child.key, data);
      return;
    }

    // Apply the hardcoded offset to every record uniformly.
    const timestamp = rawTimestamp + timestampOffset;

    // Sensor values are direct numbers on the node (e.g. data.DO, data.Temp)
    historyData.push({
      firebaseKey: child.key,
      temperature: data.Temp     !== undefined && data.Temp     !== null ? Number(data.Temp)     : undefined,
      ph:          data.pH       !== undefined && data.pH       !== null ? Number(data.pH)       : undefined,
      salinity:    data.Sal      !== undefined && data.Sal      !== null ? Number(data.Sal)      : undefined,
      turbidity:   data.Turb     !== undefined && data.Turb     !== null ? Number(data.Turb)     : undefined,
      do:          data.DO       !== undefined && data.DO       !== null ? Number(data.DO)       : undefined,
      timestamp:   timestamp
    });
  });

  console.log("===== HISTORY DATA SYNC =====");
  console.log("Total history records loaded from Firebase:", historyData.length);
  console.warn(`⚠️ Firebase has ${historyData.length} records available`);

  // Re-initialize date pickers now that data is loaded
  initializeDatePickers();

  // Only filter if the user has already selected a date range
  if (dateFromInput.value && dateToInput.value) {
    applyCurrentFilter(true);
  } else {
    renderTable();
    renderPagination();
  }
});

// ============== NATIVE TIME INPUT EVENT LISTENERS ===============
// Add event listeners once DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  // Add change event listeners for auto-filter on time inputs
  if (timeFromInput) {
    timeFromInput.addEventListener('change', function() {
      autoApplyFilter();
    });
  }
  
  if (timeToInput) {
    timeToInput.addEventListener('change', function() {
      autoApplyFilter();
    });
  }
  
  // Add sort select change listener
  if (sortSelect) {
    sortSelect.addEventListener('change', function() {
      autoApplyFilter();
    });
  }
});

// ============== AUTO APPLY FILTER ===============
// Called whenever date or time inputs change
function autoApplyFilter() {
  const dateFromValue = dateFromInput.value;
  const dateToValue   = dateToInput.value;

  // Only apply filter if BOTH dates are filled
  if (!dateFromValue || !dateToValue) {
    // If either date is missing, show no data
    filteredData = [];
    renderTable();
    renderPagination();
    return;
  }

  // Now call the actual filter logic
  applyCurrentFilter();
}

// ============== APPLY FILTER ===============
// Extracted filter logic so we can re-apply it after deletion
function applyCurrentFilter(preservePage = false) {
  const dateFromValue = dateFromInput.value;
  const dateToValue   = dateToInput.value;
  const timeFromValue = timeFromInput.value;
  const timeToValue   = timeToInput.value;

  // Validation: Both dates must be filled
  if (!dateFromValue || !dateToValue) {
    filteredData = [];
    renderTable();
    renderPagination();
    return;
  }

  // Validation: If one time is filled, both must be filled
  if (timeFromValue && !timeToValue) {
    filteredData = [];
    renderTable();
    renderPagination();
    return;
  }
  if (!timeFromValue && timeToValue) {
    filteredData = [];
    renderTable();
    renderPagination();
    return;
  }

  // Parse date strings as LOCAL midnight, not UTC midnight.
  // new Date("YYYY-MM-DD") parses as UTC which shifts the day in UTC+8 timezones.
  function parseDateLocal(str) {
    const [y, m, d] = str.split('-').map(Number);
    return new Date(y, m - 1, d); // local midnight
  }

  const fromDateOnly = parseDateLocal(dateFromValue);
  const toDateOnly   = parseDateLocal(dateToValue);

  // Validation: Start date must not be after end date
  if (fromDateOnly > toDateOnly) {
    filteredData = [];
    renderTable();
    renderPagination();
    return;
  }

  // Clear any prior selection when a new filter is applied
  selectedKeys.clear();

  if (timeFromValue && timeToValue) {
    const [fromHours, fromMinutes] = timeFromValue.split(':').map(Number);
    const [toHours,   toMinutes  ] = timeToValue.split(':').map(Number);
    const fromTotalMinutes = fromHours * 60 + fromMinutes;
    const toTotalMinutes   = toHours   * 60 + toMinutes;

    // Validation: Time From must be earlier than Time To
    if (fromTotalMinutes >= toTotalMinutes) {
      filteredData = [];
      renderTable();
      renderPagination();
      return;
    }

    // Apply time window to EVERY day in the range
    filteredData = historyData.filter(item => {
      const itemDate     = new Date(item.timestamp);
      const itemDateOnly = new Date(itemDate.getFullYear(), itemDate.getMonth(), itemDate.getDate());
      if (itemDateOnly < fromDateOnly || itemDateOnly > toDateOnly) return false;
      const itemTotalMinutes = itemDate.getHours() * 60 + itemDate.getMinutes();
      return itemTotalMinutes >= fromTotalMinutes && itemTotalMinutes <= toTotalMinutes;
    });
  } else {
    filteredData = historyData.filter(item => {
      const itemDate     = new Date(item.timestamp);
      const itemDateOnly = new Date(itemDate.getFullYear(), itemDate.getMonth(), itemDate.getDate());
      return itemDateOnly >= fromDateOnly && itemDateOnly <= toDateOnly;
    });
  }

  const sortOrder = sortSelect.value;
  filteredData.sort((a, b) => sortOrder === "oldest" ? a.timestamp - b.timestamp : b.timestamp - a.timestamp);

  console.log("===== FILTER APPLIED =====");
  console.log("Date range:", dateFromValue, "to", dateToValue);
  console.log("Time range:", timeFromValue || "All day", "to", timeToValue || "All day");
  console.log("Total records in DB:", historyData.length);
  console.log("Filtered records matching criteria:", filteredData.length);
  console.log("Filtered data:", filteredData);
  // Only reset to page 1 when the user manually changes filters.
  // On Firebase auto-refresh (preservePage=true) the user stays exactly
  // where they are — new rows slide in smoothly without any page jump.
  if (!preservePage) {
    currentPage = 1;
    renderTable(false);  // full re-render on filter change
  } else {
    // Clamp page in case records were deleted and total pages shrank
    const totalPages = Math.ceil(filteredData.length / recordsPerPage) || 1;
    if (currentPage > totalPages) currentPage = totalPages;
    renderTable(true);   // live diff — only animates new/removed rows
  }
  renderPagination();
}

// ============== DATE INPUT CHANGE LISTENERS ===============
// Add event listeners for native date inputs
dateFromInput.addEventListener("change", () => {
  console.log("Start date changed:", dateFromInput.value);
  autoApplyFilter();
});

dateToInput.addEventListener("change", () => {
  console.log("End date changed:", dateToInput.value);
  autoApplyFilter();
});


// ============================================================
// BUILD ROW ELEMENT (shared by full render and live-insert)
// ============================================================
function buildRow(d, isAdmin) {
  const date    = new Date(d.timestamp).toLocaleString();
  const row     = document.createElement("tr");
  const checked = selectedKeys.has(d.firebaseKey) ? 'checked' : '';

  let rowHTML = `
    <td><strong>${date}</strong></td>
    <td class="${getColorClass('temperature', d.temperature)}">${d.temperature !== undefined ? d.temperature.toFixed(2) : "--"}</td>
    <td class="${getColorClass('ph', d.ph)}">${d.ph !== undefined ? d.ph.toFixed(2) : "--"}</td>
    <td class="${getColorClass('salinity', d.salinity)}">${d.salinity !== undefined ? d.salinity.toFixed(2) : "--"}</td>
    <td class="${getColorClass('turbidity', d.turbidity)}">${d.turbidity !== undefined ? d.turbidity.toFixed(2) : "--"}</td>
    <td class="${getColorClass('do', d.do)}">${d.do !== undefined ? d.do.toFixed(2) : "--"}</td>
  `;

  if (isAdmin) {
    rowHTML += `
      <td style="text-align:center; width:40px;">
        <input type="checkbox" class="row-checkbox" data-key="${d.firebaseKey}" ${checked}
          style="width:16px; height:16px; cursor:pointer; accent-color:#ef4444;">
      </td>
    `;
  }

  row.innerHTML = rowHTML;
  row.dataset.key = d.firebaseKey;

  if (isAdmin) {
    const checkbox = row.querySelector('.row-checkbox');
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        selectedKeys.add(d.firebaseKey);
      } else {
        selectedKeys.delete(d.firebaseKey);
      }
      updateSelectAllCheckbox();
    });
  }

  return row;
}

// ============================================================
// RENDER TABLE (with admin-only checkboxes)
// On Firebase auto-refresh: diffs the current page and smoothly
// slides in only new rows — user stays exactly where they are.
// On manual filter change: does a full clean re-render.
// ============================================================
async function renderTable(isLiveUpdate = false) {
  // 🔒 RENDER LOCK: Prevent concurrent renders causing row stacking
  if (isRendering) return;
  isRendering = true;

  const isAdmin = await canUserDelete();

  if (filteredData.length === 0) {
    historyBody.innerHTML = "";
    const colspanCount = isAdmin ? 7 : 6;
    historyBody.innerHTML = `
      <tr>
        <td colspan="${colspanCount}" style="text-align:center; padding:40px;">
          <i class="fas fa-info-circle" style="font-size:2em; color:#0ea5e9; margin-bottom:10px;"></i>
          <div style="font-size:1.1em; font-weight:600; color:#334155; margin-top:10px;">No Data Available</div>
          <div style="font-size:0.95em; color:#64748b; margin-top:5px;">
            ${!dateFromInput.value || !dateToInput.value
              ? 'Please select both start and end dates to view data'
              : 'There are no records for the selected date and time range'}
          </div>
        </td>
      </tr>`;

    const paginationInfo     = document.getElementById('paginationInfo');
    const paginationControls = document.getElementById('paginationControls');
    if (paginationInfo)     paginationInfo.innerHTML = '';
    if (paginationControls) paginationControls.innerHTML = '';

    updateExportButton();
    updateSelectAllCheckbox();
    isRendering = false;
    return;
  }

  const startIndex = (currentPage - 1) * recordsPerPage;
  const endIndex   = Math.min(startIndex + recordsPerPage, filteredData.length);
  const pageData   = filteredData.slice(startIndex, endIndex);

  if (isLiveUpdate) {
    // ── LIVE UPDATE: diff and animate only new rows ──────────────
    // Collect keys already rendered on this page
    const renderedKeys = new Set(
      [...historyBody.querySelectorAll('tr[data-key]')].map(r => r.dataset.key)
    );

    // Remove rows that are no longer in pageData (e.g. after delete)
    historyBody.querySelectorAll('tr[data-key]').forEach(row => {
      if (!pageData.find(d => d.firebaseKey === row.dataset.key)) {
        row.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
        row.style.opacity = '0';
        row.style.transform = 'translateX(-20px)';
        setTimeout(() => row.remove(), 300);
      }
    });

    // Insert new rows with a slide-in animation; refresh existing rows in-place
    const sortOrder = sortSelect.value;
    pageData.forEach((d, index) => {
      if (renderedKeys.has(d.firebaseKey)) {
        // Row already visible — update its cell values in-place so changed
        // or previously-missing sensor readings are always shown correctly
        const existingRow = historyBody.querySelector(`tr[data-key="${d.firebaseKey}"]`);
        if (existingRow) {
          const cells = existingRow.querySelectorAll('td');
          cells[0].innerHTML = `<strong>${new Date(d.timestamp).toLocaleString()}</strong>`;
          cells[1].className = getColorClass('temperature', d.temperature);
          cells[1].textContent = d.temperature !== undefined ? d.temperature.toFixed(2) : '--';
          cells[2].className = getColorClass('ph', d.ph);
          cells[2].textContent = d.ph !== undefined ? d.ph.toFixed(2) : '--';
          cells[3].className = getColorClass('salinity', d.salinity);
          cells[3].textContent = d.salinity !== undefined ? d.salinity.toFixed(2) : '--';
          cells[4].className = getColorClass('turbidity', d.turbidity);
          cells[4].textContent = d.turbidity !== undefined ? d.turbidity.toFixed(2) : '--';
          cells[5].className = getColorClass('do', d.do);
          cells[5].textContent = d.do !== undefined ? d.do.toFixed(2) : '--';
        }
        return;
      }

      const row = buildRow(d, isAdmin);

      // Start hidden and slightly offset
      row.style.opacity = '0';
      row.style.transform = 'translateY(-12px)';
      row.style.transition = 'opacity 0.4s ease, transform 0.4s ease';

      if (sortOrder === 'oldest') {
        historyBody.appendChild(row);
      } else {
        // newest-first: insert before the first existing row so it slides in at top
        const firstExisting = historyBody.querySelector('tr[data-key]');
        if (firstExisting) {
          historyBody.insertBefore(row, firstExisting);
        } else {
          historyBody.appendChild(row);
        }
      }

      // Trigger animation on next frame
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          row.style.opacity = '1';
          row.style.transform = 'translateY(0)';
        });
      });
    });

  } else {
    // ── FULL RE-RENDER: clean slate (filter change, page nav, delete) ──
    historyBody.innerHTML = "";
    pageData.forEach(d => {
      historyBody.appendChild(buildRow(d, isAdmin));
    });
  }

  // Inject checkbox header into thead (only for admins)
  if (isAdmin) {
    injectCheckboxHeader();
  } else {
    removeCheckboxHeader();
  }

  updatePaginationInfo(startIndex + 1, endIndex, filteredData.length);
  updateExportButton();
  updateSelectAllCheckbox();

  isRendering = false; // 🔓 Release lock
}

// ============== INJECT CHECKBOX COLUMN INTO THEAD (ADMIN ONLY) ===============
function injectCheckboxHeader() {
  const thead = document.querySelector('.history-table thead tr');
  if (!thead) return;

  // Remove any previously injected checkbox th to avoid duplicates
  const existing = thead.querySelector('.checkbox-th');
  if (existing) existing.remove();

  const th = document.createElement('th');
  th.className = 'checkbox-th';
  th.style.cssText = 'width:150px; text-align:center;';
  th.innerHTML = `
    <div style="display: flex; align-items: center; justify-content: center; gap: 8px;">
      <input type="checkbox" id="selectAllCheckbox"
        title="Select / deselect all records on this page"
        style="width:16px; height:16px; cursor:pointer; accent-color:#ef4444;">
      <span id="selectAllText" style="font-size: 13px; font-weight: 600;">Select All</span>
      <button id="headerTrashBtn" 
        style="background: none; border: none; color: #ef4444; cursor: pointer; padding: 4px; font-size: 16px; margin-left: 4px; opacity: 0.7; transition: opacity 0.2s;"
        title="Delete selected records"
        onmouseover="this.style.opacity='1'"
        onmouseout="this.style.opacity='0.7'">
        <i class="fas fa-trash-alt"></i>
      </button>
    </div>
  `;
  thead.appendChild(th);

  document.getElementById('selectAllCheckbox').addEventListener('change', function() {
    const currentPageKeys = getCurrentPageKeys();
    if (this.checked) {
      currentPageKeys.forEach(k => selectedKeys.add(k));
    } else {
      currentPageKeys.forEach(k => selectedKeys.delete(k));
    }
    // Reflect on row checkboxes
    document.querySelectorAll('.row-checkbox').forEach(cb => {
      cb.checked = selectedKeys.has(cb.dataset.key);
    });
    updateSelectAllCheckbox();
  });

  // Add trash button event listener
  document.getElementById('headerTrashBtn').addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    deleteSelected();
  });
}

// ============== REMOVE CHECKBOX COLUMN FROM THEAD (NON-ADMIN) ===============
function removeCheckboxHeader() {
  const thead = document.querySelector('.history-table thead tr');
  if (!thead) return;

  const existing = thead.querySelector('.checkbox-th');
  if (existing) existing.remove();
}

// Returns the Firebase keys of all records visible on the current page
function getCurrentPageKeys() {
  const startIndex = (currentPage - 1) * recordsPerPage;
  const endIndex   = Math.min(startIndex + recordsPerPage, filteredData.length);
  return filteredData.slice(startIndex, endIndex).map(d => d.firebaseKey);
}

// Sync the header checkbox state (checked / unchecked only) and update count
function updateSelectAllCheckbox() {
  const selectAll = document.getElementById('selectAllCheckbox');
  const selectAllText = document.getElementById('selectAllText');
  const trashBtn = document.getElementById('headerTrashBtn');
  
  if (!selectAll) return;

  const pageKeys      = getCurrentPageKeys();
  const selectedOnPage = pageKeys.filter(k => selectedKeys.has(k));

  // Only check if ALL items on page are selected, otherwise uncheck
  if (selectedOnPage.length === pageKeys.length && pageKeys.length > 0) {
    selectAll.checked = true;
  } else {
    selectAll.checked = false;
  }
  
  // Never use indeterminate state
  selectAll.indeterminate = false;

  // Update text to show "Select All (X)" format
  if (selectAllText) {
    if (selectedKeys.size > 0) {
      selectAllText.textContent = `Select All (${selectedKeys.size})`;
      selectAllText.style.color = '#ef4444';
      selectAllText.style.fontWeight = '700';
    } else {
      selectAllText.textContent = 'Select All';
      selectAllText.style.color = '';
      selectAllText.style.fontWeight = '600';
    }
  }

  // Update trash button visibility/opacity
  if (trashBtn) {
    if (selectedKeys.size > 0) {
      trashBtn.style.opacity = '1';
      trashBtn.style.cursor = 'pointer';
    } else {
      trashBtn.style.opacity = '0.3';
      trashBtn.style.cursor = 'not-allowed';
    }
  }
}

// ============== UPDATE PAGINATION INFO ===============
function updatePaginationInfo(start, end, total) {
  const infoElement = document.getElementById('paginationInfo');
  if (infoElement) infoElement.textContent = `Showing ${start}-${end} of ${total} records`;
}

// ============== RENDER PAGINATION CONTROLS ===============
function renderPagination() {
  const totalPages          = Math.ceil(filteredData.length / recordsPerPage);
  const paginationContainer = document.getElementById('paginationControls');

  if (!paginationContainer || totalPages <= 1) {
    if (paginationContainer) paginationContainer.innerHTML = '';
    return;
  }

  let html = `
    <button class="pagination-btn" ${currentPage === 1 ? 'disabled' : ''} onclick="goToPage(${currentPage - 1})">
      <i class="fas fa-chevron-left"></i> Previous
    </button>`;

  const maxVisible = 5;
  let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
  let endPage   = Math.min(totalPages, startPage + maxVisible - 1);
  if (endPage - startPage + 1 < maxVisible) startPage = Math.max(1, endPage - maxVisible + 1);

  if (startPage > 1) {
    html += `<button class="pagination-btn" onclick="goToPage(1)">1</button>`;
    if (startPage > 2) html += `<span class="pagination-ellipsis">...</span>`;
  }

  for (let i = startPage; i <= endPage; i++) {
    html += `<button class="pagination-btn ${i === currentPage ? 'active' : ''}" onclick="goToPage(${i})">${i}</button>`;
  }

  if (endPage < totalPages) {
    if (endPage < totalPages - 1) html += `<span class="pagination-ellipsis">...</span>`;
    html += `<button class="pagination-btn" onclick="goToPage(${totalPages})">${totalPages}</button>`;
  }

  html += `
    <button class="pagination-btn" ${currentPage === totalPages ? 'disabled' : ''} onclick="goToPage(${currentPage + 1})">
      Next <i class="fas fa-chevron-right"></i>
    </button>`;

  paginationContainer.innerHTML = html;
}

// ============== GO TO PAGE ===============
function goToPage(page) {
  const totalPages = Math.ceil(filteredData.length / recordsPerPage);
  if (page < 1 || page > totalPages) return;
  currentPage = page;
  renderTable(false);  // full re-render on explicit page navigation
  renderPagination();
  const table = document.querySelector('.history-table');
  if (table) table.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ============================================================
// DELETE FUNCTIONALITY (ADMIN ONLY - LAYER 2 SECURITY)
// ============================================================

// ── Delete Selected ──────────────────────────────────────────
async function deleteSelected() {
  // 🔒 LAYER 2 SECURITY: Verify admin role before allowing delete
  const isAdmin = await canUserDelete();
  if (!isAdmin) {
    console.warn("🔒 Delete attempt blocked: User is not admin");
    alert("⛔ Access Denied: Only administrators can delete records.");
    return;
  }

  if (selectedKeys.size === 0) return;

  showDeleteConfirmModal(
    `Delete ${selectedKeys.size} selected record${selectedKeys.size > 1 ? 's' : ''}?`,
    `This will permanently remove <strong>${selectedKeys.size}</strong> record${selectedKeys.size > 1 ? 's' : ''} from the database. This action cannot be undone.`,
    async () => {
      const keysToDelete = Array.from(selectedKeys);
      try {
        console.log("🗑️ Admin deleting records:", keysToDelete);
        
        // Delete all selected records from Firebase in parallel
        await Promise.all(
          keysToDelete.map(key => window.database.ref(`WaterQ_history/${key}`).remove())
        );
        selectedKeys.clear();
        console.log(`✅ Successfully deleted ${keysToDelete.length} records from Firebase.`);
        console.log("Deleted keys:", keysToDelete);
        showDeleteSuccess(keysToDelete.length);
        applyCurrentFilter(false); // Full re-render after deletion
      } catch (err) {
        console.error("❌ Error deleting records:", err);
        alert("An error occurred while deleting records. Please try again.");
      }
    }
  );
}

// ── Delete All Filtered ──────────────────────────────────────
async function deleteAllFiltered() {
  // 🔒 LAYER 2 SECURITY: Verify admin role before allowing delete
  const isAdmin = await canUserDelete();
  if (!isAdmin) {
    console.warn("🔒 Delete All attempt blocked: User is not admin");
    alert("⛔ Access Denied: Only administrators can delete records.");
    return;
  }

  if (filteredData.length === 0) return;

  showDeleteConfirmModal(
    `Delete all ${filteredData.length} filtered records?`,
    `This will permanently remove <strong>all ${filteredData.length}</strong> records currently shown in the table from the database. This action cannot be undone.`,
    async () => {
      const keysToDelete = filteredData.map(d => d.firebaseKey);
      try {
        console.log("🗑️ Admin deleting all filtered records:", keysToDelete);
        
        await Promise.all(
          keysToDelete.map(key => window.database.ref(`WaterQ_history/${key}`).remove())
        );
        selectedKeys.clear();
        console.log(`✅ Successfully deleted all ${keysToDelete.length} filtered records from Firebase.`);
        console.log("Deleted keys:", keysToDelete);
        showDeleteSuccess(keysToDelete.length);
        applyCurrentFilter(false); // Full re-render after deletion
      } catch (err) {
        console.error("❌ Error deleting records:", err);
        alert("An error occurred while deleting records. Please try again.");
      }
    }
  );
}

// ── Confirmation Modal ───────────────────────────────────────
function showDeleteConfirmModal(title, message, onConfirm) {
  const modal = document.getElementById('deleteConfirmModal');
  const modalTitle = document.getElementById('modalTitle');
  const modalMessage = document.getElementById('modalMessage');
  const cancelBtn = document.getElementById('modalCancelBtn');
  const confirmBtn = document.getElementById('modalConfirmBtn');
  
  if (!modal) return;
  
  // Set content
  modalTitle.textContent = title;
  modalMessage.innerHTML = message;
  
  // Show modal
  modal.classList.add('show');
  modal.style.display = 'flex';
  
  // Remove old listeners by cloning buttons
  const newCancelBtn = cancelBtn.cloneNode(true);
  const newConfirmBtn = confirmBtn.cloneNode(true);
  cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
  confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
  
  // Cancel handler
  newCancelBtn.addEventListener('click', () => {
    modal.classList.remove('show');
    setTimeout(() => modal.style.display = 'none', 150);
  });
  
  // Click outside to cancel
  const clickOutsideHandler = (e) => {
    if (e.target === modal) {
      modal.classList.remove('show');
      setTimeout(() => modal.style.display = 'none', 150);
      modal.removeEventListener('click', clickOutsideHandler);
    }
  };
  modal.addEventListener('click', clickOutsideHandler);
  
  // Confirm handler
  newConfirmBtn.addEventListener('click', async () => {
    modal.classList.remove('show');
    setTimeout(() => modal.style.display = 'none', 150);
    modal.removeEventListener('click', clickOutsideHandler);
    await onConfirm();
  });
}

// ── Delete Success Notification ──────────────────────────────
function showDeleteSuccess(count) {
  const notification = document.getElementById('successNotification');
  const text = document.getElementById('successNotificationText');
  
  if (!notification || !text) return;
  
  text.innerHTML = `<i class="fas fa-check-circle"></i> ${count} record${count > 1 ? 's' : ''} deleted successfully!`;
  notification.style.display = 'flex';
  
  setTimeout(() => notification.classList.add('show'), 10);
  
  setTimeout(() => {
    notification.classList.remove('show');
    setTimeout(() => notification.style.display = 'none', 300);
  }, 3000);
}

// ============== EXPORT FUNCTIONALITY ===============

function updateExportButton() {
  const exportBtn = document.getElementById('exportBtn');
  if (exportBtn) {
    const hasData               = filteredData.length > 0;
    exportBtn.disabled          = !hasData;
    exportBtn.style.opacity     = hasData ? '1' : '0.5';
    exportBtn.style.cursor      = hasData ? 'pointer' : 'not-allowed';
  }
}

document.addEventListener('DOMContentLoaded', function() {
  const exportBtn  = document.getElementById('exportBtn');
  const exportMenu = document.getElementById('exportMenu');

  if (exportBtn && exportMenu) {
    exportBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      exportMenu.classList.toggle('show');
    });
    document.addEventListener('click', function(e) {
      if (!e.target.closest('.export-dropdown')) exportMenu.classList.remove('show');
    });
  }
});

function getTimestamp() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
}

function calculateStats(data) {
  const params = ['temperature', 'ph', 'salinity', 'turbidity', 'do'];
  const stats  = {};
  params.forEach(param => {
    const values = data.map(d => d[param]).filter(v => v !== undefined && v !== null);
    if (values.length > 0) {
      stats[param] = {
        min: Math.min(...values),
        max: Math.max(...values),
        avg: values.reduce((a, b) => a + b, 0) / values.length
      };
    }
  });
  return stats;
}

function exportData(format) {
  const exportMenu = document.getElementById('exportMenu');
  if (exportMenu) exportMenu.classList.remove('show');

  if (filteredData.length === 0) {
    alert('No data to export. Please apply a filter first.');
    return;
  }

  const loadingOverlay = document.getElementById('exportLoading');
  if (loadingOverlay) loadingOverlay.classList.add('show');

  const dateFrom  = dateFromInput.value || 'N/A';
  const dateTo    = dateToInput.value   || 'N/A';
  const filename  = `fishda_history_${getTimestamp()}`;

  setTimeout(() => {
    try {
      if (format === 'csv')   exportToCSV(filename, dateFrom, dateTo);
      if (format === 'excel') exportToExcel(filename, dateFrom, dateTo);
      if (format === 'pdf')   exportToPDF(filename, dateFrom, dateTo);

      if (loadingOverlay) loadingOverlay.classList.remove('show');
      showExportSuccess(format);
    } catch (error) {
      console.error('Export error:', error);
      if (loadingOverlay) loadingOverlay.classList.remove('show');
      alert('Error generating export file. Please try again.');
    }
  }, 500);
}

function exportToCSV(filename, dateFrom, dateTo) {
  let csv = `FISHDA Historical Data Export\nExport Date: ${new Date().toLocaleString()}\nDate Range: ${dateFrom} to ${dateTo}\nTotal Records: ${filteredData.length}\n\n`;
  csv += 'Date & Time,Temperature (°C),pH,Salinity (ppt),Turbidity (NTU),DO (mg/L)\n';

  filteredData.forEach(item => {
    csv += `${new Date(item.timestamp).toLocaleString()},`;
    csv += `${item.temperature !== undefined ? item.temperature.toFixed(2) : 'N/A'},`;
    csv += `${item.ph         !== undefined ? item.ph.toFixed(2)          : 'N/A'},`;
    csv += `${item.salinity   !== undefined ? item.salinity.toFixed(2)    : 'N/A'},`;
    csv += `${item.turbidity  !== undefined ? item.turbidity.toFixed(2)   : 'N/A'},`;
    csv += `${item.do         !== undefined ? item.do.toFixed(2)          : 'N/A'}\n`;
  });

  csv += '\n--- Summary Statistics ---\nParameter,Minimum,Maximum,Average\n';
  const stats       = calculateStats(filteredData);
  const paramLabels = { temperature:'Temperature (°C)', ph:'pH', salinity:'Salinity (ppt)', turbidity:'Turbidity (NTU)', do:'DO (mg/L)' };
  Object.keys(stats).forEach(p => {
    csv += `${paramLabels[p]},${stats[p].min.toFixed(2)},${stats[p].max.toFixed(2)},${stats[p].avg.toFixed(2)}\n`;
  });

  const link = document.createElement('a');
  link.href     = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  link.download = `${filename}.csv`;
  link.click();
}

function exportToExcel(filename, dateFrom, dateTo) {
  const wb   = XLSX.utils.book_new();
  const data = [
    ['FISHDA Historical Data Export'],
    ['Export Date:', new Date().toLocaleString()],
    ['Date Range:', `${dateFrom} to ${dateTo}`],
    ['Total Records:', filteredData.length],
    [],
    ['Date & Time', 'Temperature (°C)', 'pH', 'Salinity (ppt)', 'Turbidity (NTU)', 'DO (mg/L)']
  ];

  filteredData.forEach(item => {
    data.push([
      new Date(item.timestamp).toLocaleString(),
      item.temperature !== undefined ? parseFloat(item.temperature.toFixed(2)) : 'N/A',
      item.ph          !== undefined ? parseFloat(item.ph.toFixed(2))          : 'N/A',
      item.salinity    !== undefined ? parseFloat(item.salinity.toFixed(2))    : 'N/A',
      item.turbidity   !== undefined ? parseFloat(item.turbidity.toFixed(2))   : 'N/A',
      item.do          !== undefined ? parseFloat(item.do.toFixed(2))          : 'N/A'
    ]);
  });

  data.push([], ['--- Summary Statistics ---'], ['Parameter', 'Minimum', 'Maximum', 'Average']);
  const stats       = calculateStats(filteredData);
  const paramLabels = { temperature:'Temperature (°C)', ph:'pH', salinity:'Salinity (ppt)', turbidity:'Turbidity (NTU)', do:'DO (mg/L)' };
  Object.keys(stats).forEach(p => {
    data.push([paramLabels[p], parseFloat(stats[p].min.toFixed(2)), parseFloat(stats[p].max.toFixed(2)), parseFloat(stats[p].avg.toFixed(2))]);
  });

  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [{ wch:20 }, { wch:15 }, { wch:10 }, { wch:15 }, { wch:15 }, { wch:12 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Historical Data');
  XLSX.writeFile(wb, `${filename}.xlsx`);
}

function exportToPDF(filename, dateFrom, dateTo) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF('p', 'mm', 'a4');

  doc.setFontSize(18); doc.setTextColor(30, 41, 59);
  doc.text('Bangus Fish Pond Water Quality Report', 14, 20);
  doc.setFontSize(10); doc.setTextColor(100);
  doc.text(`Export Date: ${new Date().toLocaleString()}`, 14, 28);
  doc.text(`Date Range: ${dateFrom} to ${dateTo}`,        14, 34);
  doc.text(`Total Records: ${filteredData.length}`,       14, 40);

  doc.autoTable({
    startY: 48,
    head: [['Date & Time', 'Temp (°C)', 'pH', 'Salinity (ppt)', 'Turbidity (NTU)', 'DO (mg/L)']],
    body: filteredData.map(item => [
      new Date(item.timestamp).toLocaleString(),
      item.temperature !== undefined ? item.temperature.toFixed(2) : 'N/A',
      item.ph          !== undefined ? item.ph.toFixed(2)          : 'N/A',
      item.salinity    !== undefined ? item.salinity.toFixed(2)    : 'N/A',
      item.turbidity   !== undefined ? item.turbidity.toFixed(2)   : 'N/A',
      item.do          !== undefined ? item.do.toFixed(2)          : 'N/A'
    ]),
    theme: 'grid',
    headStyles: { fillColor: [30, 41, 59], textColor: 255, fontStyle: 'bold', halign: 'center' },
    bodyStyles: { fontSize: 9 },
    columnStyles: { 
      0: { cellWidth: 45, halign: 'left' },
      1: { cellWidth: 25, halign: 'center' },
      2: { cellWidth: 25, halign: 'center' },
      3: { cellWidth: 25, halign: 'center' },
      4: { cellWidth: 25, halign: 'center' },
      5: { cellWidth: 25, halign: 'center' }
    },
    margin: { top: 10, left: 15, right: 15, bottom: 10 },
    tableWidth: 'auto'
  });

  const stats = calculateStats(filteredData);
  const paramLabels = { temperature:'Temperature (°C)', ph:'pH', salinity:'Salinity (ppt)', turbidity:'Turbidity (NTU)', do:'DO (mg/L)' };
  let finalY = doc.lastAutoTable.finalY + 10;

  doc.setFontSize(12); doc.setTextColor(30, 41, 59);
  doc.text('Summary Statistics', 14, finalY);

  doc.autoTable({
    startY: finalY + 5,
    head: [['Parameter', 'Minimum', 'Maximum', 'Average']],
    body: Object.keys(stats).map(p => [paramLabels[p], stats[p].min.toFixed(2), stats[p].max.toFixed(2), stats[p].avg.toFixed(2)]),
    theme: 'grid',
    headStyles: { fillColor: [30, 41, 59], textColor: 255, fontStyle: 'bold', halign: 'center' },
    bodyStyles: { fontSize: 10 },
    columnStyles: { 0: { cellWidth: 50 }, 1: { cellWidth: 40, halign: 'center' }, 2: { cellWidth: 40, halign: 'center' }, 3: { cellWidth: 40, halign: 'center' } },
    margin: { top: 10, left: 15, right: 15, bottom: 10 }
  });

  finalY = doc.lastAutoTable.finalY + 10;
  doc.setFontSize(12); doc.setTextColor(30, 41, 59);
  doc.text('Water Quality Thresholds', 14, finalY);

  const thresholdData = [
    ['Temperature (°C)', '26.0 - 32.0', '24.0 - 26.0 / 32.0 - 34.0', '< 24.0 / > 34.0'],
    ['pH', '7.5 - 8.5', '7.0 - 7.5 / 8.5 - 9.0', '< 7.0 / > 9.0'],
    ['Salinity (ppt)', '15.0 - 25.0', '10.0 - 15.0 / 25.0 - 30.0', '< 10.0 / > 30.0'],
    ['Turbidity (NTU)', '20.0 - 40.0', '40.0 - 60.0', '> 60.0'],
    ['DO (mg/L)', '> 5.0', '3.0 - 5.0', '< 3.0']
  ];

  doc.autoTable({
    startY: finalY + 5,
    head: [['Parameter', 'Safe Range', 'Caution Range', 'Critical Range']],
    body: thresholdData,
    theme: 'grid',
    headStyles: { fillColor: [30, 41, 59], textColor: 255, fontStyle: 'bold', halign: 'center', fontSize: 9 },
    bodyStyles: { fontSize: 9 },
    columnStyles: { 0: { cellWidth: 40, halign: 'left' }, 1: { cellWidth: 45, halign: 'center' }, 2: { cellWidth: 50, halign: 'center' }, 3: { cellWidth: 35, halign: 'center' } },
    margin: { top: 10, left: 15, right: 15, bottom: 10 }
  });

  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i); 
    doc.setFontSize(8); 
    doc.setTextColor(150);
    doc.text(`Page ${i} of ${pageCount}`, doc.internal.pageSize.getWidth() / 2, doc.internal.pageSize.getHeight() - 10, { align: 'center' });
  }

  doc.save(`${filename}.pdf`);
}

function showExportSuccess(format) {
  const notification = document.getElementById('successNotification');
  const text = document.getElementById('successNotificationText');
  
  if (!notification || !text) return;
  
  const formatName = {csv:'CSV', excel:'Excel', pdf:'PDF'}[format];
  text.innerHTML = `<i class="fas fa-check-circle"></i> ${formatName} file downloaded successfully!`;
  notification.style.display = 'flex';
  
  setTimeout(() => notification.classList.add('show'), 10);
  
  setTimeout(() => {
    notification.classList.remove('show');
    setTimeout(() => notification.style.display = 'none', 300);
  }, 3000);
}

// ============== MAKE FUNCTIONS GLOBAL ===============
window.goToPage         = goToPage;
window.exportData       = exportData;
window.deleteSelected   = deleteSelected;
window.deleteAllFiltered = deleteAllFiltered;

console.log("✅ history.js fully loaded with ADMIN-ONLY delete security and render lock enabled");
