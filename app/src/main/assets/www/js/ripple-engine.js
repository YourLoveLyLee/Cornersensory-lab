(function (global) {
  "use strict";

  const CORNER_MAP = {
    TL: { label: "L1", name: "TOP-LEFT", color: "#F0B429", glow: "rgba(240, 180, 41, 0.55)" },
    TR: { label: "R1", name: "TOP-RIGHT", color: "#E12D39", glow: "rgba(225, 45, 57, 0.55)" },
    BL: { label: "L2", name: "BOTTOM-LEFT", color: "#D4AF37", glow: "rgba(212, 175, 55, 0.50)" },
    BR: { label: "R2", name: "BOTTOM-RIGHT", color: "#C81E2B", glow: "rgba(200, 30, 43, 0.50)" },
  };

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function easeOutQuart(t) {
    return 1 - Math.pow(1 - t, 4);
  }

  class RippleEngine {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.ripples = [];
      this.rafId = null;
      this.nextId = 1;
      this.onStateChange = null;
    }

    setStateListener(fn) {
      this.onStateChange = fn;
    }

    _getOrigin(corner, w, h) {
      switch (corner) {
        case "TL":
          return { x: 0, y: 0 };
        case "TR":
          return { x: w, y: 0 };
        case "BL":
          return { x: 0, y: h };
        case "BR":
          return { x: w, y: h };
        default:
          return { x: w / 2, y: h / 2 };
      }
    }

    trigger(corner, options = {}) {
      if (!CORNER_MAP[corner]) return null;
      const now = performance.now();
      const durationMs = Math.max(350, Math.min(500, options.durationMs || 440));
      const rect = this.canvas.getBoundingClientRect();
      const w = Math.max(320, rect.width || window.innerWidth);
      const h = Math.max(480, rect.height || window.innerHeight);
      const maxRadius = Math.min(w, h) * 0.62;
      const meta = CORNER_MAP[corner];

      const instance = {
        id: this.nextId++,
        corner,
        label: meta.label,
        startTime: now,
        durationMs,
        maxRadius,
        peakMag: options.peakMag || 0,
        color: meta.color,
        glow: meta.glow,
      };

      this.ripples.push(instance);
      this._ensureRunning();
      this._emitState(now);
      return instance;
    }

    clear() {
      this.ripples = [];
      if (this.rafId !== null) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      this._clearCanvas();
      this._emitState(performance.now());
    }

    _ensureRunning() {
      if (this.rafId !== null) return;
      const tick = (now) => {
        this._renderFrame(now);
        if (this.ripples.length > 0) {
          this.rafId = requestAnimationFrame(tick);
        } else {
          this.rafId = null;
          this._clearCanvas();
          this._emitState(now);
        }
      };
      this.rafId = requestAnimationFrame(tick);
    }

    _syncCanvasSize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, window.innerWidth);
      const h = Math.max(1, window.innerHeight);
      if (this.canvas.width !== Math.floor(w * dpr) || this.canvas.height !== Math.floor(h * dpr)) {
        this.canvas.width = Math.floor(w * dpr);
        this.canvas.height = Math.floor(h * dpr);
      }
      return { w, h, dpr };
    }

    _clearCanvas() {
      const { w, h, dpr } = this._syncCanvasSize();
      const ctx = this.ctx;
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.restore();
    }

    _renderFrame(now) {
      const { w, h, dpr } = this._syncCanvasSize();
      const ctx = this.ctx;

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // Keep unfinished ripples
      const active = [];
      for (let i = 0; i < this.ripples.length; i++) {
        const r = this.ripples[i];
        const progress = (now - r.startTime) / r.durationMs;
        if (progress < 1) {
          active.push(r);
          this._drawRipple(ctx, r, Math.max(0, progress), w, h);
        }
      }
      this.ripples = active;
      ctx.restore();

      this._emitState(now);
    }

    _drawRipple(ctx, r, t, w, h) {
      const origin = this._getOrigin(r.corner, w, h);

      // Smooth fade to exact zero at t=1 (no abrupt disappearance)
      const fade = Math.pow(1 - t, 1.75);
      const radiusOuter = easeOutQuart(t) * r.maxRadius;

      // Subtle origin radial halo
      if (fade > 0.01) {
        const haloRadius = Math.max(24, radiusOuter * 0.45);
        const grad = ctx.createRadialGradient(origin.x, origin.y, 0, origin.x, origin.y, haloRadius);
        grad.addColorStop(0, this._withAlpha(r.color, 0.28 * fade));
        grad.addColorStop(0.6, this._withAlpha("#E12D39", 0.08 * fade));
        grad.addColorStop(1, "rgba(0, 0, 0, 0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(origin.x, origin.y, haloRadius, 0, Math.PI * 2);
        ctx.fill();
      }

      // Primary expanding ring (Gold / Crimson per corner)
      ctx.save();
      ctx.strokeStyle = this._withAlpha(r.color, 0.92 * fade);
      ctx.lineWidth = Math.max(1.0, 2.8 * (1 - t * 0.45));
      ctx.shadowColor = r.glow;
      ctx.shadowBlur = 12 * fade;
      ctx.beginPath();
      ctx.arc(origin.x, origin.y, Math.max(2, radiusOuter), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // Secondary trailing harmonic ring (slight delay for depth)
      if (t > 0.07) {
        const tInner = Math.min(1, (t - 0.07) / 0.93);
        const fadeInner = Math.pow(1 - tInner, 1.85);
        const radiusInner = easeOutCubic(tInner) * (r.maxRadius * 0.72);
        const accentHex = r.corner === "TL" || r.corner === "BL" ? "#E12D39" : "#F0B429";

        ctx.save();
        ctx.strokeStyle = this._withAlpha(accentHex, 0.65 * fadeInner);
        ctx.lineWidth = Math.max(0.8, 1.8 * (1 - tInner * 0.4));
        ctx.shadowColor = this._withAlpha(accentHex, 0.45 * fadeInner);
        ctx.shadowBlur = 8 * fadeInner;
        ctx.beginPath();
        ctx.arc(origin.x, origin.y, Math.max(1, radiusInner), 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    _withAlpha(hex, alpha) {
      const a = Math.max(0, Math.min(1, alpha));
      const clean = hex.replace("#", "");
      const num = parseInt(clean, 16);
      const r = (num >> 16) & 255;
      const g = (num >> 8) & 255;
      const b = num & 255;
      return `rgba(${r}, ${g}, ${b}, ${a.toFixed(4)})`;
    }

    _emitState(now) {
      if (!this.onStateChange) return;
      const activeSummary = this.ripples.map((r) => {
        const pct = Math.min(100, Math.max(0, Math.round(((now - r.startTime) / r.durationMs) * 100)));
        return `${r.label}@${pct}%`;
      });
      this.onStateChange({
        activeCount: this.ripples.length,
        summary: activeSummary.length ? `ANIMATING (${activeSummary.length}): ${activeSummary.join("  ")}` : "IDLE (0 active)",
      });
    }
  }

  global.CornerSense = global.CornerSense || {};
  global.CornerSense.RippleEngine = RippleEngine;
  global.CornerSense.CORNER_LABELS = CORNER_MAP;
})(window);
