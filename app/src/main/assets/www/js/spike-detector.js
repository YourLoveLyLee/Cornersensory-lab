(function (global) {
  "use strict";

  class SpikeDetector {
    constructor(config = {}) {
      this.config = {
        sensitivity: config.sensitivity ?? 6, // 1..10
        threshold: config.threshold ?? 4.5, // m/s^2
        cooldownMs: config.cooldownMs ?? 400, // ms
        windowMs: config.windowMs ?? 250, // total capture window ms
        preTriggerMs: 80,
      };

      this.ema = { x: 0, y: 0, z: 0, initialized: false };
      this.prevHp = { x: 0, y: 0, z: 0, mag: 0 };
      this.preBuffer = [];
      this.maxPreSamples = 120;

      this.lastTriggerMs = -Infinity;
      this.lastFrameTMs = null;
      this.pendingSuppressMs = 0;
      this.suppressUntilTMs = -Infinity;
      this.capturing = null;

      this.tapListeners = new Set();
      this.diagListeners = new Set();
    }

    updateConfig(partial) {
      this.config = { ...this.config, ...partial };
    }

    onTapCaptured(fn) {
      this.tapListeners.add(fn);
      return () => this.tapListeners.delete(fn);
    }

    onDiagnostic(fn) {
      this.diagListeners.add(fn);
      return () => this.diagListeners.delete(fn);
    }

    _emitDiag(type, message, data = {}) {
      const evt = { type, message, time: new Date().toLocaleTimeString(), ...data };
      this.diagListeners.forEach((fn) => fn(evt));
    }

    reset() {
      this.ema.initialized = false;
      this.preBuffer = [];
      this.capturing = null;
      this.lastTriggerMs = -Infinity;
      this.lastFrameTMs = null;
      this.pendingSuppressMs = 0;
      this.suppressUntilTMs = -Infinity;
    }

    suppressFor(ms) {
      if (this.lastFrameTMs !== null) {
        this.suppressUntilTMs = Math.max(this.suppressUntilTMs, this.lastFrameTMs + ms);
      } else {
        this.pendingSuppressMs = Math.max(this.pendingSuppressMs, ms);
      }
    }

    processFrame(frame) {
      const dtMs = Math.max(1, frame.dtMs || 10);
      this.lastFrameTMs = frame.tMs;
      if (this.pendingSuppressMs > 0) {
        this.suppressUntilTMs = frame.tMs + this.pendingSuppressMs;
        this.pendingSuppressMs = 0;
      }

      // Slow baseline EMA (~55ms tau) strips gravity drift & slow wrist rotation
      if (!this.ema.initialized) {
        this.ema.x = frame.ax;
        this.ema.y = frame.ay;
        this.ema.z = frame.az;
        this.ema.initialized = true;
      } else {
        const alpha = Math.exp(-dtMs / 55);
        this.ema.x = alpha * this.ema.x + (1 - alpha) * frame.ax;
        this.ema.y = alpha * this.ema.y + (1 - alpha) * frame.ay;
        this.ema.z = alpha * this.ema.z + (1 - alpha) * frame.az;
      }

      const hpx = frame.ax - this.ema.x;
      const hpy = frame.ay - this.ema.y;
      const hpz = frame.az - this.ema.z;
      const hpMag = Math.hypot(hpx, hpy, hpz);

      // Instantaneous delta & jerk for hand-movement rejection
      const dx = hpx - this.prevHp.x;
      const dy = hpy - this.prevHp.y;
      const dz = hpz - this.prevHp.z;
      const deltaMag = Math.hypot(dx, dy, dz);
      const jerk = deltaMag / (dtMs / 1000);

      this.prevHp.x = hpx;
      this.prevHp.y = hpy;
      this.prevHp.z = hpz;
      this.prevHp.mag = hpMag;

      const samplePoint = {
        tMs: frame.tMs,
        dtMs,
        ax: hpx,
        ay: hpy,
        az: hpz,
        rawAx: frame.ax,
        rawAy: frame.ay,
        rawAz: frame.az,
        mag: hpMag,
        gx: frame.gx,
        gy: frame.gy,
        gz: frame.gz,
        ra: frame.ra,
        rb: frame.rb,
        rg: frame.rg,
      };

      // If currently recording post-spike window, append and finalize when done
      if (this.capturing) {
        this.capturing.samples.push(samplePoint);
        const elapsed = frame.tMs - this.capturing.triggerTimeMs;
        if (elapsed >= this.capturing.postWindowMs) {
          const finalized = this._finalizeCapture(this.capturing);
          this.capturing = null;
          this.lastTriggerMs = frame.tMs;
          this.tapListeners.forEach((fn) => fn(finalized));
        }
        this._pushPreBuffer(samplePoint);
        return { hpMag, hpx, hpy, hpz, state: "CAPTURING" };
      }

      this._pushPreBuffer(samplePoint);

      // Check cooldown and post-UI-button grace suppression
      if (
        frame.tMs - this.lastTriggerMs < this.config.cooldownMs ||
        frame.tMs < this.suppressUntilTMs
      ) {
        return { hpMag, hpx, hpy, hpz, state: "COOLDOWN" };
      }

      // Check threshold crossing
      if (hpMag >= this.config.threshold) {
        // Compute pre-trigger background RMS (excluding very last 15ms onset)
        const preWindow = this.preBuffer.filter(
          (s) => frame.tMs - s.tMs > 15 && frame.tMs - s.tMs <= 90
        );
        let preRms = 0;
        if (preWindow.length > 0) {
          let sumSq = 0;
          for (const p of preWindow) sumSq += p.mag * p.mag;
          preRms = Math.sqrt(sumSq / preWindow.length);
        }

        // Sensitivity gate (1..10): checks impulse sharpness & quiet baseline
        // Sensitivity 1 = lenient, Sensitivity 10 = strict sharp tap only
        const sensFactor = (this.config.sensitivity - 1) / 9; // 0..1
        const minDeltaRatio = 0.25 + sensFactor * 0.45; // delta >= 25%..70% of threshold
        const minJerk = this.config.threshold * (12 + sensFactor * 48);
        const maxAllowedPreRms = this.config.threshold * (0.75 - sensFactor * 0.35);

        const isSharp = deltaMag >= this.config.threshold * minDeltaRatio || jerk >= minJerk;
        const isQuietBefore = preRms <= maxAllowedPreRms;

        if (!isSharp || !isQuietBefore) {
          // Reject ordinary sustained hand motion / shaking; apply short 120ms debounce so log isn't spammed
          if (!this._lastRejectMs || frame.tMs - this._lastRejectMs > 220) {
            this._lastRejectMs = frame.tMs;
            const reason = !isQuietBefore
              ? `Sustained motion rejected (preRMS=${preRms.toFixed(2)})`
              : `Slow movement rejected (Δ=${deltaMag.toFixed(2)}, jerk=${jerk.toFixed(0)})`;
            this._emitDiag("REJECT", reason, { hpMag, preRms, jerk });
          }
          return { hpMag, hpx, hpy, hpz, state: "REJECTED_MOTION" };
        }

        // Start capturing pre + post spike window
        const preSamples = this.preBuffer
          .filter((s) => frame.tMs - s.tMs <= this.config.preTriggerMs)
          .map((s) => ({ ...s }));
        const postWindowMs = Math.max(60, this.config.windowMs - this.config.preTriggerMs);

        this.capturing = {
          triggerTimeMs: frame.tMs,
          wallTimestamp: frame.wallTime,
          postWindowMs,
          samples: preSamples,
          triggerIndex: Math.max(0, preSamples.length - 1),
        };

        this._emitDiag(
          "SPIKE",
          `Spike triggered at ${hpMag.toFixed(2)} m/s² (jerk ${jerk.toFixed(0)})`,
          { hpMag, jerk }
        );
        return { hpMag, hpx, hpy, hpz, state: "TRIGGERED" };
      }

      return { hpMag, hpx, hpy, hpz, state: "ARMED" };
    }

    _pushPreBuffer(pt) {
      this.preBuffer.push(pt);
      while (this.preBuffer.length > this.maxPreSamples) {
        this.preBuffer.shift();
      }
      // Also trim older than 150ms
      const newestT = pt.tMs;
      while (this.preBuffer.length > 10 && newestT - this.preBuffer[0].tMs > 150) {
        this.preBuffer.shift();
      }
    }

    _finalizeCapture(cap) {
      const samples = cap.samples;
      const t0 = cap.triggerTimeMs;

      // Normalize sample times relative to trigger time (e.g. -80ms .. +170ms)
      const relSamples = samples.map((s) => ({
        relMs: +(s.tMs - t0).toFixed(2),
        ax: +s.ax.toFixed(4),
        ay: +s.ay.toFixed(4),
        az: +s.az.toFixed(4),
        mag: +s.mag.toFixed(4),
        ra: s.ra !== null ? +s.ra.toFixed(3) : null,
        rb: s.rb !== null ? +s.rb.toFixed(3) : null,
        rg: s.rg !== null ? +s.rg.toFixed(3) : null,
      }));

      // Analyze post-onset impulse (from -10ms onwards)
      let peakMag = 0;
      let peakIdx = cap.triggerIndex;
      let peakAbsX = 0,
        peakAbsY = 0,
        peakAbsZ = 0;
      let signedPeakX = 0,
        signedPeakY = 0,
        signedPeakZ = 0;

      let sumAbsX = 0,
        sumAbsY = 0,
        sumAbsZ = 0;
      let sumSqX = 0,
        sumSqY = 0,
        sumSqZ = 0,
        sumSqMag = 0;
      let activeCount = 0;

      let gyroCount = 0;
      let peakRa = 0,
        peakRb = 0,
        peakRg = 0;
      let signedRa = 0,
        signedRb = 0,
        signedRg = 0;

      for (let i = 0; i < relSamples.length; i++) {
        const s = relSamples[i];
        if (s.relMs < -12) continue;

        activeCount++;
        const absX = Math.abs(s.ax);
        const absY = Math.abs(s.ay);
        const absZ = Math.abs(s.az);

        if (s.mag > peakMag) {
          peakMag = s.mag;
          peakIdx = i;
        }
        if (absX > peakAbsX) {
          peakAbsX = absX;
          signedPeakX = s.ax;
        }
        if (absY > peakAbsY) {
          peakAbsY = absY;
          signedPeakY = s.ay;
        }
        if (absZ > peakAbsZ) {
          peakAbsZ = absZ;
          signedPeakZ = s.az;
        }

        sumAbsX += absX;
        sumAbsY += absY;
        sumAbsZ += absZ;
        sumSqX += s.ax * s.ax;
        sumSqY += s.ay * s.ay;
        sumSqZ += s.az * s.az;
        sumSqMag += s.mag * s.mag;

        if (s.ra !== null || s.rb !== null || s.rg !== null) {
          gyroCount++;
          const aRa = Math.abs(s.ra || 0);
          const aRb = Math.abs(s.rb || 0);
          const aRg = Math.abs(s.rg || 0);
          if (aRa > peakRa) {
            peakRa = aRa;
            signedRa = s.ra || 0;
          }
          if (aRb > peakRb) {
            peakRb = aRb;
            signedRb = s.rb || 0;
          }
          if (aRg > peakRg) {
            peakRg = aRg;
            signedRg = s.rg || 0;
          }
        }
      }

      // First initial impulse polarity (within first 35ms of trigger)
      let firstPeakMag = 0;
      let firstX = 0,
        firstY = 0,
        firstZ = 0;
      for (const s of relSamples) {
        if (s.relMs >= -8 && s.relMs <= 35 && s.mag > firstPeakMag) {
          firstPeakMag = s.mag;
          firstX = s.ax;
          firstY = s.ay;
          firstZ = s.az;
        }
      }

      // Vibration duration: from first crossing >= 25% of threshold (or 0ms) until settled below settleFloor for >= 20ms
      const settleFloor = Math.max(0.7, this.config.threshold * 0.22);
      let startRelMs = 0;
      let endRelMs = 20;
      let foundStart = false;
      for (let i = 0; i < relSamples.length; i++) {
        const s = relSamples[i];
        if (!foundStart && s.relMs >= -15 && s.mag >= settleFloor * 1.3) {
          startRelMs = s.relMs;
          foundStart = true;
        }
        if (foundStart && s.mag >= settleFloor) {
          endRelMs = s.relMs;
        }
      }
      const durationMs = Math.max(5, +(endRelMs - startRelMs).toFixed(1));

      const denom = Math.max(1e-6, sumSqMag);
      const count = Math.max(1, activeCount);

      return {
        id: "tap_" + cap.wallTimestamp + "_" + Math.floor(Math.random() * 1000),
        timestampIso: new Date(cap.wallTimestamp).toISOString(),
        wallTimestamp: cap.wallTimestamp,
        peakMag: +peakMag.toFixed(3),
        peakX: +peakAbsX.toFixed(3),
        peakY: +peakAbsY.toFixed(3),
        peakZ: +peakAbsZ.toFixed(3),
        signedPeakX: +signedPeakX.toFixed(3),
        signedPeakY: +signedPeakY.toFixed(3),
        signedPeakZ: +signedPeakZ.toFixed(3),
        firstX: +firstX.toFixed(3),
        firstY: +firstY.toFixed(3),
        firstZ: +firstZ.toFixed(3),
        meanAbsX: +(sumAbsX / count).toFixed(3),
        meanAbsY: +(sumAbsY / count).toFixed(3),
        meanAbsZ: +(sumAbsZ / count).toFixed(3),
        energyRatioX: +(sumSqX / denom).toFixed(4),
        energyRatioY: +(sumSqY / denom).toFixed(4),
        energyRatioZ: +(sumSqZ / denom).toFixed(4),
        durationMs,
        gyroAvailable: gyroCount > 0,
        peakRa: gyroCount > 0 ? +peakRa.toFixed(2) : null,
        peakRb: gyroCount > 0 ? +peakRb.toFixed(2) : null,
        peakRg: gyroCount > 0 ? +peakRg.toFixed(2) : null,
        signedRa: gyroCount > 0 ? +signedRa.toFixed(2) : null,
        signedRb: gyroCount > 0 ? +signedRb.toFixed(2) : null,
        signedRg: gyroCount > 0 ? +signedRg.toFixed(2) : null,
        peakRelMs: relSamples[peakIdx]?.relMs ?? 0,
        samples: relSamples,
      };
    }
  }

  global.CornerSense = global.CornerSense || {};
  global.CornerSense.SpikeDetector = SpikeDetector;
})(window);
