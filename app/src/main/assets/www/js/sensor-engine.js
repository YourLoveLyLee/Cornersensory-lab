(function (global) {
  "use strict";

  class SensorEngine {
    constructor() {
      this.running = false;
      this.sourceMode = "auto"; // "auto" | "browser"
      this.activeDriver = "IDLE";
      this.listeners = new Set();
      this.statusListeners = new Set();

      this.nativeCaps = null;
      this.hasNativeBridge = typeof global.AndroidSensors !== "undefined";

      // Browser generic sensors
      this.genericLinAccel = null;
      this.genericAccel = null;
      this.genericGyro = null;

      // Latest readings
      this.latest = {
        tMs: 0,
        dtMs: 0,
        ax: 0,
        ay: 0,
        az: 0,
        gx: 0,
        gy: 0,
        gz: 0,
        ra: null,
        rb: null,
        rg: null,
        oa: null,
        ob: null,
        og: null,
        magLinear: 0,
        magWithGravity: 0,
      };

      // Gravity estimator when only raw accelerometer+gravity is available
      this.gravEst = { x: 0, y: 0, z: 9.80665, initialized: false };

      // Availability tracking
      this.availability = {
        accel: "IDLE",
        accelGrav: "IDLE",
        linearAccel: "IDLE",
        gyro: "IDLE",
        orientation: "IDLE",
      };

      // Rate tracking
      this.sampleCountWindow = 0;
      this.rateWindowStart = performance.now();
      this.measuredHz = 0;
      this.lastFrameTimeMs = null;

      // Bound listeners
      this._onDeviceMotion = this._handleDeviceMotion.bind(this);
      this._onDeviceOrientation = this._handleDeviceOrientation.bind(this);
      this._onNativeBatch = this._handleNativeBatch.bind(this);

      if (this.hasNativeBridge) {
        try {
          this.nativeCaps = JSON.parse(global.AndroidSensors.getCapabilitiesJson());
        } catch (err) {
          this.nativeCaps = null;
        }
      }
    }

    onSample(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }

    onStatus(fn) {
      this.statusListeners.add(fn);
      return () => this.statusListeners.delete(fn);
    }

    _notifyStatus() {
      const snapshot = this.getDiagnostics();
      this.statusListeners.forEach((fn) => fn(snapshot));
    }

    _emitSample(sample) {
      this.listeners.forEach((fn) => fn(sample));
    }

    setSourceMode(mode) {
      const wasRunning = this.running;
      if (wasRunning) this.stop();
      this.sourceMode = mode;
      this._notifyStatus();
      if (wasRunning) this.start();
    }

    async requestPermissions() {
      const results = [];
      try {
        if (
          typeof DeviceMotionEvent !== "undefined" &&
          typeof DeviceMotionEvent.requestPermission === "function"
        ) {
          const res = await DeviceMotionEvent.requestPermission();
          results.push("DeviceMotion: " + res);
        } else {
          results.push("DeviceMotion: no prompt required");
        }
      } catch (e) {
        results.push("DeviceMotion error: " + e.message);
      }

      try {
        if (
          typeof DeviceOrientationEvent !== "undefined" &&
          typeof DeviceOrientationEvent.requestPermission === "function"
        ) {
          const res = await DeviceOrientationEvent.requestPermission();
          results.push("DeviceOrientation: " + res);
        }
      } catch (e) {
        results.push("DeviceOrientation error: " + e.message);
      }

      if (navigator.permissions && navigator.permissions.query) {
        for (const name of ["accelerometer", "gyroscope"]) {
          try {
            const p = await navigator.permissions.query({ name });
            results.push(name + ": " + p.state);
          } catch (_) {
            results.push(name + ": permission API unsupported");
          }
        }
      }
      this._notifyStatus();
      return results;
    }

    start() {
      if (this.running) return;
      this.running = true;
      this.sampleCountWindow = 0;
      this.rateWindowStart = performance.now();
      this.measuredHz = 0;
      this.lastFrameTimeMs = null;
      this.gravEst.initialized = false;

      const useNative = this.sourceMode === "auto" && this.hasNativeBridge;

      if (useNative) {
        global.__onAndroidSensorBatch = this._onNativeBatch;
        const ok = global.AndroidSensors.start(200);
        if (ok) {
          this.activeDriver = "ANDROID_SENSOR_MANAGER_200HZ";
          this.availability.accel = this.nativeCaps?.hasAccelerometer ? "ACTIVE" : "UNAVAILABLE";
          this.availability.accelGrav = this.nativeCaps?.hasAccelerometer ? "ACTIVE" : "UNAVAILABLE";
          this.availability.linearAccel = this.nativeCaps?.hasLinearAcceleration
            ? "HARDWARE"
            : this.nativeCaps?.hasAccelerometer
            ? "DERIVED (HPF)"
            : "UNAVAILABLE";
          this.availability.gyro = this.nativeCaps?.hasGyroscope ? "ACTIVE" : "UNAVAILABLE";
          this.availability.orientation = this.nativeCaps?.hasRotationVector ? "ACTIVE" : "UNAVAILABLE";
          if (global.AndroidSensors.setKeepScreenOn) {
            global.AndroidSensors.setKeepScreenOn(true);
          }
          this._notifyStatus();
          return;
        }
      }

      this._startBrowserSensors();
    }

    _startBrowserSensors() {
      this.activeDriver = "BROWSER_APIS";
      this.availability.accel = "WAITING";
      this.availability.accelGrav = "WAITING";
      this.availability.linearAccel = "WAITING";
      this.availability.gyro = "WAITING";
      this.availability.orientation = "WAITING";

      let genericStarted = false;

      // Try Generic Sensor API first if available in secure context
      if ("LinearAccelerationSensor" in global || "Accelerometer" in global) {
        try {
          if ("LinearAccelerationSensor" in global) {
            this.genericLinAccel = new global.LinearAccelerationSensor({ frequency: 200 });
            this.genericLinAccel.addEventListener("reading", () => {
              if (!this.running) return;
              this.availability.linearAccel = "GENERIC_SENSOR_API";
              this._ingestGenericReading();
            });
            this.genericLinAccel.addEventListener("error", () => {
              this.genericLinAccel = null;
            });
            this.genericLinAccel.start();
            genericStarted = true;
          }
          if ("Accelerometer" in global) {
            this.genericAccel = new global.Accelerometer({ frequency: 200 });
            this.genericAccel.addEventListener("reading", () => {
              if (!this.running) return;
              this.availability.accel = "GENERIC_SENSOR_API";
              this.availability.accelGrav = "GENERIC_SENSOR_API";
              if (!this.genericLinAccel) {
                this._ingestGenericReading();
              }
            });
            this.genericAccel.addEventListener("error", () => {
              this.genericAccel = null;
            });
            this.genericAccel.start();
            genericStarted = true;
          }
          if ("Gyroscope" in global) {
            this.genericGyro = new global.Gyroscope({ frequency: 200 });
            this.genericGyro.addEventListener("reading", () => {
              if (!this.running) return;
              this.availability.gyro = "GENERIC_SENSOR_API";
            });
            this.genericGyro.addEventListener("error", () => {
              this.genericGyro = null;
            });
            this.genericGyro.start();
          }
        } catch (_) {
          this._stopGenericSensors();
          genericStarted = false;
        }
      }

      // Always attach DeviceMotionEvent & DeviceOrientationEvent
      if ("DeviceMotionEvent" in global) {
        global.addEventListener("devicemotion", this._onDeviceMotion);
      } else if (!genericStarted) {
        this.availability.accel = "UNAVAILABLE";
        this.availability.accelGrav = "UNAVAILABLE";
        this.availability.linearAccel = "UNAVAILABLE";
        this.availability.gyro = "UNAVAILABLE";
      }

      if ("DeviceOrientationEvent" in global) {
        global.addEventListener("deviceorientation", this._onDeviceOrientation);
      } else {
        this.availability.orientation = "UNAVAILABLE";
      }

      // After 1.5s, mark any still-waiting sensor as UNAVAILABLE
      setTimeout(() => {
        if (!this.running) return;
        for (const k of Object.keys(this.availability)) {
          if (this.availability[k] === "WAITING") {
            this.availability[k] = "UNAVAILABLE";
          }
        }
        this._notifyStatus();
      }, 1500);

      this._notifyStatus();
    }

    _stopGenericSensors() {
      for (const s of [this.genericLinAccel, this.genericAccel, this.genericGyro]) {
        if (s) {
          try {
            s.stop();
          } catch (_) {}
        }
      }
      this.genericLinAccel = null;
      this.genericAccel = null;
      this.genericGyro = null;
    }

    stop() {
      if (!this.running) return;
      this.running = false;

      if (this.hasNativeBridge) {
        try {
          global.AndroidSensors.stop();
        } catch (_) {}
        global.__onAndroidSensorBatch = null;
      }

      global.removeEventListener("devicemotion", this._onDeviceMotion);
      global.removeEventListener("deviceorientation", this._onDeviceOrientation);
      this._stopGenericSensors();

      this.activeDriver = "IDLE";
      this.measuredHz = 0;
      this._notifyStatus();
    }

    _ingestGenericReading() {
      const nowMs = performance.now();
      const lin = this.genericLinAccel;
      const acc = this.genericAccel;
      const gyr = this.genericGyro;

      const hasLin = lin && Number.isFinite(lin.x);
      const hasAcc = acc && Number.isFinite(acc.x);
      const hasGyr = gyr && Number.isFinite(gyr.x);

      const gx = hasAcc ? acc.x : 0;
      const gy = hasAcc ? acc.y : 0;
      const gz = hasAcc ? acc.z : 0;

      const radToDeg = 180 / Math.PI;
      const ra = hasGyr ? gyr.z * radToDeg : null;
      const rb = hasGyr ? gyr.x * radToDeg : null;
      const rg = hasGyr ? gyr.y * radToDeg : null;

      this._processRawFrame({
        tMs: nowMs,
        ax: hasLin ? lin.x : null,
        ay: hasLin ? lin.y : null,
        az: hasLin ? lin.z : null,
        gx,
        gy,
        gz,
        ra,
        rb,
        rg,
        oa: this.latest.oa,
        ob: this.latest.ob,
        og: this.latest.og,
      });
    }

    _handleDeviceMotion(event) {
      if (!this.running) return;
      // Avoid double-feeding if Generic LinearAccelerationSensor is actively providing readings
      if (this.genericLinAccel && this.availability.linearAccel === "GENERIC_SENSOR_API") {
        return;
      }

      const nowMs = performance.now();
      const acc = event.acceleration;
      const accG = event.accelerationIncludingGravity;
      const rot = event.rotationRate;

      const hasLin = acc && Number.isFinite(acc.x) && Number.isFinite(acc.y) && Number.isFinite(acc.z);
      const hasGrav = accG && Number.isFinite(accG.x) && Number.isFinite(accG.y) && Number.isFinite(accG.z);
      const hasRot = rot && (Number.isFinite(rot.alpha) || Number.isFinite(rot.beta) || Number.isFinite(rot.gamma));

      if (hasGrav) {
        this.availability.accel = "DEVICEMOTION";
        this.availability.accelGrav = "DEVICEMOTION";
      }
      if (hasLin) {
        this.availability.linearAccel = "DEVICEMOTION";
      } else if (hasGrav) {
        this.availability.linearAccel = "DERIVED (HPF)";
      }
      if (hasRot) {
        this.availability.gyro = "DEVICEMOTION";
      }

      if (!hasLin && !hasGrav && !hasRot) return;

      this._processRawFrame({
        tMs: nowMs,
        ax: hasLin ? acc.x : null,
        ay: hasLin ? acc.y : null,
        az: hasLin ? acc.z : null,
        gx: hasGrav ? accG.x : 0,
        gy: hasGrav ? accG.y : 0,
        gz: hasGrav ? accG.z : 0,
        ra: hasRot && Number.isFinite(rot.alpha) ? rot.alpha : null,
        rb: hasRot && Number.isFinite(rot.beta) ? rot.beta : null,
        rg: hasRot && Number.isFinite(rot.gamma) ? rot.gamma : null,
        oa: this.latest.oa,
        ob: this.latest.ob,
        og: this.latest.og,
      });
    }

    _handleDeviceOrientation(event) {
      if (!this.running) return;
      if (Number.isFinite(event.alpha) || Number.isFinite(event.beta) || Number.isFinite(event.gamma)) {
        this.availability.orientation = "DEVICEORIENTATION";
        this.latest.oa = event.alpha;
        this.latest.ob = event.beta;
        this.latest.og = event.gamma;
      }
    }

    _handleNativeBatch(batch) {
      if (!this.running || !Array.isArray(batch)) return;
      for (let i = 0; i < batch.length; i++) {
        this._processRawFrame(batch[i]);
      }
    }

    _processRawFrame(raw) {
      const tMs = Number.isFinite(raw.t) ? raw.t : raw.tMs;
      let dtMs = 10;
      if (this.lastFrameTimeMs !== null) {
        dtMs = Math.max(1, Math.min(200, tMs - this.lastFrameTimeMs));
      }
      this.lastFrameTimeMs = tMs;

      const gx = Number.isFinite(raw.gx) ? raw.gx : 0;
      const gy = Number.isFinite(raw.gy) ? raw.gy : 0;
      const gz = Number.isFinite(raw.gz) ? raw.gz : 0;

      let ax, ay, az;
      if (Number.isFinite(raw.ax) && Number.isFinite(raw.ay) && Number.isFinite(raw.az)) {
        ax = raw.ax;
        ay = raw.ay;
        az = raw.az;
      } else {
        // Real gravity estimator when device only reports accelerationIncludingGravity
        if (!this.gravEst.initialized) {
          this.gravEst.x = gx;
          this.gravEst.y = gy;
          this.gravEst.z = gz;
          this.gravEst.initialized = true;
        } else {
          const tauMs = 180;
          const alpha = Math.exp(-dtMs / tauMs);
          this.gravEst.x = alpha * this.gravEst.x + (1 - alpha) * gx;
          this.gravEst.y = alpha * this.gravEst.y + (1 - alpha) * gy;
          this.gravEst.z = alpha * this.gravEst.z + (1 - alpha) * gz;
        }
        ax = gx - this.gravEst.x;
        ay = gy - this.gravEst.y;
        az = gz - this.gravEst.z;
      }

      const magLinear = Math.hypot(ax, ay, az);
      const magWithGravity = Math.hypot(gx, gy, gz);

      const frame = {
        tMs,
        wallTime: Date.now(),
        dtMs,
        ax,
        ay,
        az,
        gx,
        gy,
        gz,
        ra: Number.isFinite(raw.ra) ? raw.ra : null,
        rb: Number.isFinite(raw.rb) ? raw.rb : null,
        rg: Number.isFinite(raw.rg) ? raw.rg : null,
        oa: Number.isFinite(raw.oa) ? raw.oa : this.latest.oa,
        ob: Number.isFinite(raw.ob) ? raw.ob : this.latest.ob,
        og: Number.isFinite(raw.og) ? raw.og : this.latest.og,
        magLinear,
        magWithGravity,
      };

      this.latest = frame;

      // Update rolling Hz once every 500ms
      this.sampleCountWindow++;
      const nowPerf = performance.now();
      const elapsed = nowPerf - this.rateWindowStart;
      if (elapsed >= 500) {
        this.measuredHz = (this.sampleCountWindow * 1000) / elapsed;
        this.sampleCountWindow = 0;
        this.rateWindowStart = nowPerf;
        this._notifyStatus();
      }

      this._emitSample(frame);
    }

    getDiagnostics() {
      return {
        running: this.running,
        sourceMode: this.sourceMode,
        activeDriver: this.activeDriver,
        measuredHz: this.measuredHz,
        hasNativeBridge: this.hasNativeBridge,
        nativeCaps: this.nativeCaps,
        availability: { ...this.availability },
        gyroAvailable:
          this.availability.gyro === "ACTIVE" ||
          this.availability.gyro === "DEVICEMOTION" ||
          this.availability.gyro === "GENERIC_SENSOR_API",
        userAgent: navigator.userAgent,
      };
    }
  }

  global.CornerSense = global.CornerSense || {};
  global.CornerSense.SensorEngine = SensorEngine;
})(window);
