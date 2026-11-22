(function (global) {
  "use strict";

  const { SensorEngine } = global.CornerSense;
  const { SpikeDetector } = global.CornerSense;
  const Analysis = global.CornerSense.Analysis;
  const { ScopeCanvas, renderTapSignature } = global.CornerSense.Charts;
  const { RippleEngine, CORNER_LABELS } = global.CornerSense;

  const STORAGE_KEY = "cornersense_lab_sessions_v1";
  const TAPS_PER_CORNER = 10;

  const state = {
    activeTab: "phantom",
    includeGravityInScopes: false,
    peakAccel: 0,
    lastSpikeTimestampText: "NONE",

    // Phantom Controller State
    phantomEngaged: false,
    phantomDebug: false,
    phantomCounts: { TL: 0, TR: 0, BL: 0, BR: 0 },
    phantomIgnoredTouches: 0,
    phantomFlashTimer: null,
    phantomPadTimers: { TL: null, TR: null, BL: null, BR: null },

    // Calibration
    calibrating: false,
    calibSamples: [],
    calibStartMs: 0,
    calibResult: null,

    // Experiment
    expMode: "individual", // "individual" | "sequential"
    selectedCorner: "TL",
    armed: false,
    ignoredTouches: 0,
    dataset: { TL: [], TR: [], BL: [], BR: [] },
    lastCapturedTap: null,
    sequentialPauseUntil: 0,

    // Analysis & Live detection
    analysisReport: null,
    liveDetectEnabled: false,
    lastLivePrediction: null,

    // History
    sessions: [],
  };

  const engine = new SensorEngine();
  const detector = new SpikeDetector();
  let rippleEngine = null;

  // Scopes
  let scopeAccX, scopeAccY, scopeAccZ, scopeGyrA, scopeGyrB, scopeGyrG;
  let rafId = null;

  function $(id) {
    return document.getElementById(id);
  }

  function init() {
    initScopes();
    rippleEngine = new RippleEngine($("phantomRippleCanvas"));
    rippleEngine.setStateListener((info) => {
      if (state.phantomDebug) {
        $("dbgRippleState").textContent = info.summary;
        $("dbgRippleDetail").textContent = info.summary;
      }
    });

    loadHistory();
    bindUI();
    renderCornerGrid();
    renderCornerTable();
    renderSensorDetails(engine.getDiagnostics());
    renderHistoryList();
    updateDetectorLabels();
    refreshPhantomModelStatus();
    $("sensorStatusStrip").classList.add("hidden");
    startRenderLoop();

    // Wire sensor stream
    engine.onSample(handleSensorSample);
    engine.onStatus(handleSensorStatus);

    // Wire spike captures
    detector.onTapCaptured(handleCapturedTap);
    detector.onDiagnostic(handleDetectorDiag);

    // Android lifecycle pause hook
    global.__onAndroidLifecyclePause = () => {
      if (state.armed) {
        state.armed = false;
        updateArmUI();
      }
      if (state.phantomEngaged) {
        state.phantomEngaged = false;
        updatePhantomEngageUI();
      }
      if (engine.running) {
        engine.stop();
      }
    };

    global.__onAndroidExportResult = (ok, msg) => {
      $("exportFeedback").textContent = (ok ? "EXPORT OK: " : "EXPORT NOTE: ") + msg;
    };
  }

  function initScopes() {
    scopeAccX = new ScopeCanvas($("canvasAccelX"), { color: "#ef4444", scale: 12 });
    scopeAccY = new ScopeCanvas($("canvasAccelY"), { color: "#f0b429", scale: 12 });
    scopeAccZ = new ScopeCanvas($("canvasAccelZ"), { color: "#60a5fa", scale: 12 });
    scopeGyrA = new ScopeCanvas($("canvasGyroA"), { color: "#ef4444", scale: 180 });
    scopeGyrB = new ScopeCanvas($("canvasGyroB"), { color: "#f0b429", scale: 180 });
    scopeGyrG = new ScopeCanvas($("canvasGyroG"), { color: "#60a5fa", scale: 180 });
  }

  function startRenderLoop() {
    const loop = () => {
      if (state.activeTab === "monitor") {
        scopeAccX.render();
        scopeAccY.render();
        scopeAccZ.render();
        scopeGyrA.render();
        scopeGyrB.render();
        scopeGyrG.render();
      }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  }

  function bindUI() {
    // Bottom tab navigation
    document.querySelectorAll(".nav-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.getAttribute("data-tab");
        switchTab(tab);
      });
    });

    // Phantom Controller Controls
    $("engagePhantomBtn").addEventListener("click", async () => {
      const model = ensureClassifierModel();
      if (!model) {
        refreshPhantomModelStatus();
        $("phantomFlashSub").textContent = "COLLECT ≥2 CORNERS IN TAPS TAB FIRST";
        return;
      }

      if (!state.phantomEngaged) {
        await engine.requestPermissions();
        if (!engine.running) engine.start();
        state.phantomEngaged = true;
        detector.suppressFor(350);
      } else {
        state.phantomEngaged = false;
      }
      updatePhantomEngageUI();
    });

    $("resetPhantomCountersBtn").addEventListener("click", () => {
      for (const c of Analysis.CORNERS) {
        state.phantomCounts[c] = 0;
        $("phantomCount" + c).textContent = "0";
        $("phantomTime" + c).textContent = "--:--:--";
      }
      $("phantomIgnoredTouches").textContent = "0";
      state.phantomIgnoredTouches = 0;
      $("phantomFlashSub").textContent = state.phantomEngaged ? "LISTENING FOR FRAME TAPS" : "STANDBY";
      $("dbgCorner").textContent = "--";
      $("dbgConfidence").textContent = "--";
      $("dbgRawSpike").textContent = "--";
      $("dbgTimestamp").textContent = "--";
    });

    $("phantomDebugToggle").addEventListener("change", (e) => {
      state.phantomDebug = e.target.checked;
      $("phantomDebugPanel").classList.toggle("hidden", !state.phantomDebug);
    });

    $("phantomGoTrainBtn").addEventListener("click", () => {
      switchTab("experiment");
    });

    // Touch shield on Phantom Stage: proves screen touches NEVER activate controller inputs or ripples
    $("phantomStage").addEventListener("pointerdown", (e) => {
      if (e.target && e.target.closest("button, label, input")) return;
      if (state.phantomEngaged) {
        state.phantomIgnoredTouches++;
        $("phantomIgnoredTouches").textContent = String(state.phantomIgnoredTouches);
      }
    });

    // Top bar sensor controls
    $("toggleSensorsBtn").addEventListener("click", async () => {
      if (engine.running) {
        engine.stop();
        state.armed = false;
        state.phantomEngaged = false;
        updateArmUI();
        updatePhantomEngageUI();
      } else {
        await engine.requestPermissions();
        engine.start();
      }
    });

    $("sensorSourceSelect").addEventListener("change", (e) => {
      engine.setSourceMode(e.target.value);
    });

    $("requestPermBtn").addEventListener("click", async () => {
      const log = await engine.requestPermissions();
      handleDetectorDiag({
        type: "INFO",
        time: new Date().toLocaleTimeString(),
        message: "Permissions checked -> " + log.join(" | "),
      });
      switchTab("calibrate");
    });

    $("resetPeakBtn").addEventListener("click", () => {
      state.peakAccel = 0;
      state.lastSpikeTimestampText = "NONE";
      $("kpiPeakMag").innerHTML = '0.00 <span class="unit">m/s²</span>';
      $("kpiLastSpikeTime").textContent = "LAST SPIKE: NONE";
    });

    $("showGravityToggle").addEventListener("change", (e) => {
      state.includeGravityInScopes = e.target.checked;
      $("kpiGravityNote").textContent = e.target.checked
        ? "RAW WITH GRAVITY"
        : "LINEAR (HIGH-PASS / HW)";
    });

    // Calibration
    $("startCalibBtn").addEventListener("click", startCalibration);
    $("applyCalibBtn").addEventListener("click", () => {
      if (!state.calibResult) return;
      detector.updateConfig({ threshold: state.calibResult.recommendedThreshold });
      $("paramThreshold").value = state.calibResult.recommendedThreshold;
      updateDetectorLabels();
      $("calibStatusBadge").textContent = "THRESHOLD APPLIED";
    });

    // Detector Sliders
    $("paramSensitivity").addEventListener("input", (e) => {
      detector.updateConfig({ sensitivity: Number(e.target.value) });
      updateDetectorLabels();
    });
    $("paramThreshold").addEventListener("input", (e) => {
      detector.updateConfig({ threshold: Number(e.target.value) });
      updateDetectorLabels();
    });
    $("paramCooldown").addEventListener("input", (e) => {
      detector.updateConfig({ cooldownMs: Number(e.target.value) });
      updateDetectorLabels();
    });
    $("paramWindow").addEventListener("input", (e) => {
      detector.updateConfig({ windowMs: Number(e.target.value) });
      updateDetectorLabels();
    });
    $("resetDetectorDefaultsBtn").addEventListener("click", () => {
      detector.updateConfig({ sensitivity: 6, threshold: 4.5, cooldownMs: 400, windowMs: 250 });
      $("paramSensitivity").value = 6;
      $("paramThreshold").value = 4.5;
      $("paramCooldown").value = 400;
      $("paramWindow").value = 250;
      updateDetectorLabels();
    });

    $("clearDiagLogBtn").addEventListener("click", () => {
      $("detectorEventLog").innerHTML = '<div class="log-empty">Log cleared.</div>';
    });

    // Experiment Mode Controls
    $("modeIndividualBtn").addEventListener("click", () => setExpMode("individual"));
    $("modeSequentialBtn").addEventListener("click", () => setExpMode("sequential"));

    document.querySelectorAll(".corner-target").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.selectedCorner = btn.getAttribute("data-corner");
        renderCornerGrid();
        renderCornerTable();
      });
    });

    $("touchShieldZone").addEventListener("pointerdown", () => {
      if (state.armed) {
        state.ignoredTouches++;
        $("ignoredTouchCounter").textContent = String(state.ignoredTouches);
      }
    });

    $("armRecordingBtn").addEventListener("click", () => {
      if (!engine.running) {
        engine.start();
      }
      state.armed = !state.armed;
      if (state.armed && state.expMode === "sequential") {
        const nextIncomplete = Analysis.CORNERS.find((c) => state.dataset[c].length < TAPS_PER_CORNER);
        if (nextIncomplete) state.selectedCorner = nextIncomplete;
      }
      detector.suppressFor(350);
      updateArmUI();
      renderCornerGrid();
      renderCornerTable();
    });

    $("undoLastTapBtn").addEventListener("click", () => {
      const list = state.dataset[state.selectedCorner];
      if (list.length > 0) {
        list.pop();
        state.lastCapturedTap = list[list.length - 1] || null;
        renderTapSignature($("canvasTapSignature"), state.lastCapturedTap);
        updateLastTapMetrics(state.lastCapturedTap);
        renderCornerGrid();
        renderCornerTable();
        updateExportCount();
        refreshPhantomModelStatus();
      }
    });

    $("clearCornerBtn").addEventListener("click", () => {
      state.dataset[state.selectedCorner] = [];
      state.lastCapturedTap = null;
      renderTapSignature($("canvasTapSignature"), null);
      updateLastTapMetrics(null);
      renderCornerGrid();
      renderCornerTable();
      updateExportCount();
      refreshPhantomModelStatus();
    });

    $("clearAllExperimentBtn").addEventListener("click", () => {
      state.dataset = { TL: [], TR: [], BL: [], BR: [] };
      state.armed = false;
      state.lastCapturedTap = null;
      state.ignoredTouches = 0;
      $("ignoredTouchCounter").textContent = "0";
      renderTapSignature($("canvasTapSignature"), null);
      updateLastTapMetrics(null);
      updateArmUI();
      renderCornerGrid();
      renderCornerTable();
      updateExportCount();
      refreshPhantomModelStatus();
    });

    // Analysis & Live Detection
    $("recomputeAnalysisBtn").addEventListener("click", runAnalysis);
    $("toggleLiveDetectBtn").addEventListener("click", () => {
      const model = ensureClassifierModel();
      if (!model) {
        $("livePredCorner").textContent = "NO MODEL";
        $("livePredConfidence").textContent = "Collect ≥2 taps on ≥2 corners first.";
        return;
      }
      state.liveDetectEnabled = !state.liveDetectEnabled;
      if (state.liveDetectEnabled && !engine.running) {
        engine.start();
      }
      $("toggleLiveDetectBtn").textContent = state.liveDetectEnabled
        ? "STOP LIVE DETECT"
        : "ENABLE LIVE DETECT";
      $("toggleLiveDetectBtn").classList.toggle("active-stop", state.liveDetectEnabled);
      if (state.liveDetectEnabled) {
        detector.suppressFor(350);
        $("livePredCorner").textContent = "LISTENING...";
        $("livePredConfidence").textContent = "Tap any physical corner";
      } else {
        $("livePredCorner").textContent = "STANDBY";
      }
    });

    // History & Export
    $("saveSessionBtn").addEventListener("click", saveCurrentSession);
    $("exportJsonBtn").addEventListener("click", exportJson);
    $("exportCsvBtn").addEventListener("click", exportCsv);
    $("clearHistoryBtn").addEventListener("click", () => {
      state.sessions = [];
      localStorage.removeItem(STORAGE_KEY);
      renderHistoryList();
    });
  }

  function ensureClassifierModel() {
    const report = Analysis.analyzeExperiment(state.dataset);
    state.analysisReport = report;
    return report.classifierModel;
  }

  function refreshPhantomModelStatus() {
    const report = Analysis.analyzeExperiment(state.dataset);
    state.analysisReport = report;
    const statusEl = $("phantomModelStatus");
    const trainBtn = $("phantomGoTrainBtn");
    const engageBtn = $("engagePhantomBtn");

    if (report.classifierModel) {
      const nCorners = report.classifierModel.evalCorners.length;
      statusEl.textContent = `MODEL READY (${report.totalCount} TAPS · ${nCorners}/4 CORNERS)`;
      trainBtn.classList.add("hidden");
      engageBtn.disabled = false;
    } else {
      statusEl.textContent = `MODEL UNTRAINED (${report.totalCount} TAPS — TRAIN IN TAPS TAB)`;
      trainBtn.classList.remove("hidden");
      if (state.phantomEngaged) {
        state.phantomEngaged = false;
        updatePhantomEngageUI();
      }
    }
  }

  function updatePhantomEngageUI() {
    const btn = $("engagePhantomBtn");
    btn.textContent = state.phantomEngaged ? "DISENGAGE" : "ENGAGE CONTROLLER";
    btn.classList.toggle("active-stop", state.phantomEngaged);
    $("phantomFlashSub").textContent = state.phantomEngaged
      ? "ARMED — TAP PHYSICAL PHONE CORNERS"
      : "STANDBY";
  }

  function triggerPhantomFeedback(corner, pred, tap) {
    const meta = CORNER_LABELS[corner];
    if (!meta) return;

    // 1. Create a NEW independent ripple instance originating at the physical corner
    rippleEngine.trigger(corner, {
      durationMs: 440,
      peakMag: tap.peakMag,
    });

    // 2. Increment counter & record timestamp
    state.phantomCounts[corner] = (state.phantomCounts[corner] || 0) + 1;
    const timeText = formatPreciseTime(tap.wallTimestamp);
    $("phantomCount" + corner).textContent = String(state.phantomCounts[corner]);
    $("phantomTime" + corner).textContent = timeText;

    // 3. Smooth luminous pad highlight (auto-fades via CSS transition)
    const isGold = corner === "TL" || corner === "BL";
    const padEl = $("phantomPad" + corner);
    padEl.classList.remove("pad-flash-gold", "pad-flash-crimson");
    void padEl.offsetWidth; // Force reflow so simultaneous/repeated taps re-trigger cleanly
    padEl.classList.add(isGold ? "pad-flash-gold" : "pad-flash-crimson");

    if (state.phantomPadTimers[corner]) clearTimeout(state.phantomPadTimers[corner]);
    state.phantomPadTimers[corner] = setTimeout(() => {
      padEl.classList.remove("pad-flash-gold", "pad-flash-crimson");
    }, 30);

    // 4. Briefly display recognized button label (L1 / R1 / L2 / R2) with smooth decay
    const flashEl = $("phantomFlashLabel");
    flashEl.textContent = meta.label;
    flashEl.classList.remove("flash-on-gold", "flash-on-crimson");
    void flashEl.offsetWidth;
    flashEl.classList.add(isGold ? "flash-on-gold" : "flash-on-crimson");
    $("phantomFlashSub").textContent = `${meta.name} · ${pred.confidence.toFixed(0)}% CONF`;

    if (state.phantomFlashTimer) clearTimeout(state.phantomFlashTimer);
    state.phantomFlashTimer = setTimeout(() => {
      flashEl.classList.remove("flash-on-gold", "flash-on-crimson");
    }, 60);

    // 5. Populate Debug Mode metrics
    $("dbgCorner").textContent = `${meta.name} (${meta.label})`;
    $("dbgConfidence").textContent = `${pred.confidence.toFixed(1)}%`;
    $("dbgRawSpike").textContent = `${tap.peakMag.toFixed(2)} m/s² (X:${tap.signedPeakX.toFixed(1)} Y:${tap.signedPeakY.toFixed(1)} Z:${tap.signedPeakZ.toFixed(1)})`;
    $("dbgTimestamp").textContent = timeText;
  }

  function formatPreciseTime(ms) {
    const d = new Date(ms);
    const pad = (n, w = 2) => String(n).padStart(w, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  }

  function switchTab(tab) {
    state.activeTab = tab;
    document.querySelectorAll(".tab-panel").forEach((p) => {
      p.classList.toggle("active", p.id === "tab-" + tab);
    });
    document.querySelectorAll(".nav-btn").forEach((b) => {
      const isAct = b.getAttribute("data-tab") === tab;
      b.classList.toggle("active", isAct);
      b.setAttribute("aria-selected", String(isAct));
    });

    if (tab === "phantom") {
      $("sensorStatusStrip").classList.add("hidden");
      refreshPhantomModelStatus();
    } else {
      $("sensorStatusStrip").classList.remove("hidden");
    }
    if (tab === "experiment") {
      renderTapSignature($("canvasTapSignature"), state.lastCapturedTap);
    }
    if (tab === "analysis") {
      runAnalysis();
    }
  }

  function handleSensorSample(frame) {
    const det = detector.processFrame(frame);

    if (state.calibrating) {
      state.calibSamples.push(det.hpMag);
      const elapsed = performance.now() - state.calibStartMs;
      const pct = Math.min(100, (elapsed / 4000) * 100);
      $("calibProgressBar").style.width = pct.toFixed(0) + "%";
      if (elapsed >= 4000) {
        finishCalibration();
      }
    }

    const axPlot = state.includeGravityInScopes ? frame.gx : frame.ax;
    const ayPlot = state.includeGravityInScopes ? frame.gy : frame.ay;
    const azPlot = state.includeGravityInScopes ? frame.gz : frame.az;
    scopeAccX.push(axPlot);
    scopeAccY.push(ayPlot);
    scopeAccZ.push(azPlot);

    const hasGyro = frame.ra !== null || frame.rb !== null || frame.rg !== null;
    scopeGyrA.setUnavailable(!hasGyro);
    scopeGyrB.setUnavailable(!hasGyro);
    scopeGyrG.setUnavailable(!hasGyro);
    if (hasGyro) {
      scopeGyrA.push(frame.ra || 0);
      scopeGyrB.push(frame.rb || 0);
      scopeGyrG.push(frame.rg || 0);
    }

    if (det.hpMag > state.peakAccel) {
      state.peakAccel = det.hpMag;
    }

    if (state.activeTab === "monitor") {
      const dispMag = state.includeGravityInScopes ? frame.magWithGravity : det.hpMag;
      $("kpiTotalMag").innerHTML = `${dispMag.toFixed(2)} <span class="unit">m/s²</span>`;
      $("kpiPeakMag").innerHTML = `${state.peakAccel.toFixed(2)} <span class="unit">m/s²</span>`;
      $("kpiSampleInterval").textContent = `Δt: ${frame.dtMs.toFixed(1)} ms`;
      $("kpiDetectorState").textContent = det.state;

      const meterPct = Math.min(100, (det.hpMag / 20) * 100);
      $("intensityBar").style.width = meterPct.toFixed(1) + "%";
      $("intensityNumeric").textContent = `${det.hpMag.toFixed(2)} / 20.0 m/s²`;

      $("valAccelX").textContent = axPlot.toFixed(2);
      $("valAccelY").textContent = ayPlot.toFixed(2);
      $("valAccelZ").textContent = azPlot.toFixed(2);
      $("accelCoordsReadout").textContent = `X:${axPlot.toFixed(2)} Y:${ayPlot.toFixed(2)} Z:${azPlot.toFixed(2)}`;

      if (hasGyro) {
        $("gyroUnavailableBanner").classList.add("hidden");
        $("valGyroA").textContent = (frame.ra || 0).toFixed(1);
        $("valGyroB").textContent = (frame.rb || 0).toFixed(1);
        $("valGyroG").textContent = (frame.rg || 0).toFixed(1);
        $("gyroCoordsReadout").textContent = `α:${(frame.ra || 0).toFixed(1)} β:${(frame.rb || 0).toFixed(1)} γ:${(frame.rg || 0).toFixed(1)}`;
      } else {
        $("gyroUnavailableBanner").classList.remove("hidden");
        $("valGyroA").textContent = "N/A";
        $("valGyroB").textContent = "N/A";
        $("valGyroG").textContent = "N/A";
        $("gyroCoordsReadout").textContent = "GYRO UNAVAILABLE";
      }
    }
  }

  function handleSensorStatus(diag) {
    const btn = $("toggleSensorsBtn");
    btn.textContent = diag.running ? "STOP SENSORS" : "START SENSORS";
    btn.classList.toggle("active-stop", diag.running);

    $("streamDot").className = "dot " + (diag.running ? "active" : "");
    $("liveHzText").textContent = diag.measuredHz.toFixed(1) + " Hz";
    $("kpiSampleRate").innerHTML = `${diag.measuredHz.toFixed(1)} <span class="unit">Hz</span>`;
    $("activeSourceBadge").textContent = diag.activeDriver;

    if (diag.nativeCaps && diag.nativeCaps.model) {
      $("deviceTargetLabel").textContent = `DEVICE: ${(diag.nativeCaps.manufacturer + " " + diag.nativeCaps.model).toUpperCase()} // API ${diag.nativeCaps.sdkInt}`;
    }

    const av = diag.availability;
    const chip = (label, status) => {
      const ok = status !== "IDLE" && status !== "UNAVAILABLE" && status !== "WAITING";
      const cls = status === "UNAVAILABLE" ? "chip-warn" : ok ? "chip-ok" : "chip-muted";
      return `<span class="chip ${cls}">${label}: ${status}</span>`;
    };
    $("availabilityChips").innerHTML =
      chip("ACCEL", av.accel) +
      chip("GYRO", av.gyro) +
      chip("ORIENT", av.orientation) +
      chip("LINEAR", av.linearAccel);

    renderSensorDetails(diag);
  }

  function renderSensorDetails(diag) {
    const rows = [];
    rows.push(["Driver Mode", diag.activeDriver]);
    rows.push(["Measured Update Freq", diag.measuredHz.toFixed(1) + " Hz"]);
    if (diag.nativeCaps) {
      const nc = diag.nativeCaps;
      rows.push([
        "Hardware Accelerometer",
        nc.hasAccelerometer
          ? `${nc.accelerometerInfo?.name} (max ${Math.round(nc.accelerometerInfo?.maxHz || 0)} Hz)`
          : "Not detected",
      ]);
      rows.push([
        "Hardware Linear Accel",
        nc.hasLinearAcceleration ? nc.linearAccelInfo?.name : "Not present (High-pass derived)",
      ]);
      rows.push([
        "Hardware Gyroscope",
        nc.hasGyroscope
          ? `${nc.gyroscopeInfo?.name} (max ${Math.round(nc.gyroscopeInfo?.maxHz || 0)} Hz)`
          : "UNAVAILABLE ON HARDWARE",
      ]);
      rows.push([
        "Rotation / Orientation",
        nc.hasRotationVector ? nc.rotationInfo?.name : "Browser DeviceOrientation fallback",
      ]);
    } else {
      rows.push(["Browser DeviceMotion", "DeviceMotionEvent" in global ? "Supported" : "Unsupported"]);
      rows.push([
        "Generic Sensor API",
        "Accelerometer" in global || "LinearAccelerationSensor" in global
          ? "Available in Secure Context"
          : "Unsupported in this browser",
      ]);
    }

    $("sensorDetailsTable").innerHTML = rows
      .map(
        ([k, v]) =>
          `<div class="diag-row"><span class="muted">${k}</span><span class="mono">${v}</span></div>`
      )
      .join("");
  }

  function handleDetectorDiag(evt) {
    const logEl = $("detectorEventLog");
    if (logEl.querySelector(".log-empty")) logEl.innerHTML = "";
    const row = document.createElement("div");
    row.className = evt.type === "REJECT" ? "log-item-rej" : "log-item-ok";
    row.textContent = `[${evt.time}] ${evt.type}: ${evt.message}`;
    logEl.prepend(row);
    while (logEl.children.length > 40) {
      logEl.removeChild(logEl.lastChild);
    }

    if (evt.type === "SPIKE") {
      state.lastSpikeTimestampText = evt.time;
      $("kpiLastSpikeTime").textContent = "LAST SPIKE: " + evt.time;
    }
  }

  function startCalibration() {
    if (!engine.running) {
      engine.start();
    }
    state.calibrating = true;
    state.calibSamples = [];
    state.calibStartMs = performance.now();
    $("calibProgressWrap").classList.remove("hidden");
    $("calibProgressBar").style.width = "0%";
    $("calibStatusBadge").textContent = "SAMPLING 4.0s...";
    $("startCalibBtn").disabled = true;
  }

  function finishCalibration() {
    state.calibrating = false;
    $("startCalibBtn").disabled = false;
    const vals = state.calibSamples;
    if (!vals.length) {
      $("calibStatusBadge").textContent = "NO SAMPLES RECEIVED";
      return;
    }

    let sum = 0,
      peak = 0;
    for (const v of vals) {
      sum += v;
      if (v > peak) peak = v;
    }
    const mu = sum / vals.length;
    let sq = 0;
    for (const v of vals) sq += (v - mu) * (v - mu);
    const sd = vals.length > 1 ? Math.sqrt(sq / (vals.length - 1)) : 0;

    const rawRec = Math.max(2.5, Math.min(18.0, peak * 1.85 + 3 * sd));
    const rec = Math.round(rawRec * 2) / 2;

    state.calibResult = {
      mean: +mu.toFixed(3),
      std: +sd.toFixed(3),
      peak: +peak.toFixed(3),
      recommendedThreshold: rec,
      sampleCount: vals.length,
    };

    $("calibMean").textContent = mu.toFixed(3) + " m/s²";
    $("calibStd").textContent = sd.toFixed(3) + " m/s²";
    $("calibPeak").textContent = peak.toFixed(3) + " m/s²";
    $("calibRec").textContent = rec.toFixed(1) + " m/s²";
    $("calibStatusBadge").textContent = `DONE (${vals.length} samples)`;
    $("applyCalibBtn").classList.remove("hidden");
  }

  function updateDetectorLabels() {
    const cfg = detector.config;
    $("valSensitivity").textContent = `${cfg.sensitivity} / 10`;
    $("valThreshold").textContent = `${cfg.threshold.toFixed(1)} m/s²`;
    $("valCooldown").textContent = `${cfg.cooldownMs} ms`;
    $("valWindow").textContent = `${cfg.windowMs} ms`;
    $("kpiRejectionNote").textContent = `THR: ${cfg.threshold.toFixed(1)} m/s²`;

    const markerPct = Math.min(98, (cfg.threshold / 20) * 100);
    $("intensityThresholdMarker").style.left = markerPct.toFixed(1) + "%";
  }

  function setExpMode(mode) {
    state.expMode = mode;
    $("modeIndividualBtn").classList.toggle("active", mode === "individual");
    $("modeSequentialBtn").classList.toggle("active", mode === "sequential");
    $("seqStatusBanner").classList.toggle("hidden", mode !== "sequential");
    $("experimentInstructions").innerHTML =
      mode === "individual"
        ? "<strong>Instructions (Individual Mode):</strong> Hold the phone naturally in your normal grip. Tap <strong>ARM TAP RECORDER</strong>, pause 0.5s, then tap the selected corner's outer frame 10 times with steady spacing (~1s apart)."
        : "<strong>Instructions (Auto Sequential Mode):</strong> System steps automatically through TOP LEFT → TOP RIGHT → BOTTOM LEFT → BOTTOM RIGHT (10 taps each) with a 2.0s reposition pause between corners.";
    updateArmUI();
  }

  function handleCapturedTap(tap) {
    // 1. Phantom Controller Mode (sensor-detected physical corner classification)
    if (state.activeTab === "phantom" && state.phantomEngaged) {
      const model = state.analysisReport?.classifierModel || ensureClassifierModel();
      if (model) {
        const pred = Analysis.classifyLiveTap(tap, model);
        if (pred && pred.predicted) {
          triggerPhantomFeedback(pred.predicted, pred, tap);
        }
      }
      return;
    }

    // 2. Analysis Live Detection Mode
    if (state.activeTab === "analysis" && state.liveDetectEnabled && state.analysisReport?.classifierModel) {
      const pred = Analysis.classifyLiveTap(tap, state.analysisReport.classifierModel);
      if (pred) {
        state.lastLivePrediction = pred;
        $("livePredCorner").textContent = pred.predictedName;
        $("livePredConfidence").textContent = `CONFIDENCE: ${pred.confidence}% (|a|=${tap.peakMag} m/s²)`;
        renderLiveDistBars(pred);
        rippleEngine.trigger(pred.predicted, { durationMs: 420, peakMag: tap.peakMag });
      }
      return;
    }

    // 3. Experiment Recording Mode
    if (state.activeTab !== "experiment" || !state.armed) return;
    if (state.expMode === "sequential" && performance.now() < state.sequentialPauseUntil) {
      return;
    }

    const corner = state.selectedCorner;
    const list = state.dataset[corner];

    if (list.length >= TAPS_PER_CORNER && state.expMode === "individual") {
      state.armed = false;
      updateArmUI();
      return;
    }

    list.push(tap);
    state.lastCapturedTap = tap;

    // Visual ripple on the actual sensor-detected corner during experiment capture
    rippleEngine.trigger(corner, { durationMs: 400, peakMag: tap.peakMag });

    renderTapSignature($("canvasTapSignature"), tap);
    updateLastTapMetrics(tap);
    updateExportCount();

    if (state.expMode === "sequential" && list.length >= TAPS_PER_CORNER) {
      const nextCorner = Analysis.CORNERS.find((c) => state.dataset[c].length < TAPS_PER_CORNER);
      if (nextCorner) {
        state.selectedCorner = nextCorner;
        state.sequentialPauseUntil = performance.now() + 2000;
        $("seqStatusBanner").textContent = `SWITCHING TO ${Analysis.CORNER_NAMES[nextCorner]} (2s PAUSE)...`;
        setTimeout(() => {
          if (state.expMode === "sequential" && state.armed) {
            $("seqStatusBanner").textContent = `ACTIVE: ${Analysis.CORNER_NAMES[state.selectedCorner]}`;
          }
        }, 2000);
      } else {
        state.armed = false;
        $("seqStatusBanner").textContent = "SEQUENCE COMPLETE (40/40 TAPS)";
      }
    } else if (state.expMode === "individual" && list.length >= TAPS_PER_CORNER) {
      state.armed = false;
    }

    updateArmUI();
    renderCornerGrid();
    renderCornerTable();
    refreshPhantomModelStatus();
  }

  function updateArmUI() {
    const btn = $("armRecordingBtn");
    const lbl = $("armStatusLabel");
    if (state.armed) {
      btn.textContent = "DISARM RECORDER";
      btn.classList.add("active-stop");
      lbl.textContent = `ARMED: ${Analysis.CORNER_NAMES[state.selectedCorner]}`;
      lbl.classList.add("armed");
      if (state.expMode === "sequential") {
        $("seqStatusBanner").textContent = `ACTIVE: ${Analysis.CORNER_NAMES[state.selectedCorner]}`;
      }
    } else {
      btn.textContent = "ARM TAP RECORDER";
      btn.classList.remove("active-stop");
      lbl.textContent = "DISARMED";
      lbl.classList.remove("armed");
    }
  }

  function renderCornerGrid() {
    let total = 0;
    for (const c of Analysis.CORNERS) {
      const n = state.dataset[c].length;
      total += n;
      const btn = $("cornerBtn" + c);
      btn.classList.toggle("active", state.selectedCorner === c);
      btn.classList.toggle("complete", n >= TAPS_PER_CORNER);
      $("count" + c).textContent = `${n} / ${TAPS_PER_CORNER}`;

      const pipsEl = $("pips" + c);
      let pipsHtml = "";
      for (let i = 0; i < TAPS_PER_CORNER; i++) {
        pipsHtml += `<span class="pip ${i < n ? "filled" : ""}"></span>`;
      }
      pipsEl.innerHTML = pipsHtml;
    }
    $("totalCollectedBadge").textContent = `${total} / 40 TAPS`;
  }

  function updateLastTapMetrics(tap) {
    if (!tap) {
      $("lastTapMeta").textContent = "NO TAP CAPTURED";
      $("tapPeakMag").textContent = "--";
      $("tapDuration").textContent = "--";
      $("tapAxesPeak").textContent = "--";
      $("tapGyroPeak").textContent = "--";
      return;
    }
    $("lastTapMeta").textContent = `${tap.samples.length} samples @ ${new Date(tap.wallTimestamp).toLocaleTimeString()}`;
    $("tapPeakMag").textContent = `${tap.peakMag.toFixed(2)} m/s²`;
    $("tapDuration").textContent = `${tap.durationMs.toFixed(1)} ms`;
    $("tapAxesPeak").textContent = `${tap.signedPeakX.toFixed(1)} / ${tap.signedPeakY.toFixed(1)} / ${tap.signedPeakZ.toFixed(1)}`;
    $("tapGyroPeak").textContent = tap.gyroAvailable
      ? `${tap.signedRa.toFixed(1)} / ${tap.signedRb.toFixed(1)} / ${tap.signedRg.toFixed(1)} °/s`
      : "UNAVAILABLE";
  }

  function renderCornerTable() {
    const corner = state.selectedCorner;
    const list = state.dataset[corner];
    $("activeCornerListTitle").textContent = Analysis.CORNER_NAMES[corner];
    $("activeCornerListCount").textContent = `${list.length} samples`;

    const tbody = $("cornerSamplesBody");
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">No taps recorded for this corner yet.</td></tr>';
      return;
    }

    tbody.innerHTML = list
      .map(
        (t, idx) => `
      <tr data-tap-index="${idx}">
        <td>${idx + 1}</td>
        <td>${new Date(t.wallTimestamp).toLocaleTimeString()}</td>
        <td class="accent-gold">${t.peakMag.toFixed(2)}</td>
        <td>(${t.firstX.toFixed(1)}, ${t.firstY.toFixed(1)}, ${t.firstZ.toFixed(1)})</td>
        <td>${t.durationMs.toFixed(0)}ms</td>
        <td><button type="button" class="btn btn-outline btn-xs inspect-tap-btn" data-idx="${idx}">VIEW</button></td>
      </tr>`
      )
      .join("");

    tbody.querySelectorAll(".inspect-tap-btn").forEach((b) => {
      b.addEventListener("click", () => {
        const tap = list[Number(b.getAttribute("data-idx"))];
        if (tap) {
          state.lastCapturedTap = tap;
          renderTapSignature($("canvasTapSignature"), tap);
          updateLastTapMetrics(tap);
        }
      });
    });
  }

  function runAnalysis() {
    const report = Analysis.analyzeExperiment(state.dataset);
    state.analysisReport = report;

    const card = $("verdictCard");
    card.classList.toggle("verdict-fail", !report.verdict.isPositive);
    $("verdictBadge").textContent = report.verdict.badge;
    $("verdictSummary").textContent = report.verdict.summary;

    if (!report.ready) {
      $("verdictAccuracy").textContent = "--% LOOCV";
      $("verdictMeta").textContent = `Collected ${report.totalCount} taps total. Random baseline: 25.0%`;
    } else {
      $("verdictAccuracy").textContent = `${report.accuracy.toFixed(1)}% LOOCV`;
      $("verdictMeta").textContent = `Evaluated N=${report.evaluatedN} // Random Baseline: ${report.randomBaseline}% // Cohen's κ: ${report.kappa}`;
    }

    renderConfusionMatrix(report);
    renderCornerStatsTable(report);
    renderAnovaList(report);
    renderSimilarityMatrix(report);
  }

  function renderConfusionMatrix(report) {
    const el = $("confusionMatrixContainer");
    if (!report.ready || !report.confusionMatrix) {
      el.innerHTML = '<div class="log-empty">Collect ≥2 taps on ≥2 corners to compute LOOCV confusion matrix.</div>';
      return;
    }

    const cm = report.confusionMatrix;
    let html = '<table class="matrix-table"><thead><tr><th>ACTUAL \\ PRED</th>';
    for (const c of Analysis.CORNERS) html += `<th>${c}</th>`;
    html += "<th>RECALL</th></tr></thead><tbody>";

    for (const actual of Analysis.CORNERS) {
      let rowSum = 0;
      for (const pred of Analysis.CORNERS) rowSum += cm[actual][pred];
      html += `<tr><th>${actual}</th>`;
      for (const pred of Analysis.CORNERS) {
        const val = cm[actual][pred];
        const cls = actual === pred && val > 0 ? "matrix-diag" : val > 0 ? "matrix-err" : "";
        html += `<td class="${cls}">${val}</td>`;
      }
      const recall = rowSum > 0 ? ((cm[actual][actual] / rowSum) * 100).toFixed(0) + "%" : "--";
      html += `<td>${recall}</td></tr>`;
    }
    html += "</tbody></table>";
    el.innerHTML = html;
  }

  function renderCornerStatsTable(report) {
    const tbody = $("cornerStatsBody");
    const rows = Analysis.CORNERS.map((c) => report.cornerStats[c]).filter(Boolean);
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-cell">No sample data collected.</td></tr>';
      return;
    }
    tbody.innerHTML = rows
      .map(
        (s) => `
      <tr>
        <td><strong>${s.corner}</strong></td>
        <td>${s.n}</td>
        <td class="accent-gold">${s.meanPeakMag} (max ${s.maxPeakMag})</td>
        <td>${s.meanX}±${s.stdX}</td>
        <td>${s.meanY}±${s.stdY}</td>
        <td>${s.meanZ}±${s.stdZ}</td>
        <td>${s.meanDurMs}±${s.stdDurMs}</td>
      </tr>`
      )
      .join("");
  }

  function renderAnovaList(report) {
    const el = $("anovaFeatureList");
    if (!report.anova || !report.anova.length) {
      el.innerHTML = '<div class="log-empty">Insufficient samples for ANOVA F-test.</div>';
      return;
    }
    el.innerHTML = report.anova
      .slice(0, 8)
      .map(
        (a) =>
          `<div class="diag-row"><span>${a.label}</span><span class="mono">F=${a.fStat} // η²=${a.etaSq}</span></div>`
      )
      .join("");
  }

  function renderSimilarityMatrix(report) {
    const el = $("similarityMatrixContainer");
    if (!report.similarityMatrix) {
      el.innerHTML = '<div class="log-empty">Insufficient samples for similarity matrix.</div>';
      return;
    }
    let html = '<table class="matrix-table"><thead><tr><th>CORNER</th>';
    for (const c of Analysis.CORNERS) html += `<th>${c}</th>`;
    html += "</tr></thead><tbody>";

    for (const c1 of Analysis.CORNERS) {
      html += `<tr><th>${c1}</th>`;
      for (const c2 of Analysis.CORNERS) {
        const cell = report.similarityMatrix[c1][c2];
        if (!cell) {
          html += "<td>--</td>";
        } else if (c1 === c2) {
          html += `<td class="matrix-diag">100%</td>`;
        } else {
          const highOverlap = cell.similarityPct > 75;
          html += `<td class="${highOverlap ? "matrix-err" : ""}">${cell.similarityPct}%<br/><span class="muted">d=${cell.distance}</span></td>`;
        }
      }
      html += "</tr>";
    }
    html += "</tbody></table>";
    el.innerHTML = html;
  }

  function renderLiveDistBars(pred) {
    const el = $("liveDistBars");
    el.innerHTML = Object.entries(pred.probabilities)
      .map(
        ([c, pct]) => `
      <div class="dist-bar-row">
        <span>${c}</span>
        <div class="dist-track"><div class="dist-fill" style="width:${pct}%"></div></div>
        <span>${pct.toFixed(0)}%</span>
      </div>`
      )
      .join("");
  }

  function updateExportCount() {
    const total = Analysis.CORNERS.reduce((acc, c) => acc + state.dataset[c].length, 0);
    $("exportSessionCount").textContent = `${total} taps in memory`;
  }

  function loadHistory() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      state.sessions = raw ? JSON.parse(raw) : [];
    } catch (_) {
      state.sessions = [];
    }
  }

  function saveCurrentSession() {
    const total = Analysis.CORNERS.reduce((acc, c) => acc + state.dataset[c].length, 0);
    if (total === 0) {
      $("exportFeedback").textContent = "Cannot save empty session — collect at least 1 tap first.";
      return;
    }
    const report = Analysis.analyzeExperiment(state.dataset);
    const label = $("sessionLabelInput").value.trim() || `Session ${new Date().toLocaleString()}`;
    const entry = {
      id: "sess_" + Date.now(),
      label,
      createdAt: new Date().toISOString(),
      totalTaps: total,
      accuracy: report.accuracy,
      verdict: report.verdict.badge,
      diagnostics: engine.getDiagnostics(),
      detectorConfig: { ...detector.config },
      calibration: state.calibResult,
      dataset: JSON.parse(JSON.stringify(state.dataset)),
    };

    state.sessions.unshift(entry);
    if (state.sessions.length > 20) state.sessions.pop();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.sessions));
    $("sessionLabelInput").value = "";
    $("exportFeedback").textContent = `Saved "${label}" (${total} taps) to local history.`;
    renderHistoryList();
  }

  function renderHistoryList() {
    const el = $("historyList");
    if (!state.sessions.length) {
      el.innerHTML = '<div class="log-empty">No saved sessions yet.</div>';
      return;
    }
    el.innerHTML = state.sessions
      .map(
        (s) => `
      <div class="history-item">
        <div>
          <div><strong>${escapeHtml(s.label)}</strong></div>
          <div class="mono small-meta">${s.totalTaps} taps // ${s.accuracy !== null ? s.accuracy + "% LOOCV" : "Incomplete"} // ${escapeHtml(s.verdict)}</div>
        </div>
        <div class="history-actions">
          <button type="button" class="btn btn-outline btn-xs load-sess-btn" data-id="${s.id}">LOAD</button>
          <button type="button" class="btn btn-outline btn-xs del-sess-btn" data-id="${s.id}">DEL</button>
        </div>
      </div>`
      )
      .join("");

    el.querySelectorAll(".load-sess-btn").forEach((b) => {
      b.addEventListener("click", () => {
        const found = state.sessions.find((s) => s.id === b.getAttribute("data-id"));
        if (!found) return;
        state.dataset = JSON.parse(JSON.stringify(found.dataset));
        if (found.detectorConfig) {
          detector.updateConfig(found.detectorConfig);
          $("paramSensitivity").value = detector.config.sensitivity;
          $("paramThreshold").value = detector.config.threshold;
          $("paramCooldown").value = detector.config.cooldownMs;
          $("paramWindow").value = detector.config.windowMs;
          updateDetectorLabels();
        }
        renderCornerGrid();
        renderCornerTable();
        updateExportCount();
        refreshPhantomModelStatus();
        runAnalysis();
        switchTab("phantom");
      });
    });

    el.querySelectorAll(".del-sess-btn").forEach((b) => {
      b.addEventListener("click", () => {
        const id = b.getAttribute("data-id");
        state.sessions = state.sessions.filter((s) => s.id !== id);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state.sessions));
        renderHistoryList();
      });
    });
  }

  function exportJson() {
    const report = Analysis.analyzeExperiment(state.dataset);
    const payload = {
      exportedAt: new Date().toISOString(),
      app: "CornerSense Lab - Phantom Controller",
      diagnostics: engine.getDiagnostics(),
      detectorConfig: detector.config,
      calibration: state.calibResult,
      analysisSummary: {
        ready: report.ready,
        totalCount: report.totalCount,
        accuracy: report.accuracy,
        kappa: report.kappa,
        verdict: report.verdict,
        confusionMatrix: report.confusionMatrix,
        anova: report.anova,
        similarityMatrix: report.similarityMatrix,
        cornerStats: report.cornerStats,
      },
      dataset: state.dataset,
    };
    triggerDownload(
      `cornersense_lab_${Date.now()}.json`,
      "application/json",
      JSON.stringify(payload, null, 2)
    );
  }

  function exportCsv() {
    const headers = [
      "corner",
      "tap_index",
      "timestamp_iso",
      "peak_mag_ms2",
      "first_x",
      "first_y",
      "first_z",
      "signed_peak_x",
      "signed_peak_y",
      "signed_peak_z",
      "mean_abs_x",
      "mean_abs_y",
      "mean_abs_z",
      "energy_ratio_x",
      "energy_ratio_y",
      "energy_ratio_z",
      "duration_ms",
      "gyro_available",
      "signed_gyro_alpha",
      "signed_gyro_beta",
      "signed_gyro_gamma",
    ];
    const lines = [headers.join(",")];
    for (const c of Analysis.CORNERS) {
      state.dataset[c].forEach((t, idx) => {
        lines.push(
          [
            c,
            idx + 1,
            t.timestampIso,
            t.peakMag,
            t.firstX,
            t.firstY,
            t.firstZ,
            t.signedPeakX,
            t.signedPeakY,
            t.signedPeakZ,
            t.meanAbsX,
            t.meanAbsY,
            t.meanAbsZ,
            t.energyRatioX,
            t.energyRatioY,
            t.energyRatioZ,
            t.durationMs,
            t.gyroAvailable,
            t.signedRa ?? "",
            t.signedRb ?? "",
            t.signedRg ?? "",
          ].join(",")
        );
      });
    }
    triggerDownload(`cornersense_taps_${Date.now()}.csv`, "text/csv", lines.join("\n"));
  }

  function triggerDownload(filename, mimeType, content) {
    if (global.AndroidExport && typeof global.AndroidExport.saveFile === "function") {
      global.AndroidExport.saveFile(filename, mimeType, content);
      return;
    }
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $("exportFeedback").textContent = `Downloaded ${filename}`;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  document.addEventListener("DOMContentLoaded", init);
})(window);
