// AUTO LAYOUT ENGINE v11 — PROPER HUG + SMART SIZING
// Goal: Real auto layout with correct HUG/FILL/FIXED per node,
// proper gaps, padding, alignment — same visual as original.

figma.showUI(__html__, { width: 380, height: 580, title: "Auto Layout Engine" });

figma.ui.onmessage = async (msg) => {
  try {
    if (msg.type === "preview") await runEngine(false);
    else if (msg.type === "export") await runEngine(true);
    else if (msg.type === "cancel") figma.closePlugin();
    else if (msg.type === "getSelection") sendSelectionInfo();
  } catch (e) { figma.ui.postMessage({ type: "error", text: String(e) }); }
};

figma.on("selectionchange", sendSelectionInfo);

function sendSelectionInfo() {
  try {
    const sel = figma.currentPage.selection;
    if (!sel.length) { figma.ui.postMessage({ type: "selection", hasSelection: false }); return; }
    const n = sel[0];
    figma.ui.postMessage({
      type: "selection", hasSelection: true,
      name: n.name, nodeType: n.type, w: Math.round(n.width), h: Math.round(n.height)
    });
  } catch (_) { }
}

const uiLog = t => { try { figma.ui.postMessage({ type: "log", text: t }); } catch (_) { } };
const uiProg = (p, l) => { try { figma.ui.postMessage({ type: "progress", pct: p, label: l }); } catch (_) { } };

function alive(n) { try { return n && !n.removed; } catch (_) { return false; } }

function getAbsPos(n) {
  try { const t = n.absoluteTransform; if (t) return { x: t[0][2], y: t[1][2] }; } catch (_) { }
  try { return { x: n.x, y: n.y }; } catch (_) { return { x: 0, y: 0 }; }
}

function collectPostOrder(root, pred) {
  const out = [];
  function walk(n) {
    try {
      if (!alive(n)) return;
      if ("children" in n && n.children) for (const c of Array.from(n.children)) { try { walk(c); } catch (_) { } }
      if (pred(n)) out.push(n);
    } catch (_) { }
  }
  walk(root);
  return out;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function runEngine(exportMode) {
  uiLog("Starting v11…"); uiProg(5, "Starting");
  let root;
  try {
    const sel = figma.currentPage.selection;
    if (!sel || !sel.length) { figma.ui.postMessage({ type: "error", text: "No frame selected." }); return; }
    root = sel[0];
    if (!["FRAME", "COMPONENT", "INSTANCE"].includes(root.type)) {
      figma.ui.postMessage({ type: "error", text: "Select a Frame/Component/Instance." }); return;
    }
  } catch (e) { figma.ui.postMessage({ type: "error", text: "Selection: " + e }); return; }

  let clone;
  try {
    clone = root.clone();
    clone.name = (exportMode ? "" : "🔍 Preview — ") + root.name + " [Auto Layout]";
    clone.x = root.x + root.width + 80;
    clone.y = root.y;
    figma.currentPage.appendChild(clone);
    uiLog("Cloned"); uiProg(12, "Cloned");
  } catch (e) { figma.ui.postMessage({ type: "error", text: "Clone: " + e }); return; }

  try { uiProg(20, "Detaching"); detachInstances(clone); } catch (e) { uiLog("Warn detach: " + e); }
  try { uiProg(30, "Converting groups"); convertGroups(clone); } catch (e) { uiLog("Warn groups: " + e); }
  try { uiProg(40, "Loading fonts"); await loadFonts(clone); } catch (e) { uiLog("Warn fonts: " + e); }

  // SNAPSHOT — ground truth positions before any AL
  const snap = new Map();
  try { uiProg(50, "Snapshotting"); snapshot(clone, snap); uiLog("Snap: " + snap.size + " nodes"); }
  catch (e) { figma.ui.postMessage({ type: "error", text: "Snapshot: " + e }); return; }

  // PASS 1: Apply AL + ABSOLUTE positioning (visual safety net)
  try { uiProg(60, "Applying Auto Layout"); applyALPass1(clone, snap); }
  catch (e) { figma.ui.postMessage({ type: "error", text: "AL Pass1: " + e }); return; }

  // PASS 2: Upgrade children from ABSOLUTE → AUTO with proper sizing
  try { uiProg(75, "Upgrading to proper AUTO flow"); applyALPass2(clone, snap); }
  catch (e) { uiLog("Warn pass2: " + e); }

  // PASS 3: Set correct HUG / FILL / FIXED sizing modes
  try { uiProg(88, "Setting HUG/FILL/FIXED"); applySizingModes(clone, snap); }
  catch (e) { uiLog("Warn sizing: " + e); }

  try { figma.currentPage.selection = [clone]; figma.viewport.scrollAndZoomIntoView([clone]); } catch (_) { }
  uiProg(100, exportMode ? "Export complete" : "Preview ready");
  uiLog(exportMode ? "✅ Export done." : "✅ Preview created — original untouched.");
  figma.ui.postMessage({ type: "done", mode: exportMode ? "export" : "preview" });
}

// ─── DETACH ───────────────────────────────────────────────────────────────────
function detachInstances(root) {
  const insts = collectPostOrder(root, n => n.type === "INSTANCE");
  for (const i of insts) { if (alive(i)) try { i.detachInstance(); } catch (_) { } }
  uiLog("Detached " + insts.length);
}

// ─── GROUPS → FRAMES ──────────────────────────────────────────────────────────
function convertGroups(root) {
  const groups = collectPostOrder(root, n => n.type === "GROUP");
  let c = 0;
  for (const grp of groups) {
    try {
      if (!alive(grp)) continue;
      const par = grp.parent;
      if (!par || !alive(par) || !("children" in par)) continue;
      const gAbs = getAbsPos(grp), pAbs = getAbsPos(par);
      const kids = Array.from(grp.children), kAbs = kids.map(k => getAbsPos(k));
      const gw = Math.max(grp.width, 1), gh = Math.max(grp.height, 1);
      const idx = Array.from(par.children).indexOf(grp);
      const fr = figma.createFrame();
      fr.name = grp.name;
      try { fr.fills = []; } catch (_) { } try { fr.strokes = []; } catch (_) { }
      try { fr.effects = []; } catch (_) { } try { fr.clipsContent = false; } catch (_) { }
      try { fr.layoutMode = "NONE"; } catch (_) { }
      ["opacity", "visible", "locked", "blendMode"].forEach(p => { try { fr[p] = grp[p]; } catch (_) { } });
      try { if (idx >= 0) par.insertChild(idx, fr); else par.appendChild(fr); }
      catch (_) { try { par.appendChild(fr); } catch (__) { try { fr.remove(); } catch (___) { } continue; } }
      try { fr.x = gAbs.x - pAbs.x; fr.y = gAbs.y - pAbs.y; } catch (_) { }
      try { fr.resize(gw, gh); } catch (_) { }
      const frAbs = getAbsPos(fr);
      for (let i = 0; i < kids.length; i++) {
        const k = kids[i]; if (!alive(k)) continue;
        try { fr.appendChild(k); k.x = kAbs[i].x - frAbs.x; k.y = kAbs[i].y - frAbs.y; } catch (_) { }
      }
      if (alive(grp) && grp.parent !== fr) try { grp.remove(); } catch (_) { }
      c++;
    } catch (_) { }
  }
  uiLog("Converted " + c + " groups");
}

// ─── FONTS ────────────────────────────────────────────────────────────────────
async function loadFonts(root) {
  const fonts = new Set();
  function walk(n) {
    try {
      if (!alive(n)) return;
      if (n.type === "TEXT") { try { n.getStyledTextSegments(["fontName"]).forEach(s => fonts.add(JSON.stringify(s.fontName))); } catch (_) { try { fonts.add(JSON.stringify(n.fontName)); } catch (__) { } } }
      if ("children" in n && n.children) for (const c of Array.from(n.children)) walk(c);
    } catch (_) { }
  }
  walk(root);
  for (const f of fonts) try { await figma.loadFontAsync(JSON.parse(f)); } catch (_) { }
}

// ─── SNAPSHOT ────────────────────────────────────────────────────────────────
function snapshot(root, map) {
  function walk(n) {
    try {
      if (!alive(n)) return;
      const a = getAbsPos(n);
      map.set(n.id, { ax: a.x, ay: a.y, w: n.width, h: n.height });
      if ("children" in n && n.children) for (const c of Array.from(n.children)) walk(c);
    } catch (_) { }
  }
  walk(root);
}

// ─── PASS 1: Apply layoutMode + ALL children ABSOLUTE ─────────────────────────
// This is the safety net — visual fidelity guaranteed before Pass 2 runs.
function applyALPass1(root, snap) {
  const containers = collectPostOrder(root, n =>
    alive(n) && "children" in n && n.type !== "GROUP" && n.type !== "PAGE"
  );
  let n = 0;
  for (const node of containers) {
    try {
      const ns = snap.get(node.id);
      if (!ns) continue;
      const kids = [];
      for (const k of Array.from(node.children)) {
        if (!alive(k)) continue;
        const ks = snap.get(k.id);
        if (!ks) continue;
        kids.push({ node: k, lx: ks.ax - ns.ax, ly: ks.ay - ns.ay, w: ks.w, h: ks.h });
      }
      if (!kids.length) continue;
      const dir = detectDir(kids);
      try {
        node.layoutMode = dir; node.primaryAxisSizingMode = "FIXED"; node.counterAxisSizingMode = "FIXED";
        node.primaryAxisAlignItems = "MIN"; node.counterAxisAlignItems = "MIN";
        node.itemSpacing = 0; node.paddingTop = 0; node.paddingBottom = 0; node.paddingLeft = 0; node.paddingRight = 0;
        node.clipsContent = false;
      } catch (_) { continue; }
      try { node.resize(Math.max(ns.w, 1), Math.max(ns.h, 1)); } catch (_) { }
      for (const k of kids) {
        if (!alive(k.node)) continue;
        try { k.node.layoutPositioning = "ABSOLUTE"; } catch (_) { continue; }
        try { k.node.x = Math.round(k.lx); k.node.y = Math.round(k.ly); } catch (_) { }
        try { k.node.resize(Math.max(k.w, 1), Math.max(k.h, 1)); } catch (_) { }
      }
      n++;
    } catch (_) { }
  }
  uiLog("Pass1: " + n + " containers");
}

// ─── PASS 2: Upgrade ABSOLUTE children → AUTO flow ────────────────────────────
// For each container, check if children form a clean 1D stack.
// If yes: set layoutPositioning=AUTO, set proper gap+padding.
// Children that don't fit (overlap etc) stay ABSOLUTE.
function applyALPass2(root, snap) {
  const containers = collectPostOrder(root, n =>
    alive(n) && "children" in n && n.layoutMode && n.layoutMode !== "NONE"
  );
  let upgraded = 0;
  for (const node of containers) {
    try {
      const ns = snap.get(node.id);
      if (!ns) continue;
      const kids = [];
      for (const k of Array.from(node.children)) {
        if (!alive(k)) continue;
        const ks = snap.get(k.id);
        if (!ks) continue;
        kids.push({ node: k, lx: ks.ax - ns.ax, ly: ks.ay - ns.ay, w: ks.w, h: ks.h });
      }
      if (kids.length < 2) continue;

      const dir = node.layoutMode; // already set in pass1

      // Separate overlapping (stay ABSOLUTE) from non-overlapping (candidates for AUTO)
      const { flow, abs } = separateFlowAbs(kids, dir);
      if (flow.length < 2) continue;

      // Validate monotonic order
      if (!isMonotonic(flow, dir)) continue;

      // Compute gap and padding
      const gap = computeGap(flow, dir);
      const padding = computePadding(ns, flow);
      const align = computeAlign(flow, dir);

      // Apply
      try {
        node.itemSpacing = Math.max(0, Math.round(gap));
        node.paddingTop = Math.max(0, Math.round(padding.top));
        node.paddingBottom = Math.max(0, Math.round(padding.bottom));
        node.paddingLeft = Math.max(0, Math.round(padding.left));
        node.paddingRight = Math.max(0, Math.round(padding.right));
        node.counterAxisAlignItems = align;
      } catch (_) { }

      // Restore size after padding change
      try { node.resize(Math.max(ns.w, 1), Math.max(ns.h, 1)); } catch (_) { }

      // Promote flow children to AUTO
      for (const item of flow) {
        if (!alive(item.node)) continue;
        try { item.node.layoutPositioning = "AUTO"; item.node.layoutGrow = 0; item.node.layoutAlign = "INHERIT"; } catch (_) { }
        try { item.node.resize(Math.max(item.w, 1), Math.max(item.h, 1)); } catch (_) { }
      }
      upgraded++;
    } catch (_) { }
  }
  uiLog("Pass2: " + upgraded + " upgraded to AUTO flow");
}

// ─── PASS 3: Set HUG / FILL / FIXED sizing ────────────────────────────────────
// Rules:
//   - Root container (parent = PAGE): always FIXED
//   - Child whose primary-axis size fills ≥88% of parent: FILL (layoutGrow=1)
//   - Child in AL parent, counter axis spans ≥88%: STRETCH
//   - Leaf containers (no AL children): HUG both axes
//   - Others: FIXED
function applySizingModes(root, snap) {
  // Post-order so children are sized before parents decide HUG
  const all = collectPostOrder(root, n =>
    alive(n) && "children" in n && n.layoutMode && n.layoutMode !== "NONE"
  );

  for (const node of all) {
    try {
      const ns = snap.get(node.id);
      if (!ns) continue;
      const isRootLevel = !node.parent || node.parent.type === "PAGE";

      if (isRootLevel) {
        try { node.primaryAxisSizingMode = "FIXED"; } catch (_) { }
        try { node.counterAxisSizingMode = "FIXED"; } catch (_) { }
        try { node.resize(Math.max(ns.w, 1), Math.max(ns.h, 1)); } catch (_) { }
        continue;
      }

      const par = node.parent;
      const parMode = (par && "layoutMode" in par) ? par.layoutMode : "NONE";

      // Has this container any AUTO-flow children?
      const hasAutoKids = Array.from(node.children).some(k => {
        try { return alive(k) && k.layoutPositioning === "AUTO"; } catch (_) { return false; }
      });

      if (parMode !== "NONE") {
        const isParH = par.layoutMode === "HORIZONTAL";
        const parPS = snap.get(par.id);
        const parPrimDim = parPS ? (isParH ? parPS.w : parPS.h) : 1;
        const myPrimDim = isParH ? ns.w : ns.h;
        const fillRatio = myPrimDim / Math.max(parPrimDim, 1);

        if (fillRatio >= 0.88) {
          try { node.layoutGrow = 1; } catch (_) { }
          try { node.layoutAlign = "STRETCH"; } catch (_) { }
        } else {
          try { node.layoutGrow = 0; } catch (_) { }
          try { node.layoutAlign = "INHERIT"; } catch (_) { }
        }
      }

      if (hasAutoKids) {
        // Container has real flow → HUG children
        try { node.primaryAxisSizingMode = "AUTO"; } catch (_) { try { node.primaryAxisSizingMode = "FIXED"; } catch (__) { } }
        try { node.counterAxisSizingMode = "AUTO"; } catch (_) { try { node.counterAxisSizingMode = "FIXED"; } catch (__) { } }
      } else {
        // No AUTO flow children (all ABSOLUTE) → FIXED
        try { node.primaryAxisSizingMode = "FIXED"; } catch (_) { }
        try { node.counterAxisSizingMode = "FIXED"; } catch (_) { }
        try { node.resize(Math.max(ns.w, 1), Math.max(ns.h, 1)); } catch (_) { }
      }
    } catch (_) { }
  }
  uiLog("Pass3: sizing modes applied");
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function detectDir(kids) {
  if (kids.length < 2) return "VERTICAL";
  const TOL = 8;
  const yB = countBands(kids.map(k => ({ s: k.ly, e: k.ly + k.h })), TOL);
  if (yB === 1) return "HORIZONTAL";
  const xB = countBands(kids.map(k => ({ s: k.lx, e: k.lx + k.w })), TOL);
  if (xB === 1) return "VERTICAL";
  const xs = kids.map(k => k.lx + k.w / 2), ys = kids.map(k => k.ly + k.h / 2);
  const xS = Math.max(...xs) - Math.min(...xs), yS = Math.max(...ys) - Math.min(...ys);
  return xS >= yS ? "HORIZONTAL" : "VERTICAL";
}

function countBands(ranges, tol) {
  if (!ranges.length) return 0;
  const s = [...ranges].sort((a, b) => a.s - b.s);
  let bands = 1, end = s[0].e;
  for (let i = 1; i < s.length; i++) {
    if (s[i].s > end + tol) { bands++; end = s[i].e; }
    else if (s[i].e > end) end = s[i].e;
  }
  return bands;
}

// Separate children into flow (non-overlapping along direction) and absolute (overlapping)
function separateFlowAbs(kids, dir) {
  // Mark any child that overlaps another
  const ol = new Array(kids.length).fill(false);
  for (let i = 0; i < kids.length; i++) {
    for (let j = 0; j < kids.length; j++) {
      if (i === j) continue;
      if (rectsOverlap(kids[i], kids[j], 2)) { ol[i] = true; break; }
    }
  }
  const flow = kids.filter((_, i) => !ol[i]);
  const abs = kids.filter((_, i) => ol[i]);

  // Additionally: if flow items don't form a single band in their cross axis, demote them
  if (flow.length >= 2) {
    const TOL = 10;
    if (dir === "HORIZONTAL") {
      const bands = countBands(flow.map(k => ({ s: k.ly, e: k.ly + k.h })), TOL);
      if (bands > 1) return { flow: [], abs: kids }; // multi-row → all absolute
    } else {
      const bands = countBands(flow.map(k => ({ s: k.lx, e: k.lx + k.w })), TOL);
      if (bands > 1) return { flow: [], abs: kids }; // multi-col → all absolute
    }
  }
  return { flow, abs };
}

function rectsOverlap(a, b, t) {
  return !(a.lx + a.w - t <= b.lx || b.lx + b.w - t <= a.lx || a.ly + a.h - t <= b.ly || b.ly + b.h - t <= a.ly);
}

function isMonotonic(items, dir) {
  const s = [...items].sort((a, b) => dir === "HORIZONTAL" ? a.lx - b.lx : a.ly - b.ly);
  for (let i = 1; i < s.length; i++) {
    const prev = s[i - 1], curr = s[i];
    const pEnd = dir === "HORIZONTAL" ? prev.lx + prev.w : prev.ly + prev.h;
    const cSt = dir === "HORIZONTAL" ? curr.lx : curr.ly;
    if (cSt < pEnd - 6) return false;
  }
  return true;
}

function computeGap(items, dir) {
  if (items.length < 2) return 0;
  const s = [...items].sort((a, b) => dir === "HORIZONTAL" ? a.lx - b.lx : a.ly - b.ly);
  let min = Infinity;
  for (let i = 1; i < s.length; i++) {
    const p = s[i - 1], c = s[i];
    const g = dir === "HORIZONTAL" ? c.lx - (p.lx + p.w) : c.ly - (p.ly + p.h);
    if (g >= 0 && g < min) min = g;
  }
  return min === Infinity ? 0 : min;
}

function computePadding(ns, items) {
  const minX = Math.min(...items.map(i => i.lx));
  const minY = Math.min(...items.map(i => i.ly));
  const maxX = Math.max(...items.map(i => i.lx + i.w));
  const maxY = Math.max(...items.map(i => i.ly + i.h));
  return {
    top: Math.max(0, minY),
    bottom: Math.max(0, ns.h - maxY),
    left: Math.max(0, minX),
    right: Math.max(0, ns.w - maxX),
  };
}

function computeAlign(items, dir) {
  const isH = dir === "HORIZONTAL";
  const starts = items.map(i => isH ? i.ly : i.lx);
  const ends = items.map(i => isH ? i.ly + i.h : i.lx + i.w);
  const centres = items.map(i => isH ? i.ly + i.h / 2 : i.lx + i.w / 2);
  const vari = arr => { const m = arr.reduce((s, v) => s + v, 0) / arr.length; return arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length; };
  const sv = vari(starts), ev = vari(ends), cv = vari(centres);
  const best = Math.min(sv, ev, cv);
  if (best > 16) return "MIN";
  if (best === cv) return "CENTER";
  if (best === sv) return "MIN";
  return "MAX";
}
