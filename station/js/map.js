// Plan view. North-up canvas, no tiles, no network — it draws the alignment,
// where you are, and the tie back to the centreline.

import { formatStation } from './alignment.js';

export class PlanView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scale = 1;          // pixels per metre
    this.cx = 0; this.cy = 0; // view centre in local metres
    this.follow = true;
    this.alignment = null;
    this.drawPts = [];
    this.marks = [];
    this.pois = [];
    this.fix = null;         // {x,y,acc,heading}
    this.snap = null;        // [x,y]
    this.target = null;      // {x,y,station}
    this.units = { label: 'm', perMetre: 1, interval: 100 };
    this._pointers = new Map();
    this._pinch = null;
    this._bind();
    this._resize();
    new ResizeObserver(() => { this._resize(); this.draw(); }).observe(canvas);
  }

  setAlignment(al, units) {
    this.alignment = al;
    this.units = units || this.units;
    this.drawPts = al ? al.xy : [];
    if (al) this.fit();
  }

  fit(pad = 0.12) {
    if (!this.alignment || !this.alignment.xy.length) return;
    const b = this.alignment.bounds();
    const w = Math.max(b.maxX - b.minX, 1), h = Math.max(b.maxY - b.minY, 1);
    const { width, height } = this._size();
    this.scale = Math.min(width / (w * (1 + pad * 2)), height / (h * (1 + pad * 2)));
    this.cx = (b.minX + b.maxX) / 2;
    this.cy = (b.minY + b.maxY) / 2;
    this.follow = false;
    this.draw();
  }

  centreOn(x, y) { this.cx = x; this.cy = y; }

  zoomBy(f, px, py) {
    const before = this.toWorld(px, py);
    this.scale = Math.max(0.02, Math.min(60, this.scale * f));
    const after = this.toWorld(px, py);
    this.cx += before[0] - after[0];
    this.cy += before[1] - after[1];
    this.follow = false;
    this.draw();
  }

  _size() {
    const r = this.canvas.getBoundingClientRect();
    return { width: r.width || 300, height: r.height || 200 };
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const { width, height } = this._size();
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  toScreen(x, y) {
    const { width, height } = this._size();
    return [width / 2 + (x - this.cx) * this.scale, height / 2 - (y - this.cy) * this.scale];
  }
  toWorld(px, py) {
    const { width, height } = this._size();
    return [this.cx + (px - width / 2) / this.scale, this.cy - (py - height / 2) / this.scale];
  }

  _bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', e => {
      c.setPointerCapture(e.pointerId);
      this._pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
      if (this._pointers.size === 2) {
        const [a, b] = [...this._pointers.values()];
        this._pinch = Math.hypot(a[0] - b[0], a[1] - b[1]);
      }
    });
    c.addEventListener('pointermove', e => {
      if (!this._pointers.has(e.pointerId)) return;
      const prev = this._pointers.get(e.pointerId);
      this._pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
      if (this._pointers.size === 2 && this._pinch) {
        const [a, b] = [...this._pointers.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (this._pinch > 4) this.zoomBy(d / this._pinch, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
        this._pinch = d;
        return;
      }
      if (this._pointers.size === 1) {
        this.cx -= (e.offsetX - prev[0]) / this.scale;
        this.cy += (e.offsetY - prev[1]) / this.scale;
        this.follow = false;
        this.draw();
      }
    });
    const up = e => { this._pointers.delete(e.pointerId); if (this._pointers.size < 2) this._pinch = null; };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', e => {
      e.preventDefault();
      this.zoomBy(Math.exp(-e.deltaY * 0.0015), e.offsetX, e.offsetY);
    }, { passive: false });
  }

  draw() {
    const ctx = this.ctx;
    const { width, height } = this._size();
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#171310';
    ctx.fillRect(0, 0, width, height);

    if (this.follow && this.fix) this.centreOn(this.fix.x, this.fix.y);

    this._grid(ctx, width, height);
    if (this.alignment) {
      this._alignment(ctx);
      this._ticks(ctx);
    }
    this._pois(ctx);
    this._marks(ctx);
    this._targetMark(ctx);
    this._tie(ctx);
    this._fix(ctx);
    this._chrome(ctx, width, height);
  }

  _grid(ctx, w, h) {
    // Grid squares snap to a round distance in the display unit.
    const perMetre = this.units.perMetre;
    const targetPx = 70;
    const raw = targetPx / this.scale * perMetre;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 5, 10].map(m => m * pow).find(v => v >= raw) || pow * 10;
    const stepM = step / perMetre;
    ctx.strokeStyle = 'rgba(241,234,223,.045)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const [wx0, wy1] = this.toWorld(0, 0);
    const [wx1, wy0] = this.toWorld(w, h);
    for (let x = Math.ceil(wx0 / stepM) * stepM; x <= wx1; x += stepM) {
      const sx = this.toScreen(x, 0)[0];
      ctx.moveTo(sx, 0); ctx.lineTo(sx, h);
    }
    for (let y = Math.ceil(wy0 / stepM) * stepM; y <= wy1; y += stepM) {
      const sy = this.toScreen(0, y)[1];
      ctx.moveTo(0, sy); ctx.lineTo(w, sy);
    }
    ctx.stroke();
    this._gridStep = step;
  }

  _alignment(ctx) {
    const pts = this.drawPts;
    if (pts.length < 2) return;
    // Decimate to roughly one vertex per pixel — plenty for a plan view.
    const stride = Math.max(1, Math.floor(pts.length / 4000));
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(201,169,107,.28)';
    ctx.lineWidth = 7;
    this._path(ctx, pts, stride); ctx.stroke();
    ctx.strokeStyle = '#C9A96B';
    ctx.lineWidth = 2;
    this._path(ctx, pts, stride); ctx.stroke();

    // ends
    const ends = [[pts[0], 'BOA'], [pts[pts.length - 1], 'EOA']];
    ctx.font = '600 11px ui-monospace,Menlo,monospace';
    for (const [p, label] of ends) {
      const [sx, sy] = this.toScreen(p[0], p[1]);
      ctx.fillStyle = '#E6D2A6';
      ctx.beginPath(); ctx.arc(sx, sy, 4, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(241,234,223,.6)';
      ctx.fillText(label, sx + 7, sy - 6);
    }
  }

  _path(ctx, pts, stride) {
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < pts.length; i += stride) {
      const [sx, sy] = this.toScreen(pts[i][0], pts[i][1]);
      started ? ctx.lineTo(sx, sy) : (ctx.moveTo(sx, sy), started = true);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(...this.toScreen(last[0], last[1]));
  }

  _ticks(ctx) {
    const al = this.alignment;
    const { interval, perMetre } = this.units;
    // Show whole stations, then thin them out until the labels stop colliding.
    let stepUnits = interval;
    while (stepUnits / perMetre * this.scale < 55) stepUnits *= 2;
    const stepM = stepUnits / perMetre;
    const labels = stepUnits / perMetre * this.scale > 90;

    ctx.font = '500 10px ui-monospace,Menlo,monospace';
    ctx.textAlign = 'left';
    const firstSta = Math.ceil(al.stationAt(0) / stepUnits) * stepUnits;
    for (let sta = firstSta, guard = 0; guard < 4000; sta += stepUnits, guard++) {
      const d = al.distanceAtStation(sta);
      if (d == null || d > al.length) break;
      const p = al.pointAt(d);
      if (!p) break;
      const [sx, sy] = this.toScreen(p.x, p.y);
      const th = (90 - p.bearing) * Math.PI / 180;
      const nx = -Math.sin(th), ny = Math.cos(th); // left normal on screen axes
      const len = 7;
      ctx.strokeStyle = 'rgba(241,234,223,.45)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(sx - nx * len, sy + ny * len);
      ctx.lineTo(sx + nx * len, sy - ny * len);
      ctx.stroke();
      if (labels) {
        ctx.fillStyle = 'rgba(241,234,223,.55)';
        ctx.fillText(formatStation(sta, interval, 0), sx + 8, sy - 8);
      }
    }
  }

  _pois(ctx) {
    for (const p of this.pois) {
      const [sx, sy] = this.toScreen(p.x, p.y);
      ctx.fillStyle = 'rgba(120,200,255,.85)';
      ctx.beginPath(); ctx.arc(sx, sy, 3, 0, 7); ctx.fill();
    }
  }

  _marks(ctx) {
    ctx.font = '500 10px ui-monospace,Menlo,monospace';
    for (const m of this.marks) {
      if (m.x == null) continue;
      const [sx, sy] = this.toScreen(m.x, m.y);
      ctx.fillStyle = '#F1EADF';
      ctx.beginPath();
      ctx.moveTo(sx, sy - 5); ctx.lineTo(sx + 5, sy); ctx.lineTo(sx, sy + 5); ctx.lineTo(sx - 5, sy);
      ctx.closePath(); ctx.fill();
    }
  }

  _targetMark(ctx) {
    if (!this.target) return;
    const [sx, sy] = this.toScreen(this.target.x, this.target.y);
    ctx.strokeStyle = '#7FE0A8';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(sx, sy, 9, 0, 7); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sx - 13, sy); ctx.lineTo(sx + 13, sy);
    ctx.moveTo(sx, sy - 13); ctx.lineTo(sx, sy + 13); ctx.stroke();
  }

  _tie(ctx) {
    if (!this.fix || !this.snap) return;
    const a = this.toScreen(this.fix.x, this.fix.y);
    const b = this.toScreen(this.snap[0], this.snap[1]);
    ctx.strokeStyle = 'rgba(230,210,166,.75)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(230,210,166,.9)';
    ctx.beginPath(); ctx.arc(b[0], b[1], 3, 0, 7); ctx.fill();
  }

  _fix(ctx) {
    if (!this.fix) return;
    const [sx, sy] = this.toScreen(this.fix.x, this.fix.y);
    if (this.fix.acc) {
      const r = this.fix.acc * this.scale;
      if (r > 3) {
        ctx.fillStyle = 'rgba(126,190,255,.12)';
        ctx.strokeStyle = 'rgba(126,190,255,.35)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(sx, sy, r, 0, 7); ctx.fill(); ctx.stroke();
      }
    }
    if (this.fix.heading != null && isFinite(this.fix.heading)) {
      const th = (90 - this.fix.heading) * Math.PI / 180;
      ctx.fillStyle = 'rgba(126,190,255,.35)';
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.arc(sx, sy, 26, -th - 0.35, -th + 0.35);
      ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = '#7EBEFF';
    ctx.strokeStyle = '#0B0A09';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(sx, sy, 7, 0, 7); ctx.fill(); ctx.stroke();
  }

  _chrome(ctx, w, h) {
    // north arrow
    ctx.save();
    ctx.translate(w - 26, 26);
    ctx.strokeStyle = 'rgba(241,234,223,.5)';
    ctx.fillStyle = 'rgba(241,234,223,.75)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, 12); ctx.lineTo(0, -12); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -15); ctx.lineTo(4, -7); ctx.lineTo(-4, -7); ctx.closePath(); ctx.fill();
    ctx.font = '600 10px ui-monospace,Menlo,monospace';
    ctx.textAlign = 'center';
    ctx.fillText('N', 0, 25);
    ctx.restore();

    // scale bar, matching the grid step
    const step = this._gridStep;
    if (step) {
      const px = step / this.units.perMetre * this.scale;
      ctx.strokeStyle = 'rgba(241,234,223,.6)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(14, h - 18); ctx.lineTo(14 + px, h - 18);
      ctx.moveTo(14, h - 22); ctx.lineTo(14, h - 14);
      ctx.moveTo(14 + px, h - 22); ctx.lineTo(14 + px, h - 14);
      ctx.stroke();
      ctx.fillStyle = 'rgba(241,234,223,.7)';
      ctx.font = '500 10px ui-monospace,Menlo,monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`${step} ${this.units.label}`, 14, h - 24);
    }
  }
}
