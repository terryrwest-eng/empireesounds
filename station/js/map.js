// Plan view. North-up canvas, no tiles, no network — it draws the alignment,
// where you are, and the tie back to the centreline.

import { formatStation } from './alignment.js';
import { segments, centroid, area as polygonArea, formatArea } from './measure.js';

export class PlanView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scale = 1;          // pixels per metre
    this.cx = 0; this.cy = 0; // view centre in local metres
    this.follow = true;
    this.alignment = null;
    this.alignmentList = [];
    this.activeId = null;
    this.drawPts = [];
    this.marks = [];
    this.selectedMark = null;
    this.pois = [];
    this.fix = null;         // {x,y,acc,heading}
    this.snap = null;        // [x,y]
    this.target = null;      // {x,y,station,label}
    this.measure = null;     // {mode, points:[{x,y}], live:{x,y}}
    this.units = { label: 'm', perMetre: 1, interval: 100 };
    this.onTap = null;       // (worldX, worldY, hitPinId) => void
    this._pointers = new Map();
    this._pinch = null;
    this._tapStart = null;
    this._bind();
    this._resize();
    new ResizeObserver(() => { this._resize(); this.draw(); }).observe(canvas);
  }

  setAlignment(al, units) {
    this.setAlignments(al ? [{ id: 'one', name: al.name, al }] : [], 'one', units);
  }

  /**
   * A job can have several alignments running together. All of them draw; the
   * active one is the bright line with the station ticks, because that is the
   * one the readout is talking about.
   */
  setAlignments(list, activeId, units) {
    this.alignmentList = list || [];
    this.activeId = activeId;
    this.units = units || this.units;
    const active = this.alignmentList.find(a => a.id === activeId) || this.alignmentList[0];
    this.alignment = active ? active.al : null;
    this.drawPts = this.alignment ? this.alignment.xy : [];
    if (this.alignmentList.length) this.fitAll();
  }

  /** Frame everything in the project, not just the line with the readout. */
  fitAll(pad = 0.12) {
    if (!this.alignmentList || !this.alignmentList.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const item of this.alignmentList) {
      const b = item.al.bounds();
      minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY);
      maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY);
    }
    const w = Math.max(maxX - minX, 1), h = Math.max(maxY - minY, 1);
    const { width, height } = this._size();
    this.scale = Math.min(width / (w * (1 + pad * 2)), height / (h * (1 + pad * 2)));
    this.cx = (minX + maxX) / 2;
    this.cy = (minY + maxY) / 2;
    this.follow = false;
    this.draw();
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
      if (this._pointers.size === 1) this._tapStart = [e.offsetX, e.offsetY, Date.now()];
      else this._tapStart = null;
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
        // A drag is a pan, not a tap — but let a shaky thumb still count as one.
        if (this._tapStart && Math.hypot(e.offsetX - this._tapStart[0], e.offsetY - this._tapStart[1]) > 8) {
          this._tapStart = null;
        }
        this.cx -= (e.offsetX - prev[0]) / this.scale;
        this.cy += (e.offsetY - prev[1]) / this.scale;
        this.follow = false;
        this.draw();
      }
    });
    const up = e => {
      if (this._tapStart && this._pointers.size === 1 && this.onTap) {
        const [sx, sy, t] = this._tapStart;
        if (Date.now() - t < 700) {
          const [wx, wy] = this.toWorld(sx, sy);
          this.onTap(wx, wy, this.pickPin(sx, sy));
        }
      }
      this._tapStart = null;
      this._pointers.delete(e.pointerId);
      if (this._pointers.size < 2) this._pinch = null;
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', e => {
      e.preventDefault();
      this.zoomBy(Math.exp(-e.deltaY * 0.0015), e.offsetX, e.offsetY);
    }, { passive: false });
  }

  /**
   * Labels are placed first-come, first-served: anything that would land on top
   * of text already drawn is dropped instead. A map with two numbers written
   * over each other is worse than a map with one.
   */
  _claimLabel(cx, cy, w, h) {
    const box = { x: cx - w / 2, y: cy - h / 2, w, h };
    for (const b of this._labels) {
      if (box.x < b.x + b.w && box.x + box.w > b.x && box.y < b.y + b.h && box.y + box.h > b.y) return null;
    }
    this._labels.push(box);
    return box;
  }

  /** Try the preferred spot, then a few nearby, before giving up on a label. */
  _claimLabelNear(cx, cy, w, h, offsets) {
    for (const [dx, dy] of offsets) {
      const box = this._claimLabel(cx + dx, cy + dy, w, h);
      if (box) return box;
    }
    return null;
  }

  draw() {
    const ctx = this.ctx;
    const { width, height } = this._size();
    this._labels = [];
    // Markers are not text, but text must not land on them either.
    if (this.fix) {
      const [fx, fy] = this.toScreen(this.fix.x, this.fix.y);
      this._labels.push({ x: fx - 16, y: fy - 16, w: 32, h: 32 });
    }
    for (const m of this.marks) {
      if (m.x == null) continue;
      const [mx, my] = this.toScreen(m.x, m.y);
      this._labels.push({ x: mx - 8, y: my - 26, w: 16, h: 26 });
    }
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#171310';
    ctx.fillRect(0, 0, width, height);

    if (this.follow && this.fix) this.centreOn(this.fix.x, this.fix.y);

    this._grid(ctx, width, height);
    for (const item of this.alignmentList) {
      if (item.id === this.activeId) continue;
      this._otherAlignment(ctx, item);
    }
    if (this.alignment) {
      this._alignment(ctx);
      this._ticks(ctx);
    }
    this._pois(ctx);
    this._measure(ctx);
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
    const active = this.alignmentList.find(a => a.id === this.activeId);
    const ends = [
      [pts[0], active ? `${active.name} BOA` : 'BOA'],
      [pts[pts.length - 1], 'EOA']
    ];
    ctx.font = '600 11px ui-monospace,Menlo,monospace';
    for (const [p, label] of ends) {
      const [sx, sy] = this.toScreen(p[0], p[1]);
      ctx.fillStyle = '#E6D2A6';
      ctx.beginPath(); ctx.arc(sx, sy, 4, 0, 7); ctx.fill();
      const lw = ctx.measureText(label).width;
      if (this._claimLabel(sx + 7 + lw / 2, sy - 10, lw + 4, 13)) {
        ctx.fillStyle = 'rgba(241,234,223,.6)';
        ctx.fillText(label, sx + 7, sy - 6);
      }
    }
  }

  /** A line in the project that does not currently have the readout. */
  _otherAlignment(ctx, item) {
    const pts = item.al.xy;
    if (pts.length < 2) return;
    const stride = Math.max(1, Math.floor(pts.length / 3000));
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(201,169,107,.32)';
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 5]);
    this._path(ctx, pts, stride);
    ctx.stroke();
    ctx.setLineDash([]);

    // Name it at its midpoint, so parallel pipelines can be told apart.
    const mid = pts[Math.floor(pts.length / 2)];
    const [sx, sy] = this.toScreen(mid[0], mid[1]);
    ctx.font = '600 10px ui-monospace,Menlo,monospace';
    ctx.textAlign = 'center';
    const w = ctx.measureText(item.name).width + 8;
    if (this._claimLabel(sx, sy - 12, w, 14)) {
      ctx.fillStyle = 'rgba(20,16,14,.8)';
      ctx.fillRect(sx - w / 2, sy - 19, w, 14);
      ctx.fillStyle = 'rgba(201,169,107,.85)';
      ctx.fillText(item.name, sx, sy - 8);
    }
    ctx.textAlign = 'left';
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
        const text = formatStation(sta, interval, 0);
        const w = ctx.measureText(text).width;
        if (this._claimLabel(sx + 8 + w / 2, sy - 12, w + 4, 13)) {
          ctx.fillStyle = 'rgba(241,234,223,.55)';
          ctx.fillText(text, sx + 8, sy - 8);
        }
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

  /** Which pin is under this screen point, if any. */
  pickPin(px, py, slop = 20) {
    let best = null;
    this.marks.forEach((m, i) => {
      if (m.x == null) return;
      const [sx, sy] = this.toScreen(m.x, m.y);
      // The tip of the pin is at the point; the head sits above it.
      const d = Math.hypot(px - sx, py - (sy - 9));
      if (d <= slop && (!best || d < best.d)) best = { d, index: i, mark: m };
    });
    return best ? best.index : null;
  }

  _marks(ctx) {
    ctx.font = '600 10px ui-monospace,Menlo,monospace';
    ctx.textAlign = 'center';
    this.marks.forEach((m, i) => {
      if (m.x == null) return;
      const [sx, sy] = this.toScreen(m.x, m.y);
      const selected = i === this.selectedMark;
      // A teardrop pin: the point is the position, the head carries the label.
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(sx - 7, sy - 8, sx - 6, sy - 13);
      ctx.arc(sx, sy - 13, 6, Math.PI, 0);
      ctx.quadraticCurveTo(sx + 7, sy - 8, sx, sy);
      ctx.closePath();
      ctx.fillStyle = selected ? '#7FE0A8' : '#F1EADF';
      ctx.fill();
      ctx.strokeStyle = 'rgba(11,10,9,.85)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#14100E';
      ctx.beginPath();
      ctx.arc(sx, sy - 13, 2.4, 0, 7);
      ctx.fill();

      const label = m.label || m.note;
      if (label && this.scale > 0.05) {
        const w = ctx.measureText(label).width + 8;
        if (this._claimLabel(sx, sy - 34, w, 14)) {
          ctx.fillStyle = 'rgba(20,16,14,.75)';
          ctx.fillRect(sx - w / 2, sy - 40, w, 13);
          ctx.fillStyle = '#F1EADF';
          ctx.fillText(label, sx, sy - 30);
        }
      }
    });
    ctx.textAlign = 'left';
  }

  /** The live tape: legs, running lengths, and the figure being closed. */
  _measure(ctx) {
    const m = this.measure;
    if (!m || !m.points.length) return;
    const pts = m.points.slice();
    const live = m.live ? { x: m.live.x, y: m.live.y } : null;
    // The figure is the placed points. The live leg is drawn, but it is not part
    // of the shape, so what is on screen is what gets saved.
    const chain = pts;
    const closing = m.mode === 'area' && chain.length > 2;

    // fill first, so the lines sit on top of it
    if (closing) {
      ctx.beginPath();
      chain.forEach((p, i) => {
        const [sx, sy] = this.toScreen(p.x, p.y);
        i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy);
      });
      ctx.closePath();
      ctx.fillStyle = 'rgba(127,224,168,.14)';
      ctx.fill();
    }

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#7FE0A8';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    chain.forEach((p, i) => {
      const [sx, sy] = this.toScreen(p.x, p.y);
      i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy);
    });
    if (closing) ctx.closePath();
    ctx.stroke();

    // the leg being dragged out is dashed, so it reads as not-yet-placed
    if (live && pts.length) {
      const a = this.toScreen(pts[pts.length - 1].x, pts[pts.length - 1].y);
      const b = this.toScreen(live.x, live.y);
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = 'rgba(127,224,168,.75)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Reserve the headline number first — it outranks every leg label.
    let areaLabel = null;
    if (closing) {
      const a = polygonArea(chain);
      const c = centroid(chain);
      if (a > 0 && c) {
        const [cx, cy] = this.toScreen(c.x, c.y);
        const text = formatArea(a, this.units.label === 'ft' ? 'ft' : 'm');
        ctx.font = '600 12px ui-monospace,Menlo,monospace';
        const w = Math.max(ctx.measureText(text.primary).width, ctx.measureText(text.secondary).width) + 14;
        const box = this._claimLabelNear(cx, cy, w, 34,
          [[0, 0], [0, 44], [0, -44], [0, 80], [0, -80], [w * 0.6, 0], [-w * 0.6, 0]]);
        if (box) areaLabel = { box, text };
      }
    }

    ctx.font = '600 10px ui-monospace,Menlo,monospace';
    ctx.textAlign = 'center';
    const legs = segments(closing ? [...chain, chain[0]] : chain);
    legs.forEach(leg => {
      const a = chain[leg.from], b = chain[leg.to] || chain[0];
      const [ax, ay] = this.toScreen(a.x, a.y);
      const [bx, by] = this.toScreen(b.x, b.y);
      if (Math.hypot(bx - ax, by - ay) < 44) return; // no room for a label
      const text = `${(leg.horizontal * this.units.perMetre).toFixed(2)} ${this.units.label}`;
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      const w = ctx.measureText(text).width + 8;
      if (!this._claimLabel(mx, my, w, 15)) return;
      ctx.fillStyle = 'rgba(20,16,14,.8)';
      ctx.fillRect(mx - w / 2, my - 7, w, 14);
      ctx.fillStyle = '#7FE0A8';
      ctx.fillText(text, mx, my + 3.5);
    });

    // vertices, numbered so the results list can be read against the map
    pts.forEach((p, i) => {
      const [sx, sy] = this.toScreen(p.x, p.y);
      ctx.fillStyle = '#0B0A09';
      ctx.strokeStyle = '#7FE0A8';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sx, sy, 5.5, 0, 7); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#7FE0A8';
      ctx.font = '600 9px ui-monospace,Menlo,monospace';
      ctx.fillText(String(i + 1), sx, sy - 9);
    });

    if (areaLabel) {
      const { box, text } = areaLabel;
      const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
      ctx.fillStyle = 'rgba(20,16,14,.88)';
      ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.strokeStyle = 'rgba(127,224,168,.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(box.x, box.y, box.w, box.h);
      ctx.font = '600 12px ui-monospace,Menlo,monospace';
      ctx.fillStyle = '#7FE0A8';
      ctx.fillText(text.primary, cx, cy - 1);
      ctx.font = '500 10px ui-monospace,Menlo,monospace';
      ctx.fillStyle = 'rgba(241,234,223,.75)';
      ctx.fillText(text.secondary, cx, cy + 12);
    }
    ctx.textAlign = 'left';
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
