(function (global) {
  "use strict";

  class ScopeCanvas {
    constructor(canvas, options = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.color = options.color || "#ef4444";
      this.maxPoints = options.maxPoints || 180;
      this.scale = options.scale || 15;
      this.autoScale = options.autoScale !== false;
      this.unavailable = false;
      this.buffer = new Array(this.maxPoints).fill(0);
    }

    push(value) {
      this.buffer.push(Number.isFinite(value) ? value : 0);
      if (this.buffer.length > this.maxPoints) {
        this.buffer.shift();
      }
    }

    setUnavailable(flag) {
      this.unavailable = flag;
    }

    render() {
      const canvas = this.canvas;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(120, Math.floor(rect.width));
      const h = Math.max(54, Math.floor(rect.height));

      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }

      const ctx = this.ctx;
      ctx.save();
      ctx.scale(dpr, dpr);

      // Background
      ctx.fillStyle = "#111620";
      ctx.fillRect(0, 0, w, h);

      // Grid lines
      ctx.strokeStyle = "#1e2738";
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        const x = (w * i) / 4;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }

      // Zero line
      const midY = h / 2;
      ctx.strokeStyle = "#2e3b52";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(0, midY);
      ctx.lineTo(w, midY);
      ctx.stroke();
      ctx.setLineDash([]);

      if (this.unavailable) {
        ctx.fillStyle = "#6c7b96";
        ctx.font = "10px ui-monospace, monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("SENSOR UNAVAILABLE", w / 2, midY);
        ctx.restore();
        return;
      }

      let range = this.scale;
      if (this.autoScale) {
        let peak = 2.0;
        for (let i = 0; i < this.buffer.length; i++) {
          const a = Math.abs(this.buffer[i]);
          if (a > peak) peak = a;
        }
        range = Math.max(this.scale * 0.4, peak * 1.15);
      }

      // Trace
      ctx.strokeStyle = this.color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      const n = this.buffer.length;
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * w;
        const clamped = Math.max(-range, Math.min(range, this.buffer[i]));
        const y = midY - (clamped / range) * (h * 0.44);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Scale label
      ctx.fillStyle = "#687792";
      ctx.font = "9px ui-monospace, monospace";
      ctx.textAlign = "left";
      ctx.fillText("±" + range.toFixed(1), 4, 10);

      ctx.restore();
    }
  }

  function renderTapSignature(canvas, tap) {
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(240, Math.floor(rect.width));
    const h = Math.max(140, Math.floor(rect.height));

    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#111620";
    ctx.fillRect(0, 0, w, h);

    const midY = h / 2;
    ctx.strokeStyle = "#263246";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(w, midY);
    ctx.stroke();

    if (!tap || !tap.samples || tap.samples.length < 2) {
      ctx.fillStyle = "#687792";
      ctx.font = "11px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("ARM RECORDER & TAP PHYSICAL CORNER TO INSPECT WAVEFORM", w / 2, midY);
      ctx.restore();
      return;
    }

    const samples = tap.samples;
    const minT = samples[0].relMs;
    const maxT = samples[samples.length - 1].relMs;
    const spanT = Math.max(1, maxT - minT);

    let peakAxis = 2.0;
    for (const s of samples) {
      peakAxis = Math.max(peakAxis, Math.abs(s.ax), Math.abs(s.ay), Math.abs(s.az));
    }
    const range = peakAxis * 1.15;

    // Trigger t=0 vertical line
    const trigX = ((0 - minT) / spanT) * w;
    ctx.strokeStyle = "rgba(225, 45, 57, 0.7)";
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(trigX, 0);
    ctx.lineTo(trigX, h);
    ctx.stroke();
    ctx.setLineDash([]);

    const series = [
      { key: "ax", color: "#ef4444", label: "X" },
      { key: "ay", color: "#f0b429", label: "Y" },
      { key: "az", color: "#60a5fa", label: "Z" },
    ];

    for (const ser of series) {
      ctx.strokeStyle = ser.color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        const x = ((s.relMs - minT) / spanT) * w;
        const y = midY - (s[ser.key] / range) * (h * 0.43);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Legend & window annotations
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillStyle = "#8a99b5";
    ctx.textAlign = "left";
    ctx.fillText(`${minT.toFixed(0)}ms`, 6, h - 6);
    ctx.textAlign = "right";
    ctx.fillText(`+${maxT.toFixed(0)}ms`, w - 6, h - 6);
    ctx.textAlign = "left";
    ctx.fillStyle = "#ef4444";
    ctx.fillText("X", 8, 14);
    ctx.fillStyle = "#f0b429";
    ctx.fillText("Y", 22, 14);
    ctx.fillStyle = "#60a5fa";
    ctx.fillText("Z", 36, 14);
    ctx.fillStyle = "#e12d39";
    ctx.fillText("TRIGGER (0ms)", Math.min(w - 86, trigX + 4), 14);

    ctx.restore();
  }

  global.CornerSense = global.CornerSense || {};
  global.CornerSense.Charts = {
    ScopeCanvas,
    renderTapSignature,
  };
})(window);
