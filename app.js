const STORAGE_KEYS = {
  settings: "truckRouteTracker.settings",
  job: "truckRouteTracker.activeJob",
  history: "truckRouteTracker.history",
};

const DEFAULT_SETTINGS = {
  mpg: 6.5,
  fuelPrice: 4,
};

const AUTO_PAUSE_MS = 90 * 60 * 1000;
const MOVING_SPEED_MPH = 10;
const ARRIVAL_RADIUS_MILES = 3;
const SUSTAINED_MOVING_MS = 60 * 1000;
const STALE_POINT_MS = 5 * 60 * 1000;
const DEADHEAD_WARN_SHARE = 0.2;
const DEADHEAD_ALERT_SHARE = 0.3;
const GEOCODING_API_KEY = "";

let state = {
  settings: loadSettings(),
  job: loadJob(),
  history: loadHistory(),
  watchId: null,
  lastTick: Date.now(),
};

let currentScreen = "start";

const els = {
  screenTitle: document.getElementById("screenTitle"),
  gpsBadge: document.getElementById("gpsBadge"),
  notice: document.getElementById("notice"),
  startScreen: document.getElementById("startScreen"),
  driveScreen: document.getElementById("driveScreen"),
  completeScreen: document.getElementById("completeScreen"),
  insightsScreen: document.getElementById("insightsScreen"),
  summaryScreen: document.getElementById("summaryScreen"),
  startForm: document.getElementById("startForm"),
  grossPay: document.getElementById("grossPay"),
  destination: document.getElementById("destination"),
  plannedMiles: document.getElementById("plannedMiles"),
  deadheadMiles: document.getElementById("deadheadMiles"),
  mpg: document.getElementById("mpg"),
  fuelPrice: document.getElementById("fuelPrice"),
  preFuel: document.getElementById("preFuel"),
  preNet: document.getElementById("preNet"),
  insightsButton: document.getElementById("insightsButton"),
  insightCards: document.getElementById("insightCards"),
  recommendations: document.getElementById("recommendations"),
  backFromInsights: document.getElementById("backFromInsights"),
  historyToggle: document.getElementById("historyToggle"),
  historyPanel: document.getElementById("historyPanel"),
  recordingState: document.getElementById("recordingState"),
  stateLabel: document.getElementById("stateLabel"),
  routeLabel: document.getElementById("routeLabel"),
  liveMiles: document.getElementById("liveMiles"),
  driveTime: document.getElementById("driveTime"),
  totalTime: document.getElementById("totalTime"),
  pauseResumeButton: document.getElementById("pauseResumeButton"),
  arrivalPrompt: document.getElementById("arrivalPrompt"),
  completeButton: document.getElementById("completeButton"),
  gpsGapNotice: document.getElementById("gpsGapNotice"),
  actualLoadedMiles: document.getElementById("actualLoadedMiles"),
  actualDeadheadMiles: document.getElementById("actualDeadheadMiles"),
  cancelComplete: document.getElementById("cancelComplete"),
  confirmComplete: document.getElementById("confirmComplete"),
  finalOutcome: document.getElementById("finalOutcome"),
  finalNet: document.getElementById("finalNet"),
  finalMiles: document.getElementById("finalMiles"),
  finalLoadedMiles: document.getElementById("finalLoadedMiles"),
  deadheadSummaryRow: document.getElementById("deadheadSummaryRow"),
  finalDeadheadMiles: document.getElementById("finalDeadheadMiles"),
  finalFuel: document.getElementById("finalFuel"),
  finalDriveTime: document.getElementById("finalDriveTime"),
  finalTotalTime: document.getElementById("finalTotalTime"),
  finalGross: document.getElementById("finalGross"),
  newRouteButton: document.getElementById("newRouteButton"),
};

init();

function init() {
  els.mpg.value = formatInputNumber(state.settings.mpg);
  els.fuelPrice.value = formatInputNumber(state.settings.fuelPrice);
  bindEvents();
  render();
  startClock();
  registerServiceWorker();
}

function bindEvents() {
  ["input", "change"].forEach((eventName) => {
    els.startForm.addEventListener(eventName, handleEstimateInput);
  });

  els.startForm.addEventListener("submit", startRoute);
  els.pauseResumeButton.addEventListener("click", togglePause);
  els.completeButton.addEventListener("click", showCompletionConfirm);
  els.cancelComplete.addEventListener("click", () => showScreen("drive"));
  els.confirmComplete.addEventListener("click", completeJob);
  els.newRouteButton.addEventListener("click", resetToStart);
  els.insightsButton.addEventListener("click", showInsights);
  els.backFromInsights.addEventListener("click", () => render());
  els.historyToggle.addEventListener("click", toggleHistory);
  els.historyPanel.addEventListener("click", handleHistoryAction);
}

function handleEstimateInput() {
  state.settings = readSettings();
  saveSettings();
  renderPreEstimate();
}

async function startRoute(event) {
  event.preventDefault();
  const grossPay = toNumber(els.grossPay.value);
  if (grossPay <= 0) {
    showNotice("Enter the gross pay before starting.");
    els.grossPay.focus();
    return;
  }

  const now = Date.now();
  const destinationText = els.destination.value.trim();
  const loadedMiles = Math.max(0, toNumber(els.plannedMiles.value));
  const deadheadMiles = Math.max(0, toNumber(els.deadheadMiles.value));

  state.settings = readSettings();
  saveSettings();
  hideNotice();

  const job = {
    id: `job-${now}`,
    grossPay,
    destinationText,
    plannedMiles: loadedMiles,
    deadheadMiles,
    actualLoadedMiles: null,
    actualDeadheadMiles: null,
    finalMiles: loadedMiles + deadheadMiles,
    mileageSource: "estimate",
    destinationCoords: null,
    status: "active",
    startedAt: now,
    completedAt: null,
    activeStartedAt: now,
    activeMs: 0,
    autoPauseStartedAt: null,
    manualPauseStartedAt: null,
    slowStartedAt: null,
    movingStartedAt: null,
    miles: 0,
    points: [],
    lastPoint: null,
    gpsInterrupted: false,
    summary: null,
  };

  state.job = job;
  saveJob();
  setGpsBadge("Route active", "live");
  render();
}

function togglePause() {
  if (!state.job) return;
  if (state.job.status === "active") {
    pauseJob(Date.now(), "manual");
  } else {
    resumeJob(Date.now(), "manual");
  }
  saveJob();
  render();
}

function pauseJob(pausedAt, reason) {
  const job = state.job;
  if (!job || job.status !== "active") return;
  if (job.activeStartedAt) {
    job.activeMs += Math.max(0, pausedAt - job.activeStartedAt);
  }
  job.activeStartedAt = null;
  job.status = reason === "auto" ? "autoPaused" : "manualPaused";
  job.autoPauseStartedAt = reason === "auto" ? pausedAt : null;
  job.manualPauseStartedAt = reason === "manual" ? pausedAt : null;
  job.slowStartedAt = null;
  job.movingStartedAt = null;
}

function resumeJob(resumedAt) {
  const job = state.job;
  if (!job || job.status === "active") return;
  job.status = "active";
  job.activeStartedAt = resumedAt;
  job.autoPauseStartedAt = null;
  job.manualPauseStartedAt = null;
  job.slowStartedAt = null;
  job.movingStartedAt = null;
}

function showCompletionConfirm() {
  if (!state.job) return;
  els.actualLoadedMiles.value = state.job.actualLoadedMiles ?? state.job.plannedMiles ?? "";
  els.actualDeadheadMiles.value = state.job.actualDeadheadMiles ?? state.job.deadheadMiles ?? "";
  els.gpsGapNotice.textContent = "Use the estimated miles or adjust them to what the route actually took.";
  els.gpsGapNotice.hidden = false;
  showScreen("complete");
}

function completeJob() {
  if (!state.job) return;
  const now = Date.now();
  if (state.job.status === "active" && state.job.activeStartedAt) {
    state.job.activeMs += Math.max(0, now - state.job.activeStartedAt);
  }
  applyFinalMileage(state.job);
  state.job.activeStartedAt = null;
  state.job.completedAt = now;
  state.job.status = "completed";
  state.job.summary = buildSummary(state.job);

  const completed = state.job;
  state.history = [completed.summary, ...state.history].slice(0, 10);
  saveHistory();
  localStorage.removeItem(STORAGE_KEYS.job);
  stopGpsWatch();
  setGpsBadge("Complete", "muted");
  renderFinalSummary(completed.summary);
  state.job = null;
  showScreen("summary");
}

function resetToStart() {
  state.job = null;
  localStorage.removeItem(STORAGE_KEYS.job);
  els.startForm.reset();
  els.mpg.value = formatInputNumber(state.settings.mpg);
  els.fuelPrice.value = formatInputNumber(state.settings.fuelPrice);
  setGpsBadge("Ready", "muted");
  hideNotice();
  render();
}

function startGpsWatch() {
  if (!("geolocation" in navigator)) {
    setGpsBadge("GPS unavailable", "warn");
    showNotice("This device does not support GPS tracking.");
    return;
  }
  if (state.watchId !== null) return;

  state.watchId = navigator.geolocation.watchPosition(handleGpsPosition, handleGpsError, {
    enableHighAccuracy: true,
    maximumAge: 5000,
    timeout: 20000,
  });
  setGpsBadge("GPS starting", "warn");
}

function stopGpsWatch() {
  if (state.watchId !== null && "geolocation" in navigator) {
    navigator.geolocation.clearWatch(state.watchId);
  }
  state.watchId = null;
}

function handleGpsPosition(position) {
  if (!state.job || state.job.status === "completed") return;
  const coords = position.coords;
  if (!Number.isFinite(coords.latitude) || !Number.isFinite(coords.longitude)) return;

  const now = position.timestamp || Date.now();
  const point = {
    lat: coords.latitude,
    lon: coords.longitude,
    time: now,
    accuracy: coords.accuracy || null,
    speedMph: getSpeedMph(coords),
  };

  setGpsBadge("GPS recording", "live");
  processPoint(point);
  saveJob();
  render();
}

function handleGpsError(error) {
  setGpsBadge("GPS issue", "warn");
  if (error.code === error.PERMISSION_DENIED) {
    showNotice("Location access is needed to record the drive.");
  } else {
    showNotice("GPS is not available right now. The route stays open.");
  }
}

function processPoint(point) {
  const job = state.job;
  const last = job.lastPoint;
  let distance = 0;
  let computedSpeed = point.speedMph;

  if (last) {
    distance = haversineMiles(last.lat, last.lon, point.lat, point.lon);
    const hours = Math.max((point.time - last.time) / 3600000, 0.000001);
    computedSpeed = Number.isFinite(computedSpeed) ? computedSpeed : distance / hours;
  }

  const stalePoint = last && point.time - last.time > STALE_POINT_MS;
  const validDistance = !stalePoint && distance >= 0.01 && distance < 25;
  const moving = computedSpeed >= MOVING_SPEED_MPH;

  if (stalePoint) {
    job.gpsInterrupted = true;
  }

  if (job.status === "active" && validDistance) {
    job.miles += distance;
  }

  if (moving) {
    job.slowStartedAt = null;
    job.movingStartedAt = job.movingStartedAt || point.time;
  } else {
    job.movingStartedAt = null;
    job.slowStartedAt = job.slowStartedAt || point.time;
  }

  if (job.status === "active" && job.slowStartedAt && point.time - job.slowStartedAt >= AUTO_PAUSE_MS) {
    pauseJob(job.slowStartedAt, "auto");
    showNotice("Auto-paused for rest. Tracking will resume when driving starts again.");
  }

  if (job.status === "autoPaused" && moving && job.movingStartedAt && point.time - job.movingStartedAt >= SUSTAINED_MOVING_MS) {
    resumeJob(job.movingStartedAt);
    showNotice("Auto-resumed drive recording.");
  }

  job.lastPoint = point;
  job.points.push(point);
  if (job.points.length > 1200) {
    job.points = job.points.slice(-1200);
  }
}

async function geocodeDestination(query) {
  try {
    if (GEOCODING_API_KEY) {
      const url = new URL("https://api.opencagedata.com/geocode/v1/json");
      url.searchParams.set("q", query);
      url.searchParams.set("key", GEOCODING_API_KEY);
      url.searchParams.set("limit", "1");
      const response = await fetch(url);
      if (!response.ok) return null;
      const data = await response.json();
      const first = data.results && data.results[0];
      if (!first || !first.geometry) return null;
      return { lat: first.geometry.lat, lon: first.geometry.lng };
    }

    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", query);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "1");
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (!data.length) return null;
    return { lat: Number(data[0].lat), lon: Number(data[0].lon) };
  } catch {
    return null;
  }
}

function readSettings() {
  return {
    mpg: Math.max(1, toNumber(els.mpg.value) || DEFAULT_SETTINGS.mpg),
    fuelPrice: Math.max(0, toNumber(els.fuelPrice.value) || DEFAULT_SETTINGS.fuelPrice),
  };
}

function render() {
  if (state.job && state.job.status !== "completed") {
    setGpsBadge(state.job.status === "active" ? "Route active" : "Paused", state.job.status === "active" ? "live" : "warn");
    if (currentScreen !== "complete") {
      showScreen("drive");
    }
    renderDrive();
  } else {
    showScreen("start");
    renderPreEstimate();
    renderHistory();
  }
}

function showScreen(name) {
  currentScreen = name;
  els.startScreen.hidden = name !== "start";
  els.driveScreen.hidden = name !== "drive";
  els.completeScreen.hidden = name !== "complete";
  els.insightsScreen.hidden = name !== "insights";
  els.summaryScreen.hidden = name !== "summary";
  els.screenTitle.textContent = {
    start: "Start route",
    drive: state.job && state.job.status === "active" ? "Drive running" : "Route paused",
    complete: "Complete job",
    insights: "Insights",
    summary: "Route summary",
  }[name];
}

function renderPreEstimate() {
  const settings = readSettings();
  const loadedMiles = Math.max(0, toNumber(els.plannedMiles.value));
  const deadheadMiles = Math.max(0, toNumber(els.deadheadMiles.value));
  const miles = loadedMiles + deadheadMiles;
  const grossPay = Math.max(0, toNumber(els.grossPay.value));
  const fuel = estimateFuel(miles, settings);
  const net = grossPay - fuel;
  els.preFuel.textContent = money(fuel);
  els.preNet.textContent = money(net);
  els.preNet.className = net < 0 ? "loss-text" : "";
}

function renderDrive() {
  const job = state.job;
  const summary = buildSummary(job);
  const isPaused = job.status !== "active";
  const isAutoPaused = job.status === "autoPaused";

  els.recordingState.classList.toggle("paused", isPaused);
  els.stateLabel.textContent = isPaused ? (isAutoPaused ? "Resting" : "Paused") : "Route Active";
  els.routeLabel.textContent = job.destinationText || "Current route";
  els.liveMiles.textContent = summary.miles.toFixed(1);
  els.driveTime.textContent = duration(summary.activeMs);
  els.totalTime.textContent = duration(summary.totalMs);
  els.pauseResumeButton.textContent = isPaused ? "Resume Timer" : "Pause Timer";
  els.pauseResumeButton.classList.toggle("start-button", isPaused);
  els.pauseResumeButton.classList.toggle("safe-button", !isPaused);

  const arrived = isNearDestination(job);
  els.arrivalPrompt.hidden = true;
}

function renderFinalSummary(summary) {
  const loss = summary.net < 0;
  const deadheadLevel = getDeadheadLevel(summary.deadheadMiles, summary.miles);
  els.finalOutcome.textContent = loss ? "Loss" : "Profit";
  els.finalNet.textContent = money(summary.net);
  els.finalNet.classList.toggle("loss", loss);
  els.finalMiles.textContent = summary.miles.toFixed(1);
  els.finalLoadedMiles.textContent = summary.loadedMiles.toFixed(1);
  els.finalDeadheadMiles.textContent = formatDeadhead(summary.deadheadMiles, summary.miles);
  els.deadheadSummaryRow.classList.toggle("deadhead-warn", deadheadLevel === "warn");
  els.deadheadSummaryRow.classList.toggle("deadhead-alert", deadheadLevel === "alert");
  els.finalFuel.textContent = money(summary.fuel);
  els.finalDriveTime.textContent = duration(summary.activeMs);
  els.finalTotalTime.textContent = duration(summary.totalMs);
  els.finalGross.textContent = money(summary.grossPay);
}

function applyFinalMileage(job) {
  const loadedMiles = Math.max(0, toNumber(els.actualLoadedMiles.value) || job.plannedMiles || 0);
  const deadheadMiles = Math.max(0, toNumber(els.actualDeadheadMiles.value) || job.deadheadMiles || 0);

  job.actualLoadedMiles = loadedMiles;
  job.actualDeadheadMiles = deadheadMiles;
  job.finalMiles = loadedMiles + deadheadMiles;
  job.mileageSource = "actual";
}

function renderHistory() {
  if (!state.history.length) {
    els.historyPanel.innerHTML = "<h2>Recent routes</h2><p>No saved routes yet.</p>";
    return;
  }

  const items = state.history
    .map((item, index) => {
      const label = item.destinationText || "Route";
      const outcome = item.net < 0 ? "Loss" : "Profit";
      const date = new Date(item.completedAt).toLocaleDateString();
      const deadheadClass = getDeadheadLevel(item.deadheadMiles || 0, item.miles || 0);
      return `<div class="history-item ${deadheadClass ? `deadhead-${deadheadClass}` : ""}"><div><strong>${escapeHtml(label)} - ${outcome} ${money(item.net)}</strong><span>${date} | ${item.miles.toFixed(1)} mi total | ${formatDeadhead(item.deadheadMiles || 0, item.miles || 0)}</span></div><button class="mini-danger-button" type="button" data-delete-history="${index}">Delete</button></div>`;
    })
    .join("");
  els.historyPanel.innerHTML = `<h2>Recent routes</h2>${items}<button class="secondary-button history-clear-button" type="button" data-clear-history="true">Clear Recent Routes</button>`;
}

function toggleHistory() {
  renderHistory();
  els.historyPanel.hidden = !els.historyPanel.hidden;
}

function handleHistoryAction(event) {
  const deleteButton = event.target.closest("[data-delete-history]");
  const clearButton = event.target.closest("[data-clear-history]");

  if (deleteButton) {
    const index = Number(deleteButton.dataset.deleteHistory);
    if (Number.isInteger(index)) {
      state.history.splice(index, 1);
      saveHistory();
      renderHistory();
    }
  }

  if (clearButton) {
    state.history = [];
    saveHistory();
    renderHistory();
  }
}

function showInsights() {
  renderInsights();
  showScreen("insights");
}

function renderInsights() {
  const now = new Date();
  const periods = [
    { label: "Daily", since: startOfDay(now) },
    { label: "Weekly", since: startOfWeek(now) },
    { label: "Monthly", since: startOfMonth(now) },
  ];

  els.insightCards.innerHTML = periods
    .map((period) => {
      const totals = aggregateRoutes(state.history.filter((item) => new Date(item.completedAt) >= period.since));
      const outcome = totals.net < 0 ? "Loss" : "Net";
      const rate = totals.miles > 0 ? totals.net / totals.miles : 0;
      const deadheadClass = getDeadheadLevel(totals.deadheadMiles, totals.miles);
      return `<article class="insight-card ${totals.net < 0 ? "loss" : ""} ${deadheadClass ? `deadhead-${deadheadClass}` : ""}">
        <span>${period.label}</span>
        <strong>${outcome} ${money(totals.net)}</strong>
        <div>${totals.miles.toFixed(1)} miles</div>
        <small>${money(rate)} / mile | ${formatDeadhead(totals.deadheadMiles, totals.miles)}</small>
      </article>`;
    })
    .join("");

  els.recommendations.innerHTML = buildRecommendations(state.history)
    .map((item) => `<div class="recommendation-item"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.body)}</span></div>`)
    .join("");
}

function aggregateRoutes(routes) {
  return routes.reduce(
    (totals, item) => {
      totals.count += 1;
      totals.gross += item.grossPay || 0;
      totals.fuel += item.fuel || 0;
      totals.net += item.net || 0;
      totals.miles += item.miles || 0;
      totals.loadedMiles += item.loadedMiles || Math.max(0, (item.miles || 0) - (item.deadheadMiles || 0));
      totals.deadheadMiles += item.deadheadMiles || 0;
      totals.activeMs += item.activeMs || 0;
      return totals;
    },
    { count: 0, gross: 0, fuel: 0, net: 0, miles: 0, loadedMiles: 0, deadheadMiles: 0, activeMs: 0 }
  );
}

function buildRecommendations(history) {
  if (!history.length) {
    return [
      {
        title: "Complete a few real routes",
        body: "After saved jobs build up, BML can compare profit per mile, fuel cost, and driving time.",
      },
    ];
  }

  const monthly = aggregateRoutes(history.filter((item) => new Date(item.completedAt) >= startOfMonth(new Date())));
  const all = aggregateRoutes(history);
  const profitPerMile = all.miles > 0 ? all.net / all.miles : 0;
  const fuelShare = all.gross > 0 ? all.fuel / all.gross : 0;
  const profitPerHour = all.activeMs > 0 ? all.net / (all.activeMs / 3600000) : 0;
  const deadheadShare = all.miles > 0 ? all.deadheadMiles / all.miles : 0;
  const recommendations = [];

  if (monthly.net < 0) {
    recommendations.push({
      title: "Monthly loss warning",
      body: "This month is negative. Raise the minimum gross pay or avoid routes with weak pay against fuel.",
    });
  }

  if (profitPerMile < 1.25) {
    recommendations.push({
      title: "Watch profit per mile",
      body: `Current average is ${money(profitPerMile)} per mile. Use this as a floor before accepting a route.`,
    });
  } else {
    recommendations.push({
      title: "Good mileage return",
      body: `Average net is ${money(profitPerMile)} per mile. Favor routes that meet or beat this number.`,
    });
  }

  if (fuelShare > 0.35) {
    recommendations.push({
      title: "Fuel is taking too much",
      body: "Fuel is over 35% of gross pay. Check fuel price, MPG, weight, and pickup/drop-off distance.",
    });
  }

  if (deadheadShare > DEADHEAD_ALERT_SHARE) {
    recommendations.push({
      title: "Deadhead is hurting profit",
      body: `${Math.round(deadheadShare * 100)}% of miles are unpaid deadhead. Raise the minimum rate or avoid pickups this far away.`,
    });
  } else if (deadheadShare > DEADHEAD_WARN_SHARE) {
    recommendations.push({
      title: "Deadhead needs attention",
      body: `${Math.round(deadheadShare * 100)}% of miles are unpaid deadhead. Compare closer pickups before taking similar loads.`,
    });
  }

  if (profitPerHour > 0 && profitPerHour < 35) {
    recommendations.push({
      title: "Low profit per driving hour",
      body: `Average net is ${money(profitPerHour)} per drive hour. Long routes may need better pay or fewer delays.`,
    });
  }

  const best = history
    .filter((item) => item.miles > 0)
    .sort((a, b) => b.net / b.miles - a.net / a.miles)[0];

  if (best) {
    recommendations.push({
      title: "Repeat the best pattern",
      body: `${best.destinationText || "Best route"} produced ${money(best.net / best.miles)} per mile. Compare future offers to that route.`,
    });
  }

  return recommendations.slice(0, 4);
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfWeek(date) {
  const day = date.getDay();
  const start = startOfDay(date);
  start.setDate(start.getDate() - day);
  return start;
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function buildSummary(job) {
  const now = Date.now();
  const loadedMiles = Number.isFinite(job.actualLoadedMiles) && job.actualLoadedMiles >= 0
    ? job.actualLoadedMiles
    : job.plannedMiles || 0;
  const deadheadMiles = Number.isFinite(job.actualDeadheadMiles) && job.actualDeadheadMiles >= 0
    ? job.actualDeadheadMiles
    : job.deadheadMiles || 0;
  const miles = loadedMiles + deadheadMiles;
  const activeMs = job.status === "active" && job.activeStartedAt
    ? job.activeMs + Math.max(0, now - job.activeStartedAt)
    : job.activeMs;
  const totalMs = Math.max(0, (job.completedAt || now) - job.startedAt);
  const fuel = estimateFuel(miles, state.settings);
  return {
    id: job.id,
    destinationText: job.destinationText,
    grossPay: job.grossPay,
    miles,
    loadedMiles,
    deadheadMiles,
    fuel,
    net: job.grossPay - fuel,
    activeMs,
    totalMs,
    mileageSource: job.mileageSource || "gps",
    startedAt: job.startedAt,
    completedAt: job.completedAt || now,
  };
}

function getDeadheadLevel(deadheadMiles, totalMiles) {
  if (!totalMiles || totalMiles <= 0 || !deadheadMiles) return "";
  const share = deadheadMiles / totalMiles;
  if (share > DEADHEAD_ALERT_SHARE) return "alert";
  if (share > DEADHEAD_WARN_SHARE) return "warn";
  return "";
}

function formatDeadhead(deadheadMiles, totalMiles) {
  const share = totalMiles > 0 ? Math.round((deadheadMiles / totalMiles) * 100) : 0;
  return `${Number(deadheadMiles || 0).toFixed(1)} (${share}%)`;
}

function isNearDestination(job) {
  if (!job.destinationCoords || !job.lastPoint) return false;
  const distance = haversineMiles(
    job.lastPoint.lat,
    job.lastPoint.lon,
    job.destinationCoords.lat,
    job.destinationCoords.lon
  );
  return distance <= ARRIVAL_RADIUS_MILES && job.status !== "active";
}

function estimateFuel(miles, settings) {
  if (!miles || miles <= 0) return 0;
  return (miles / settings.mpg) * settings.fuelPrice;
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const radius = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getSpeedMph(coords) {
  return Number.isFinite(coords.speed) && coords.speed >= 0 ? coords.speed * 2.236936 : NaN;
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function toNumber(value) {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : 0;
}

function money(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(value || 0);
}

function duration(ms) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatInputNumber(value) {
  return Number(value).toString();
}

function showNotice(message) {
  els.notice.textContent = message;
  els.notice.hidden = false;
}

function hideNotice() {
  els.notice.hidden = true;
}

function setGpsBadge(text, tone) {
  els.gpsBadge.textContent = text;
  els.gpsBadge.className = `badge ${tone === "live" ? "badge-live" : tone === "warn" ? "badge-warn" : "badge-muted"}`;
}

function startClock() {
  window.setInterval(() => {
    if (state.job && state.job.status !== "completed") {
      renderDrive();
    }
  }, 1000);
}

function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...readJson(STORAGE_KEYS.settings, {}) };
}

function saveSettings() {
  localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(state.settings));
}

function loadJob() {
  return readJson(STORAGE_KEYS.job, null);
}

function saveJob() {
  if (state.job && state.job.status !== "completed") {
    localStorage.setItem(STORAGE_KEYS.job, JSON.stringify(state.job));
  }
}

function loadHistory() {
  return readJson(STORAGE_KEYS.history, []);
}

function saveHistory() {
  localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(state.history));
}

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  }
}
