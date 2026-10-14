/* Reading geometry lives in the same sphere as the overview; shared knots
 * remain shared objects. This file is loaded after the main page script. */
let reading = null, readingReturn = null, overviewPositions = null;
const READING_STRAIGHTEN_MS = 900, READING_ENTER_MS = 1100;
// A positive wheel delta advances through the poem, like scrolling a page.
let readingScrollDirection = -1;

function capturePoints() {
  return allPoints.map(p => [p.x, p.y, p.z]);
}
function putPoints(values) {
  allPoints.forEach((p, i) => { [p.x, p.y, p.z] = values[i]; });
  layoutRevision++;
  needsRedraw = true;
  pickDirty = true;
}
function readingMetrics(si) {
  const x = Math.max(54, W * 0.24), textX = x + 30;
  const size = W < 640 ? 18 : 21, lineHeight = size * 1.65;
  const width = Math.max(80, W - textX - 32);
  const author = POEMS[si].author || "", authorSize = W < 640 ? 12 : 14, authorGap = 14;
  ctx.font = `${authorSize}px ${READING}`;
  const authorWidth = ctx.measureText(author).width;
  let offset = 0;
  const entries = strands[si].texts.map((text, i) => {
    ctx.font = `${i === 0 ? size + 8 : size}px ${i === 0 ? BRUSH : READING}`;
    const rowWidth = i === 0 && author ? Math.max(1, width - authorGap - authorWidth) : width;
    const rows = [];
    let row = "";
    for (const ch of text) {
      if (row && ctx.measureText(row + ch).width > rowWidth) { rows.push(row); row = ""; }
      row += ch;
    }
    if (row) rows.push(row);
    const entry = { offset, rows, height: Math.max(1, rows.length) * lineHeight };
    offset += entry.height + (i === 0 ? 42 : 30);
    return entry;
  });
  return { x, textX, size, lineHeight, entries, total: offset, author, authorSize, authorGap };
}
function sphereAtScreen(x, y, radius = 0.9) {
  return unproject(x, y).map(v => v * radius);
}
function beginStraightReading(si) {
  if (!overviewPositions) overviewPositions = capturePoints();
  if (!savedView) savedView = { ...view };
  setPhysicsPaused(true);
  camAnim = null;
  spin.yaw = spin.pitch = 0;
  dragging = false;
  canvas.classList.remove("dragging");
  readingReturn = null;
  reading = { si, started: performance.now(), from: capturePoints(),
    base: overviewPositions.map(p => [...p]), metrics: readingMetrics(si),
    scroll: 0, scrollTarget: 0, textAlpha: 0, related: new Set(), allowed: new Set(),
    nodes: strands[si].nodes.map(n => ({ ...n })) };
  focusStrand = si;
  lockedKnot = -1;
  knotTextHover = hoverStrand = hoverKnot = -1;
  titleAlpha = 0; titleTween = null; titleHoverKey = "";
  strands[si].nodes.forEach(n => {
    if (n.isKnot) n.strands.forEach(other => { if (other !== si) reading.related.add(other); });
  });
  needsRedraw = pickDirty = true;
}
function readingTargets(nodeTargets) {
  const r = reading, selected = strands[r.si];
  const anchors = new Map(), nearest = new Map();
  // One semantic knot can contain two different lines from this poem. Keep
  // every verse as a reading occurrence; attach the shared physical knot to
  // the occurrence nearest the viewport center while it passes through view.
  selected.nodes.forEach((n, i) => {
    const distance = Math.abs(H * .2 + r.metrics.entries[i].offset - r.scroll - H * .5);
    if (!nearest.has(n) || distance < nearest.get(n)) {
      nearest.set(n, distance); anchors.set(n, nodeTargets[i]);
    }
  });
  const targets = r.base.map(p => [...p]);
  // Displace each attached strand with its anchors. Interpolate between two
  // shared anchors and smoothly relax toward its original shape at the ends.
  for (const si of r.related) {
    const ns = strands[si].nodes;
    const attached = ns.flatMap((n, i) => anchors.has(n) ? [{ i, n }] : []);
    ns.forEach((n, i) => {
      if (anchors.has(n)) return;
      const left = attached.filter(a => a.i < i).at(-1);
      const right = attached.find(a => a.i > i);
      const blend = left && right ? (i - left.i) / (right.i - left.i) : 0;
      const delta = a => {
        const src = r.base[pointIndex.get(a.n)], dst = anchors.get(a.n);
        return dst.map((v, j) => v - src[j]);
      };
      let shift;
      if (left && right) { const a = delta(left), b = delta(right); shift = a.map((v, j) => lerp(v, b[j], blend)); }
      else { const a = left || right; const falloff = Math.exp(-Math.abs(i - a.i) / 5); shift = delta(a).map(v => v * falloff); }
      const id = pointIndex.get(n), src = r.base[id];
      const moved = src.map((v, j) => v + shift[j]);
      const radius = clamp(Math.hypot(...src), PHYSICS.R_IN, PHYSICS.R_OUT);
      const length = Math.hypot(...moved) || 1;
      targets[id] = moved.map(v => v / length * radius);
    });
  }
  for (const [n, target] of anchors) targets[pointIndex.get(n)] = target;
  return targets;
}
function tickStraightReading(now, dt) {
  if (readingReturn) {
    const transition = readingReturn;
    const t = clamp((now - transition.start) / (transition.duration || 700), 0, 1), e = easeInOut(t);
    putPoints(transition.from.map((p, i) => interpolateOnShell(p, transition.to[i], e)));
    if (transition.exitingReading) {
      transition.exitingReading.textAlpha = transition.textAlpha *
        (1 - easeInOut(clamp((now - transition.start) / 450, 0, 1)));
    }
    if (t === 1) {
      readingReturn = null; overviewPositions = null;
      if (transition.refitKnot && lockedKnot >= 0) {
        updateSamples();
        knotLayout = computeKnotView(lockedKnot);
        tweenViewTo(knotLayout.view, 250);
      }
    }
    return;
  }
  if (!reading) return;
  const r = reading, m = r.metrics, elapsed = now - r.started;
  const straighten = clamp(elapsed / READING_STRAIGHTEN_MS, 0, 1);
  const enter = clamp((elapsed - READING_STRAIGHTEN_MS) / READING_ENTER_MS, 0, 1);
  const previousScroll = r.scroll;
  r.scroll = lerp(r.scroll, r.scrollTarget, 1 - Math.exp(-dt / 110));
  if (Math.abs(r.scroll - r.scrollTarget) < 0.1) r.scroll = r.scrollTarget;
  const active = enter < 1 || r.lastEnter !== enter || previousScroll !== r.scroll || pickDirty;
  r.lastEnter = enter;
  r.textAlpha = easeInOut(enter);
  if (!active) return;
  const ns = strands[r.si].nodes;
  const finalTop = H * 0.2;
  const nodeTargets = ns.map((n, i) => {
    const scrolling = finalTop + m.entries[i].offset + r.scroll * readingScrollDirection;
    const entering = lerp(H + 70 + m.entries[i].offset, scrolling, easeInOut(enter));
    const y = entering;
    return sphereAtScreen(m.x, y);
  });
  const targets = readingTargets(nodeTargets);
  const e = easeInOut(straighten);
  r.nodes.forEach((n, i) => {
    const original = r.from[pointIndex.get(ns[i])], target = nodeTargets[i];
    const radius = lerp(Math.hypot(...original), .9, e);
    const mixed = original.map((v, j) => lerp(v, target[j], e));
    const length = Math.hypot(...mixed) || 1;
    [n.x, n.y, n.z] = mixed.map(v => v / length * radius);
  });
  // Interpolate on the shell rather than through the camera at the sphere center.
  putPoints(targets.map((p, i) => {
    const from = r.from[i], radius = lerp(Math.hypot(...from), Math.hypot(...p), e);
    const pos = from.map((v, j) => lerp(v, p[j], e)), length = Math.hypot(...pos) || 1;
    return pos.map(v => v / length * radius);
  }));
}
function stopStraightReading() {
  if (!overviewPositions) return;
  readingReturn = { from: capturePoints(), to: overviewPositions, start: performance.now() };
  reading = null;
}
function scrollReading(delta) {
  if (!reading || performance.now() - reading.started < READING_STRAIGHTEN_MS + READING_ENTER_MS) return;
  const max = Math.max(0, reading.metrics.total - H * 0.5);
  reading.scrollTarget = clamp(reading.scrollTarget + delta, 0, max);
  needsRedraw = true;
}
function readingAllowedStrands() {
  if (!reading) return null;
  const allowed = new Set();
  for (const n of strands[reading.si].nodes) {
    if (!n.isKnot || !n.onScreen || n.sy < 70 || n.sy > H - 30) continue;
    for (const si of n.strands) if (si !== reading.si) allowed.add(si);
  }
  reading.allowed = allowed;
  return allowed;
}
function drawStraightPoem(r = reading) {
  if (!r || r.textAlpha <= 0) return;
  const m = r.metrics, s = strands[r.si];
  ctx.save();
  ctx.globalAlpha = r.textAlpha;
  ctx.textAlign = "left"; ctx.textBaseline = "top";
  r.nodes.forEach((n, i) => {
    // Text follows the actual 3D point, never an independent scroll overlay.
    // Text blocks may still be visible when their anchor is outside the
    // camera's line culling cone. Project without that cone, then let the
    // canvas clip glyphs at the actual screen edge.
    const cz = n.x * cam.fx + n.y * cam.fy + n.z * cam.fz;
    if (cz <= 0) return;
    const px = W / 2 + cam.F * (n.x * cam.rx + n.z * cam.rz) / cz;
    const py = H / 2 - cam.F * (n.x * cam.ux + n.y * cam.uy + n.z * cam.uz) / cz;
    if (py + m.entries[i].height < 0 || py > H) return;
    ctx.font = `${i === 0 ? m.size + 8 : m.size}px ${i === 0 ? BRUSH : READING}`;
    ctx.fillStyle = "#202020";
    m.entries[i].rows.forEach((row, j) => ctx.fillText(row, px + 30, py + j * m.lineHeight));
    if (i === 0 && m.author) {
      const last = m.entries[0].rows.length - 1;
      const titleWidth = ctx.measureText(m.entries[0].rows[last]).width;
      placeReadingAuthor(r, px + 30 + titleWidth + m.authorGap,
        py + last * m.lineHeight + (m.size + 8 - m.authorSize) * .75);
    }

  });
  ctx.restore();
}



// Restore the original spherical network while the existing knot camera moves
// into place. No DOM panel or separate node UI is introduced.
function interpolateOnShell(from, to, t) {
  if (t <= 0) return [...from];
  if (t >= 1) return [...to];
  const ra = Math.hypot(...from), rb = Math.hypot(...to);
  if (ra < 1e-9 || rb < 1e-9) return from.map((v, i) => lerp(v, to[i], t));
  const a = from.map(v => v / ra), b = to.map(v => v / rb);
  const dot = clamp(a.reduce((sum, v, i) => sum + v * b[i], 0), -1, 1);
  const angle = Math.acos(dot), sin = Math.sin(angle), radius = lerp(ra, rb, t);
  if (angle < 1e-6) return a.map(v => v * radius);
  let tangent;
  if (Math.abs(sin) > 1e-6) tangent = b.map((v, i) => (v - dot * a[i]) / sin);
  else {
    const axis = Math.abs(a[0]) < .8 ? [1, 0, 0] : [0, 1, 0];
    const projection = axis.reduce((sum, v, i) => sum + v * a[i], 0);
    tangent = axis.map((v, i) => v - projection * a[i]);
    const length = Math.hypot(...tangent);
    tangent = tangent.map(v => v / length);
  }
  return a.map((v, i) => radius * (v * Math.cos(angle * t) + tangent[i] * Math.sin(angle * t)));
}
function transitionReadingToKnot(ki) {
  if (!reading || !strands[reading.si].nodes.includes(knots[ki])) return;
  const exiting = reading;
  stopStraightReading();
  readingReturn.duration = 900;
  readingReturn.exitingReading = { ...exiting, nodes: strands[exiting.si].nodes };
  readingReturn.textAlpha = exiting.textAlpha;
  focusStrand = -1;
  lockedKnot = ki;
  knotTextHover = hoverStrand = hoverKnot = -1;
  knotTextLevel = 0;
  titleAlpha = 0; titleTween = null; titleHoverKey = "";
  // Compute framing with the restored network; immediately put the animated
  // start back before drawing any frame, so there is no coordinate flash.
  putPoints(readingReturn.to);
  updateSamples();
  knotLayout = computeKnotView(ki);
  putPoints(readingReturn.from);
  updateSamples();
  tweenViewTo(knotLayout.view, readingReturn.duration);
  needsRedraw = pickDirty = true;
}


// Native links follow the same title point, scrolling and fading with it.
function placeReadingAuthor(r, x, y) {
  const element = document.getElementById("readingAuthor"), m = r.metrics;
  const url = typeof AUTHORS === "undefined" ? null : AUTHORS[m.author]?.wikipedia_url;
  const key = m.author + "|" + (url || "");
  if (element.dataset.authorKey !== key) {
    const name = document.createElement(url ? "a" : "span");
    name.textContent = m.author;
    if (url) {
      name.href = url;
      name.target = "_blank";
      name.rel = "noopener noreferrer";
      name.setAttribute("aria-label", `${m.author}（维基百科）`);
    }
    element.replaceChildren(name);
    element.dataset.authorKey = key;
  }
  element.hidden = false;
  element.style.left = `${x}px`; element.style.top = `${y}px`;
  element.style.fontSize = `${m.authorSize}px`;
  element.style.opacity = r.textAlpha;
  const link = element.querySelector("a");
  if (link) {
    const interactive = r === reading && r.textAlpha > .2 && y + m.authorSize > 0 && y < H;
    link.style.pointerEvents = interactive ? "auto" : "none";
    link.tabIndex = interactive ? 0 : -1;
  }
}
