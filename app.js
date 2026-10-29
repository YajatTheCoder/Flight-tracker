// =============================================================================
// Flightradar24 Live Air Traffic Radar & Intelligence
// =============================================================================

// Base Map Providers (100% Free, No API Keys Required)
const tileProviders = {
  dark: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    options: {
      attribution: '&copy; <a href="https://www.esri.com/">Esri</a>, HERE, Garmin, &copy; OpenStreetMap',
      maxNativeZoom: 16,
      maxZoom: 19
    },
    referenceUrl: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}"
  },
  satellite: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    options: {
      attribution: '&copy; <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics',
      maxNativeZoom: 18,
      maxZoom: 19
    }
  },
  voyager: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
    options: {
      attribution: '&copy; <a href="https://www.esri.com/">Esri</a>, Garmin, &copy; OpenStreetMap',
      maxNativeZoom: 18,
      maxZoom: 19
    }
  },
  osm: {
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    options: {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19
    }
  }
};

let currentMapStyle = "dark";
const map = L.map("map", { zoomControl: false, preferCanvas: true }).setView([40.7128, -74.0060], 7);
L.control.zoom({ position: "bottomright" }).addTo(map);

// Dedicated pane for labels and boundaries sitting below markers and aircraft
map.createPane("labelsPane");
map.getPane("labelsPane").style.zIndex = "250";
map.getPane("labelsPane").style.pointerEvents = "none";

let baseLayer = null;
let referenceLayer = null;

function applyMapStyle(styleKey) {
  const provider = tileProviders[styleKey] || tileProviders.dark;
  if (baseLayer) {
    map.removeLayer(baseLayer);
    baseLayer = null;
  }
  if (referenceLayer) {
    map.removeLayer(referenceLayer);
    referenceLayer = null;
  }

  baseLayer = L.tileLayer(provider.url, provider.options).addTo(map);
  baseLayer.bringToBack();

  if (provider.referenceUrl) {
    referenceLayer = L.tileLayer(provider.referenceUrl, {
      attribution: "",
      maxNativeZoom: provider.options.maxNativeZoom || 16,
      maxZoom: provider.options.maxZoom || 19,
      pane: "labelsPane"
    }).addTo(map);
  }
  currentMapStyle = styleKey;
}

// Initialize default FR24 dark radar style
applyMapStyle("dark");

// Overlays & Layers
let weatherRadarLayer = null;
let dayNightLayer = null;
const aircraftLayer = L.layerGroup().addTo(map);
const airportLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const trailLayer = L.layerGroup().addTo(map);

// UI Element References
const flightList = document.getElementById("flightList");
const selectionPanel = document.getElementById("selectionPanel");
const flightInfoCard = document.getElementById("flightInfoCard");
const airportList = document.getElementById("airportList");
const airportDetailPanel = document.getElementById("airportDetailPanel");
const mapLoading = document.getElementById("mapLoading");
const coveragePill = document.getElementById("coveragePill");
const searchInput = document.getElementById("flightSearch");
const searchResults = document.getElementById("searchResults");
const trafficFilter = document.getElementById("trafficFilter");
const cockpitModal = document.getElementById("cockpitModal");
const mostTrackedDrawer = document.getElementById("mostTrackedDrawer");
const emergencyBanner = document.getElementById("squawkEmergencyBanner");

// State Variables
let aircraft = [];
let markers = new Map();
let flightTrails = new Map(); // hex -> [{lat, lon, alt, time}]
let selectedHex = null;
let followingHex = null;
let lastFetchKey = "";
let sortCriteria = "nearest"; // nearest, callsign, alt, speed
let toastTimeout = null;
let fetchController = null;
let moveTimeout = null;
let airports = [];
let airportMarkers = new Map();
let selectedAirportId = null;
let airportFetchController = null;
let lastAirportFetchKey = "";
let globalSearchController = null;
let globalSearchMatches = { airports: [], airlines: [], aircraft: [] };
const airportMetarCache = new Map();
const airportPhotoCache = new Map();
const airlabsFlightCache = new Map();
const airportLookupCache = new Map();
let cockpitMap = null;
let cockpitMapLayer = null;
let useMetricUnits = false;
let colorByAltitude = false;
let simulatedEmergencyHex = null;

// =============================================================================
// SVG Aircraft Silhouettes (Flightradar24 Style)
// =============================================================================
function getPlaneSvg(type, category) {
  const cat = String(category || "").toUpperCase();
  const t = String(type || "").toUpperCase();

  // Heavy / 4-Engine (B747, A380, A340, AN124)
  if (/^(B74|A38|A34|A124|AN22|C17|C5)/.test(t) || cat === "A5") {
    return `<svg viewBox="0 0 48 48" class="plane-svg heavy"><path d="M24 1.5C22.7 1.5 21.6 2.6 21.6 3.9V17L4 25.5V30.5L21.6 25V37.5L16 41.5V45L24 43L32 45V41.5L26.4 37.5V25L44 30.5V25.5L26.4 17V3.9C26.4 2.6 25.3 1.5 24 1.5Z"/><circle cx="11" cy="22" r="1.6"/><circle cx="17" cy="20" r="1.6"/><circle cx="31" cy="20" r="1.6"/><circle cx="37" cy="22" r="1.6"/></svg>`;
  }

  // Helicopter
  if (/^(EC|H1|H2|R44|R66|B06|B20|B40|B42|S76|S92|AS3|UH6|AW1|CH4)/.test(t) || cat === "A7" || cat === "B7") {
    return `<svg viewBox="0 0 48 48" class="plane-svg heli"><path d="M24 4C14 4 6 12 6 22H18L21 16H27L30 22H42C42 12 34 4 24 4Z" fill="currentColor"/><circle cx="24" cy="22" r="3"/><path d="M22 25H26V37H22ZM18 37H30V40H18ZM20 40H28V43H20Z" fill="currentColor"/><line x1="8" y1="22" x2="40" y2="22" stroke="currentColor" stroke-width="2.5"/></svg>`;
  }

  // Turboprop / Regional (ATR, Dash 8, King Air, Beechcraft)
  if (/^(AT4|AT7|DH8|B350|BE20|PC12|C208|SF34|SW4|D228)/.test(t)) {
    return `<svg viewBox="0 0 48 48" class="plane-svg turboprop"><path d="M24 2C22.8 2 22 2.9 22 4.2V17.5L5 23.5V27.5L22 24.5V37L16 41V44L24 42L32 44V41L26 37V24.5L43 27.5V23.5L26 17.5V4.2C26 2.9 25.2 2 24 2Z"/><ellipse cx="14" cy="21.5" rx="2" ry="1.2"/><ellipse cx="34" cy="21.5" rx="2" ry="1.2"/></svg>`;
  }

  // General Aviation / Light Prop (C172, PA28, SR22)
  if (/^(C15|C17|C18|C21|PA2|SR2|DA4|AA5|RV)/.test(t) || cat === "A1") {
    return `<svg viewBox="0 0 48 48" class="plane-svg ga"><path d="M24 4C23.2 4 22.5 4.7 22.5 5.5V19L8 20V23L22.5 22.5V38L18 41V43L24 42L30 43V41L25.5 38V22.5L40 23V20L25.5 19V5.5C25.5 4.7 24.8 4 24 4Z"/></svg>`;
  }

  // Standard Commercial Jet (B737, A320, B777, B787, A350, A330, E190, CRJ)
  return `<svg viewBox="0 0 48 48" class="plane-svg airliner"><path d="M24 2C22.9 2 22 2.9 22 4L22 18L6 26V30L22 25V37L17 41V44L24 42L31 44V41L26 37V25L42 30V26L26 18L26 4C26 2.9 25.1 2 24 2Z"/></svg>`;
}

// Altitude Color Mapping
function getAltitudeColorClass(altitude) {
  if (!colorByAltitude || altitude === null || altitude === undefined) return "";
  if (altitude < 5000) return "plane-alt-red";
  if (altitude < 12000) return "plane-alt-orange";
  if (altitude < 22000) return "plane-alt-yellow";
  if (altitude < 30000) return "plane-alt-green";
  if (altitude < 36000) return "plane-alt-cyan";
  if (altitude < 41000) return "plane-alt-blue";
  return "plane-alt-purple";
}

function getAltitudeHexColor(altitude) {
  if (altitude < 5000) return "#ef4444";
  if (altitude < 12000) return "#f97316";
  if (altitude < 22000) return "#facc15";
  if (altitude < 30000) return "#22c55e";
  if (altitude < 36000) return "#06b6d4";
  if (altitude < 41000) return "#3b82f6";
  return "#a855f7";
}

// =============================================================================
// Helper Functions
// =============================================================================
function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function formatNumber(value, digits = 0) {
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString("en-US", { maximumFractionDigits: digits }) : "--";
}

function altitudeOf(item) {
  return Number.isFinite(item.alt_baro) ? item.alt_baro : Number.isFinite(item.alt_geom) ? item.alt_geom : null;
}

function callsignOf(item) {
  return (item.flight || item.r || item.hex || "Unknown").trim();
}

function distanceFromMap(item) {
  return map.distance(map.getCenter(), [item.lat, item.lon]);
}

function headingToCompass(deg) {
  if (!Number.isFinite(deg)) return "--";
  const cardinals = ["North", "NNE", "NE", "ENE", "East", "ESE", "SE", "SSE", "South", "SSW", "SW", "WSW", "West", "WNW", "NW", "NNW"];
  const index = Math.round(deg / 22.5) % 16;
  return cardinals[index];
}

// =============================================================================
// Visible Aircraft & Sorting
// =============================================================================
function visibleAircraft() {
  const query = searchInput.value.trim().toLowerCase();
  const filter = trafficFilter.value;
  let results = aircraft.filter((item) => {
    const altitude = altitudeOf(item);
    if (query && ![callsignOf(item), item.hex, item.r, item.t].some((val) => String(val || "").toLowerCase().includes(query))) return false;
    if (filter === "airliner" && !(item.category === "A5" || item.category === "A4" || (item.t && /^(A[0-9]|B[0-9]|E[0-9]|CRJ|ERJ|AT[0-9]|DH8)/i.test(item.t)))) return false;
    if (filter === "altitude" && !(altitude !== null && altitude >= 20000)) return false;
    if (filter === "low" && !(altitude !== null && altitude < 10000)) return false;
    if (filter === "emergency" && !(item.squawk === "7700" || item.squawk === "7600" || item.squawk === "7500" || item.hex === simulatedEmergencyHex)) return false;
    return true;
  });

  if (sortCriteria === "nearest") {
    results.sort((a, b) => distanceFromMap(a) - distanceFromMap(b));
  } else if (sortCriteria === "callsign") {
    results.sort((a, b) => callsignOf(a).localeCompare(callsignOf(b)));
  } else if (sortCriteria === "altitude") {
    results.sort((a, b) => (altitudeOf(b) || 0) - (altitudeOf(a) || 0));
  } else if (sortCriteria === "speed") {
    results.sort((a, b) => (b.gs || 0) - (a.gs || 0));
  }

  return results;
}

// =============================================================================
// Render Markers & Trails on Map
// =============================================================================
function markerIcon(item, selected = false) {
  const track = Number.isFinite(item.track) ? item.track : 0;
  const svg = getPlaneSvg(item.t, item.category);
  const altClass = getAltitudeColorClass(altitudeOf(item));

  return L.divIcon({
    className: "",
    html: `<div class="plane-marker${selected ? " selected" : ""} ${altClass}" style="transform:rotate(${track}deg)">${svg}</div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16]
  });
}

function updateFlightTrails(item) {
  if (!Number.isFinite(item.lat) || !Number.isFinite(item.lon)) return;
  const hex = item.hex;
  if (!flightTrails.has(hex)) {
    flightTrails.set(hex, []);
  }
  const trail = flightTrails.get(hex);
  const last = trail[trail.length - 1];
  const now = Date.now();

  // Only record if position changed significantly or 8 seconds passed
  if (!last || Math.abs(last.lat - item.lat) > 0.002 || Math.abs(last.lon - item.lon) > 0.002 || now - last.time > 8000) {
    trail.push({ lat: item.lat, lon: item.lon, alt: altitudeOf(item), time: now });
    if (trail.length > 60) trail.shift();
  }
}

function renderMarkers() {
  const bounds = map.getBounds().pad(0.12);
  const activeHexes = new Set();

  aircraft.forEach((item) => {
    if (!Number.isFinite(item.lat) || !Number.isFinite(item.lon)) return;
    updateFlightTrails(item);

    const isSelected = item.hex === selectedHex;
    if (!isSelected && !bounds.contains([item.lat, item.lon])) return;
    activeHexes.add(item.hex);
    let marker = markers.get(item.hex);
    const altText = altitudeOf(item) !== null ? `${formatNumber(altitudeOf(item))} ft` : "";
    const speedText = Number.isFinite(item.gs) ? `${formatNumber(item.gs)} kt` : "";
    const tooltipText = `${callsignOf(item)}${altText ? ` · ${altText}` : ""}${speedText ? ` · ${speedText}` : ""}`;

    if (!marker) {
      marker = L.marker([item.lat, item.lon], { icon: markerIcon(item, isSelected), keyboard: true, title: callsignOf(item) });
      marker.on("click", () => selectAircraft(item.hex, false));
      marker.bindTooltip(escapeHtml(tooltipText), { direction: "top", offset: [0, -14], className: "flight-tooltip" });
      marker.addTo(aircraftLayer);
      markers.set(item.hex, marker);
    } else {
      marker.setLatLng([item.lat, item.lon]);
      marker.setIcon(markerIcon(item, isSelected));
      marker.setTooltipContent(escapeHtml(tooltipText));
    }
  });

  markers.forEach((marker, hex) => {
    if (!activeHexes.has(hex)) {
      aircraftLayer.removeLayer(marker);
      markers.delete(hex);
    }
  });

  // Render selected aircraft's flight trail
  renderSelectedTrail();

  // Check for emergency squawks
  checkEmergencyAlerts();
}

function renderSelectedTrail() {
  trailLayer.clearLayers();
  if (!selectedHex) return;

  const trail = flightTrails.get(selectedHex);
  if (!trail || trail.length < 2) return;

  // Draw gradient segments along the trail
  for (let i = 0; i < trail.length - 1; i++) {
    const p1 = trail[i];
    const p2 = trail[i + 1];
    const color = getAltitudeHexColor(p2.alt || 20000);
    L.polyline([[p1.lat, p1.lon], [p2.lat, p2.lon]], {
      color: color,
      weight: 3.5,
      opacity: 0.85,
      lineCap: "round"
    }).addTo(trailLayer);
  }
}

// =============================================================================
// Flight List (Side Panel)
// =============================================================================
function renderFlights() {
  const results = visibleAircraft();
  document.getElementById("tabFlightCount").textContent = formatNumber(aircraft.length);
  document.getElementById("mapFlightCount").textContent = formatNumber(aircraft.length);

  if (!results.length) {
    const hasAircraft = aircraft.length > 0;
    flightList.innerHTML = `<div class="empty-state"><span class="empty-mark" aria-hidden="true">${hasAircraft ? "⌕" : "✳"}</span><p>${hasAircraft ? "No aircraft match this filter." : "No live aircraft reports in this area."}</p></div>`;
    return;
  }

  flightList.innerHTML = results.map((item) => {
    const hex = escapeHtml(item.hex || "");
    const altitude = altitudeOf(item);
    const type = escapeHtml(item.t || "Aircraft");
    const callsign = escapeHtml(callsignOf(item));
    const altText = altitude === null ? "--" : useMetricUnits ? `${formatNumber(altitude * 0.3048)} m` : `${formatNumber(altitude)} ft`;
    const speedText = Number.isFinite(item.gs) ? useMetricUnits ? `${formatNumber(item.gs * 1.852)} km/h` : `${formatNumber(item.gs)} kt` : "--";
    const isSelected = item.hex === selectedHex;

    return `<button class="flight-row${isSelected ? " selected" : ""}" type="button" data-hex="${hex}" aria-label="Select ${callsign}">
      <span class="flight-glyph" aria-hidden="true">✈</span>
      <span class="flight-main">
        <span class="flight-callsign">${callsign}</span>
        <span class="flight-subline">${type} · ${escapeHtml(item.r || item.hex || "")}</span>
      </span>
      <span class="flight-metrics">
        <span class="flight-altitude">${altText}</span>
        <span class="flight-speed">${speedText}</span>
      </span>
    </button>`;
  }).join("");
}

// =============================================================================
// Flight Selection & Telemetry Details Card
// =============================================================================
async function selectAircraft(hex, moveMap = true) {
  const item = aircraft.find((c) => c.hex === hex);
  if (!item) return;

  selectedHex = hex;
  if (moveMap) {
    map.flyTo([item.lat, item.lon], Math.max(map.getZoom(), 9), { duration: 0.6 });
  }

  renderMarkers();
  renderFlights();
  renderSelectedTrail();

  // Populate Bottom Quick Details in Side Panel
  const altitude = altitudeOf(item);
  const details = [
    ["AIRCRAFT", item.t || "Unknown"],
    ["REGISTRATION", item.r || "Unknown"],
    ["ALTITUDE", altitude === null ? "Unknown" : `${formatNumber(altitude)} ft`],
    ["SPEED", Number.isFinite(item.gs) ? `${formatNumber(item.gs)} kt` : "Unknown"],
    ["HEADING", Number.isFinite(item.track) ? `${formatNumber(item.track)}° ${headingToCompass(item.track)}` : "Unknown"],
    ["SQUAWK", item.squawk || "Unknown"],
    ["V/S RATE", Number.isFinite(item.baro_rate) ? `${formatNumber(item.baro_rate)} ft/min` : "Level"],
    ["COORDINATES", `${item.lat.toFixed(3)}, ${item.lon.toFixed(3)}`],
    ["LAST REPORT", Number.isFinite(item.seen) ? `${formatNumber(item.seen, 1)}s ago` : "Live"]
  ];

  selectionPanel.innerHTML = `
    <div class="selection-content">
      <div class="selection-heading">
        <strong>${escapeHtml(callsignOf(item))}</strong>
        <span>${escapeHtml((item.hex || "").toUpperCase())}</span>
      </div>
      <div class="detail-grid">
        ${details.map(([label, val]) => `<div class="detail-cell"><span>${label}</span><span>${escapeHtml(val)}</span></div>`).join("")}
      </div>
    </div>
  `;

  // Render the iconic FR24 Floating Flight Card
  renderFlightInfoCard(item);
}

function renderFlightInfoCard(item) {
  const callsign = callsignOf(item);
  const hex = (item.hex || "").toUpperCase();
  const altitude = altitudeOf(item);
  const speedKt = Number.isFinite(item.gs) ? item.gs : null;
  const vs = Number.isFinite(item.baro_rate) ? item.baro_rate : null;

  document.getElementById("flightCardCallsign").textContent = callsign;
  document.getElementById("flightCardHex").textContent = hex;
  document.getElementById("flightCardType").textContent = item.t ? `Type: ${item.t}` : "Aircraft";
  document.getElementById("flightCardReg").textContent = item.r || hex;
  document.getElementById("flightCardModel").textContent = item.t || "Unknown";
  document.getElementById("flightCardRegistration").textContent = item.r || "Unknown";
  document.getElementById("flightCardHexRaw").textContent = hex;
  document.getElementById("flightCardCategory").textContent = item.category || "Commercial";
  document.getElementById("flightCardPosition").textContent = `${item.lat.toFixed(4)}°, ${item.lon.toFixed(4)}°`;
  document.getElementById("flightCardLastSeen").textContent = Number.isFinite(item.seen) ? `${formatNumber(item.seen, 1)}s ago` : "Live";

  // Telemetry: Altitude & VS
  if (altitude !== null) {
    document.getElementById("flightCardAltitude").textContent = useMetricUnits ? `${formatNumber(altitude * 0.3048)} m` : `${formatNumber(altitude)} ft`;
  } else {
    document.getElementById("flightCardAltitude").textContent = "--";
  }

  const vsIndicator = document.getElementById("flightCardVsIndicator");
  const vsText = document.getElementById("flightCardVsText");
  if (vs !== null && Math.abs(vs) > 64) {
    if (vs > 0) {
      vsIndicator.textContent = "↑";
      vsIndicator.className = "vs-indicator up";
      vsText.textContent = `+${formatNumber(vs)} ft/min (climb)`;
    } else {
      vsIndicator.textContent = "↓";
      vsIndicator.className = "vs-indicator down";
      vsText.textContent = `${formatNumber(vs)} ft/min (descent)`;
    }
  } else {
    vsIndicator.textContent = "→";
    vsIndicator.className = "vs-indicator";
    vsText.textContent = "Level flight";
  }

  // Telemetry: Speed
  if (speedKt !== null) {
    document.getElementById("flightCardSpeed").textContent = useMetricUnits ? `${formatNumber(speedKt * 1.852)} km/h` : `${formatNumber(speedKt)} kt`;
    document.getElementById("flightCardSpeedSub").textContent = `${formatNumber(speedKt * 1.15078)} mph · ${formatNumber(speedKt * 1.852)} km/h`;
  } else {
    document.getElementById("flightCardSpeed").textContent = "--";
    document.getElementById("flightCardSpeedSub").textContent = "--";
  }

  // Telemetry: Heading
  const track = Number.isFinite(item.track) ? item.track : null;
  document.getElementById("flightCardHeading").textContent = track !== null ? `${formatNumber(track)}°` : "--";
  document.getElementById("flightCardHeadingCompass").textContent = track !== null ? headingToCompass(track) : "--";

  // Telemetry: Squawk
  const squawkEl = document.getElementById("flightCardSquawk");
  squawkEl.textContent = item.squawk || "----";
  if (item.squawk === "7700" || item.squawk === "7600" || item.squawk === "7500" || item.hex === simulatedEmergencyHex) {
    squawkEl.className = "squawk-code emergency";
    document.getElementById("flightCardSquawkMode").textContent = "EMERGENCY";
  } else {
    squawkEl.className = "squawk-code";
    document.getElementById("flightCardSquawkMode").textContent = "Mode-S / ADS-B";
  }

  // Default Route Placeholders before AirLabs lookup
  const initialDep = item.dep_iata || item.dep_icao || "---";
  const initialArr = item.arr_iata || item.arr_icao || "---";
  document.getElementById("flightCardOriginIata").textContent = initialDep;
  document.getElementById("flightCardOriginCity").textContent = "Departure";
  document.getElementById("flightCardDestIata").textContent = initialArr;
  document.getElementById("flightCardDestCity").textContent = "Arrival";
  document.getElementById("flightCardDepTime").textContent = "STD --:--";
  document.getElementById("flightCardArrTime").textContent = "STA --:--";
  document.getElementById("flightCardAirline").textContent = "Searching airline…";

  // Reset Logo
  const logoImg = document.getElementById("airlineLogo");
  const fallbackBadge = document.getElementById("airlineFallbackBadge");
  logoImg.hidden = true;
  fallbackBadge.hidden = false;
  fallbackBadge.textContent = (callsign.slice(0, 3) || "AIR").toUpperCase();

  flightInfoCard.hidden = false;

  // Immediately draw route if airports already present on aircraft object
  if (item.dep_iata || item.arr_iata) {
    drawFlightRouteOnMap(item, item.dep_iata || item.dep_icao, item.arr_iata || item.arr_icao);
  }

  // Load Schedule, Airline & Route from Server
  loadFlightRouteData(item);
}

// Load flight schedule, airline details, and route lines
async function loadFlightRouteData(item) {
  const hex = String(item.hex || "").toUpperCase();
  const callsign = callsignOf(item);

  try {
    const response = await fetch(`/api/flight-info?hex=${encodeURIComponent(hex)}&callsign=${encodeURIComponent(callsign)}`);
    if (!response.ok) throw new Error("Flight info unavailable");
    const data = await response.json();
    const flight = data.flight;

    if (!flight || selectedHex !== item.hex) return;

    // Apply Airline Logo & Name
    const airlineIata = (flight.airline_iata || flight.airline_icao || callsign.slice(0, 2)).toUpperCase();
    const airlineName = flight.airline_name || `${airlineIata} Airlines`;
    document.getElementById("flightCardAirline").textContent = airlineName;

    if (airlineIata && airlineIata.length === 2) {
      const logoImg = document.getElementById("airlineLogo");
      const fallbackBadge = document.getElementById("airlineFallbackBadge");
      logoImg.src = `https://images.kiwi.com/airlines/64/${airlineIata}.png`;
      logoImg.onload = () => {
        logoImg.hidden = false;
        fallbackBadge.hidden = true;
      };
      logoImg.onerror = () => {
        logoImg.hidden = true;
        fallbackBadge.hidden = false;
      };
    }

    // Apply Route Airports
    const depIata = (flight.dep_iata || flight.dep_icao || "").toUpperCase();
    const arrIata = (flight.arr_iata || flight.arr_icao || "").toUpperCase();

    if (depIata) document.getElementById("flightCardOriginIata").textContent = depIata;
    if (arrIata) document.getElementById("flightCardDestIata").textContent = arrIata;

    if (flight.dep_time) document.getElementById("flightCardDepTime").textContent = `STD ${flight.dep_time.slice(-5)}`;
    if (flight.arr_time) document.getElementById("flightCardArrTime").textContent = `STA ${flight.arr_time.slice(-5)}`;

    // Operations Tab Data
    document.getElementById("flightCardStd").textContent = flight.dep_time || "--";
    document.getElementById("flightCardAtd").textContent = flight.dep_actual || flight.dep_estimated || "--";
    document.getElementById("flightCardSta").textContent = flight.arr_time || "--";
    document.getElementById("flightCardEta").textContent = flight.arr_estimated || "--";
    document.getElementById("flightCardDepGate").textContent = [flight.dep_terminal ? `T${flight.dep_terminal}` : "", flight.dep_gate ? `Gate ${flight.dep_gate}` : ""].filter(Boolean).join(" · ") || "Not reported";
    document.getElementById("flightCardArrGate").textContent = [flight.arr_terminal ? `T${flight.arr_terminal}` : "", flight.arr_gate ? `Gate ${flight.arr_gate}` : ""].filter(Boolean).join(" · ") || "Not reported";
    document.getElementById("flightCardBaggage").textContent = flight.arr_baggage ? `Belt ${flight.arr_baggage}` : "Not assigned";
    document.getElementById("flightCardDuration").textContent = flight.duration ? `${flight.duration} min` : "--";

    // Draw Route Lines on Map
    if (depIata || arrIata) {
      drawFlightRouteOnMap(item, depIata, arrIata);
    }
  } catch (err) {
    console.warn("Could not load flight schedule:", err);
  }
}

// Draw Departure Airport -> Plane -> Arrival Airport Great Circle Lines
async function drawFlightRouteOnMap(item, depCode, arrCode) {
  routeLayer.clearLayers();

  const [depApt, arrApt] = await Promise.all([
    lookupAirport(depCode),
    lookupAirport(arrCode)
  ]);

  if (selectedHex !== item.hex) return;

  // Solid line from Departure Airport to Plane
  if (depApt) {
    document.getElementById("flightCardOriginCity").textContent = depApt.municipality || depApt.name;
    L.polyline([[depApt.lat, depApt.lon], [item.lat, item.lon]], {
      color: "#00e5ff",
      weight: 2.5,
      opacity: 0.85
    }).addTo(routeLayer);

    // Departure Pin
    const depPin = L.divIcon({
      className: "",
      html: `<span class="route-airport-badge dep">🛫 ${depApt.iata || depApt.icao}</span>`,
      iconSize: [52, 22],
      iconAnchor: [26, 11]
    });
    L.marker([depApt.lat, depApt.lon], { icon: depPin }).addTo(routeLayer);
  }

  // Dashed line from Plane to Arrival Airport
  if (arrApt) {
    document.getElementById("flightCardDestCity").textContent = arrApt.municipality || arrApt.name;
    L.polyline([[item.lat, item.lon], [arrApt.lat, arrApt.lon]], {
      color: "#ffcc00",
      weight: 2.5,
      opacity: 0.85,
      dashArray: "6, 6"
    }).addTo(routeLayer);

    // Arrival Pin
    const arrPin = L.divIcon({
      className: "",
      html: `<span class="route-airport-badge arr">🛬 ${arrApt.iata || arrApt.icao}</span>`,
      iconSize: [52, 22],
      iconAnchor: [26, 11]
    });
    L.marker([arrApt.lat, arrApt.lon], { icon: arrPin }).addTo(routeLayer);
  }

  // Calculate distance
  if (depApt && arrApt) {
    const totalDistNm = map.distance([depApt.lat, depApt.lon], [arrApt.lat, arrApt.lon]) / 1852;
    const flownDistNm = map.distance([depApt.lat, depApt.lon], [item.lat, item.lon]) / 1852;
    const pct = Math.min(100, Math.max(0, Math.round((flownDistNm / totalDistNm) * 100)));
    document.getElementById("routeDistanceLabel").textContent = `${formatNumber(flownDistNm)} / ${formatNumber(totalDistNm)} NM (${pct}%)`;
  }
}

async function lookupAirport(code) {
  if (!code) return null;
  const clean = code.trim().toUpperCase();
  if (airportLookupCache.has(clean)) return airportLookupCache.get(clean);

  try {
    const res = await fetch(`/api/airports?code=${encodeURIComponent(clean)}`);
    if (!res.ok) return null;
    const data = await res.json();
    const apt = data.airport;
    airportLookupCache.set(clean, apt);
    return apt;
  } catch {
    return null;
  }
}

// =============================================================================
// 3D Cockpit View Simulator Modal (FR24 Cockpit Perspective)
// =============================================================================
function openCockpitView() {
  if (!selectedHex) return;
  const item = aircraft.find((c) => c.hex === selectedHex);
  if (!item) return;

  cockpitModal.hidden = false;
  document.getElementById("hudFlightCallsign").textContent = callsignOf(item);
  document.getElementById("hudAircraftType").textContent = item.t || "Jet Aircraft";

  // Initialize or re-center cockpit map underlay
  if (!cockpitMap) {
    cockpitMap = L.map("cockpitMap", {
      zoomControl: false,
      attributionControl: false,
      dragging: false,
      touchZoom: false,
      doubleClickZoom: false,
      scrollWheelZoom: false
    });
    cockpitMapLayer = L.tileLayer(tileProviders.satellite.url, tileProviders.satellite.options).addTo(cockpitMap);
  }

  cockpitMap.setView([item.lat, item.lon], 13);
  setTimeout(() => cockpitMap.invalidateSize(), 150);

  updateCockpitHud(item);
}

function updateCockpitHud(item) {
  const speed = Number.isFinite(item.gs) ? Math.round(item.gs) : 0;
  const alt = altitudeOf(item) || 0;
  const vs = Number.isFinite(item.baro_rate) ? item.baro_rate : 0;
  const heading = Number.isFinite(item.track) ? Math.round(item.track) : 0;

  // Airspeed & Mach
  document.getElementById("hudSpeedVal").textContent = speed;
  const mach = (speed / 573).toFixed(2);
  document.getElementById("hudMachVal").textContent = `M ${mach}`;

  // Altitude & Vertical Speed
  document.getElementById("hudAltVal").textContent = formatNumber(alt);
  document.getElementById("hudVsVal").textContent = `${vs >= 0 ? "+" : ""}${formatNumber(vs)} FPM`;

  // Heading & Compass
  document.getElementById("hudHeadingVal").textContent = `${String(heading).padStart(3, "0")}°`;

  // Pitch Ladder & Horizon Transform
  const pitchAngle = Math.max(-15, Math.min(15, vs / 250));
  const rollAngle = 0; // Level wings or simulated bank
  const ladder = document.getElementById("hudPitchLadder");
  if (ladder) {
    ladder.style.transform = `translateY(${pitchAngle * 4}px) rotate(${rollAngle}deg)`;
  }

  // Telemetry Footer
  document.getElementById("hudCoordsText").textContent = `${item.lat.toFixed(3)}°, ${item.lon.toFixed(3)}°`;
  document.getElementById("hudSquawkText").textContent = item.squawk || "1200";

  if (cockpitMap && !cockpitModal.hidden) {
    cockpitMap.panTo([item.lat, item.lon], { animate: false });
  }
}

function closeCockpitView() {
  cockpitModal.hidden = true;
}

// =============================================================================
// Squawk 7700 Emergency Alert Monitor
// =============================================================================
function checkEmergencyAlerts() {
  const emergencyFlight = aircraft.find((c) =>
    c.squawk === "7700" || c.squawk === "7600" || c.squawk === "7500" || c.hex === simulatedEmergencyHex
  );

  if (emergencyFlight) {
    const callsign = callsignOf(emergencyFlight);
    const squawkType = emergencyFlight.squawk === "7600" ? "RADIO FAILURE (7600)" : emergencyFlight.squawk === "7500" ? "HIJACK (7500)" : "GENERAL EMERGENCY (7700)";
    document.getElementById("emergencyFlightText").textContent = `${callsign} (${emergencyFlight.t || "Aircraft"}) · Squawk ${squawkType} · Alt ${formatNumber(altitudeOf(emergencyFlight))} ft`;
    emergencyBanner.hidden = false;

    document.getElementById("emergencyTrackBtn").onclick = () => {
      selectAircraft(emergencyFlight.hex, true);
    };
  } else if (!simulatedEmergencyHex) {
    emergencyBanner.hidden = true;
  }
}

function simulateEmergencyTest() {
  if (aircraft.length === 0) {
    showToast("No live aircraft in current view to test emergency.");
    return;
  }
  const candidate = aircraft[0];
  simulatedEmergencyHex = candidate.hex;
  candidate.squawk = "7700";
  checkEmergencyAlerts();
  selectAircraft(candidate.hex, true);
  showToast(`Simulated Squawk 7700 alert for ${callsignOf(candidate)}`);
}

// =============================================================================
// Top 10 Most Tracked Flights
// =============================================================================
function generateTopTrackedFlights() {
  // Identify most interesting live flights in airspace
  const sorted = [...aircraft].sort((a, b) => {
    // Score based on altitude, speed, airline category
    const scoreA = (a.category === "A5" ? 50 : 0) + (a.t?.startsWith("B7") || a.t?.startsWith("A3") ? 30 : 0) + (a.gs || 0);
    const scoreB = (b.category === "A5" ? 50 : 0) + (b.t?.startsWith("B7") || b.t?.startsWith("A3") ? 30 : 0) + (b.gs || 0);
    return scoreB - scoreA;
  }).slice(0, 10);

  const listHtml = sorted.map((item, idx) => {
    const callsign = callsignOf(item);
    const viewers = formatNumber(14500 - idx * 1150 + (parseInt(item.hex, 16) % 850));
    const alt = altitudeOf(item) !== null ? `${formatNumber(altitudeOf(item))} ft` : "--";
    const type = item.t || "Airliner";

    return `
      <button class="tracked-row" type="button" data-hex="${escapeHtml(item.hex)}">
        <span class="tracked-rank">#${idx + 1}</span>
        <span class="tracked-main">
          <span class="tracked-ident">
            <strong>${escapeHtml(callsign)}</strong>
            <span>${escapeHtml(type)}</span>
          </span>
          <span class="tracked-route">Alt ${alt} · Spd ${formatNumber(item.gs)} kt</span>
        </span>
        <span class="tracked-viewers">🔥 ${viewers}</span>
      </button>
    `;
  }).join("");

  document.getElementById("mostTrackedList").innerHTML = listHtml || "<div class='search-empty'>Scanning active flights…</div>";
  document.getElementById("topTrackedTabList").innerHTML = listHtml || "<div class='search-empty'>Scanning active flights…</div>";
}

// =============================================================================
// Weather Radar (RainViewer) & Day/Night Terminator Overlays
// =============================================================================
async function toggleWeatherRadar(enable) {
  if (!enable) {
    if (weatherRadarLayer) {
      map.removeLayer(weatherRadarLayer);
      weatherRadarLayer = null;
    }
    showToast("Weather Radar disabled");
    return;
  }

  showToast("Fetching live precipitation radar…");
  try {
    const res = await fetch("https://api.rainviewer.com/public/weather-maps.json");
    if (!res.ok) throw new Error("Radar feed unavailable");
    const data = await res.json();
    const pastScans = data.radar?.past || [];
    if (!pastScans.length) throw new Error("No recent radar scan");
    const latestPath = pastScans[pastScans.length - 1].path;

    if (weatherRadarLayer) map.removeLayer(weatherRadarLayer);
    weatherRadarLayer = L.tileLayer(`https://tilecache.rainviewer.com/v2/radar/${latestPath}/512/{z}/{x}/{y}/2/1_1.png`, {
      opacity: 0.65,
      zIndex: 300,
      attribution: '&copy; <a href="https://www.rainviewer.com/">RainViewer</a>'
    }).addTo(map);

    showToast("Live Weather Radar active");
  } catch (err) {
    showToast("Could not load weather radar data");
    document.getElementById("checkWeatherRadar").checked = false;
  }
}

// Day / Night Terminator Polygon calculation
function updateDayNightTerminator() {
  if (dayNightLayer) {
    map.removeLayer(dayNightLayer);
    dayNightLayer = null;
  }
  if (!document.getElementById("checkDayNight").checked) return;

  const now = new Date();
  const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 1000 / 60 / 60 / 24);
  const declination = -23.44 * Math.cos((2 * Math.PI / 365) * (dayOfYear + 10)) * (Math.PI / 180);
  const utcHours = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
  const subsolarLon = 180 - (utcHours * 15);

  const coords = [];
  const startSide = declination >= 0 ? -90 : 90;
  coords.push([startSide, -180]);

  for (let lon = -180; lon <= 180; lon += 3) {
    const deltaLon = (lon - subsolarLon) * (Math.PI / 180);
    const lat = Math.atan(-Math.cos(deltaLon) / Math.tan(declination)) * (180 / Math.PI);
    coords.push([lat, lon]);
  }

  coords.push([startSide, 180]);
  coords.push([startSide, -180]);

  dayNightLayer = L.polygon(coords, {
    color: "transparent",
    fillColor: "#05080c",
    fillOpacity: 0.28,
    interactive: false
  }).addTo(map);
}

// =============================================================================
// Map Style Switcher
// =============================================================================
function setMapStyle(styleKey) {
  if (!tileProviders[styleKey] || styleKey === currentMapStyle) return;

  applyMapStyle(styleKey);

  document.querySelectorAll(".layer-opt").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mapStyle === styleKey);
  });
  showToast(`Switched to ${btnLabel(styleKey)} map`);
}

function btnLabel(key) {
  return key === "dark" ? "FR24 Dark" : key === "satellite" ? "Satellite" : key === "voyager" ? "Aviation Light" : "OpenStreetMap";
}

// =============================================================================
// ADS-B Aircraft Data Fetching
// =============================================================================
function requestRadius() {
  const bounds = map.getBounds();
  const center = map.getCenter();
  const corners = [bounds.getNorthWest(), bounds.getNorthEast(), bounds.getSouthWest(), bounds.getSouthEast()];
  const maxNm = Math.max(...corners.map((c) => map.distance(center, c) / 1852));
  return Math.max(10, Math.min(250, Math.ceil(maxNm)));
}

async function loadAircraft(force = false) {
  const center = map.getCenter();
  const radius = requestRadius();
  const key = `${center.lat.toFixed(2)},${center.lng.toFixed(2)},${radius}`;

  document.getElementById("regionName").textContent = `${center.lat.toFixed(2)}°, ${center.lng.toFixed(2)}°`;
  if (!force && key === lastFetchKey) return;
  lastFetchKey = key;

  if (fetchController) fetchController.abort();
  fetchController = new AbortController();
  mapLoading.classList.remove("hidden");

  try {
    const res = await fetch(`/api/aircraft?lat=${center.lat.toFixed(4)}&lon=${center.lng.toFixed(4)}&radius=${radius}`, {
      signal: fetchController.signal,
      headers: { Accept: "application/json" }
    });
    if (!res.ok) throw new Error("ADS-B network error");
    const data = await res.json();
    const fetched = (Array.isArray(data.ac) ? data.ac : []).filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon));
    if (selectedHex) {
      const cur = aircraft.find((c) => c.hex === selectedHex);
      if (cur && !fetched.some((c) => c.hex === selectedHex)) {
        fetched.unshift(cur);
      }
    }
    aircraft = fetched;

    document.getElementById("updatedLabel").textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
    document.getElementById("coverageText").textContent = `${aircraft.length} AIRCRAFT · ${radius} NM RADAR`;

    renderMarkers();
    renderFlights();
    generateTopTrackedFlights();

    // Auto-Follow Camera Lock
    if (followingHex) {
      const target = aircraft.find((c) => c.hex === followingHex);
      if (target) {
        map.panTo([target.lat, target.lon], { animate: true, duration: 0.8 });
      }
    }

    // Update Cockpit HUD if open
    if (!cockpitModal.hidden && selectedHex) {
      const sel = aircraft.find((c) => c.hex === selectedHex);
      if (sel) updateCockpitHud(sel);
    }
  } catch (err) {
    if (err.name === "AbortError") return;
    document.getElementById("coverageText").textContent = "NETWORK DISCONNECTED";
    showToast("Reconnecting to ADS-B network…");
  } finally {
    if (!fetchController.signal.aborted) mapLoading.classList.add("hidden");
  }
}

// =============================================================================
// Airports Directory & Arrivals/Departures Boards
// =============================================================================
function airportCode(apt) {
  return apt.iata || apt.icao || apt.id;
}

function airportIcon(apt, selected = false) {
  return L.divIcon({
    className: "",
    html: `<span class="airport-marker${selected ? " selected" : ""}">${escapeHtml(airportCode(apt) || "APT")}</span>`,
    iconSize: [36, 22],
    iconAnchor: [18, 11]
  });
}

function renderAirportMarkers() {
  if (!document.getElementById("checkAirportPins").checked) {
    airportLayer.clearLayers();
    airportMarkers.clear();
    return;
  }

  const bounds = map.getBounds();
  const visible = airports.filter((apt) => bounds.contains([apt.lat, apt.lon]));
  const visibleIds = new Set(visible.map((a) => a.id));

  visible.forEach((apt) => {
    let marker = airportMarkers.get(apt.id);
    if (!marker) {
      marker = L.marker([apt.lat, apt.lon], { icon: airportIcon(apt), title: apt.name });
      marker.on("click", () => selectAirport(apt.id, { openDetails: true }));
      marker.addTo(airportLayer);
      airportMarkers.set(apt.id, marker);
    } else {
      marker.setIcon(airportIcon(apt, apt.id === selectedAirportId));
    }
  });

  airportMarkers.forEach((marker, id) => {
    if (!visibleIds.has(id)) {
      airportLayer.removeLayer(marker);
      airportMarkers.delete(id);
    }
  });
}

function renderAirportList() {
  const sorted = [...airports].sort((a, b) => map.distance(map.getCenter(), [a.lat, a.lon]) - map.distance(map.getCenter(), [b.lat, b.lon]));
  document.getElementById("airportCount").textContent = formatNumber(sorted.length);

  if (!sorted.length) {
    airportList.innerHTML = '<div class="empty-state"><span class="empty-mark" aria-hidden="true">⌖</span><p>Zoom into map to load regional airports.</p></div>';
    return;
  }

  airportList.innerHTML = sorted.map((apt) => {
    const distNm = map.distance(map.getCenter(), [apt.lat, apt.lon]) / 1852;
    const loc = [apt.municipality, apt.country].filter(Boolean).join(", ");
    return `
      <button class="airport-row${apt.id === selectedAirportId ? " selected" : ""}" type="button" data-airport-id="${escapeHtml(apt.id)}">
        <span class="airport-code">${escapeHtml(airportCode(apt) || "APT")}</span>
        <span class="airport-row-main">
          <span class="airport-row-name">${escapeHtml(apt.name)}</span>
          <span class="airport-row-sub">${escapeHtml(loc)}</span>
        </span>
        <span class="airport-row-distance">${formatNumber(distNm, 1)} nm</span>
      </button>
    `;
  }).join("");
}

async function loadAirports(force = false) {
  const bounds = map.getBounds();
  if (map.getZoom() < 5) {
    airports = [];
    airportMarkers.clear();
    airportLayer.clearLayers();
    renderAirportList();
    document.getElementById("airportUpdated").textContent = "Zoom in to load";
    return;
  }

  const key = `${bounds.getSouth().toFixed(2)},${bounds.getWest().toFixed(2)},${bounds.getNorth().toFixed(2)},${bounds.getEast().toFixed(2)}`;
  if (!force && key === lastAirportFetchKey) return;
  lastAirportFetchKey = key;

  if (airportFetchController) airportFetchController.abort();
  airportFetchController = new AbortController();

  const params = new URLSearchParams({
    south: bounds.getSouth().toFixed(4),
    west: bounds.getWest().toFixed(4),
    north: bounds.getNorth().toFixed(4),
    east: bounds.getEast().toFixed(4)
  });

  try {
    const res = await fetch(`/api/airports?${params}`, { signal: airportFetchController.signal });
    if (!res.ok) throw new Error("Airports unavailable");
    const data = await res.json();
    airports = (Array.isArray(data.airports) ? data.airports : [])
      .filter((a) => a.icao || a.iata)
      .sort((a, b) => Number(b.scheduled) - Number(a.scheduled))
      .slice(0, 100);

    document.getElementById("airportUpdated").textContent = `${formatNumber(airports.length)} in radar`;
    renderAirportMarkers();
    renderAirportList();
  } catch (err) {
    if (err.name === "AbortError") return;
  }
}

// Select an Airport and load Arrivals/Departures board
async function selectAirport(id, options = {}) {
  const apt = airports.find((a) => a.id === id);
  if (!apt) return;

  selectedAirportId = id;
  setActiveTab("airports");
  renderAirportMarkers();
  renderAirportList();

  if (options.center) {
    map.flyTo([apt.lat, apt.lon], Math.max(map.getZoom(), 11), { duration: 0.6 });
  }

  const code = airportCode(apt);
  airportDetailPanel.innerHTML = `
    <div class="selection-content">
      <div class="airport-card-heading">
        <h2>${escapeHtml(apt.name)}</h2>
        <span class="airport-card-code">${escapeHtml(code)}</span>
      </div>
      <p class="airport-card-meta">${escapeHtml([apt.municipality, apt.country].filter(Boolean).join(", "))} · Elev ${apt.elevation || "--"} ft</p>
      <div class="airport-board-tabs">
        <button class="board-tab active" id="btnDepBoard" type="button">Departures</button>
        <button class="board-tab" id="btnArrBoard" type="button">Arrivals</button>
      </div>
      <div class="board-flight-table" id="boardFlightTable">
        <div class="search-empty">Loading flight timetable…</div>
      </div>
    </div>
  `;

  // Fetch real timetable from /api/airport-board
  try {
    const res = await fetch(`/api/airport-board?code=${encodeURIComponent(code)}`);
    if (!res.ok) throw new Error("Board unavailable");
    const data = await res.json();
    const deps = data.departures || [];
    const arrs = data.arrivals || [];

    function renderBoard(items, isDep) {
      const table = document.getElementById("boardFlightTable");
      if (!table) return;
      if (!items.length) {
        table.innerHTML = `<div class="search-empty">No ${isDep ? "departures" : "arrivals"} currently scheduled.</div>`;
        return;
      }
      table.innerHTML = items.slice(0, 15).map((f) => {
        const time = (isDep ? f.dep_time : f.arr_time) ? (isDep ? f.dep_time : f.arr_time).slice(-5) : "--:--";
        const dest = isDep ? (f.arr_iata || f.arr_icao || "---") : (f.dep_iata || f.dep_icao || "---");
        const status = f.status ? f.status.toUpperCase() : "SCHEDULED";
        const gate = (isDep ? f.dep_gate : f.arr_gate) || "";

        return `
          <div class="board-flight-row">
            <div>
              <strong>${escapeHtml(f.flight_iata || f.flight_icao || "FLT")}</strong>
              <small style="color:var(--text-muted); margin-left:6px">${dest} ${gate ? `· G${gate}` : ""}</small>
            </div>
            <div>
              <span>${time}</span>
              <span class="status-pill" style="margin-left:8px">${status}</span>
            </div>
          </div>
        `;
      }).join("");
    }

    renderBoard(deps, true);

    const btnDep = document.getElementById("btnDepBoard");
    const btnArr = document.getElementById("btnArrBoard");
    if (btnDep && btnArr) {
      btnDep.onclick = () => {
        btnDep.classList.add("active");
        btnArr.classList.remove("active");
        renderBoard(deps, true);
      };
      btnArr.onclick = () => {
        btnArr.classList.add("active");
        btnDep.classList.remove("active");
        renderBoard(arrs, false);
      };
    }
  } catch {
    const table = document.getElementById("boardFlightTable");
    if (table) table.innerHTML = '<div class="search-empty">Flight timetable feed not reporting.</div>';
  }
}

// =============================================================================
// Global Search (Flights, Airports, Airlines)
// =============================================================================
function renderSearchResults(data, query) {
  const rawAircraft = Array.isArray(data.aircraft) ? data.aircraft : [];
  const rawScheduled = Array.isArray(data.scheduled) ? data.scheduled : [];
  const rawAirports = Array.isArray(data.airports) ? data.airports : [];
  const rawAirlines = Array.isArray(data.airlines) ? data.airlines : [];

  globalSearchMatches = {
    aircraft: rawAircraft,
    scheduled: rawScheduled,
    airports: rawAirports,
    airlines: rawAirlines
  };

  const groups = [
    ["LIVE & EN-ROUTE FLIGHTS", "aircraft", globalSearchMatches.aircraft],
    ["SCHEDULED TIMETABLES", "scheduled", globalSearchMatches.scheduled],
    ["AIRPORTS", "airports", globalSearchMatches.airports],
    ["AIRLINES", "airlines", globalSearchMatches.airlines]
  ].filter(([, , items]) => items.length);

  if (!groups.length) {
    searchResults.innerHTML = `<div class="search-empty">No live flights, airports, or airlines matched “${escapeHtml(query)}”.</div>`;
    searchResults.hidden = false;
    return;
  }

  searchResults.innerHTML = groups.map(([heading, kind, items]) => `
    <section class="search-group">
      <h2>${heading}</h2>
      ${items.map((item, index) => {
        if (kind === "aircraft") {
          const call = escapeHtml(callsignOf(item));
          const route = [item.dep_iata, item.arr_iata].filter(Boolean).join(" ➔ ");
          const alt = altitudeOf(item);
          const altText = alt !== null ? `${formatNumber(alt)} ft` : "";
          const speedText = Number.isFinite(item.gs) ? `${formatNumber(item.gs)} kt` : "";
          const meta = [item.t || "Aircraft", route, altText, speedText].filter(Boolean).join(" · ");
          const isEnRoute = item.is_scheduled || !item.seen;

          return `<button class="search-result-row" type="button" data-search-kind="aircraft" data-search-index="${index}">
            <span class="search-result-code aircraft-result">✈</span>
            <span class="search-result-copy">
              <strong>${call}</strong>
              <small>${escapeHtml(meta)}</small>
            </span>
            <span class="search-result-tag ${isEnRoute ? "enroute-tag" : "live-tag"}">${isEnRoute ? "EN ROUTE" : "LIVE"}</span>
          </button>`;
        }
        if (kind === "scheduled") {
          const call = escapeHtml(item.flight_iata || item.flight_icao || item.flight || "FLT");
          const route = [item.dep_iata, item.arr_iata].filter(Boolean).join(" ➔ ");
          const meta = [item.airline_name || item.airline_iata || "Airline", route, item.status ? item.status.toUpperCase() : ""].filter(Boolean).join(" · ");

          return `<button class="search-result-row" type="button" data-search-kind="scheduled" data-search-index="${index}">
            <span class="search-result-code" style="color:var(--fr-yellow)">📅</span>
            <span class="search-result-copy">
              <strong>${call}</strong>
              <small>${escapeHtml(meta)}</small>
            </span>
            <span class="search-result-tag schedule-tag">SCHEDULE</span>
          </button>`;
        }
        if (kind === "airports") {
          return `<button class="search-result-row" type="button" data-search-kind="airports" data-search-index="${index}">
            <span class="search-result-code">${escapeHtml(airportCode(item) || "APT")}</span>
            <span class="search-result-copy">
              <strong>${escapeHtml(item.name)}</strong>
              <small>${escapeHtml([item.municipality, item.country].filter(Boolean).join(", "))}</small>
            </span>
            <span class="search-result-tag">AIRPORT</span>
          </button>`;
        }
        return `<button class="search-result-row" type="button" data-search-kind="airlines" data-search-index="${index}">
          <span class="search-result-code">${escapeHtml(item.icao || item.iata || "AIR")}</span>
          <span class="search-result-copy">
            <strong>${escapeHtml(item.name)}</strong>
            <small>${escapeHtml([item.iata, item.icao, item.country].filter(Boolean).join(" · "))}</small>
          </span>
          <span class="search-result-tag">AIRLINE</span>
        </button>`;
      }).join("")}
    </section>
  `).join("");

  searchResults.hidden = false;
}

async function searchGlobally(query) {
  if (globalSearchController) globalSearchController.abort();
  globalSearchController = new AbortController();
  searchResults.innerHTML = '<div class="search-empty"><span class="loading-ring"></span> Searching live airspace, schedules, and airports…</div>';
  searchResults.hidden = false;

  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal: globalSearchController.signal });
    const data = await res.json();
    if (query === searchInput.value.trim()) renderSearchResults(data, query);
  } catch (err) {
    if (err.name === "AbortError") return;
    searchResults.innerHTML = '<div class="search-empty">Search temporarily unavailable.</div>';
  }
}

async function selectSearchResult(kind, index) {
  const item = globalSearchMatches[kind]?.[index];
  if (!item) return;
  searchResults.hidden = true;
  searchInput.blur();

  if (kind === "aircraft") {
    aircraft = [item, ...aircraft.filter((c) => c.hex !== item.hex)];
    setActiveTab("traffic");
    searchInput.value = "";

    // Fly camera smoothly to aircraft coordinates anywhere across the world
    if (Number.isFinite(item.lat) && Number.isFinite(item.lon)) {
      map.flyTo([item.lat, item.lon], 7, { duration: 1.2 });
    }
    await selectAircraft(item.hex, false);
    showToast(`Tracking ${callsignOf(item)}`);
  } else if (kind === "scheduled") {
    const call = item.flight_iata || item.flight_icao || item.flight;
    let targetPlane = aircraft.find((c) => callsignOf(c).toUpperCase() === (call || "").toUpperCase());

    if (!targetPlane) {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(call)}`);
        const d = await res.json();
        if (d.aircraft && d.aircraft.length > 0) {
          targetPlane = d.aircraft[0];
          aircraft = [targetPlane, ...aircraft.filter((c) => c.hex !== targetPlane.hex)];
        }
      } catch {}
    }

    if (targetPlane) {
      setActiveTab("traffic");
      searchInput.value = "";
      if (Number.isFinite(targetPlane.lat) && Number.isFinite(targetPlane.lon)) {
        map.flyTo([targetPlane.lat, targetPlane.lon], 7, { duration: 1.2 });
      }
      await selectAircraft(targetPlane.hex, false);
      showToast(`Tracking ${callsignOf(targetPlane)}`);
    } else {
      showToast(`Flight ${call} timetable loaded`);
    }
  } else if (kind === "airports") {
    airports = [item, ...airports.filter((c) => c.id !== item.id)];
    selectAirport(item.id, { center: true });
  } else {
    searchInput.value = item.icao || item.iata || "";
    setActiveTab("traffic");
    renderFlights();
  }
}

// =============================================================================
// Aviation Weather (METAR)
// =============================================================================
async function fetchMetar(code) {
  const airport = code.trim().toUpperCase();
  const result = document.getElementById("weatherResult");
  if (!/^[A-Z0-9]{4}$/.test(airport)) {
    result.innerHTML = '<div class="search-empty">Enter a 4-character ICAO code, such as KJFK, EGLL, or RJTT.</div>';
    return;
  }

  result.innerHTML = '<div class="search-empty"><span class="loading-ring"></span> Fetching latest METAR observation…</div>';
  try {
    const res = await fetch(`/api/metar?ids=${encodeURIComponent(airport)}`);
    if (!res.ok) throw new Error("Weather service offline");
    const observations = await res.json();
    const metar = Array.isArray(observations) ? observations[0] : null;
    if (!metar) throw new Error(`No recent METAR report for ${airport}`);

    const cloudText = Array.isArray(metar.clouds) && metar.clouds.length
      ? metar.clouds.map((l) => `${l.cover || ""} ${l.base === undefined ? "" : formatNumber(l.base) + " ft"}`).join(" · ")
      : "Clear skies";

    const metrics = [
      ["WIND", metar.wdir === "VRB" ? `VRB ${formatNumber(metar.wspd)} kt` : `${formatNumber(metar.wdir)}° / ${formatNumber(metar.wspd)} kt`],
      ["VISIBILITY", metar.visib ? `${metar.visib} SM` : "--"],
      ["TEMPERATURE", Number.isFinite(metar.temp) ? `${formatNumber(metar.temp)}°C` : "--"],
      ["DEW POINT", Number.isFinite(metar.dewp) ? `${formatNumber(metar.dewp)}°C` : "--"],
      ["ALTIMETER", Number.isFinite(metar.altim) ? `${Number(metar.altim).toFixed(2)} inHg` : "--"],
      ["CLOUDS", cloudText]
    ];

    result.innerHTML = `
      <div class="weather-airport">${escapeHtml(metar.icaoId || airport)}</div>
      <div class="weather-time">OBSERVED ${metar.obsTime ? new Date(metar.obsTime * 1000).toUTCString() : "Live"}</div>
      <div class="weather-metrics">
        ${metrics.map(([label, val]) => `<div class="weather-metric"><span>${label}</span><span>${escapeHtml(val)}</span></div>`).join("")}
      </div>
      <div class="metar-raw">${escapeHtml(metar.rawOb || "Raw observation not reported")}</div>
    `;
  } catch (err) {
    result.innerHTML = `<div class="search-empty">${escapeHtml(err.message)}</div>`;
  }
}

// =============================================================================
// Tab Switching & Toasts
// =============================================================================
function setActiveTab(view) {
  const views = { traffic: "trafficView", airports: "airportsView", weather: "weatherView", topTracked: "topTrackedView" };
  Object.entries(views).forEach(([name, panelId]) => {
    const active = name === view;
    const tab = document.getElementById(`${name}Tab`);
    if (tab) {
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    }
    const el = document.getElementById(panelId);
    if (el) el.hidden = !active;
  });

  if (view === "airports") loadAirports();
  if (view === "weather") fetchMetar(document.getElementById("airportCode").value);
  if (view === "topTracked") generateTopTrackedFlights();
}

function showToast(message) {
  const toast = document.getElementById("mapToast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove("visible"), 2600);
}

function updateClock() {
  const now = new Date();
  document.getElementById("utcClock").textContent = `${new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(now)} UTC`;
}

// =============================================================================
// Event Handlers & Initialization
// =============================================================================
function setupEventHandlers() {
  // Navigation Tabs
  document.getElementById("trafficTab").addEventListener("click", () => setActiveTab("traffic"));
  document.getElementById("airportsTab").addEventListener("click", () => setActiveTab("airports"));
  document.getElementById("weatherTab").addEventListener("click", () => setActiveTab("weather"));
  document.getElementById("topTrackedTab").addEventListener("click", () => setActiveTab("topTracked"));

  // Flight Card Tabs (Overview, Ops, ACARS)
  document.getElementById("tabOverview").addEventListener("click", () => {
    document.getElementById("tabOverview").classList.add("active");
    document.getElementById("tabOps").classList.remove("active");
    document.getElementById("tabAcars").classList.remove("active");
    document.getElementById("paneOverview").hidden = false;
    document.getElementById("paneOps").hidden = true;
    document.getElementById("paneAcars").hidden = true;
  });

  document.getElementById("tabOps").addEventListener("click", () => {
    document.getElementById("tabOps").classList.add("active");
    document.getElementById("tabOverview").classList.remove("active");
    document.getElementById("tabAcars").classList.remove("active");
    document.getElementById("paneOps").hidden = false;
    document.getElementById("paneOverview").hidden = true;
    document.getElementById("paneAcars").hidden = true;
  });

  document.getElementById("tabAcars").addEventListener("click", () => {
    document.getElementById("tabAcars").classList.add("active");
    document.getElementById("tabOverview").classList.remove("active");
    document.getElementById("tabOps").classList.remove("active");
    document.getElementById("paneAcars").hidden = false;
    document.getElementById("paneOverview").hidden = true;
    document.getElementById("paneOps").hidden = true;
  });

  // Flight Card Action Buttons
  document.getElementById("cockpitViewBtn").addEventListener("click", openCockpitView);
  document.getElementById("cockpitCloseBtn").addEventListener("click", closeCockpitView);

  document.getElementById("followAircraftBtn").addEventListener("click", () => {
    if (followingHex === selectedHex) {
      followingHex = null;
      document.getElementById("followAircraftBtn").classList.remove("active");
      document.getElementById("followBtnText").textContent = "Follow";
      showToast("Camera lock disabled");
    } else {
      followingHex = selectedHex;
      document.getElementById("followAircraftBtn").classList.add("active");
      document.getElementById("followBtnText").textContent = "Following";
      showToast("Camera locked on aircraft");
    }
  });

  document.getElementById("fitRouteBtn").addEventListener("click", () => {
    if (routeLayer.getLayers().length) {
      const bounds = L.featureGroup(routeLayer.getLayers()).getBounds();
      map.fitBounds(bounds, { padding: [50, 50] });
    } else if (selectedHex) {
      const item = aircraft.find((c) => c.hex === selectedHex);
      if (item) map.setView([item.lat, item.lon], 11);
    }
  });

  document.getElementById("shareFlightBtn").addEventListener("click", () => {
    const callsign = document.getElementById("flightCardCallsign").textContent;
    const url = `${window.location.origin}/flighttracker.html?flight=${callsign}`;
    navigator.clipboard?.writeText(url);
    showToast(`Flight link copied: ${callsign}`);
  });

  document.getElementById("flightCardClose").addEventListener("click", () => {
    flightInfoCard.hidden = true;
    selectedHex = null;
    followingHex = null;
    routeLayer.clearLayers();
    trailLayer.clearLayers();
    renderMarkers();
    renderFlights();
    selectionPanel.innerHTML = '<div class="selection-empty"><span class="selection-crosshair" aria-hidden="true">＋</span><span>Click an aircraft on the radar or in the list to inspect telemetry and route.</span></div>';
  });

  // Emergency Alert Dismiss & Sim
  document.getElementById("emergencyDismissBtn").addEventListener("click", () => {
    emergencyBanner.hidden = true;
  });
  document.getElementById("simEmergencyBtn").addEventListener("click", simulateEmergencyTest);

  // Top 10 Most Tracked Drawer
  document.getElementById("topTrackedHeaderBtn").addEventListener("click", () => {
    generateTopTrackedFlights();
    mostTrackedDrawer.hidden = !mostTrackedDrawer.hidden;
  });
  document.getElementById("mostTrackedClose").addEventListener("click", () => {
    mostTrackedDrawer.hidden = true;
  });

  // Map Layer Styles & Overlays
  document.getElementById("mapLayersBtn").addEventListener("click", () => {
    const dd = document.getElementById("layersDropdown");
    dd.hidden = !dd.hidden;
  });

  document.querySelectorAll("[data-map-style]").forEach((btn) => {
    btn.addEventListener("click", () => setMapStyle(btn.dataset.mapStyle));
  });

  document.getElementById("checkWeatherRadar").addEventListener("change", (e) => {
    toggleWeatherRadar(e.target.checked);
  });
  document.getElementById("radarToggleMapBtn").addEventListener("click", () => {
    const cb = document.getElementById("checkWeatherRadar");
    cb.checked = !cb.checked;
    toggleWeatherRadar(cb.checked);
  });
  document.getElementById("weatherRadarHeaderBtn").addEventListener("click", () => {
    const cb = document.getElementById("checkWeatherRadar");
    cb.checked = !cb.checked;
    toggleWeatherRadar(cb.checked);
  });

  document.getElementById("checkDayNight").addEventListener("change", updateDayNightTerminator);
  document.getElementById("checkAirportPins").addEventListener("change", renderAirportMarkers);
  document.getElementById("checkAltitudeColors").addEventListener("change", (e) => {
    colorByAltitude = e.target.checked;
    renderMarkers();
  });

  // Units Toggle (Kts / ft vs Km/h / m)
  document.getElementById("unitsToggleBtn").addEventListener("click", () => {
    useMetricUnits = !useMetricUnits;
    document.getElementById("unitsToggleBtn").textContent = useMetricUnits ? "UNITS: KM/H · M" : "UNITS: KTS · FT";
    renderFlights();
    if (selectedHex) {
      const item = aircraft.find((c) => c.hex === selectedHex);
      if (item) renderFlightInfoCard(item);
    }
    showToast(`Units: ${useMetricUnits ? "Metric (km/h, meters)" : "Nautical (knots, feet)"}`);
  });

  // Search Input & Forms (Live Debounced Global Search & Auto-Select)
  let searchDebounceTimer = null;
  searchInput.addEventListener("input", () => {
    const q = searchInput.value.trim();
    renderFlights();
    clearTimeout(searchDebounceTimer);
    if (q.length < 2) {
      searchResults.hidden = true;
      return;
    }
    searchDebounceTimer = setTimeout(() => {
      searchGlobally(q);
    }, 280);
  });

  document.getElementById("searchForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = searchInput.value.trim();
    if (q.length < 2) return;

    // Check local loaded aircraft first
    const norm = q.toUpperCase().replace(/[\s-]/g, "");
    const local = aircraft.find((c) => [callsignOf(c), c.r, c.hex].some((v) => String(v || "").toUpperCase().replace(/[\s-]/g, "") === norm));
    if (local) {
      searchResults.hidden = true;
      searchInput.blur();
      searchInput.value = "";
      setActiveTab("traffic");
      selectAircraft(local.hex, true);
      return;
    }

    // If matches are already displayed in dropdown, auto-select first matching flight
    if (globalSearchMatches.aircraft.length > 0) {
      await selectSearchResult("aircraft", 0);
      return;
    }
    if (globalSearchMatches.scheduled.length > 0) {
      await selectSearchResult("scheduled", 0);
      return;
    }

    // Otherwise do immediate global query and auto-select
    searchResults.innerHTML = '<div class="search-empty"><span class="loading-ring"></span> Locating flight globally…</div>';
    searchResults.hidden = false;
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      renderSearchResults(data, q);
      if (data.aircraft && data.aircraft.length > 0) {
        await selectSearchResult("aircraft", 0);
      } else if (data.scheduled && data.scheduled.length > 0) {
        await selectSearchResult("scheduled", 0);
      }
    } catch {
      searchResults.innerHTML = '<div class="search-empty">Flight search unavailable.</div>';
    }
  });

  searchResults.addEventListener("click", async (e) => {
    const row = e.target.closest("[data-search-kind]");
    if (row) await selectSearchResult(row.dataset.searchKind, Number(row.dataset.searchIndex));
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-wrap")) searchResults.hidden = true;
    if (!e.target.closest(".tool-dropdown-wrap")) document.getElementById("layersDropdown").hidden = true;
  });

  // Weather METAR Form
  document.getElementById("airportForm").addEventListener("submit", (e) => {
    e.preventDefault();
    fetchMetar(document.getElementById("airportCode").value);
  });

  // Map Control Tools
  document.getElementById("refreshButton").addEventListener("click", () => loadAircraft(true));
  document.getElementById("locateButton").addEventListener("click", () => {
    if (!navigator.geolocation) {
      showToast("Geolocation not supported by browser");
      return;
    }
    navigator.geolocation.getCurrentPosition(({ coords }) => {
      map.flyTo([coords.latitude, coords.longitude], 9, { duration: 0.8 });
      loadAircraft(true);
      loadAirports(true);
      showToast("Map centered on your location");
    }, () => {
      showToast("Location access denied");
    });
  });

  // Delegated clicks for flight lists & top tracked
  flightList.addEventListener("click", (e) => {
    const row = e.target.closest("[data-hex]");
    if (row) selectAircraft(row.dataset.hex, true);
  });

  document.getElementById("mostTrackedList").addEventListener("click", (e) => {
    const row = e.target.closest("[data-hex]");
    if (row) {
      mostTrackedDrawer.hidden = true;
      selectAircraft(row.dataset.hex, true);
    }
  });

  document.getElementById("topTrackedTabList").addEventListener("click", (e) => {
    const row = e.target.closest("[data-hex]");
    if (row) selectAircraft(row.dataset.hex, true);
  });

  airportList.addEventListener("click", (e) => {
    const row = e.target.closest("[data-airport-id]");
    if (row) selectAirport(row.dataset.airportId, { center: true });
  });

  trafficFilter.addEventListener("change", renderFlights);
  document.getElementById("sortButton").addEventListener("click", (e) => {
    const options = ["nearest", "callsign", "altitude", "speed"];
    const nextIdx = (options.indexOf(sortCriteria) + 1) % options.length;
    sortCriteria = options[nextIdx];
    e.currentTarget.innerHTML = `${sortCriteria.toUpperCase()} <span aria-hidden="true">↕</span>`;
    renderFlights();
  });

  // Map Movement Listener
  map.on("moveend", () => {
    renderMarkers();
    clearTimeout(moveTimeout);
    moveTimeout = setTimeout(() => {
      loadAircraft();
      loadAirports();
      updateDayNightTerminator();
    }, 400);
  });

  // Keyboard Shortcuts
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
      e.preventDefault();
      searchInput.focus();
    }
    if (e.key === "Escape") {
      searchInput.blur();
      searchResults.hidden = true;
      closeCockpitView();
    }
  });
}

// =============================================================================
// App Startup
// =============================================================================
updateClock();
setInterval(updateClock, 1000);
setupEventHandlers();
updateDayNightTerminator();
setInterval(updateDayNightTerminator, 60000);
loadAircraft(true);
loadAirports(true);
setInterval(() => loadAircraft(true), 45000);