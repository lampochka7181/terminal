// src/Liveline.tsx
import { useRef as useRef2, useState, useLayoutEffect, useMemo } from "react";

// src/theme.ts
function parseColorRgb(color) {
  const hex = color.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const rgb = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgb) return [+rgb[1], +rgb[2], +rgb[3]];
  return [128, 128, 128];
}
function rgba(r, g, b, a) {
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
function resolveTheme(color, mode) {
  const [r, g, b] = parseColorRgb(color);
  const isDark = mode === "dark";
  return {
    // Line
    line: color,
    lineWidth: 4,
    // Fill gradient
    fillTop: rgba(r, g, b, isDark ? 0.12 : 0.08),
    fillBottom: rgba(r, g, b, 0),
    // Grid
    gridLine: isDark ? "rgba(255, 255, 255, 0.06)" : "rgba(0, 0, 0, 0.06)",
    gridLabel: isDark ? "rgba(255, 255, 255, 0.4)" : "rgba(0, 0, 0, 0.35)",
    // Dot — always semantic
    dotUp: "#22c55e",
    dotDown: "#ef4444",
    dotFlat: color,
    glowUp: "rgba(34, 197, 94, 0.18)",
    glowDown: "rgba(239, 68, 68, 0.18)",
    glowFlat: rgba(r, g, b, 0.12),
    // Badge
    badgeOuterBg: isDark ? "rgba(40, 40, 40, 0.95)" : "rgba(255, 255, 255, 0.95)",
    badgeOuterShadow: isDark ? "rgba(0, 0, 0, 0.4)" : "rgba(0, 0, 0, 0.15)",
    badgeBg: color,
    badgeText: "#ffffff",
    // Dash line
    dashLine: rgba(r, g, b, 0.4),
    // Reference line
    refLine: isDark ? "rgba(255, 255, 255, 0.15)" : "rgba(0, 0, 0, 0.12)",
    refLabel: isDark ? "rgba(255, 255, 255, 0.45)" : "rgba(0, 0, 0, 0.4)",
    // Time axis
    timeLabel: isDark ? "rgba(255, 255, 255, 0.35)" : "rgba(0, 0, 0, 0.3)",
    // Crosshair
    crosshairLine: isDark ? "rgba(255, 255, 255, 0.2)" : "rgba(0, 0, 0, 0.12)",
    tooltipBg: isDark ? "rgba(30, 30, 30, 0.95)" : "rgba(255, 255, 255, 0.95)",
    tooltipText: isDark ? "#e5e5e5" : "#1a1a1a",
    tooltipBorder: isDark ? "rgba(255, 255, 255, 0.1)" : "rgba(0, 0, 0, 0.08)",
    // Background
    bgRgb: isDark ? [10, 10, 10] : [255, 255, 255],
    // Fonts
    labelFont: '22px "SF Mono", Menlo, Monaco, "Cascadia Code", monospace',
    valueFont: '600 22px "SF Mono", Menlo, monospace',
    badgeFont: '500 22px "SF Mono", Menlo, monospace'
  };
}

// src/useLivelineEngine.ts
import { useRef, useEffect, useCallback } from "react";

// src/math/lerp.ts
function lerp(current, target, speed, dt = 16.67) {
  const factor = 1 - Math.pow(1 - speed, dt / 16.67);
  return current + (target - current) * factor;
}

// src/math/range.ts
function computeRange(visible, currentValue, referenceValue, exaggerate) {
  let targetMin = Infinity;
  let targetMax = -Infinity;
  for (const p of visible) {
    if (p.value < targetMin) targetMin = p.value;
    if (p.value > targetMax) targetMax = p.value;
  }
  if (currentValue < targetMin) targetMin = currentValue;
  if (currentValue > targetMax) targetMax = currentValue;
  if (referenceValue !== void 0) {
    if (referenceValue < targetMin) targetMin = referenceValue;
    if (referenceValue > targetMax) targetMax = referenceValue;
  }
  const rawRange = targetMax - targetMin;
  const marginFactor = exaggerate ? 0.01 : 0.12;
  const minRange = rawRange * (exaggerate ? 0.02 : 0.1) || (exaggerate ? 0.04 : 0.4);
  if (rawRange < minRange) {
    const mid = (targetMin + targetMax) / 2;
    targetMin = mid - minRange / 2;
    targetMax = mid + minRange / 2;
  } else {
    const margin = rawRange * marginFactor;
    targetMin -= margin;
    targetMax += margin;
  }
  return { min: targetMin, max: targetMax };
}

// src/math/momentum.ts
function detectMomentum(points, lookback = 20) {
  if (points.length < 3) return "flat";
  const start = Math.max(0, points.length - lookback);
  let min = Infinity;
  let max = -Infinity;
  for (let i = start; i < points.length; i++) {
    const v = points[i].value;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  if (range === 0) return "flat";
  const last = points[points.length - 1].value;
  const prev = points[points.length - 2].value;
  const immediateDelta = last - prev;
  if (immediateDelta > 0) return "up";
  if (immediateDelta < 0) return "down";
  const tailStart = Math.max(start, points.length - 3);
  const first = points[tailStart].value;
  const delta = last - first;
  const threshold = range * 0.05;
  if (delta > threshold) return "up";
  if (delta < -threshold) return "down";
  return "flat";
}

// src/math/interpolate.ts
function interpolateAtTime(points, time) {
  if (points.length === 0) return null;
  if (time <= points[0].time) return points[0].value;
  if (time >= points[points.length - 1].time) return points[points.length - 1].value;
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = lo + hi >> 1;
    if (points[mid].time <= time) lo = mid;
    else hi = mid;
  }
  const p1 = points[lo];
  const p2 = points[hi];
  const dt = p2.time - p1.time;
  if (dt === 0) return p1.value;
  const t = (time - p1.time) / dt;
  return p1.value + (p2.value - p1.value) * t;
}

// src/canvas/dpr.ts
function getDpr() {
  if (typeof window === "undefined") return 1;
  return Math.min(window.devicePixelRatio || 1, 3);
}
function applyDpr(ctx, dpr, w, h) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
}

// src/draw/grid.ts
function pickInterval(valRange, pxPerUnit, minGap, prev) {
  if (prev > 0) {
    const px = prev * pxPerUnit;
    if (px >= minGap * 0.5 && px <= minGap * 4) return prev;
  }
  const divisorSets = [[2, 2.5, 2], [2, 2, 2.5], [2.5, 2, 2]];
  let best = Infinity;
  for (const divs of divisorSets) {
    let span = Math.pow(10, Math.ceil(Math.log10(valRange)));
    let i = 0;
    while (span / divs[i % 3] * pxPerUnit >= minGap) {
      span /= divs[i % 3];
      i++;
    }
    if (span < best) best = span;
  }
  return best === Infinity ? valRange / 5 : best;
}
function divisible(val, interval) {
  const ratio = val / interval;
  return Math.abs(ratio - Math.round(ratio)) < 0.01;
}
var FADE_IN = 0.18;
var FADE_OUT = 0.12;
function drawGrid(ctx, layout, palette, formatValue, state, dt) {
  const { w, h, pad, valRange, minVal, maxVal, toY } = layout;
  const chartH = h - pad.top - pad.bottom;
  if (chartH <= 0 || valRange <= 0) return;
  const pxPerUnit = chartH / valRange;
  const coarse = pickInterval(valRange, pxPerUnit, 72, state.interval);
  state.interval = coarse;
  const fine = coarse / 2;
  const finePx = fine * pxPerUnit;
  const fineTarget = finePx < 80 ? 0 : finePx >= 120 ? 1 : (finePx - 80) / 40;
  const fadeZone = 64;
  const edgeAlpha = (y) => {
    const fromEdge = Math.min(y - pad.top, h - pad.bottom - y);
    if (fromEdge >= fadeZone) return 1;
    if (fromEdge <= 0) return 0;
    return fromEdge / fadeZone;
  };
  const targets = /* @__PURE__ */ new Map();
  const first = Math.ceil(minVal / fine) * fine;
  for (let val = first; val <= maxVal; val += fine) {
    const y = toY(val);
    if (y < pad.top - 2 || y > h - pad.bottom + 2) continue;
    const isCoarse = divisible(val, coarse);
    const target = (isCoarse ? 1 : fineTarget) * edgeAlpha(y);
    const key = Math.round(val * 1e3);
    targets.set(key, target);
  }
  for (const [key, alpha] of state.labels) {
    const target = targets.get(key) ?? 0;
    const speed = target >= alpha ? FADE_IN : FADE_OUT;
    let next = lerp(alpha, target, speed, dt);
    if (Math.abs(next - target) < 0.02) next = target;
    if (next < 0.01 && target === 0) {
      state.labels.delete(key);
    } else {
      state.labels.set(key, next);
    }
  }
  for (const [key, target] of targets) {
    if (!state.labels.has(key)) {
      state.labels.set(key, target * FADE_IN);
    }
  }
  const baseAlpha = ctx.globalAlpha;
  ctx.setLineDash([2, 6]);
  ctx.lineWidth = 1;
  ctx.font = palette.labelFont;
  ctx.textAlign = "left";
  for (const [key, alpha] of state.labels) {
    if (alpha < 0.02) continue;
    const val = key / 1e3;
    const y = toY(val);
    if (y < pad.top - 10 || y > h - pad.bottom + 10) continue;
    ctx.save();
    ctx.globalAlpha = baseAlpha * alpha;
    ctx.strokeStyle = palette.gridLine;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
    ctx.fillStyle = palette.gridLabel;
    ctx.fillText(formatValue(val), w - pad.right + 16, y + 8);
    ctx.restore();
  }
  ctx.setLineDash([]);
}

// src/math/spline.ts
function drawSpline(ctx, pts) {
  if (pts.length < 2) return;
  if (pts.length === 2) {
    ctx.lineTo(pts[1][0], pts[1][1]);
    return;
  }
  const n = pts.length;
  const delta = new Array(n - 1);
  const h = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = pts[i + 1][0] - pts[i][0];
    delta[i] = h[i] === 0 ? 0 : (pts[i + 1][1] - pts[i][1]) / h[i];
  }
  const m = new Array(n);
  m[0] = delta[0];
  m[n - 1] = delta[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (delta[i - 1] * delta[i] <= 0) {
      m[i] = 0;
    } else {
      m[i] = (delta[i - 1] + delta[i]) / 2;
    }
  }
  for (let i = 0; i < n - 1; i++) {
    if (delta[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
    } else {
      const alpha = m[i] / delta[i];
      const beta = m[i + 1] / delta[i];
      const s2 = alpha * alpha + beta * beta;
      if (s2 > 9) {
        const s = 3 / Math.sqrt(s2);
        m[i] = s * alpha * delta[i];
        m[i + 1] = s * beta * delta[i];
      }
    }
  }
  for (let i = 0; i < n - 1; i++) {
    const hi = h[i];
    ctx.bezierCurveTo(
      pts[i][0] + hi / 3,
      pts[i][1] + m[i] * hi / 3,
      pts[i + 1][0] - hi / 3,
      pts[i + 1][1] - m[i + 1] * hi / 3,
      pts[i + 1][0],
      pts[i + 1][1]
    );
  }
}

// src/draw/loadingShape.ts
var LOADING_AMPLITUDE_RATIO = 0.07;
var LOADING_SCROLL_SPEED = 1e-3;
function loadingY(t, centerY, amplitude, scroll) {
  return centerY + amplitude * (Math.sin(t * 9.4 + scroll) * 0.55 + Math.sin(t * 15.7 + scroll * 1.3) * 0.3 + Math.sin(t * 4.2 + scroll * 0.7) * 0.15);
}
function loadingBreath(now_ms) {
  return 0.22 + 0.08 * Math.sin(now_ms / 1200 * Math.PI);
}

// src/draw/line.ts
function parseRgba(color) {
  const hex = color.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
  }
  const rgba2 = color.match(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)/);
  if (rgba2) return [+rgba2[1], +rgba2[2], +rgba2[3], +rgba2[4]];
  const rgb = color.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgb) return [+rgb[1], +rgb[2], +rgb[3], 1];
  return [128, 128, 128, 1];
}
function blendColor(c1, c2, t) {
  if (t <= 0) return c1;
  if (t >= 1) return c2;
  const [r1, g1, b1, a1] = parseRgba(c1);
  const [r2, g2, b2, a2] = parseRgba(c2);
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);
  const a = a1 + (a2 - a1) * t;
  if (a >= 0.995) return `rgb(${r},${g},${b})`;
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}
function renderCurve(ctx, layout, palette, pts, showFill, lineAlpha = 1, fillAlpha = 1, strokeColor) {
  const { h, pad } = layout;
  const baseAlpha = ctx.globalAlpha;
  if (showFill && fillAlpha > 0.01) {
    ctx.globalAlpha = baseAlpha * fillAlpha;
    const grad = ctx.createLinearGradient(0, pad.top, 0, h - pad.bottom);
    grad.addColorStop(0, palette.fillTop);
    grad.addColorStop(1, palette.fillBottom);
    ctx.beginPath();
    ctx.moveTo(pts[0][0], h - pad.bottom);
    ctx.lineTo(pts[0][0], pts[0][1]);
    drawSpline(ctx, pts);
    ctx.lineTo(pts[pts.length - 1][0], h - pad.bottom);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  }
  ctx.globalAlpha = baseAlpha * lineAlpha;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  drawSpline(ctx, pts);
  ctx.strokeStyle = strokeColor ?? palette.line;
  ctx.lineWidth = palette.lineWidth;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.globalAlpha = baseAlpha;
}
function drawLine(ctx, layout, palette, visible, smoothValue, now, showFill, scrubX, scrubAmount = 0, chartReveal = 1, now_ms = 0) {
  const { h, pad, toX, toY, chartW, chartH } = layout;
  const yMin = pad.top;
  const yMax = h - pad.bottom;
  const clampY = (y) => Math.max(yMin, Math.min(yMax, y));
  const centerY = pad.top + chartH / 2;
  const amplitude = chartH * LOADING_AMPLITUDE_RATIO;
  const scroll = now_ms * LOADING_SCROLL_SPEED;
  const morphY = chartReveal < 1 ? (rawY, x) => {
    const t = Math.max(0, Math.min(1, (x - pad.left) / chartW));
    const baseY = loadingY(t, centerY, amplitude, scroll);
    return baseY + (rawY - baseY) * chartReveal;
  } : (rawY, _x) => rawY;
  const pts = visible.map((p, i) => {
    const x = toX(p.time);
    const y = i === visible.length - 1 ? morphY(clampY(toY(smoothValue)), x) : morphY(clampY(toY(p.value)), x);
    return [x, y];
  });
  const liveTipX = toX(now);
  const fullRightX = pad.left + chartW;
  const tipX = chartReveal < 1 ? liveTipX + (fullRightX - liveTipX) * (1 - chartReveal) : liveTipX;
  pts.push([tipX, morphY(clampY(toY(smoothValue)), tipX)]);
  if (pts.length < 2) return;
  let lineAlpha = 1;
  let fillAlpha = 1;
  if (chartReveal < 1) {
    const breath = loadingBreath(now_ms);
    lineAlpha = breath + (1 - breath) * chartReveal;
    fillAlpha = chartReveal;
  }
  const strokeColor = chartReveal < 1 ? blendColor(palette.gridLabel, palette.line, Math.min(1, chartReveal * 3)) : void 0;
  const isScrubbing = scrubX !== null;
  ctx.save();
  ctx.beginPath();
  ctx.rect(pad.left - 1, pad.top, chartW + 2, chartH);
  ctx.clip();
  if (isScrubbing) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, scrubX, h);
    ctx.clip();
    renderCurve(ctx, layout, palette, pts, showFill, lineAlpha, fillAlpha, strokeColor);
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.rect(scrubX, 0, layout.w - scrubX, h);
    ctx.clip();
    ctx.globalAlpha = 1 - scrubAmount * 0.6;
    renderCurve(ctx, layout, palette, pts, showFill, lineAlpha, fillAlpha, strokeColor);
    ctx.restore();
  } else {
    renderCurve(ctx, layout, palette, pts, showFill, lineAlpha, fillAlpha, strokeColor);
  }
  ctx.restore();
  const realCurrentY = Math.max(pad.top, Math.min(h - pad.bottom, toY(smoothValue)));
  const currentY = chartReveal < 1 ? centerY + (realCurrentY - centerY) * chartReveal : realCurrentY;
  ctx.setLineDash([8, 8]);
  ctx.strokeStyle = layout._dashLineColor || "#f55252";
  ctx.lineWidth = 3;
  const dashBase = isScrubbing ? 1 - scrubAmount * 0.2 : 1;
  ctx.globalAlpha = chartReveal < 1 ? dashBase * chartReveal : dashBase;
  ctx.beginPath();
  ctx.moveTo(tipX, currentY);
  ctx.lineTo(layout.w, currentY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  const last = pts[pts.length - 1];
  last[1] = Math.max(10, Math.min(h - 10, last[1]));
  return pts;
}

// src/draw/dot.ts
var PULSE_INTERVAL = 1500;
var PULSE_DURATION = 900;
function lerpColor(a, b, t) {
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r},${g},${bl})`;
}
function drawDot(ctx, x, y, palette, pulse = true, scrubAmount = 0, now_ms = performance.now()) {
  const baseAlpha = ctx.globalAlpha;
  const dim = scrubAmount * 0.7;
  if (pulse && dim < 0.3) {
    const t = now_ms % PULSE_INTERVAL / PULSE_DURATION;
    if (t < 1) {
      const radius = 18 + t * 24;
      const pulseAlpha = 0.35 * (1 - t) * (1 - dim * 3);
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = palette.line;
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = baseAlpha * pulseAlpha;
      ctx.stroke();
    }
  }
  ctx.save();
  ctx.globalAlpha = baseAlpha;
  ctx.shadowColor = palette.badgeOuterShadow;
  ctx.shadowBlur = 12 * (1 - dim);
  ctx.shadowOffsetY = 2;
  ctx.beginPath();
  ctx.arc(x, y, 9, 0, Math.PI * 2);
  if (dim > 0.01) {
    const outerRgb = parseColorRgb(palette.badgeOuterBg);
    const lineRgb = parseColorRgb(palette.line);
    ctx.fillStyle = lerpColor(lineRgb, outerRgb, dim);
  } else {
    ctx.fillStyle = palette.line;
  }
  ctx.fill();
  ctx.restore();
}
function drawArrows(ctx, x, y, momentum, palette, arrows, dt, now_ms = performance.now()) {
  const baseAlpha = ctx.globalAlpha;
  const upTarget = momentum === "up" ? 1 : 0;
  const downTarget = momentum === "down" ? 1 : 0;
  const canFadeInUp = arrows.down < 0.02;
  const canFadeInDown = arrows.up < 0.02;
  arrows.up = lerp(arrows.up, canFadeInUp ? upTarget : 0, upTarget > arrows.up ? 0.08 : 0.04, dt);
  arrows.down = lerp(arrows.down, canFadeInDown ? downTarget : 0, downTarget > arrows.down ? 0.08 : 0.04, dt);
  if (arrows.up < 0.01) arrows.up = 0;
  if (arrows.down < 0.01) arrows.down = 0;
  if (arrows.up > 0.99) arrows.up = 1;
  if (arrows.down > 0.99) arrows.down = 1;
  const cycle = now_ms % 1400 / 1400;
  const drawChevrons = (dir, opacity) => {
    if (opacity < 0.01) return;
    const baseX = x + 38;
    const baseY = y;
    ctx.save();
    ctx.strokeStyle = palette.gridLabel;
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let i = 0; i < 2; i++) {
      const start = i * 0.2;
      const dur = 0.35;
      const localT = cycle - start;
      const wave = localT >= 0 && localT < dur ? Math.sin(localT / dur * Math.PI) : 0;
      const pulse = 0.3 + 0.7 * wave;
      ctx.globalAlpha = baseAlpha * opacity * pulse;
      const nudge = dir === -1 ? -6 : 6;
      const cy = baseY + dir * (i * 16 - 8) + nudge;
      ctx.beginPath();
      ctx.moveTo(baseX - 10, cy - dir * 7);
      ctx.lineTo(baseX, cy);
      ctx.lineTo(baseX + 10, cy - dir * 7);
      ctx.stroke();
    }
    ctx.restore();
  };
  drawChevrons(-1, arrows.up);
  drawChevrons(1, arrows.down);
  ctx.globalAlpha = baseAlpha;
}

// src/draw/crosshair.ts
function drawCrosshair(ctx, layout, palette, hoverX, hoverValue, hoverTime, formatValue, formatTime, scrubOpacity, tooltipY, liveDotX, tooltipOutline) {
  if (scrubOpacity < 0.01) return;
  const { h, pad, toY } = layout;
  const y = toY(hoverValue);
  ctx.save();
  ctx.globalAlpha = scrubOpacity * 0.5;
  ctx.strokeStyle = palette.crosshairLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(hoverX, pad.top);
  ctx.lineTo(hoverX, h - pad.bottom);
  ctx.stroke();
  ctx.restore();
  const dotRadius = 8 * Math.min(scrubOpacity * 3, 1);
  if (dotRadius > 0.5) {
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(hoverX, y, dotRadius, 0, Math.PI * 2);
    ctx.fillStyle = palette.line;
    ctx.fill();
  }
  if (scrubOpacity < 0.1 || layout.w < 300) return;
  const valueText = formatValue(hoverValue);
  const timeText = formatTime(hoverTime);
  const separator = "  \xB7  ";
  ctx.save();
  ctx.globalAlpha = scrubOpacity;
  ctx.font = '400 26px "SF Mono", Menlo, monospace';
  const valueW = ctx.measureText(valueText).width;
  const sepW = ctx.measureText(separator).width;
  const timeW = ctx.measureText(timeText).width;
  const totalW = valueW + sepW + timeW;
  let tx = hoverX - totalW / 2;
  const minX = pad.left + 4;
  const dotRightEdge = liveDotX != null ? liveDotX + 14 : layout.w - pad.right;
  const maxX = dotRightEdge - totalW;
  if (tx < minX) tx = minX;
  if (tx > maxX) tx = maxX;
  const ty = pad.top + (tooltipY ?? 28) + 20;
  ctx.textAlign = "left";
  if (tooltipOutline) {
    ctx.strokeStyle = palette.tooltipBg;
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.strokeText(valueText, tx, ty);
    ctx.strokeText(separator + timeText, tx + valueW, ty);
  }
  ctx.fillStyle = palette.tooltipText;
  ctx.fillText(valueText, tx, ty);
  ctx.fillStyle = palette.gridLabel;
  ctx.fillText(separator + timeText, tx + valueW, ty);
  ctx.restore();
}

// src/draw/referenceLine.ts
function drawReferenceLine(ctx, layout, palette, ref) {
  const { w, h, pad, toY, chartW } = layout;
  const y = toY(ref.value);
  if (y < pad.top - 10 || y > h - pad.bottom + 10) return;
  const label = ref.label ?? "";
  if (label) {
    ctx.font = "500 22px system-ui, sans-serif";
    const textW = ctx.measureText(label).width;
    const centerX = pad.left + chartW / 2;
    const gapPad = 16;
    ctx.strokeStyle = palette.refLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(centerX - textW / 2 - gapPad, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(centerX + textW / 2 + gapPad, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
    ctx.fillStyle = palette.refLabel;
    ctx.textAlign = "center";
    ctx.fillText(label, centerX, y + 8);
  } else {
    ctx.strokeStyle = palette.refLine;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

// src/math/intervals.ts
function niceTimeInterval(windowSecs) {
  if (windowSecs <= 15) return 2;
  if (windowSecs <= 30) return 5;
  if (windowSecs <= 60) return 10;
  if (windowSecs <= 120) return 15;
  if (windowSecs <= 300) return 30;
  if (windowSecs <= 600) return 60;
  if (windowSecs <= 1800) return 300;
  if (windowSecs <= 3600) return 600;
  if (windowSecs <= 14400) return 1800;
  if (windowSecs <= 43200) return 3600;
  if (windowSecs <= 86400) return 7200;
  if (windowSecs <= 604800) return 86400;
  return 604800;
}

// src/draw/timeAxis.ts
var FADE = 0.08;
function drawTimeAxis(ctx, layout, palette, windowSecs, targetWindowSecs, formatTime, state, dt) {
  const { h, pad, leftEdge, rightEdge, toX } = layout;
  const chartLeft = pad.left;
  const chartRight = layout.w - pad.right;
  const chartW = chartRight - chartLeft;
  const fadeZone = 100;
  const edgeAlpha = (x) => {
    const fromLeft = x - chartLeft;
    const fromRight = chartRight - x;
    const fromEdge = Math.min(fromLeft, fromRight);
    if (fromEdge >= fadeZone) return 1;
    if (fromEdge <= 0) return 0;
    return fromEdge / fadeZone;
  };
  ctx.font = palette.labelFont;
  const targetPxPerSec = chartW / targetWindowSecs;
  let interval = niceTimeInterval(targetWindowSecs);
  while (interval * targetPxPerSec < 120 && interval < targetWindowSecs) {
    interval *= 2;
  }
  const useLocalDays = interval >= 86400;
  let firstTime;
  if (useLocalDays) {
    const d = new Date((leftEdge - interval) * 1e3);
    d.setHours(0, 0, 0, 0);
    firstTime = d.getTime() / 1e3;
  } else {
    firstTime = Math.ceil((leftEdge - interval) / interval) * interval;
  }
  const targets = /* @__PURE__ */ new Set();
  for (let t = firstTime; t <= rightEdge + interval && targets.size < 30; t += interval) {
    targets.add(Math.round(t * 100));
  }
  for (const key of targets) {
    const text = formatTime(key / 100);
    const existing = state.labels.get(key);
    if (!existing) {
      state.labels.set(key, { alpha: 0, text });
    } else {
      existing.text = text;
    }
  }
  for (const [key, label] of state.labels) {
    const x = toX(key / 100);
    const isTarget = targets.has(key);
    const target = isTarget ? edgeAlpha(x) : 0;
    let next = lerp(label.alpha, target, FADE, dt);
    if (Math.abs(next - target) < 0.02) next = target;
    if (next < 0.01 && target === 0) {
      state.labels.delete(key);
    } else {
      label.alpha = next;
    }
  }
  const baseAlpha = ctx.globalAlpha;
  const lineY = h - pad.bottom;
  const tickLen = 10;
  ctx.strokeStyle = palette.gridLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(chartLeft, lineY);
  ctx.lineTo(chartRight, lineY);
  ctx.stroke();
  ctx.textAlign = "center";
  const labels = [];
  for (const [key, label] of state.labels) {
    if (label.alpha < 0.02) continue;
    const x = toX(key / 100);
    if (x < chartLeft - 20 || x > chartRight) continue;
    const w = ctx.measureText(label.text).width;
    labels.push({ x, alpha: label.alpha, text: label.text, w });
  }
  labels.sort((a, b) => a.x - b.x);
  const drawn = [];
  for (const label of labels) {
    const left = label.x - label.w / 2;
    if (drawn.length > 0) {
      const prev = drawn[drawn.length - 1];
      const prevRight = prev.x + prev.w / 2;
      if (left < prevRight + 16) {
        if (label.alpha > prev.alpha) {
          drawn[drawn.length - 1] = label;
        }
        continue;
      }
    }
    drawn.push(label);
  }
  for (const label of drawn) {
    ctx.save();
    ctx.globalAlpha = baseAlpha * label.alpha;
    ctx.strokeStyle = palette.gridLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(label.x, lineY);
    ctx.lineTo(label.x, lineY + tickLen);
    ctx.stroke();
    ctx.fillStyle = palette.timeLabel;
    ctx.fillText(label.text, label.x, lineY + tickLen + 28);
    ctx.restore();
  }
}

// src/draw/orderbook.ts
var GREEN = [34, 197, 94];
var RED = [239, 68, 68];
function createOrderbookState() {
  return {
    labels: [],
    spawnTimer: 0,
    smoothSpeed: BASE_SPEED,
    prevBidTotal: 0,
    prevAskTotal: 0,
    churnRate: 0
  };
}
var MAX_LABELS = 50;
var LABEL_LIFETIME = 6;
var SPAWN_INTERVAL = 40;
var MIN_LABEL_GAP = 22;
var BASE_SPEED = 60;
var MAX_SPEED = 160;
function mixColor(from, to, t) {
  const r = Math.round(from[0] + (to[0] - from[0]) * t);
  const g = Math.round(from[1] + (to[1] - from[1]) * t);
  const b = Math.round(from[2] + (to[2] - from[2]) * t);
  return `rgb(${r},${g},${b})`;
}
function drawOrderbook(ctx, layout, palette, orderbook, dt, state, swingMagnitude) {
  const { pad, h, chartH } = layout;
  const dtSec = dt / 1e3;
  if (orderbook.bids.length === 0 && orderbook.asks.length === 0) return;
  let maxSize = 0;
  let bidTotal = 0;
  let askTotal = 0;
  for (const [, size] of orderbook.bids) {
    bidTotal += size;
    if (size > maxSize) maxSize = size;
  }
  for (const [, size] of orderbook.asks) {
    askTotal += size;
    if (size > maxSize) maxSize = size;
  }
  if (maxSize === 0) return;
  const totalSize = bidTotal + askTotal;
  const prevTotal = state.prevBidTotal + state.prevAskTotal;
  let churnSignal = 0;
  if (prevTotal > 0) {
    const delta = Math.abs(bidTotal - state.prevBidTotal) + Math.abs(askTotal - state.prevAskTotal);
    churnSignal = Math.min(delta / prevTotal, 1);
  }
  state.prevBidTotal = bidTotal;
  state.prevAskTotal = askTotal;
  const churnLerp = churnSignal > state.churnRate ? 0.3 : 0.05;
  state.churnRate += (churnSignal - state.churnRate) * churnLerp;
  const activity = Math.max(Math.min(swingMagnitude * 5, 1), state.churnRate);
  const targetSpeed = BASE_SPEED + activity * (MAX_SPEED - BASE_SPEED);
  const speedLerp = 1 - Math.pow(0.95, dt / 16.67);
  state.smoothSpeed += (targetSpeed - state.smoothSpeed) * speedLerp;
  const speed = state.smoothSpeed;
  const labelX = pad.left + 8;
  const bottomY = h - pad.bottom - 6;
  const topY = pad.top;
  const bg = palette.bgRgb;
  state.spawnTimer += dt;
  while (state.spawnTimer >= SPAWN_INTERVAL && state.labels.length < MAX_LABELS) {
    state.spawnTimer -= SPAWN_INTERVAL;
    let tooClose = false;
    for (let j = 0; j < state.labels.length; j++) {
      if (Math.abs(state.labels[j].y - bottomY) < MIN_LABEL_GAP) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) break;
    const allLevels = [];
    for (const [, size] of orderbook.bids) allLevels.push({ size, green: true });
    for (const [, size] of orderbook.asks) allLevels.push({ size, green: false });
    let totalWeight = 0;
    for (const l of allLevels) totalWeight += l.size;
    let r = Math.random() * totalWeight;
    let picked = allLevels[0];
    for (const l of allLevels) {
      r -= l.size;
      if (r <= 0) {
        picked = l;
        break;
      }
    }
    const sizeRatio = picked.size / maxSize;
    state.labels.push({
      y: bottomY,
      text: `+ ${formatSize(picked.size)}`,
      green: picked.green,
      life: LABEL_LIFETIME,
      maxLife: LABEL_LIFETIME,
      intensity: 0.5 + sizeRatio * 0.5
    });
  }
  const range = bottomY - topY;
  let writeIdx = 0;
  for (let i = 0; i < state.labels.length; i++) {
    const l = state.labels[i];
    l.life -= dtSec;
    if (l.life <= 0) continue;
    const yProgress = range > 0 ? (l.y - topY) / range : 1;
    l.y -= speed * (0.7 + 0.3 * yProgress) * dtSec;
    if (l.y < topY - 14) continue;
    state.labels[writeIdx++] = l;
  }
  state.labels.length = writeIdx;
  const baseAlpha = ctx.globalAlpha;
  ctx.save();
  ctx.font = '600 26px "SF Mono", Menlo, monospace';
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.globalAlpha = baseAlpha;
  const outlineColor = `rgb(${bg[0]},${bg[1]},${bg[2]})`;
  for (let i = 0; i < state.labels.length; i++) {
    const l = state.labels[i];
    const lifeRatio = l.life / l.maxLife;
    const fadeIn = Math.min((1 - lifeRatio) * 10, 1);
    const yRatio = (l.y - topY) / chartH;
    const fadeOut = yRatio < 0.45 ? yRatio / 0.45 : 1;
    const colorStrength = l.intensity * fadeIn * fadeOut;
    const baseColor = l.green ? GREEN : RED;
    const fillColor = mixColor(baseColor, bg, 1 - colorStrength);
    ctx.strokeStyle = outlineColor;
    ctx.lineWidth = 4;
    ctx.lineJoin = "round";
    ctx.strokeText(l.text, labelX, l.y);
    ctx.fillStyle = fillColor;
    ctx.fillText(l.text, labelX, l.y);
  }
  ctx.restore();
}
function formatSize(size) {
  if (size >= 10) return `$${Math.round(size)}`;
  if (size >= 1) return `$${size.toFixed(1)}`;
  return `$${size.toFixed(2)}`;
}

// src/draw/particles.ts
function createParticleState() {
  return { particles: [], cooldown: 0, burstCount: 0 };
}
var MAX_PARTICLES = 80;
var PARTICLE_LIFETIME = 1;
var COOLDOWN_MS = 400;
var MAGNITUDE_THRESHOLD = 0.08;
var MAX_BURSTS = 3;
function spawnOnSwing(state, momentum, dotX, dotY, swingMagnitude, accentColor, dt, options) {
  state.cooldown = Math.max(0, state.cooldown - dt);
  if (momentum === "flat") return 0;
  if (state.cooldown > 0) return 0;
  if (swingMagnitude < MAGNITUDE_THRESHOLD) {
    state.burstCount = 0;
    return 0;
  }
  if (momentum === "down" && options?.downMomentum !== true) return 0;
  if (state.burstCount >= MAX_BURSTS) return 0;
  state.cooldown = COOLDOWN_MS;
  const scale = options?.scale ?? 1;
  const isUp = momentum === "up";
  const mag = Math.min(swingMagnitude * 5, 1);
  const burstFalloff = mag > 0.6 ? 1 : [1, 0.6, 0.35][state.burstCount] ?? 0.35;
  state.burstCount++;
  const count = Math.round((12 + mag * 20) * scale * burstFalloff);
  const speedMultiplier = 1 + mag * 0.8;
  for (let i = 0; i < count && state.particles.length < MAX_PARTICLES; i++) {
    const baseAngle = isUp ? -Math.PI / 2 : Math.PI / 2;
    const spread = Math.PI * 1.2;
    const angle = baseAngle + (Math.random() - 0.5) * spread;
    const speed = (60 + Math.random() * 100) * speedMultiplier;
    state.particles.push({
      x: dotX + (Math.random() - 0.5) * 24,
      y: dotY + (Math.random() - 0.5) * 8,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1,
      size: (1 + Math.random() * 1.2) * scale * burstFalloff,
      color: accentColor
    });
  }
  return burstFalloff;
}
function drawParticles(ctx, state, dt) {
  if (state.particles.length === 0) return;
  const dtSec = dt / 1e3;
  ctx.save();
  let writeIdx = 0;
  for (let i = 0; i < state.particles.length; i++) {
    const p = state.particles[i];
    p.life -= dtSec / PARTICLE_LIFETIME;
    if (p.life <= 0) continue;
    p.x += p.vx * dtSec;
    p.y += p.vy * dtSec;
    p.vx *= 0.95;
    p.vy *= 0.95;
    ctx.globalAlpha = p.life * 0.55;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * (0.5 + p.life * 0.5), 0, Math.PI * 2);
    ctx.fill();
    state.particles[writeIdx++] = p;
  }
  state.particles.length = writeIdx;
  ctx.restore();
}

// src/draw/index.ts
var SHAKE_DECAY_RATE = 2e-3;
var SHAKE_MIN_AMPLITUDE = 0.2;
var FADE_EDGE_WIDTH = 40;
var CROSSHAIR_FADE_MIN_PX = 5;
function createShakeState() {
  return { amplitude: 0 };
}
function drawFrame(ctx, layout, palette, opts) {
  const shake = opts.shakeState;
  let shakeX = 0;
  let shakeY = 0;
  if (shake && shake.amplitude > SHAKE_MIN_AMPLITUDE) {
    shakeX = (Math.random() - 0.5) * 2 * shake.amplitude;
    shakeY = (Math.random() - 0.5) * 2 * shake.amplitude;
    ctx.save();
    ctx.translate(shakeX, shakeY);
  }
  if (shake) {
    const decayRate = Math.pow(SHAKE_DECAY_RATE, opts.dt / 1e3);
    shake.amplitude *= decayRate;
    if (shake.amplitude < SHAKE_MIN_AMPLITUDE) shake.amplitude = 0;
  }
  const reveal = opts.chartReveal;
  const pause = opts.pauseProgress;
  const revealRamp = (start, end) => {
    const t = Math.max(0, Math.min(1, (reveal - start) / (end - start)));
    return t * t * (3 - 2 * t);
  };
  if (opts.referenceLine && reveal > 0.01) {
    ctx.save();
    if (reveal < 1) ctx.globalAlpha = reveal;
    drawReferenceLine(ctx, layout, palette, opts.referenceLine);
    ctx.restore();
  }
  if (opts.showGrid) {
    const gridAlpha = reveal < 1 ? revealRamp(0.15, 0.7) : 1;
    if (gridAlpha > 0.01) {
      ctx.save();
      if (gridAlpha < 1) ctx.globalAlpha = gridAlpha;
      drawGrid(ctx, layout, palette, opts.formatValue, opts.gridState, opts.dt);
      ctx.restore();
    }
  }
  if (opts.orderbookData && opts.orderbookState && reveal > 0.01) {
    ctx.save();
    if (reveal < 1) ctx.globalAlpha = reveal;
    drawOrderbook(ctx, layout, palette, opts.orderbookData, opts.dt, opts.orderbookState, opts.swingMagnitude);
    ctx.restore();
  }
  const scrubX = opts.scrubAmount > 0.05 ? opts.hoverX : null;
  const pts = drawLine(ctx, layout, palette, opts.visible, opts.smoothValue, opts.now, opts.showFill, scrubX, opts.scrubAmount, reveal, opts.now_ms);
  if (opts.showTimeAxis !== false) {
    const timeAlpha = reveal < 1 ? revealRamp(0.15, 0.7) : 1;
    if (timeAlpha > 0.01) {
      ctx.save();
      if (timeAlpha < 1) ctx.globalAlpha = timeAlpha;
      drawTimeAxis(ctx, layout, palette, opts.windowSecs, opts.targetWindowSecs, opts.formatTime, opts.timeAxisState, opts.dt);
      ctx.restore();
    }
  }
  if (pts && pts.length > 0) {
    const lastPt = pts[pts.length - 1];
    let dotScrub = opts.scrubAmount;
    if (opts.hoverX !== null && dotScrub > 0) {
      const distToLive = lastPt[0] - opts.hoverX;
      const fadeStart = Math.min(80, layout.chartW * 0.3);
      dotScrub = distToLive < CROSSHAIR_FADE_MIN_PX ? 0 : distToLive >= fadeStart ? opts.scrubAmount : (distToLive - CROSSHAIR_FADE_MIN_PX) / (fadeStart - CROSSHAIR_FADE_MIN_PX) * opts.scrubAmount;
    }
    const dotAlpha = reveal < 0.3 ? 0 : (reveal - 0.3) / 0.7;
    const showPulse = opts.showPulse && reveal > 0.6 && pause < 0.5;
    if (dotAlpha > 0.01) {
      ctx.save();
      if (dotAlpha < 1) ctx.globalAlpha = dotAlpha;
      drawDot(ctx, lastPt[0], lastPt[1], palette, showPulse, dotScrub, opts.now_ms);
      ctx.restore();
    }
    if (opts.showMomentum) {
      const arrowReveal = reveal < 1 ? revealRamp(0.6, 1) : 1;
      const arrowAlpha = arrowReveal * (1 - pause);
      if (arrowAlpha > 0.01) {
        ctx.save();
        if (arrowAlpha < 1) ctx.globalAlpha = arrowAlpha;
        drawArrows(
          ctx,
          lastPt[0],
          lastPt[1],
          opts.momentum,
          palette,
          opts.arrowState,
          opts.dt,
          opts.now_ms
        );
        ctx.restore();
      }
    }
    if (opts.particleState && reveal > 0.9) {
      const burstIntensity = spawnOnSwing(
        opts.particleState,
        opts.momentum,
        lastPt[0],
        lastPt[1],
        opts.swingMagnitude,
        palette.line,
        opts.dt,
        opts.particleOptions
      );
      if (burstIntensity > 0 && shake) {
        shake.amplitude = (3 + opts.swingMagnitude * 4) * burstIntensity;
      }
      drawParticles(ctx, opts.particleState, opts.dt);
    }
  }
  const fadeW = FADE_EDGE_WIDTH;
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  const fadeGrad = ctx.createLinearGradient(layout.pad.left, 0, layout.pad.left + fadeW, 0);
  fadeGrad.addColorStop(0, "rgba(0, 0, 0, 1)");
  fadeGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = fadeGrad;
  ctx.fillRect(0, 0, layout.pad.left + fadeW, layout.h);
  ctx.restore();
  if (opts.hoverX !== null && opts.hoverValue !== null && opts.hoverTime !== null && pts && pts.length > 0) {
    const lastPt = pts[pts.length - 1];
    const distToLive = lastPt[0] - opts.hoverX;
    const fadeStart = Math.min(80, layout.chartW * 0.3);
    const scrubOpacity = distToLive < CROSSHAIR_FADE_MIN_PX ? 0 : distToLive >= fadeStart ? opts.scrubAmount : (distToLive - CROSSHAIR_FADE_MIN_PX) / (fadeStart - CROSSHAIR_FADE_MIN_PX) * opts.scrubAmount;
    if (scrubOpacity > 0.01) {
      drawCrosshair(
        ctx,
        layout,
        palette,
        opts.hoverX,
        opts.hoverValue,
        opts.hoverTime,
        opts.formatValue,
        opts.formatTime,
        scrubOpacity,
        opts.tooltipY,
        lastPt[0],
        // liveDotX — tooltip right edge stops here
        opts.tooltipOutline
      );
    }
  }
  if (shake && (shakeX !== 0 || shakeY !== 0)) {
    ctx.restore();
  }
}

// src/draw/loading.ts
function drawLoading(ctx, w, h, pad, palette, now_ms, alpha = 1) {
  const chartW = w - pad.left - pad.right;
  const chartH = h - pad.top - pad.bottom;
  const centerY = pad.top + chartH / 2;
  const leftX = pad.left;
  const amplitude = chartH * LOADING_AMPLITUDE_RATIO;
  const scroll = now_ms * LOADING_SCROLL_SPEED;
  const breath = loadingBreath(now_ms);
  const numPts = 32;
  const pts = [];
  for (let i = 0; i <= numPts; i++) {
    const t = i / numPts;
    const x = leftX + t * chartW;
    const y = loadingY(t, centerY, amplitude, scroll);
    pts.push([x, y]);
  }
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  drawSpline(ctx, pts);
  ctx.strokeStyle = palette.line;
  ctx.lineWidth = palette.lineWidth;
  ctx.globalAlpha = breath * alpha;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// src/draw/empty.ts
function drawEmpty(ctx, w, h, pad, palette, alpha = 1, now_ms = 0, skipLine = false, emptyText) {
  const chartW = w - pad.left - pad.right;
  const chartH = h - pad.top - pad.bottom;
  const centerY = pad.top + chartH / 2;
  const cx = pad.left + chartW / 2;
  const text = emptyText ?? "No data to display";
  ctx.font = "400 24px system-ui, -apple-system, sans-serif";
  const amplitude = chartH * LOADING_AMPLITUDE_RATIO;
  const textW = ctx.measureText(text).width;
  const gapHalf = textW / 2 + 20;
  const fadeW = 30;
  if (!skipLine) {
    const scroll = now_ms * LOADING_SCROLL_SPEED;
    const breath = loadingBreath(now_ms);
    const numPts = 32;
    const pts = [];
    for (let i = 0; i <= numPts; i++) {
      const t = i / numPts;
      const x = pad.left + t * chartW;
      const y = loadingY(t, centerY, amplitude, scroll);
      pts.push([x, y]);
    }
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    drawSpline(ctx, pts);
    ctx.strokeStyle = palette.gridLabel;
    ctx.lineWidth = palette.lineWidth;
    ctx.globalAlpha = breath * alpha;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
  }
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  const gapLeft = cx - gapHalf - fadeW;
  const gapRight = cx + gapHalf + fadeW;
  const eraseGrad = ctx.createLinearGradient(gapLeft, 0, gapRight, 0);
  eraseGrad.addColorStop(0, "rgba(0,0,0,0)");
  eraseGrad.addColorStop(fadeW / (gapRight - gapLeft), "rgba(0,0,0,1)");
  eraseGrad.addColorStop(1 - fadeW / (gapRight - gapLeft), "rgba(0,0,0,1)");
  eraseGrad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = eraseGrad;
  ctx.globalAlpha = alpha;
  const eraseH = amplitude * 2 + palette.lineWidth + 6;
  ctx.fillRect(gapLeft, centerY - eraseH / 2, gapRight - gapLeft, eraseH);
  ctx.restore();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.globalAlpha = 0.35 * alpha;
  ctx.fillStyle = palette.gridLabel;
  ctx.fillText(text, cx, centerY);
  ctx.globalAlpha = 1;
  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
}

// src/draw/badge.ts
function badgeSvgPath(pillW, pillH, tailLen, tailSpread) {
  const r = pillH / 2;
  const cx = tailLen + pillW - r;
  const tl = tailLen + r;
  return [
    `M${tl},0`,
    `L${cx},0`,
    `A${r},${r},0,0,1,${cx},${pillH}`,
    `L${tl},${pillH}`,
    `C${tailLen + 2},${pillH},${3},${r + tailSpread},0,${r}`,
    `C${3},${r - tailSpread},${tailLen + 2},0,${tl},0`,
    "Z"
  ].join(" ");
}
function badgePillOnly(pillW, pillH) {
  const r = pillH / 2;
  return [
    `M${r},0`,
    `L${pillW - r},0`,
    `A${r},${r},0,0,1,${pillW - r},${pillH}`,
    `L${r},${pillH}`,
    `A${r},${r},0,0,1,${r},0`,
    "Z"
  ].join(" ");
}
var BADGE_PAD_X = 20;
var BADGE_PAD_Y = 6;
var BADGE_TAIL_LEN = 10;
var BADGE_TAIL_SPREAD = 5;
var BADGE_LINE_H = 32;

// src/useLivelineEngine.ts
var SVG_NS = "http://www.w3.org/2000/svg";
var MAX_DELTA_MS = 50;
var SCRUB_LERP_SPEED = 0.12;
var BADGE_WIDTH_LERP = 0.15;
var BADGE_Y_LERP = 0.35;
var BADGE_Y_LERP_TRANSITIONING = 0.5;
var MOMENTUM_COLOR_LERP = 0.12;
var WINDOW_TRANSITION_MS = 750;
var WINDOW_BUFFER = 0.05;
var VALUE_SNAP_THRESHOLD = 1e-3;
var ADAPTIVE_SPEED_BOOST = 0.2;
var MOMENTUM_GREEN = [34, 197, 94];
var MOMENTUM_RED = [239, 68, 68];
var CHART_REVEAL_SPEED = 0.14;
var PAUSE_PROGRESS_SPEED = 0.12;
var PAUSE_CATCHUP_SPEED = 0.08;
var PAUSE_CATCHUP_SPEED_FAST = 0.22;
var LOADING_ALPHA_SPEED = 0.14;
function computeAdaptiveSpeed(value, displayValue, displayMin, displayMax, lerpSpeed, noMotion) {
  const valGap = Math.abs(value - displayValue);
  const prevRange = displayMax - displayMin || 1;
  const gapRatio = Math.min(valGap / prevRange, 1);
  return noMotion ? 1 : lerpSpeed + (1 - gapRatio) * ADAPTIVE_SPEED_BOOST;
}
function updateWindowTransition(cfg, wt, displayWindow, displayMin, displayMax, noMotion, now_ms, now, points, smoothValue, buffer) {
  if (wt.to !== cfg.windowSecs) {
    wt.from = displayWindow;
    wt.to = cfg.windowSecs;
    wt.startMs = now_ms;
    wt.rangeFromMin = displayMin;
    wt.rangeFromMax = displayMax;
    const targetRightEdge = now + cfg.windowSecs * buffer;
    const targetLeftEdge = targetRightEdge - cfg.windowSecs;
    const targetVisible = [];
    for (const p of points) {
      if (p.time >= targetLeftEdge - 2 && p.time <= targetRightEdge) {
        targetVisible.push(p);
      }
    }
    if (targetVisible.length > 0) {
      const targetRange = computeRange(targetVisible, smoothValue, cfg.referenceLine?.value, cfg.exaggerate);
      wt.rangeToMin = targetRange.min;
      wt.rangeToMax = targetRange.max;
    }
  }
  let windowTransProgress = 0;
  let resultWindow;
  if (noMotion || wt.startMs === 0) {
    resultWindow = cfg.windowSecs;
  } else {
    const elapsed = now_ms - wt.startMs;
    const duration = WINDOW_TRANSITION_MS;
    const t = Math.min(elapsed / duration, 1);
    const eased = (1 - Math.cos(t * Math.PI)) / 2;
    windowTransProgress = eased;
    const logFrom = Math.log(wt.from);
    const logTo = Math.log(wt.to);
    resultWindow = Math.exp(logFrom + (logTo - logFrom) * eased);
    if (t >= 1) {
      resultWindow = cfg.windowSecs;
      wt.startMs = 0;
      windowTransProgress = 0;
    }
  }
  return { windowSecs: resultWindow, windowTransProgress };
}
function updateRange(computedRange, rangeInited, targetMin, targetMax, displayMin, displayMax, isTransitioning, windowTransProgress, wt, adaptiveSpeed, chartH, dt) {
  if (!rangeInited) {
    return {
      minVal: computedRange.min,
      maxVal: computedRange.max,
      valRange: computedRange.max - computedRange.min || 1e-3,
      targetMin: computedRange.min,
      targetMax: computedRange.max,
      displayMin: computedRange.min,
      displayMax: computedRange.max,
      rangeInited: true
    };
  }
  if (isTransitioning) {
    displayMin = wt.rangeFromMin + (wt.rangeToMin - wt.rangeFromMin) * windowTransProgress;
    displayMax = wt.rangeFromMax + (wt.rangeToMax - wt.rangeFromMax) * windowTransProgress;
    targetMin = computedRange.min;
    targetMax = computedRange.max;
  } else {
    const curRange = displayMax - displayMin;
    targetMin = computedRange.min;
    targetMax = computedRange.max;
    displayMin = lerp(displayMin, targetMin, adaptiveSpeed, dt);
    displayMax = lerp(displayMax, targetMax, adaptiveSpeed, dt);
    const pxThreshold = 0.5 * curRange / chartH || 1e-3;
    if (Math.abs(displayMin - targetMin) < pxThreshold) displayMin = targetMin;
    if (Math.abs(displayMax - targetMax) < pxThreshold) displayMax = targetMax;
  }
  return {
    minVal: displayMin,
    maxVal: displayMax,
    valRange: displayMax - displayMin || 1e-3,
    targetMin,
    targetMax,
    displayMin,
    displayMax,
    rangeInited: true
  };
}
function updateHoverState(hoverPixelX, pad, w, layout, now, visible, scrubAmount, lastHover, cfg, noMotion, leftEdge, rightEdge, chartW, dt) {
  let hoverValue = null;
  let hoverTime = null;
  let hoverChartX = null;
  let isActiveHover = false;
  if (hoverPixelX !== null && hoverPixelX >= pad.left && hoverPixelX <= w - pad.right) {
    const maxHoverX = layout.toX(now);
    const clampedX = Math.min(hoverPixelX, maxHoverX);
    const t = leftEdge + (clampedX - pad.left) / chartW * (rightEdge - leftEdge);
    const v = interpolateAtTime(visible, t);
    if (v !== null) {
      hoverValue = v;
      hoverTime = t;
      hoverChartX = clampedX;
      isActiveHover = true;
      lastHover = { x: clampedX, value: v, time: t };
      cfg.onHover?.({ time: t, value: v, x: clampedX, y: layout.toY(v) });
    }
  }
  const scrubTarget = isActiveHover ? 1 : 0;
  if (noMotion) {
    scrubAmount = scrubTarget;
  } else {
    scrubAmount += (scrubTarget - scrubAmount) * SCRUB_LERP_SPEED;
    if (scrubAmount < 0.01) scrubAmount = 0;
    if (scrubAmount > 0.99) scrubAmount = 1;
  }
  let drawHoverX = hoverChartX;
  let drawHoverValue = hoverValue;
  let drawHoverTime = hoverTime;
  if (!isActiveHover && scrubAmount > 0 && lastHover) {
    drawHoverX = lastHover.x;
    drawHoverValue = lastHover.value;
    drawHoverTime = lastHover.time;
  }
  return {
    hoverX: drawHoverX,
    hoverValue: drawHoverValue,
    hoverTime: drawHoverTime,
    scrubAmount,
    isActiveHover,
    lastHover
  };
}
function updateBadgeDOM(badge, cfg, smoothValue, layout, momentum, badgeY, badgeColor, isWindowTransitioning, noMotion, ctx, dt, chartReveal = 1) {
  if (!cfg.showBadge || chartReveal < 0.25) {
    badge.container.style.display = "none";
    return badgeY;
  }
  badge.container.style.display = "";
  const badgeOpacity = chartReveal < 0.5 ? (chartReveal - 0.25) / 0.25 : 1;
  badge.container.style.opacity = badgeOpacity < 1 ? String(badgeOpacity) : "";
  const { w, h, pad } = layout;
  const text = cfg.formatValue(smoothValue);
  badge.text.textContent = text;
  badge.text.style.font = cfg.palette.labelFont;
  badge.text.style.lineHeight = `${BADGE_LINE_H}px`;
  const tailLen = cfg.badgeTail ? BADGE_TAIL_LEN : 0;
  badge.text.style.padding = `${BADGE_PAD_Y}px ${BADGE_PAD_X}px ${BADGE_PAD_Y}px ${tailLen + BADGE_PAD_X}px`;
  ctx.font = cfg.palette.labelFont;
  const template = text.replace(/[0-9]/g, "8");
  const targetTextW = ctx.measureText(template).width;
  badge.targetW = targetTextW;
  if (badge.displayW === 0) badge.displayW = targetTextW;
  badge.displayW = lerp(badge.displayW, badge.targetW, BADGE_WIDTH_LERP, dt);
  if (Math.abs(badge.displayW - badge.targetW) < 0.3) badge.displayW = badge.targetW;
  const textW = badge.displayW;
  const pillW = textW + BADGE_PAD_X * 2;
  const pillH = BADGE_LINE_H + BADGE_PAD_Y * 2;
  const totalW = tailLen + pillW;
  badge.svg.setAttribute("width", String(Math.ceil(totalW)));
  badge.svg.setAttribute("height", String(pillH));
  badge.svg.setAttribute("viewBox", `0 0 ${totalW} ${pillH}`);
  badge.path.setAttribute("d", cfg.badgeTail ? badgeSvgPath(pillW, pillH, BADGE_TAIL_LEN, BADGE_TAIL_SPREAD) : badgePillOnly(pillW, pillH));
  const centerY = pad.top + layout.chartH / 2;
  const realTargetY = Math.max(pad.top, Math.min(h - pad.bottom, layout.toY(smoothValue)));
  const targetBadgeY = chartReveal < 1 ? centerY + (realTargetY - centerY) * chartReveal : realTargetY;
  if (badgeY === null || noMotion) {
    badgeY = targetBadgeY;
  } else {
    const badgeSpeed = isWindowTransitioning ? BADGE_Y_LERP_TRANSITIONING : BADGE_Y_LERP;
    badgeY = lerp(badgeY, targetBadgeY, badgeSpeed, dt);
  }
  const badgeLeft = w - pad.right + 16 - BADGE_PAD_X - tailLen;
  const badgeTop = badgeY - pillH / 2;
  badge.container.style.transform = `translate3d(${badgeLeft}px, ${badgeTop}px, 0)`;
  if (cfg.badgeVariant === "minimal") {
    badge.path.setAttribute("fill", cfg.palette.badgeOuterBg);
    badge.text.style.color = cfg.palette.tooltipText;
    badge.container.style.filter = `drop-shadow(0 1px 4px ${cfg.palette.badgeOuterShadow})`;
  } else {
    badge.container.style.filter = "";
    badge.text.style.color = "#fff";
    const bs = badgeColor;
    let fillColor;
    if (!cfg.showMomentum) {
      fillColor = cfg.palette.line;
    } else {
      const target = momentum === "up" ? 1 : momentum === "down" ? 0 : bs.green;
      bs.green = noMotion ? target : lerp(bs.green, target, MOMENTUM_COLOR_LERP, dt);
      if (bs.green > 0.99) bs.green = 1;
      if (bs.green < 0.01) bs.green = 0;
      const g = bs.green;
      const rr = Math.round(MOMENTUM_RED[0] + (MOMENTUM_GREEN[0] - MOMENTUM_RED[0]) * g);
      const gg = Math.round(MOMENTUM_RED[1] + (MOMENTUM_GREEN[1] - MOMENTUM_RED[1]) * g);
      const bb = Math.round(MOMENTUM_RED[2] + (MOMENTUM_GREEN[2] - MOMENTUM_RED[2]) * g);
      fillColor = `rgb(${rr},${gg},${bb})`;
    }
    badge.path.setAttribute("fill", fillColor);
  }
  return badgeY;
}
function useLivelineEngine(canvasRef, containerRef, config) {
  const configRef = useRef(config);
  configRef.current = config;
  const displayValueRef = useRef(config.value);
  const displayMinRef = useRef(0);
  const displayMaxRef = useRef(0);
  const targetMinRef = useRef(0);
  const targetMaxRef = useRef(0);
  const rangeInitedRef = useRef(false);
  const displayWindowRef = useRef(config.windowSecs);
  const windowTransitionRef = useRef({
    from: config.windowSecs,
    to: config.windowSecs,
    startMs: 0,
    rangeFromMin: 0,
    rangeFromMax: 0,
    rangeToMin: 0,
    rangeToMax: 0
  });
  const arrowStateRef = useRef({ up: 0, down: 0 });
  const gridStateRef = useRef({ interval: 0, labels: /* @__PURE__ */ new Map() });
  const timeAxisStateRef = useRef({ labels: /* @__PURE__ */ new Map() });
  const orderbookStateRef = useRef(createOrderbookState());
  const particleStateRef = useRef(createParticleState());
  const shakeStateRef = useRef(createShakeState());
  const badgeColorRef = useRef({ green: 1 });
  const badgeYRef = useRef(null);
  const reducedMotionRef = useRef(false);
  const sizeRef = useRef({ w: 0, h: 0 });
  const ctxRef = useRef(null);
  const rafRef = useRef(0);
  const lastFrameRef = useRef(0);
  const badgeRef = useRef(null);
  const hoverXRef = useRef(null);
  const scrubAmountRef = useRef(0);
  const lastHoverRef = useRef(null);
  const chartRevealRef = useRef(0);
  const pauseProgressRef = useRef(0);
  const timeDebtRef = useRef(0);
  const lastDataRef = useRef([]);
  const frozenNowRef = useRef(0);
  const pausedDataRef = useRef(null);
  const loadingAlphaRef = useRef(config.loading ? 1 : 0);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const el = document.createElement("div");
    el.style.cssText = "position:absolute;top:0;left:0;pointer-events:none;will-change:transform;display:none;z-index:1;";
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.style.cssText = "position:absolute;top:0;left:0;";
    const path = document.createElementNS(SVG_NS, "path");
    svg.appendChild(path);
    const text = document.createElement("span");
    text.style.cssText = "position:relative;display:block;color:#fff;white-space:nowrap;";
    el.appendChild(svg);
    el.appendChild(text);
    container.appendChild(el);
    badgeRef.current = { container: el, svg, path, text, displayW: 0, targetW: 0 };
    return () => {
      container.removeChild(el);
      badgeRef.current = null;
    };
  }, [containerRef]);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      sizeRef.current = { w: width, h: height };
    });
    ro.observe(container);
    const rect = container.getBoundingClientRect();
    sizeRef.current = { w: rect.width, h: rect.height };
    return () => ro.disconnect();
  }, [containerRef]);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onMove = (e) => {
      if (!configRef.current.scrub) return;
      const rect = container.getBoundingClientRect();
      hoverXRef.current = e.clientX - rect.left;
    };
    const onLeave = () => {
      hoverXRef.current = null;
      configRef.current.onHover?.(null);
    };
    const onTouchStart = (e) => {
      if (!configRef.current.scrub) return;
      if (e.touches.length !== 1) return;
      const rect = container.getBoundingClientRect();
      hoverXRef.current = e.touches[0].clientX - rect.left;
    };
    const onTouchMove = (e) => {
      if (!configRef.current.scrub) return;
      if (e.touches.length !== 1) return;
      e.preventDefault();
      const rect = container.getBoundingClientRect();
      hoverXRef.current = e.touches[0].clientX - rect.left;
    };
    const onTouchEnd = () => {
      hoverXRef.current = null;
      configRef.current.onHover?.(null);
    };
    container.addEventListener("mousemove", onMove);
    container.addEventListener("mouseleave", onLeave);
    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("touchmove", onTouchMove, { passive: false });
    container.addEventListener("touchend", onTouchEnd);
    container.addEventListener("touchcancel", onTouchEnd);
    return () => {
      container.removeEventListener("mousemove", onMove);
      container.removeEventListener("mouseleave", onLeave);
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("touchend", onTouchEnd);
      container.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [containerRef]);
  useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotionRef.current = mql.matches;
    const onChange = (e) => {
      reducedMotionRef.current = e.matches;
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  useEffect(() => {
    const onVisibility = () => {
      if (!document.hidden && !rafRef.current) {
        rafRef.current = requestAnimationFrame(draw);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  const draw = useCallback(() => {
    if (document.hidden) {
      rafRef.current = 0;
      return;
    }
    const canvas = canvasRef.current;
    const { w, h } = sizeRef.current;
    if (!canvas || w === 0 || h === 0) {
      rafRef.current = requestAnimationFrame(draw);
      return;
    }
    const cfg = configRef.current;
    const dpr = getDpr();
    const now_ms = performance.now();
    const dt = lastFrameRef.current ? Math.min(now_ms - lastFrameRef.current, MAX_DELTA_MS) : 16.67;
    lastFrameRef.current = now_ms;
    const targetW = Math.round(w * dpr);
    const targetH = Math.round(h * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    let ctx = ctxRef.current;
    if (!ctx || ctx.canvas !== canvas) {
      ctx = canvas.getContext("2d");
      ctxRef.current = ctx;
    }
    if (!ctx) {
      rafRef.current = requestAnimationFrame(draw);
      return;
    }
    applyDpr(ctx, dpr, w, h);
    const noMotion = reducedMotionRef.current;
    if (cfg.paused && pausedDataRef.current === null && cfg.data.length >= 2) {
      pausedDataRef.current = cfg.data.slice();
    }
    if (!cfg.paused) {
      pausedDataRef.current = null;
    }
    const points = pausedDataRef.current ?? cfg.data;
    const hasData = points.length >= 2;
    const pad = cfg.padding;
    const chartH = h - pad.top - pad.bottom;
    const pauseTarget = cfg.paused ? 1 : 0;
    pauseProgressRef.current = noMotion ? pauseTarget : lerp(pauseProgressRef.current, pauseTarget, PAUSE_PROGRESS_SPEED, dt);
    if (pauseProgressRef.current < 5e-3) pauseProgressRef.current = 0;
    if (pauseProgressRef.current > 0.995) pauseProgressRef.current = 1;
    const pauseProgress = pauseProgressRef.current;
    const pausedDt = dt * (1 - pauseProgress);
    const realDtSec = dt / 1e3;
    timeDebtRef.current += realDtSec * pauseProgress;
    if (!cfg.paused && timeDebtRef.current > 1e-3) {
      const catchUpSpeed = timeDebtRef.current > 10 ? PAUSE_CATCHUP_SPEED_FAST : PAUSE_CATCHUP_SPEED;
      timeDebtRef.current = lerp(timeDebtRef.current, 0, catchUpSpeed, dt);
      if (timeDebtRef.current < 0.01) timeDebtRef.current = 0;
    }
    const loadingTarget = cfg.loading ? 1 : 0;
    loadingAlphaRef.current = noMotion ? loadingTarget : lerp(loadingAlphaRef.current, loadingTarget, LOADING_ALPHA_SPEED, dt);
    if (loadingAlphaRef.current < 0.01) loadingAlphaRef.current = 0;
    if (loadingAlphaRef.current > 0.99) loadingAlphaRef.current = 1;
    const loadingAlpha = loadingAlphaRef.current;
    const revealTarget = !cfg.loading && hasData ? 1 : 0;
    chartRevealRef.current = noMotion ? revealTarget : lerp(chartRevealRef.current, revealTarget, CHART_REVEAL_SPEED, dt);
    if (Math.abs(chartRevealRef.current - revealTarget) < 5e-3) {
      chartRevealRef.current = revealTarget;
    }
    const chartReveal = chartRevealRef.current;
    const useStash = !hasData && chartReveal > 5e-3 && lastDataRef.current.length >= 2;
    if (hasData) {
      lastDataRef.current = points;
    }
    if (!hasData && !useStash) {
      if (loadingAlpha > 0.01) {
        drawLoading(ctx, w, h, pad, cfg.palette, now_ms, loadingAlpha);
      }
      if (1 - loadingAlpha > 0.01) {
        drawEmpty(ctx, w, h, pad, cfg.palette, 1 - loadingAlpha, now_ms, false, cfg.emptyText);
      }
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      const fadeGrad = ctx.createLinearGradient(pad.left, 0, pad.left + FADE_EDGE_WIDTH, 0);
      fadeGrad.addColorStop(0, "rgba(0, 0, 0, 1)");
      fadeGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = fadeGrad;
      ctx.fillRect(0, 0, pad.left + FADE_EDGE_WIDTH, h);
      ctx.restore();
      if (badgeRef.current) badgeRef.current.container.style.display = "none";
      rafRef.current = requestAnimationFrame(draw);
      return;
    }
    const effectivePoints = useStash ? lastDataRef.current : points;
    const adaptiveSpeed = computeAdaptiveSpeed(
      cfg.value,
      displayValueRef.current,
      displayMinRef.current,
      displayMaxRef.current,
      cfg.lerpSpeed,
      noMotion
    );
    if (!useStash) {
      displayValueRef.current = lerp(displayValueRef.current, cfg.value, adaptiveSpeed, pausedDt);
      if (pauseProgress < 0.5) {
        const prevRange = displayMaxRef.current - displayMinRef.current || 1;
        if (Math.abs(displayValueRef.current - cfg.value) < prevRange * VALUE_SNAP_THRESHOLD) {
          displayValueRef.current = cfg.value;
        }
      }
    }
    const smoothValue = displayValueRef.current;
    const chartW = w - pad.left - pad.right;
    const needsArrowRoom = cfg.showMomentum;
    const buffer = needsArrowRoom ? Math.max(WINDOW_BUFFER, 37 / Math.max(chartW, 1)) : WINDOW_BUFFER;
    const transition = windowTransitionRef.current;
    if (hasData) frozenNowRef.current = Date.now() / 1e3 - timeDebtRef.current;
    const now = useStash ? frozenNowRef.current : Date.now() / 1e3 - timeDebtRef.current;
    const windowResult = updateWindowTransition(
      cfg,
      transition,
      displayWindowRef.current,
      displayMinRef.current,
      displayMaxRef.current,
      noMotion,
      now_ms,
      now,
      effectivePoints,
      smoothValue,
      buffer
    );
    displayWindowRef.current = windowResult.windowSecs;
    const windowSecs = windowResult.windowSecs;
    const windowTransProgress = windowResult.windowTransProgress;
    const rightEdge = now + windowSecs * buffer;
    const leftEdge = rightEdge - windowSecs;
    const filterRight = rightEdge - (rightEdge - now) * pauseProgress;
    const visible = [];
    for (const p of effectivePoints) {
      if (p.time >= leftEdge - 2 && p.time <= filterRight) {
        visible.push(p);
      }
    }
    if (visible.length < 2) {
      if (badgeRef.current) badgeRef.current.container.style.display = "none";
      rafRef.current = requestAnimationFrame(draw);
      return;
    }
    const computedRange = computeRange(visible, smoothValue, cfg.referenceLine?.value, cfg.exaggerate);
    const isWindowTransitioning = transition.startMs > 0;
    const rangeResult = updateRange(
      computedRange,
      rangeInitedRef.current,
      targetMinRef.current,
      targetMaxRef.current,
      displayMinRef.current,
      displayMaxRef.current,
      isWindowTransitioning,
      windowTransProgress,
      transition,
      adaptiveSpeed,
      chartH,
      pausedDt
    );
    rangeInitedRef.current = rangeResult.rangeInited;
    targetMinRef.current = rangeResult.targetMin;
    targetMaxRef.current = rangeResult.targetMax;
    displayMinRef.current = rangeResult.displayMin;
    displayMaxRef.current = rangeResult.displayMax;
    if (cfg.onRangeUpdate) {
      cfg.onRangeUpdate({ min: rangeResult.displayMin, max: rangeResult.displayMax });
    }
    const { minVal, maxVal, valRange } = rangeResult;
    const momentum = cfg.momentumOverride ?? detectMomentum(visible);
    const layout = {
      w,
      h,
      pad,
      chartW,
      chartH,
      leftEdge,
      rightEdge,
      minVal,
      maxVal,
      valRange,
      toX: (t) => pad.left + (t - leftEdge) / (rightEdge - leftEdge) * chartW,
      toY: (v) => pad.top + (1 - (v - minVal) / valRange) * chartH,
      _dashLineColor: cfg.dashLineColor ? (typeof cfg.dashLineColor === 'function' ? cfg.dashLineColor(momentum) : cfg.dashLineColor) : void 0
    };
    const hoverResult = updateHoverState(
      hoverXRef.current,
      pad,
      w,
      layout,
      now,
      visible,
      scrubAmountRef.current,
      lastHoverRef.current,
      cfg,
      noMotion,
      leftEdge,
      rightEdge,
      chartW,
      dt
    );
    scrubAmountRef.current = hoverResult.scrubAmount;
    lastHoverRef.current = hoverResult.lastHover;
    const { hoverX: drawHoverX, hoverValue: drawHoverValue, hoverTime: drawHoverTime } = hoverResult;
    const lookback = Math.min(5, visible.length - 1);
    const recentDelta = lookback > 0 ? Math.abs(visible[visible.length - 1].value - visible[visible.length - 1 - lookback].value) : 0;
    const swingMagnitude = valRange > 0 ? Math.min(recentDelta / valRange, 1) : 0;
    drawFrame(ctx, layout, cfg.palette, {
      visible,
      smoothValue,
      now,
      momentum,
      arrowState: arrowStateRef.current,
      showGrid: cfg.showGrid,
      showMomentum: cfg.showMomentum,
      showPulse: cfg.showPulse,
      showFill: cfg.showFill,
      referenceLine: cfg.referenceLine,
      hoverX: drawHoverX,
      hoverValue: drawHoverValue,
      hoverTime: drawHoverTime,
      scrubAmount: scrubAmountRef.current,
      windowSecs,
      formatValue: cfg.formatValue,
      formatTime: cfg.formatTime,
      gridState: gridStateRef.current,
      timeAxisState: timeAxisStateRef.current,
      dt,
      targetWindowSecs: cfg.windowSecs,
      tooltipY: cfg.tooltipY,
      tooltipOutline: cfg.tooltipOutline,
      orderbookData: cfg.orderbookData,
      orderbookState: cfg.orderbookData ? orderbookStateRef.current : void 0,
      particleState: cfg.degenOptions ? particleStateRef.current : void 0,
      particleOptions: cfg.degenOptions,
      swingMagnitude,
      shakeState: cfg.degenOptions ? shakeStateRef.current : void 0,
      chartReveal,
      pauseProgress,
      now_ms,
      showTimeAxis: cfg.showTimeAxis
    });
    const bgAlpha = 1 - chartReveal;
    if (bgAlpha > 0.01 && revealTarget === 0 && !cfg.loading) {
      const bgEmptyAlpha = (1 - loadingAlpha) * bgAlpha;
      if (bgEmptyAlpha > 0.01) {
        drawEmpty(ctx, w, h, pad, cfg.palette, bgEmptyAlpha, now_ms, true, cfg.emptyText);
      }
    }
    const badge = badgeRef.current;
    if (badge) {
      badgeYRef.current = updateBadgeDOM(
        badge,
        cfg,
        smoothValue,
        layout,
        momentum,
        badgeYRef.current,
        badgeColorRef.current,
        isWindowTransitioning,
        noMotion,
        ctx,
        pausedDt,
        chartReveal
      );
      if (pauseProgress > 0.01 && badge.container.style.display !== "none") {
        const base = badge.container.style.opacity ? parseFloat(badge.container.style.opacity) : 1;
        badge.container.style.opacity = String(base * (1 - pauseProgress));
      }
    }
    const valEl = cfg.valueDisplayRef?.current;
    if (valEl) {
      const displayVal = cfg.valueMomentumColor ? Math.abs(smoothValue) : smoothValue;
      valEl.textContent = cfg.formatValue(displayVal);
      if (cfg.valueMomentumColor) {
        const mc = momentum === "up" ? "#22c55e" : momentum === "down" ? "#ef4444" : "";
        if (mc) valEl.style.color = mc;
        else valEl.style.removeProperty("color");
      }
    }
    rafRef.current = requestAnimationFrame(draw);
  }, [canvasRef]);
  useEffect(() => {
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [draw]);
}

// src/Liveline.tsx
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
var defaultFormatValue = (v) => v.toFixed(2);
var defaultFormatTime = (t) => {
  const d = new Date(t * 1e3);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  const s = d.getSeconds().toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
};
function Liveline({
  data,
  value,
  theme = "dark",
  color = "#3b82f6",
  window: windowSecs = 30,
  grid = true,
  badge = true,
  momentum = true,
  fill = true,
  scrub = true,
  loading = false,
  paused = false,
  emptyText,
  exaggerate = false,
  degen: degenProp,
  badgeTail = true,
  badgeVariant = "default",
  showValue = false,
  valueMomentumColor = false,
  windows,
  onWindowChange,
  windowStyle,
  tooltipY = 14,
  tooltipOutline = true,
  orderbook,
  referenceLine,
  formatValue = defaultFormatValue,
  formatTime = defaultFormatTime,
  lerpSpeed = 0.08,
  padding: paddingOverride,
  onHover,
  onRangeUpdate,
  cursor = "crosshair",
  pulse = true,
  timeAxis = true,
  dashLineColor,
  className,
  style
}) {
  const canvasRef = useRef2(null);
  const containerRef = useRef2(null);
  const valueDisplayRef = useRef2(null);
  const windowBarRef = useRef2(null);
  const windowBtnRefs = useRef2(/* @__PURE__ */ new Map());
  const [indicatorStyle, setIndicatorStyle] = useState(null);
  const palette = useMemo(() => resolveTheme(color, theme), [color, theme]);
  const isDark = theme === "dark";
  const showMomentum = momentum !== false;
  const momentumOverride = typeof momentum === "string" ? momentum : void 0;
  const pad = {
    top: paddingOverride?.top ?? 12,
    right: paddingOverride?.right ?? 80,
    bottom: paddingOverride?.bottom ?? 28,
    left: paddingOverride?.left ?? 12
  };
  const degenEnabled = degenProp != null ? degenProp !== false : false;
  const degenOptions = degenEnabled ? typeof degenProp === "object" ? degenProp : {} : void 0;
  const [activeWindowSecs, setActiveWindowSecs] = useState(
    windows && windows.length > 0 ? windows[0].secs : windowSecs
  );
  const effectiveWindowSecs = windows ? activeWindowSecs : windowSecs;
  useLayoutEffect(() => {
    if (!windows || windows.length === 0) return;
    const btn = windowBtnRefs.current.get(activeWindowSecs);
    const bar = windowBarRef.current;
    if (btn && bar) {
      const barRect = bar.getBoundingClientRect();
      const btnRect = btn.getBoundingClientRect();
      setIndicatorStyle({
        left: btnRect.left - barRect.left,
        width: btnRect.width
      });
    }
  }, [activeWindowSecs, windows]);
  const ws = windowStyle ?? "default";
  useLivelineEngine(canvasRef, containerRef, {
    data,
    value,
    palette,
    windowSecs: effectiveWindowSecs,
    lerpSpeed,
    showGrid: grid,
    showBadge: badge,
    showMomentum,
    momentumOverride,
    showFill: fill,
    referenceLine,
    formatValue,
    formatTime,
    padding: pad,
    onHover,
    showPulse: pulse,
    scrub,
    exaggerate,
    degenOptions,
    badgeTail,
    badgeVariant,
    tooltipY,
    tooltipOutline,
    valueMomentumColor,
    valueDisplayRef: showValue ? valueDisplayRef : void 0,
    orderbookData: orderbook,
    loading,
    paused,
    emptyText,
    showTimeAxis: timeAxis,
    dashLineColor,
    onRangeUpdate
  });
  const cursorStyle = scrub ? cursor : "default";
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    showValue && /* @__PURE__ */ jsx(
      "span",
      {
        ref: valueDisplayRef,
        style: {
          display: "block",
          fontSize: 40,
          fontWeight: 500,
          fontFamily: '"SF Mono", Menlo, monospace',
          color: isDark ? "rgba(255,255,255,0.85)" : "#111",
          transition: "color 0.3s",
          letterSpacing: "-0.01em",
          marginBottom: 16,
          paddingTop: 8,
          paddingLeft: pad.left
        }
      }
    ),
    windows && windows.length > 0 && /* @__PURE__ */ jsxs(
      "div",
      {
        ref: windowBarRef,
        style: {
          position: "relative",
          display: "inline-flex",
          gap: ws === "text" ? 8 : 4,
          background: ws === "text" ? "transparent" : isDark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.02)",
          borderRadius: ws === "rounded" ? 999 : 12,
          padding: ws === "text" ? 0 : ws === "rounded" ? 6 : 4,
          marginBottom: 12,
          marginLeft: pad.left
        },
        children: [
          ws !== "text" && indicatorStyle && /* @__PURE__ */ jsx("div", { style: {
            position: "absolute",
            top: ws === "rounded" ? 3 : 2,
            left: indicatorStyle.left,
            width: indicatorStyle.width,
            height: ws === "rounded" ? "calc(100% - 6px)" : "calc(100% - 4px)",
            background: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.035)",
            borderRadius: ws === "rounded" ? 999 : 4,
            transition: "left 0.25s cubic-bezier(0.4, 0, 0.2, 1), width 0.25s cubic-bezier(0.4, 0, 0.2, 1)",
            pointerEvents: "none"
          } }),
          windows.map((w) => {
            const isActive = w.secs === activeWindowSecs;
            return /* @__PURE__ */ jsx(
              "button",
              {
                ref: (el) => {
                  if (el) windowBtnRefs.current.set(w.secs, el);
                  else windowBtnRefs.current.delete(w.secs);
                },
                onClick: () => {
                  setActiveWindowSecs(w.secs);
                  onWindowChange?.(w.secs);
                },
                style: {
                  position: "relative",
                  zIndex: 1,
                  fontSize: 22,
                  padding: ws === "text" ? "4px 12px" : "6px 20px",
                  borderRadius: ws === "rounded" ? 999 : 4,
                  border: "none",
                  cursor: "pointer",
                  fontFamily: "system-ui, -apple-system, sans-serif",
                  fontWeight: isActive ? 600 : 400,
                  background: "transparent",
                  color: isActive ? isDark ? "rgba(255,255,255,0.7)" : "rgba(0,0,0,0.55)" : isDark ? "rgba(255,255,255,0.25)" : "rgba(0,0,0,0.22)",
                  transition: "color 0.2s, background 0.15s",
                  lineHeight: "16px"
                },
                children: w.label
              },
              w.secs
            );
          })
        ]
      }
    ),
    /* @__PURE__ */ jsx(
      "div",
      {
        ref: containerRef,
        className,
        style: {
          width: "100%",
          height: "100%",
          position: "relative",
          ...style
        },
        children: /* @__PURE__ */ jsx(
          "canvas",
          {
            ref: canvasRef,
            style: { display: "block", cursor: cursorStyle }
          }
        )
      }
    )
  ] });
}
export {
  Liveline
};
