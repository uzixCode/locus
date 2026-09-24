/**
 * Locus GPS Telemetry Dashboard
 * Interactive Map, Charts, Scrubber & Analytics
 */

// State
let rawData = [];
let telemetryPoints = [];
let map = null;
let trackLayer = null;
let currentMarker = null;
let startMarker = null;
let endMarker = null;
let altitudeChart = null;
let speedChart = null;
let isPlaying = false;
let playInterval = null;
let currentIndex = 0;
let baseLayers = {};

// Color helper palettes
const COLOR_GRADIENTS = {
  speed: [
    { threshold: 0, color: '#3b82f6' },    // blue (stopped/slow)
    { threshold: 2, color: '#10b981' },    // green
    { threshold: 3.5, color: '#f59e0b' },  // amber
    { threshold: 5, color: '#ef4444' },    // red (fast)
  ],
  altitude: [
    { threshold: 800, color: '#3b82f6' },
    { threshold: 830, color: '#10b981' },
    { threshold: 860, color: '#f59e0b' },
    { threshold: 885, color: '#ef4444' }
  ],
  hdop: [
    { threshold: 0.8, color: '#10b981' },  // excellent
    { threshold: 1.2, color: '#3b82f6' },  // good
    { threshold: 1.8, color: '#f59e0b' },  // moderate
    { threshold: 2.5, color: '#ef4444' }   // poor
  ]
};

// Initialize Application on DOM Ready
document.addEventListener('DOMContentLoaded', () => {
  initIcons();
  initMap();
  initEventListeners();
  renderEmptyState();
});

function initIcons() {
  if (window.lucide) {
    lucide.createIcons();
  }
}

// 1. Map Initialization
function initMap() {
  map = L.map('map', {
    zoomControl: false,
    attributionControl: true
  }).setView([-8.52, 116.42], 14);

  L.control.zoom({ position: 'topright' }).addTo(map);

  // Map Tile Layers
  const osmTiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19
  });

  const satelliteTiles = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '&copy; Esri World Imagery',
    maxZoom: 19
  });

  const topoTiles = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenTopoMap',
    maxZoom: 17
  });

  osmTiles.addTo(map);

  baseLayers = {
    "OpenStreetMap": osmTiles,
    "Satellite": satelliteTiles,
    "Topographic": topoTiles
  };

  L.control.layers(baseLayers, null, { position: 'topright' }).addTo(map);

  // Group for all track lines & markers
  trackLayer = L.featureGroup().addTo(map);
}

// 2. Data Parsing & Processing
function processCsvData(csvText) {
  Papa.parse(csvText, {
    header: true,
    dynamicTyping: true,
    skipEmptyLines: true,
    complete: (results) => {
      if (!results.data || results.data.length === 0) {
        alert("Failed to parse CSV or file is empty.");
        return;
      }

      parsePoints(results.data);
    },
    error: (err) => {
      console.error("CSV Parse Error:", err);
      alert("Error parsing CSV: " + err.message);
    }
  });
}

function parsePoints(rows) {
  telemetryPoints = [];
  let cumulativeDist = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];

    // Key normalizing
    const lat = r.Latitude || r.latitude || r.lat;
    const lng = r.Longitude || r.longitude || r.lng || r.lon;
    const alt = r['Altitude(m)'] !== undefined ? r['Altitude(m)'] : (r.Altitude || r.altitude || r.alt || 0);
    const speed = r['Speed(km/h)'] !== undefined ? r['Speed(km/h)'] : (r.Speed || r.speed || 0);
    const sats = r.Satellites !== undefined ? r.Satellites : (r.satellites || r.sats || 0);
    const hdop = r.HDOP !== undefined ? r.HDOP : (r.hdop || 1.0);
    const date = r.LocalDate || r.date || '';
    const time = r.LocalTime || r.time || '';
    telemetryPoints.push({
      index: telemetryPoints.length,
      date: String(date).trim(),
      time: String(time).trim(),
      lat: Number(lat),
      lng: Number(lng),
      alt: Number(alt),
      speed: Number(speed),
      sats: Number(sats),
      hdop: Number(hdop),
      dist: cumulativeDist
    });
  }

  if (telemetryPoints.length === 0) {
    alert("No valid GPS coordinate rows found in CSV.");
    return;
  }

  // Update date in header & map status
  if (telemetryPoints[0].date) {
    document.getElementById('trackDate').textContent = `Log Date: ${telemetryPoints[0].date}`;
  }
  const badge = document.getElementById('mapStatusBadge');
  if (badge) {
    badge.className = 'text-[10px] font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded-full';
    badge.textContent = `Active (${telemetryPoints.length.toLocaleString()} pts)`;
  }

  // Calculate stats & render UI
  calculateSummaryStats();
  renderTrackOnMap();
  renderCharts();
  renderTable();

  // Set slider max
  const slider = document.getElementById('timelineSlider');
  slider.max = telemetryPoints.length - 1;
  slider.value = 0;

  // Activate initial point
  setActivePoint(0, true);
  initIcons();
}

// 3. Stats Calculations
function calculateSummaryStats() {
  if (!telemetryPoints || telemetryPoints.length === 0) return;
  const totalPoints = telemetryPoints.length;
  const totalDist = telemetryPoints[totalPoints - 1].dist;

  let maxSpeed = 0;
  let speedSum = 0;
  let minAlt = Infinity;
  let maxAlt = -Infinity;
  let elevGain = 0;
  let elevLoss = 0;
  let satsSum = 0;
  let minSats = Infinity;
  let maxSats = -Infinity;
  let hdopSum = 0;

  for (let i = 0; i < totalPoints; i++) {
    const pt = telemetryPoints[i];
    if (pt.speed > maxSpeed) maxSpeed = pt.speed;
    speedSum += pt.speed;

    if (pt.alt < minAlt) minAlt = pt.alt;
    if (pt.alt > maxAlt) maxAlt = pt.alt;

    if (i > 0) {
      const diff = pt.alt - telemetryPoints[i - 1].alt;
      if (diff > 0) elevGain += diff;
      else elevLoss += Math.abs(diff);
    }

    satsSum += pt.sats;
    if (pt.sats < minSats) minSats = pt.sats;
    if (pt.sats > maxSats) maxSats = pt.sats;

    hdopSum += pt.hdop;
  }

  const avgSpeed = totalPoints > 0 ? (speedSum / totalPoints) : 0;
  const avgSats = totalPoints > 0 ? Math.round(satsSum / totalPoints) : 0;
  const avgHdop = totalPoints > 0 ? (hdopSum / totalPoints) : 0;

  // Duration
  const startTime = telemetryPoints[0].time;
  const endTime = telemetryPoints[totalPoints - 1].time;
  const durationStr = calculateDuration(startTime, endTime);

  // Update KPIs
  document.getElementById('kpiDistance').innerHTML = `${totalDist.toFixed(2)} <span class="text-xs font-normal text-slate-400">km</span>`;
  document.getElementById('kpiPointCount').textContent = `${totalPoints.toLocaleString()} telemetry points`;

  document.getElementById('kpiDuration').textContent = durationStr;
  document.getElementById('kpiTimeSpan').textContent = `${startTime} → ${endTime}`;

  document.getElementById('kpiMaxSpeed').innerHTML = `${maxSpeed.toFixed(1)} <span class="text-xs font-normal text-slate-400">km/h</span>`;
  document.getElementById('kpiAvgSpeed').textContent = `Avg: ${avgSpeed.toFixed(1)} km/h`;

  document.getElementById('kpiAltRange').innerHTML = `${Math.round(minAlt)} - ${Math.round(maxAlt)} <span class="text-xs font-normal text-slate-400">m</span>`;
  document.getElementById('kpiElevGain').textContent = `+${Math.round(elevGain)}m / -${Math.round(elevLoss)}m`;

  document.getElementById('kpiSats').innerHTML = `${avgSats} <span class="text-xs font-normal text-slate-400">avg</span>`;
  document.getElementById('kpiSatsRange').textContent = `Min: ${minSats} | Max: ${maxSats}`;

  document.getElementById('kpiHdop').textContent = avgHdop.toFixed(2);
  let hdopLabel = 'Excellent';
  if (avgHdop > 2.0) hdopLabel = 'Moderate';
  else if (avgHdop > 1.2) hdopLabel = 'Good';
  document.getElementById('kpiHdopQuality').textContent = `${hdopLabel} Accuracy`;

  // Update dynamic gradient limits in legend
  updateLegend();
}

// 4. Map Track & Marker Rendering
function renderTrackOnMap() {
  trackLayer.clearLayers();

  if (telemetryPoints.length < 2) return;

  const colorMode = document.getElementById('colorModeSelect').value;

  // Render colored line segments
  for (let i = 0; i < telemetryPoints.length - 1; i++) {
    const p1 = telemetryPoints[i];
    const p2 = telemetryPoints[i + 1];
    const color = getSegmentColor(p1, colorMode);

    const segment = L.polyline([[p1.lat, p1.lng], [p2.lat, p2.lng]], {
      color: color,
      weight: 4,
      opacity: 0.9,
      lineCap: 'round',
      lineJoin: 'round'
    });

    // Segment tooltip & click
    segment.on('click', () => {
      setActivePoint(p1.index, false);
    });

    segment.bindTooltip(`
      <div class="font-mono text-xs">
        <div class="font-bold text-cyan-400">${p1.time}</div>
        <div>Speed: <b>${p1.speed} km/h</b></div>
        <div>Alt: <b>${p1.alt} m</b></div>
        <div>Sats: <b>${p1.sats}</b> | HDOP: <b>${p1.hdop}</b></div>
      </div>
    `, { sticky: true, className: 'leaflet-dark-tooltip' });

    trackLayer.addLayer(segment);
  }

  // Start Marker (Green)
  const startPt = telemetryPoints[0];
  startMarker = L.circleMarker([startPt.lat, startPt.lng], {
    radius: 7,
    fillColor: '#10b981',
    color: '#ffffff',
    weight: 2,
    opacity: 1,
    fillOpacity: 1
  }).bindPopup(`<b>Start Point</b><br>${startPt.time}<br>Alt: ${startPt.alt}m`);
  trackLayer.addLayer(startMarker);

  // End Marker (Red)
  const endPt = telemetryPoints[telemetryPoints.length - 1];
  endMarker = L.circleMarker([endPt.lat, endPt.lng], {
    radius: 7,
    fillColor: '#ef4444',
    color: '#ffffff',
    weight: 2,
    opacity: 1,
    fillOpacity: 1
  }).bindPopup(`<b>End Point</b><br>${endPt.time}<br>Alt: ${endPt.alt}m`);
  trackLayer.addLayer(endMarker);

  // Active Pulsing Position Marker
  const pulseIcon = L.divIcon({
    className: 'pulse-marker',
    html: '<div class="pulse-ring"></div><div class="pulse-dot"></div>',
    iconSize: [28, 28],
    iconAnchor: [14, 14]
  });

  currentMarker = L.marker([startPt.lat, startPt.lng], {
    icon: pulseIcon,
    zIndexOffset: 1000
  });
  trackLayer.addLayer(currentMarker);

  // Fit bounds to track
  map.fitBounds(trackLayer.getBounds(), { padding: [40, 40] });
}

function getSegmentColor(point, mode) {
  if (mode === 'solid') return '#06b6d4';

  if (mode === 'speed') {
    if (point.speed < 1.0) return '#3b82f6';
    if (point.speed < 2.5) return '#10b981';
    if (point.speed < 4.0) return '#f59e0b';
    return '#ef4444';
  }

  if (mode === 'altitude') {
    if (point.alt < 820) return '#3b82f6';
    if (point.alt < 845) return '#10b981';
    if (point.alt < 870) return '#f59e0b';
    return '#ef4444';
  }

  if (mode === 'hdop') {
    if (point.hdop <= 0.8) return '#10b981';
    if (point.hdop <= 1.2) return '#3b82f6';
    if (point.hdop <= 1.8) return '#f59e0b';
    return '#ef4444';
  }

  return '#06b6d4';
}

function updateLegend() {
  const mode = document.getElementById('colorModeSelect').value;
  const title = document.getElementById('legendTitle');
  const bar = document.getElementById('gradientBar');
  const min = document.getElementById('legendMin');
  const mid = document.getElementById('legendMid');
  const max = document.getElementById('legendMax');

  if (mode === 'speed') {
    title.textContent = 'Speed Gradient (km/h)';
    bar.className = 'h-2.5 rounded-full w-full bg-gradient-to-r from-blue-500 via-emerald-400 via-amber-400 to-rose-500 mb-1';
    min.textContent = '0 km/h';
    mid.textContent = '2.5 km/h';
    max.textContent = '5+ km/h';
  } else if (mode === 'altitude') {
    title.textContent = 'Altitude Gradient (m)';
    bar.className = 'h-2.5 rounded-full w-full bg-gradient-to-r from-blue-500 via-emerald-400 via-amber-400 to-rose-500 mb-1';
    min.textContent = '800 m';
    mid.textContent = '845 m';
    max.textContent = '880+ m';
  } else if (mode === 'hdop') {
    title.textContent = 'HDOP Accuracy Level';
    bar.className = 'h-2.5 rounded-full w-full bg-gradient-to-r from-emerald-500 via-blue-400 via-amber-400 to-rose-500 mb-1';
    min.textContent = '< 0.8 (Ideal)';
    mid.textContent = '1.2 (Good)';
    max.textContent = '2.0+ (Fair)';
  } else {
    title.textContent = 'Solid Color';
    bar.className = 'h-2.5 rounded-full w-full bg-cyan-500 mb-1';
    min.textContent = 'Single';
    mid.textContent = 'Color';
    max.textContent = 'Track';
  }
}

// 5. Active Point Selection & Scrubber Sync
function setActivePoint(index, centerMap = false) {
  if (!telemetryPoints || telemetryPoints.length === 0) return;
  if (index < 0) index = 0;
  if (index >= telemetryPoints.length) index = telemetryPoints.length - 1;

  currentIndex = index;
  const pt = telemetryPoints[index];

  // Update marker on map
  if (currentMarker) {
    currentMarker.setLatLng([pt.lat, pt.lng]);
    if (centerMap) {
      map.panTo([pt.lat, pt.lng], { animate: true, duration: 0.3 });
    }
  }

  // Update Scrubber UI
  document.getElementById('timelineSlider').value = index;
  document.getElementById('currentPointTime').textContent = pt.time;
  document.getElementById('currentPointProgress').textContent = `Pt ${index + 1} / ${telemetryPoints.length}`;

  // Update Inspector Panel
  document.getElementById('inspTime').textContent = pt.time;
  document.getElementById('inspSpeed').textContent = `${pt.speed.toFixed(2)} km/h`;
  document.getElementById('inspAlt').textContent = `${pt.alt.toFixed(1)} m`;
  document.getElementById('inspSats').textContent = pt.sats;
  document.getElementById('inspHdop').textContent = pt.hdop.toFixed(2);
  document.getElementById('inspDist').textContent = `${pt.dist.toFixed(2)} km`;
  document.getElementById('inspCoords').textContent = `Lat: ${pt.lat.toFixed(6)}, Lng: ${pt.lng.toFixed(6)}`;

  // Highlight table row if visible
  highlightTableRow(index);
}

function highlightTableRow(index) {
  const rows = document.querySelectorAll('#logTableBody tr');
  rows.forEach(r => r.classList.remove('active-point'));
  const activeRow = document.getElementById(`row-${index}`);
  if (activeRow) {
    activeRow.classList.add('active-point');
    activeRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// 6. Charts Rendering with Chart.js
function renderCharts() {
  if (!telemetryPoints || telemetryPoints.length === 0) {
    document.getElementById('chartAltStats').textContent = '--';
    document.getElementById('chartSpeedStats').textContent = '--';
    if (altitudeChart) { altitudeChart.destroy(); altitudeChart = null; }
    if (speedChart) { speedChart.destroy(); speedChart = null; }
    return;
  }

  const labels = telemetryPoints.map(p => p.time);
  const altData = telemetryPoints.map(p => p.alt);
  const speedData = telemetryPoints.map(p => p.speed);
  const satsData = telemetryPoints.map(p => p.sats);

  // Stats header strings
  const minAlt = Math.min(...altData);
  const maxAlt = Math.max(...altData);
  document.getElementById('chartAltStats').textContent = `Min: ${minAlt}m | Max: ${maxAlt}m`;

  const maxSpd = Math.max(...speedData);
  document.getElementById('chartSpeedStats').textContent = `Max: ${maxSpd.toFixed(1)} km/h`;

  // Destroy previous instances
  if (altitudeChart) altitudeChart.destroy();
  if (speedChart) speedChart.destroy();

  // Chart Global Defaults for Dark Mode
  Chart.defaults.color = '#94a3b8';
  Chart.defaults.borderColor = '#1e293b';

  // Altitude Chart
  const ctxAlt = document.getElementById('altitudeChart').getContext('2d');
  const altGradient = ctxAlt.createLinearGradient(0, 0, 0, 240);
  altGradient.addColorStop(0, 'rgba(245, 158, 11, 0.4)');
  altGradient.addColorStop(1, 'rgba(245, 158, 11, 0.0)');

  altitudeChart = new Chart(ctxAlt, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Altitude (m)',
        data: altData,
        borderColor: '#f59e0b',
        backgroundColor: altGradient,
        borderWidth: 2,
        fill: true,
        tension: 0.2,
        pointRadius: 0,
        pointHoverRadius: 6,
        pointHoverBackgroundColor: '#fbbf24'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false,
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0f172a',
          borderColor: '#334155',
          borderWidth: 1,
          titleFont: { family: 'monospace' },
          bodyFont: { family: 'monospace' },
          callbacks: {
            label: (ctx) => `Altitude: ${ctx.parsed.y} m`
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            maxTicksLimit: 8,
            font: { size: 10, family: 'monospace' }
          }
        },
        y: {
          grid: { color: '#1e293b' },
          ticks: {
            font: { size: 10, family: 'monospace' },
            callback: (v) => `${v}m`
          }
        }
      },
      onHover: (e, activeElements) => {
        if (activeElements && activeElements.length > 0) {
          const idx = activeElements[0].index;
          setActivePoint(idx, false);
        }
      }
    }
  });

  // Speed Chart
  const ctxSpeed = document.getElementById('speedChart').getContext('2d');
  const speedGradient = ctxSpeed.createLinearGradient(0, 0, 0, 240);
  speedGradient.addColorStop(0, 'rgba(16, 185, 129, 0.4)');
  speedGradient.addColorStop(1, 'rgba(16, 185, 129, 0.0)');

  speedChart = new Chart(ctxSpeed, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Speed (km/h)',
          data: speedData,
          borderColor: '#10b981',
          backgroundColor: speedGradient,
          borderWidth: 2,
          fill: true,
          tension: 0.2,
          pointRadius: 0,
          pointHoverRadius: 6,
          pointHoverBackgroundColor: '#34d399',
          yAxisID: 'y'
        },
        {
          label: 'Satellites',
          data: satsData,
          borderColor: '#a855f7',
          borderWidth: 1.5,
          borderDash: [3, 3],
          fill: false,
          tension: 0.1,
          pointRadius: 0,
          pointHoverRadius: 4,
          yAxisID: 'y1'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false,
      },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          align: 'end',
          labels: {
            boxWidth: 12,
            font: { size: 10 }
          }
        },
        tooltip: {
          backgroundColor: '#0f172a',
          borderColor: '#334155',
          borderWidth: 1,
          titleFont: { family: 'monospace' },
          bodyFont: { family: 'monospace' }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            maxTicksLimit: 8,
            font: { size: 10, family: 'monospace' }
          }
        },
        y: {
          type: 'linear',
          display: true,
          position: 'left',
          grid: { color: '#1e293b' },
          ticks: {
            font: { size: 10, family: 'monospace' },
            callback: (v) => `${v} km/h`
          }
        },
        y1: {
          type: 'linear',
          display: true,
          position: 'right',
          grid: { drawOnChartArea: false },
          ticks: {
            font: { size: 10, family: 'monospace' },
            stepSize: 2
          },
          min: 0,
          max: 16
        }
      },
      onHover: (e, activeElements) => {
        if (activeElements && activeElements.length > 0) {
          const idx = activeElements[0].index;
          setActivePoint(idx, false);
        }
      }
    }
  });
}

// 7. Table Rendering
function renderTable(filterText = '') {
  const tbody = document.getElementById('logTableBody');
  tbody.innerHTML = '';

  if (!telemetryPoints || telemetryPoints.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="9" class="p-8 text-center text-slate-500 font-sans text-xs">
          No telemetry data loaded. Upload a CSV file to inspect points.
        </td>
      </tr>
    `;
    document.getElementById('tableRecordCount').textContent = '0 rows';
    return;
  }

  const filter = filterText.toLowerCase().trim();
  let count = 0;

  telemetryPoints.forEach((pt) => {
    if (filter) {
      const match = pt.time.includes(filter) ||
                    String(pt.speed).includes(filter) ||
                    String(pt.alt).includes(filter) ||
                    String(pt.sats).includes(filter);
      if (!match) return;
    }

    count++;
    const tr = document.createElement('tr');
    tr.id = `row-${pt.index}`;
    tr.className = 'hover:bg-slate-800/60 cursor-pointer transition';
    tr.innerHTML = `
      <td class="p-3 text-slate-500">${pt.index + 1}</td>
      <td class="p-3">${pt.date}</td>
      <td class="p-3 text-cyan-400 font-bold">${pt.time}</td>
      <td class="p-3">${pt.lat.toFixed(6)}</td>
      <td class="p-3">${pt.lng.toFixed(6)}</td>
      <td class="p-3 text-amber-400">${pt.alt}</td>
      <td class="p-3 text-emerald-400">${pt.speed}</td>
      <td class="p-3 text-purple-400">${pt.sats}</td>
      <td class="p-3 text-rose-400">${pt.hdop}</td>
    `;

    tr.addEventListener('click', () => {
      setActivePoint(pt.index, true);
    });

    tbody.appendChild(tr);
  });

  document.getElementById('tableRecordCount').textContent = `${count} rows`;
}

// 8. Playback Controls
function togglePlayback() {
  if (isPlaying) {
    pausePlayback();
  } else {
    startPlayback();
  }
}

function startPlayback() {
  if (!telemetryPoints.length) return;
  isPlaying = true;
  document.getElementById('playIcon').setAttribute('data-lucide', 'pause');
  initIcons();

  const speedMultiplier = parseInt(document.getElementById('speedMultiplierSelect').value) || 5;
  const intervalMs = Math.max(20, Math.floor(300 / speedMultiplier));

  playInterval = setInterval(() => {
    if (currentIndex >= telemetryPoints.length - 1) {
      pausePlayback();
      return;
    }
    setActivePoint(currentIndex + 1, true);
  }, intervalMs);
}

function pausePlayback() {
  isPlaying = false;
  clearInterval(playInterval);
  document.getElementById('playIcon').setAttribute('data-lucide', 'play');
  initIcons();
}

function stopPlayback() {
  pausePlayback();
  setActivePoint(0, true);
}

// 9. Event Listeners Setup
function initEventListeners() {
  // File Upload
  const fileInput = document.getElementById('csvFileInput');
  const uploadBtn = document.getElementById('uploadBtn');

  uploadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      processCsvData(event.target.result);
    };
    reader.readAsText(file);
  });

  // Playback Buttons
  document.getElementById('playPauseBtn').addEventListener('click', togglePlayback);
  document.getElementById('stopBtn').addEventListener('click', stopPlayback);

  document.getElementById('speedMultiplierSelect').addEventListener('change', () => {
    if (isPlaying) {
      pausePlayback();
      startPlayback();
    }
  });

  // Timeline slider
  const slider = document.getElementById('timelineSlider');
  slider.addEventListener('input', (e) => {
    pausePlayback();
    setActivePoint(parseInt(e.target.value), true);
  });

  // Color Mode
  document.getElementById('colorModeSelect').addEventListener('change', () => {
    renderTrackOnMap();
    updateLegend();
  });

  // Center / Fit Map Bounds
  document.getElementById('fitBoundsBtn').addEventListener('click', () => {
    if (trackLayer && trackLayer.getBounds().isValid()) {
      map.fitBounds(trackLayer.getBounds(), { padding: [40, 40] });
    }
  });

  // Table Search
  document.getElementById('tableSearchInput').addEventListener('input', (e) => {
    renderTable(e.target.value);
  });

  // Copy Coords button
  document.getElementById('copyCoordsBtn').addEventListener('click', () => {
    if (telemetryPoints[currentIndex]) {
      const pt = telemetryPoints[currentIndex];
      navigator.clipboard.writeText(`${pt.lat},${pt.lng}`);
      alert(`Copied: ${pt.lat}, ${pt.lng}`);
    }
  });

  // Export GPX
  document.getElementById('exportGpxBtn').addEventListener('click', exportGpx);

  // Drag and Drop File Handlers
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    document.getElementById('dropZone').classList.remove('hidden');
  });

  window.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) {
      document.getElementById('dropZone').classList.add('hidden');
    }
  });

  window.addEventListener('drop', (e) => {
    e.preventDefault();
    document.getElementById('dropZone').classList.add('hidden');
    if (e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      const reader = new FileReader();
      reader.onload = (event) => {
        processCsvData(event.target.result);
      };
      reader.readAsText(file);
    }
  });
}

// 10. Initial Empty State
function renderEmptyState() {
  telemetryPoints = [];
  currentIndex = 0;
  isPlaying = false;
  if (playInterval) clearInterval(playInterval);

  // Reset KPI displays
  document.getElementById('kpiDistance').innerHTML = `0.00 <span class="text-xs font-normal text-slate-400">km</span>`;
  document.getElementById('kpiPointCount').textContent = `0 points`;
  document.getElementById('kpiDuration').textContent = `00:00:00`;
  document.getElementById('kpiTimeSpan').textContent = `--:--:-- → --:--:--`;
  document.getElementById('kpiMaxSpeed').innerHTML = `0.0 <span class="text-xs font-normal text-slate-400">km/h</span>`;
  document.getElementById('kpiAvgSpeed').textContent = `Avg: 0.0 km/h`;
  document.getElementById('kpiAltRange').innerHTML = `0 - 0 <span class="text-xs font-normal text-slate-400">m</span>`;
  document.getElementById('kpiElevGain').textContent = `Gain: +0m | Loss: -0m`;
  document.getElementById('kpiSats').innerHTML = `0 <span class="text-xs font-normal text-slate-400">avg</span>`;
  document.getElementById('kpiSatsRange').textContent = `Min: 0 | Max: 0`;
  document.getElementById('kpiHdop').textContent = `0.00`;
  document.getElementById('kpiHdopQuality').textContent = `Awaiting Data`;

  // Reset Inspector
  document.getElementById('inspTime').textContent = `--:--:--`;
  document.getElementById('inspSpeed').textContent = `0.00 km/h`;
  document.getElementById('inspAlt').textContent = `0.0 m`;
  document.getElementById('inspSats').textContent = `0`;
  document.getElementById('inspHdop').textContent = `0.00`;
  document.getElementById('inspDist').textContent = `0.00 km`;
  document.getElementById('inspCoords').textContent = `Lat: --, Lng: --`;

  // Reset Scrubber & Badges
  document.getElementById('currentPointTime').textContent = `--:--:--`;
  document.getElementById('currentPointProgress').textContent = `Pt 0 / 0`;
  const slider = document.getElementById('timelineSlider');
  if (slider) {
    slider.min = 0;
    slider.max = 0;
    slider.value = 0;
  }

  const badge = document.getElementById('mapStatusBadge');
  if (badge) {
    badge.className = 'text-[10px] font-mono bg-slate-800 text-slate-400 border border-slate-700 px-2 py-0.5 rounded-full';
    badge.textContent = 'Awaiting Data';
  }

  // Clear map track & layers
  if (trackLayer) trackLayer.clearLayers();

  // Reset table & charts
  renderTable();
  renderCharts();
  updateLegend();
}

// 11. Helper Functions (Haversine & Time Math)
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in km
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function deg2rad(deg) {
  return deg * (Math.PI / 180);
}

function calculateDuration(startStr, endStr) {
  if (!startStr || !endStr) return "00:00:00";
  const parseSec = (t) => {
    const parts = t.split(':').map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return 0;
  };
  const s1 = parseSec(startStr);
  const s2 = parseSec(endStr);
  let diff = s2 - s1;
  if (diff < 0) diff += 86400; // handle midnight wrap

  const h = Math.floor(diff / 3600).toString().padStart(2, '0');
  const m = Math.floor((diff % 3600) / 60).toString().padStart(2, '0');
  const s = (diff % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

// 12. GPX Export
function exportGpx() {
  if (!telemetryPoints.length) {
    alert("No data available to export.");
    return;
  }

  let gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Locus GPS Telemetry Viewer" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>Locus Telemetry Track ${telemetryPoints[0].date}</name>
  </metadata>
  <trk>
    <name>Track ${telemetryPoints[0].date} ${telemetryPoints[0].time}</name>
    <trkseg>\n`;

  telemetryPoints.forEach(p => {
    gpx += `      <trkpt lat="${p.lat}" lon="${p.lng}">
        <ele>${p.alt}</ele>
        <time>${p.date}T${p.time}Z</time>
        <extensions>
          <speed>${p.speed}</speed>
          <satellites>${p.sats}</satellites>
          <hdop>${p.hdop}</hdop>
        </extensions>
      </trkpt>\n`;
  });

  gpx += `    </trkseg>
  </trk>
</gpx>`;

  const blob = new Blob([gpx], { type: 'application/gpx+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `track_${telemetryPoints[0].date.replace(/\//g, '-')}.gpx`;
  a.click();
  URL.revokeObjectURL(url);
}
