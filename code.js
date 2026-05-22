// ============================================================
//  SMART AUTO LAYOUT RECONSTRUCTION ENGINE  —  code.js  v4
//  Strategy: PRESERVE original child order — never sort/reorder
//  children. Measure gaps from actual positions in original order.
// ============================================================

figma.showUI(__html__, { width: 380, height: 560, title: "Auto Layout Engine" });

// ─────────────────────────────────────────────────────────────
//  Message router
// ─────────────────────────────────────────────────────────────
figma.ui.onmessage = async (msg) => {
  if (msg.type === "preview") await runEngine(false);
  else if (msg.type === "export") await runEngine(true);
  else if (msg.type === "cancel") figma.closePlugin();
  else if (msg.type === "getSelection") sendSelectionInfo();
};

figma.on("selectionchange", sendSelectionInfo);

function sendSelectionInfo() {
  const sel = figma.currentPage.selection;
  if (!sel.length) {
    figma.ui.postMessage({ type: "selection", hasSelection: false });
    return;
  }
  const node = sel[0];
  figma.ui.postMessage({
    type: "selection",
    hasSelection: true,
    name: node.name,
    nodeType: node.type,
    w: Math.round(node.width),
    h: Math.round(node.height),
  });
}

function log(text) { figma.ui.postMessage({ type: "log", text }); }
function progress(pct, label) { figma.ui.postMessage({ type: "progress", pct, label }); }

function isGone(node) {
  try { return node.removed; } catch (_) { return true; }
}

// ─────────────────────────────────────────────────────────────
//  Collect all nodes post-order (leaves before parents)
// ─────────────────────────────────────────────────────────────
function collectPostOrder(root, predicate) {
  const result = [];
  function walk(node) {
    if (isGone(node)) return;
    if ("children" in node) {
      for (const child of [...node.children]) walk(child);
    }
    if (predicate(node)) result.push(node);
  }
  walk(root);
  return result;
}

// ─────────────────────────────────────────────────────────────
//  absoluteTransform → canvas {x, y}
// ─────────────────────────────────────────────────────────────
function absPos(node) {
  try {
    const t = node.absoluteTransform;
    return { x: t[0][2], y: t[1][2] };
  } catch (_) {
    return { x: node.x, y: node.y };
  }
}

// ─────────────────────────────────────────────────────────────
//  ENTRY POINT
// ─────────────────────────────────────────────────────────────
async function runEngine(exportMode) {
  const sel = figma.currentPage.selection;
  if (!sel.length) {
    figma.ui.postMessage({ type: "error", text: "No frame selected. Select a frame first." });
    return;
  }
  const root = sel[0];
  if (root.type !== "FRAME" && root.type !== "COMPONENT" && root.type !== "INSTANCE") {
    figma.ui.postMessage({ type: "error", text: "Please select a Frame, Component, or Instance." });
    return;
  }

  log("Starting reconstruction…");
  progress(5, "Cloning frame");

  try {
    const clone = root.clone();
    clone.name = (exportMode ? "" : "🔍 Preview — ") + root.name + " [Auto Layout]";
    clone.x = root.x + root.width + 80;
    clone.y = root.y;
    figma.currentPage.appendChild(clone);

    progress(10, "Detaching instances");
    safeDetachAllInstances(clone);

    progress(20, "Converting groups → frames");
    safeConvertGroupsToFrames(clone);

    progress(35, "Loading fonts");
    await preloadFonts(clone);

    progress(50, "Applying Auto Layout");
    applyAutoLayoutTree(clone);

    progress(80, "Finalising sizing");
    finaliseSizing(clone);

    figma.currentPage.selection = [clone];
    figma.viewport.scrollAndZoomIntoView([clone]);

    progress(100, exportMode ? "Export complete" : "Preview ready");
    log(exportMode ? "✅ Export placed on canvas." : "✅ Preview created — original untouched.");
    figma.ui.postMessage({ type: "done", mode: exportMode ? "export" : "preview" });

  } catch (err) {
    figma.ui.postMessage({ type: "error", text: String(err) });
    console.error(err);
  }
}

// ─────────────────────────────────────────────────────────────
//  Detach instances — deepest first
// ─────────────────────────────────────────────────────────────
function safeDetachAllInstances(root) {
  const instances = collectPostOrder(root, n => n.type === "INSTANCE");
  for (const inst of instances) {
    if (isGone(inst)) continue;
    try { inst.detachInstance(); } catch (_) { }
  }
}

// ─────────────────────────────────────────────────────────────
//  Convert GROUP → FRAME (post-order, coordinate-safe)
//
//  CRITICAL RULES:
//  1. Snapshot absoluteTransform of group AND all children
//     BEFORE touching the DOM.
//  2. Insert new frame into parent using group-relative LOCAL
//     coords (absGroup - absParent), not group.x/group.y
//     (those can be wrong if parent has a transform).
//  3. After frame is in the tree, read its absoluteTransform
//     as the authoritative origin for child positioning.
//  4. Only remove group if it's still alive and not already
//     a descendant of the new frame.
// ─────────────────────────────────────────────────────────────
function safeConvertGroupsToFrames(root) {
  const groups = collectPostOrder(root, n => n.type === "GROUP");

  for (const group of groups) {
    if (isGone(group)) continue;

    const parent = group.parent;
    if (!parent || isGone(parent) || !("children" in parent)) continue;

    // Snapshot positions BEFORE any DOM change
    const groupAbs = absPos(group);
    const parentAbs = absPos(parent);

    const childSnapshots = [];
    for (const child of [...group.children]) {
      if (isGone(child)) continue;
      childSnapshots.push({ node: child, abs: absPos(child) });
    }

    const stackIdx = parent.children.indexOf(group);
    if (stackIdx === -1) continue;

    // Build the replacement frame (transparent, no clip)
    const frame = figma.createFrame();
    frame.name = group.name;
    frame.fills = [];
    frame.strokes = [];
    frame.effects = [];
    frame.clipsContent = false;
    frame.layoutMode = "NONE";
    try { frame.opacity = group.opacity; } catch (_) { }
    try { frame.visible = group.visible; } catch (_) { }
    try { frame.locked = group.locked; } catch (_) { }
    try { frame.blendMode = group.blendMode; } catch (_) { }

    const gw = Math.max(group.width, 1);
    const gh = Math.max(group.height, 1);

    // Insert frame at same stacking index
    try { parent.insertChild(stackIdx, frame); }
    catch (_) { try { parent.appendChild(frame); } catch (__) { continue; } }

    // Position frame in LOCAL space of parent
    frame.x = groupAbs.x - parentAbs.x;
    frame.y = groupAbs.y - parentAbs.y;
    try { frame.resize(gw, gh); } catch (_) { }

    // Now read frame's actual absolute position (authoritative origin)
    const frameAbs = absPos(frame);

    // Move each child into the frame, correcting for the new origin
    for (const { node: child, abs: childAbs } of childSnapshots) {
      if (isGone(child)) continue;
      try {
        frame.appendChild(child);
        child.x = childAbs.x - frameAbs.x;
        child.y = childAbs.y - frameAbs.y;
      } catch (e) {
        log("⚠️ Skipped child '" + child.name + "': " + e);
      }
    }

    // Remove old group (only if it's still alive and outside the new frame)
    if (!isGone(group) && group.parent !== frame) {
      try { group.remove(); } catch (_) { }
    }
  }
}

// ─────────────────────────────────────────────────────────────
//  Load fonts
// ─────────────────────────────────────────────────────────────
async function preloadFonts(root) {
  const fontSet = new Set();
  collectFonts(root, fontSet);
  for (const f of fontSet) {
    try { await figma.loadFontAsync(JSON.parse(f)); } catch (_) { }
  }
}
function collectFonts(node, set) {
  if (isGone(node)) return;
  if (node.type === "TEXT") {
    try {
      for (const seg of node.getStyledTextSegments(["fontName"]))
        set.add(JSON.stringify(seg.fontName));
    } catch (_) {
      try { set.add(JSON.stringify(node.fontName)); } catch (__) { }
    }
  }
  if ("children" in node) {
    for (const c of node.children) collectFonts(c, set);
  }
}

// ─────────────────────────────────────────────────────────────
//  Apply Auto Layout — POST-ORDER so children get AL before
//  their parents try to measure them.
//
//  KEY DESIGN DECISIONS:
//  • NEVER reorder children — Figma's AL uses document order,
//    which already matches the visual stacking from the original.
//  • Detect direction from the ACTUAL positions of children
//    in their ORIGINAL order (not sorted).
//  • ONLY apply AL when children clearly form a 1D stack
//    (horizontal or vertical) with no significant cross-axis
//    variance that would indicate a 2D/grid layout.
//  • Overlapping children → ABSOLUTE positioning.
//  • The gap used is the MINIMUM gap between consecutive
//    children (most conservative — avoids shrinking spacing).
// ─────────────────────────────────────────────────────────────
function applyAutoLayoutTree(root) {
  const containers = collectPostOrder(
    root,
    n => "children" in n && n.type !== "GROUP"
  );
  for (const node of containers) {
    if (isGone(node)) continue;
    if (node.visible === false) continue;
    tryApplyAutoLayout(node);
  }
}

function tryApplyAutoLayout(node) {
  if (isGone(node)) return;

  // Get visible, live children IN DOCUMENT ORDER (do not sort)
  const allChildren = [...node.children].filter(
    c => !isGone(c) && c.visible !== false
  );
  if (allChildren.length < 2) return;

  // Split into flow children and absolute (overlapping) children
  const { flow, absolute } = classifyChildren(allChildren);
  if (flow.length < 2) {
    // Everything overlaps — leave as-is (no AL needed)
    return;
  }

  // Determine direction from flow children (in document order)
  const dir = detectDirection(flow);
  if (!dir) return;

  // Validate: the flow children must actually be arranged along
  // that axis consistently (no zigzag). If they're not clean,
  // skip rather than produce a broken layout.
  if (!isCleanStack(flow, dir)) return;

  // Measure gap and padding from original positions (doc order)
  const gap = measureGap(flow, dir);
  const padding = measurePadding(node, flow);

  // Snapshot size before AL reflowing the container
  const prevW = node.width;
  const prevH = node.height;

  // Apply Auto Layout
  try {
    node.layoutMode = dir;
    node.itemSpacing = Math.max(0, Math.round(gap));
    node.paddingTop = Math.max(0, Math.round(padding.top));
    node.paddingBottom = Math.max(0, Math.round(padding.bottom));
    node.paddingLeft = Math.max(0, Math.round(padding.left));
    node.paddingRight = Math.max(0, Math.round(padding.right));
    node.primaryAxisSizingMode = "FIXED";
    node.counterAxisSizingMode = "FIXED";
    node.primaryAxisAlignItems = "MIN";
    node.counterAxisAlignItems = "MIN";
    node.clipsContent = false;
  } catch (e) {
    log("⚠️ Could not apply AL to '" + node.name + "': " + e);
    return;
  }

  // Lock dimensions to original visual size
  try { node.resize(Math.max(prevW, 1), Math.max(prevH, 1)); } catch (_) { }

  // Overlapping children → ABSOLUTE
  for (const ov of absolute) {
    if (isGone(ov)) continue;
    try { ov.layoutPositioning = "ABSOLUTE"; } catch (_) { }
  }

  // Flow children → AUTO (normal AL flow)
  for (const child of flow) {
    if (isGone(child)) continue;
    try {
      child.layoutPositioning = "AUTO";
      child.layoutGrow = 0;
      child.layoutAlign = "INHERIT";
    } catch (_) { }
  }
}

// ─────────────────────────────────────────────────────────────
//  Classify children: flow (no overlap) vs absolute (overlapping)
// ─────────────────────────────────────────────────────────────
function classifyChildren(children) {
  // Build overlap map
  const overlapsWithAnother = new Array(children.length).fill(false);
  for (let i = 0; i < children.length; i++) {
    for (let j = 0; j < children.length; j++) {
      if (i === j) continue;
      if (boxesOverlap(children[i], children[j])) {
        overlapsWithAnother[i] = true;
        break;
      }
    }
  }

  const flow = [];
  const absolute = [];
  for (let i = 0; i < children.length; i++) {
    (overlapsWithAnother[i] ? absolute : flow).push(children[i]);
  }

  // Edge case: all overlap → treat largest as single flow element
  if (flow.length === 0 && absolute.length > 1) {
    let largestIdx = 0;
    let largestArea = 0;
    for (let i = 0; i < absolute.length; i++) {
      const area = absolute[i].width * absolute[i].height;
      if (area > largestArea) { largestArea = area; largestIdx = i; }
    }
    flow.push(absolute[largestIdx]);
    absolute.splice(largestIdx, 1);
  }

  return { flow, absolute };
}

function boxesOverlap(a, b) {
  const T = 3; // px tolerance
  return !(
    a.x + a.width - T <= b.x ||
    b.x + b.width - T <= a.x ||
    a.y + a.height - T <= b.y ||
    b.y + b.height - T <= a.y
  );
}

// ─────────────────────────────────────────────────────────────
//  Detect direction (HORIZONTAL or VERTICAL) from child positions
//  Uses children IN DOCUMENT ORDER — no sorting.
// ─────────────────────────────────────────────────────────────
function detectDirection(children) {
  if (children.length < 2) return null;

  // Centres on each axis
  const xCentres = children.map(c => c.x + c.width / 2);
  const yCentres = children.map(c => c.y + c.height / 2);

  const xVar = calcVariance(xCentres);
  const yVar = calcVariance(yCentres);

  // Low Y-centre variance → items share a horizontal band → HORIZONTAL
  // Low X-centre variance → items share a vertical column → VERTICAL
  // Use a threshold relative to the container spread
  const xSpread = Math.max(...children.map(c => c.x + c.width)) - Math.min(...children.map(c => c.x));
  const ySpread = Math.max(...children.map(c => c.y + c.height)) - Math.min(...children.map(c => c.y));

  // Normalise variance by spread² to get a relative measure
  const xNorm = xSpread > 0 ? xVar / (xSpread * xSpread) : 1;
  const yNorm = ySpread > 0 ? yVar / (ySpread * ySpread) : 1;

  if (yNorm < 0.05 && ySpread < xSpread * 0.5) return "HORIZONTAL";
  if (xNorm < 0.05 && xSpread < ySpread * 0.5) return "VERTICAL";

  // Fallback: dominant axis
  if (ySpread > xSpread * 1.3) return "VERTICAL";
  if (xSpread > ySpread * 1.3) return "HORIZONTAL";

  return "VERTICAL"; // safe default
}

function calcVariance(arr) {
  if (!arr.length) return 0;
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  return arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
}

// ─────────────────────────────────────────────────────────────
//  Validate that flow children form a clean 1-D stack
//  (no large cross-axis jumps that indicate a 2-D grid)
// ─────────────────────────────────────────────────────────────
function isCleanStack(children, dir) {
  if (children.length < 2) return true;

  if (dir === "VERTICAL") {
    // Each child should start below (or at) the previous one
    for (let i = 1; i < children.length; i++) {
      if (children[i].y < children[i - 1].y - 4) return false;
    }
  } else {
    for (let i = 1; i < children.length; i++) {
      if (children[i].x < children[i - 1].x - 4) return false;
    }
  }
  return true;
}

// ─────────────────────────────────────────────────────────────
//  Measure gap — minimum gap between consecutive children
//  in DOCUMENT ORDER (preserves original spacing intent)
// ─────────────────────────────────────────────────────────────
function measureGap(children, dir) {
  if (children.length < 2) return 0;

  // Sort ONLY for gap measurement (not for rearranging)
  const sorted = [...children].sort((a, b) =>
    dir === "HORIZONTAL" ? a.x - b.x : a.y - b.y
  );

  let minGap = Infinity;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const g = dir === "HORIZONTAL"
      ? curr.x - (prev.x + prev.width)
      : curr.y - (prev.y + prev.height);
    if (g >= 0 && g < minGap) minGap = g;
  }

  return minGap === Infinity ? 0 : minGap;
}

// ─────────────────────────────────────────────────────────────
//  Measure padding — distance from container edges to the
//  bounding box of ALL flow children combined
// ─────────────────────────────────────────────────────────────
function measurePadding(container, flowChildren) {
  if (!flowChildren.length) return { top: 0, bottom: 0, left: 0, right: 0 };

  const minX = Math.min(...flowChildren.map(c => c.x));
  const minY = Math.min(...flowChildren.map(c => c.y));
  const maxX = Math.max(...flowChildren.map(c => c.x + c.width));
  const maxY = Math.max(...flowChildren.map(c => c.y + c.height));

  return {
    top: Math.max(0, minY),
    bottom: Math.max(0, container.height - maxY),
    left: Math.max(0, minX),
    right: Math.max(0, container.width - maxX),
  };
}

// ─────────────────────────────────────────────────────────────
//  Finalise sizing — HUG / FILL / FIXED
// ─────────────────────────────────────────────────────────────
function finaliseSizing(node) {
  if (isGone(node) || !("children" in node)) return;
  for (const child of [...node.children]) finaliseSizing(child);
  if (node.layoutMode === "NONE") return;

  // Root of reconstruction → always FIXED
  if (!node.parent || node.parent.type === "PAGE") {
    try { node.primaryAxisSizingMode = "FIXED"; } catch (_) { }
    try { node.counterAxisSizingMode = "FIXED"; } catch (_) { }
    return;
  }

  // Inside an AL parent: FILL when spanning ≥ 85% of parent on primary axis
  const parentMode = ("layoutMode" in node.parent) ? node.parent.layoutMode : "NONE";
  if (parentMode !== "NONE") {
    try {
      const isH = node.layoutMode === "HORIZONTAL";
      const ratio = isH
        ? node.width / node.parent.width
        : node.height / node.parent.height;
      node.layoutGrow = ratio > 0.85 ? 1 : 0;
      node.layoutAlign = ratio > 0.85 ? "STRETCH" : "INHERIT";
    } catch (_) { }
  }

  // Try HUG both axes; fall back to FIXED on error
  try { node.primaryAxisSizingMode = "AUTO"; }
  catch (_) { try { node.primaryAxisSizingMode = "FIXED"; } catch (__) { } }
  try { node.counterAxisSizingMode = "AUTO"; }
  catch (_) { try { node.counterAxisSizingMode = "FIXED"; } catch (__) { } }
}
