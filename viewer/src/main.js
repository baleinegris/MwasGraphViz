import Graph from "graphology";
import Sigma from "sigma";
import forceAtlas2 from "graphology-layout-forceatlas2";

// ── palette ──────────────────────────────────────────────────────────────────
const PALETTE = [
  "#e41a1c","#377eb8","#4daf4a","#984ea3","#ff7f00",
  "#a65628","#f781bf","#17becf","#bcbd22","#2ca02c",
  "#d62728","#9467bd","#8c564b","#e377c2","#7f7f7f",
  "#1f77b4","#aec7e8","#ffbb78","#98df8a","#ff9896",
];

function clusterColor(clusterId) {
  return PALETTE[clusterId % PALETTE.length];
}

// sequential scale for -log10(p), dim at p = 1 so significant findings stand out on the dark background
const PVALUE_STOPS = ["#3a4466", "#6a4c9c", "#c2457f", "#f07f3c", "#f9e65c"];

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// colour at position t in [0, 1] along evenly spaced stops
function interpolateStops(stops, t) {
  const pos = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(Math.floor(pos), stops.length - 2);
  const a = hexToRgb(stops[i]);
  const b = hexToRgb(stops[i + 1]);
  const f = pos - i;
  const rgb = a.map((v, k) => Math.round(v + (b[k] - v) * f));
  return `rgb(${rgb.join(",")})`;
}

function pvalueColor(pvalue, maxLogP) {
  return interpolateStops(PVALUE_STOPS, -Math.log10(Math.max(pvalue, 1e-300)) / maxLogP);
}

// diverging scale for Cohen's d, blue when the group with the attributes has less totiviridae and red when it
// has more, dim near zero
const EFFECT_STOPS = ["#3d7bff", "#6f8fd6", "#4a4e63", "#d9765f", "#ff3d30"];

// fixed rather than taken from the data, groups with near zero variance give |d| up to ~1e15,
// and |d| >= 2 is already a very large effect
const EFFECT_MAX = 2;

function effectColor(d) {
  return interpolateStops(EFFECT_STOPS, (d / EFFECT_MAX + 1) / 2);
}

// top of the p-value scale, the 99th percentile of -log10(p) so a few extreme values don't wash out the rest
function pvalueScaleMax(graph) {
  const logPs = graph.nodes()
    .map(n => graph.getNodeAttribute(n, "pvalue"))
    .filter(p => p != null)
    .map(p => -Math.log10(Math.max(p, 1e-300)))
    .sort((a, b) => a - b);
  if (!logPs.length) return null;
  return Math.max(1, Math.ceil(logPs[Math.floor(0.99 * (logPs.length - 1))]));
}

// ── CSV parser ────────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split("\n");
  const headers = lines[0].split(",").map(h => h.trim());
  return lines.slice(1).map(line => {
    const vals = line.split(",");
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] ?? "").trim(); });
    return obj;
  });
}

// ── load ──────────────────────────────────────────────────────────────────────
// cluster_info.json is optional, the dev server answers a missing file with index.html, so a failed parse means none
async function loadClusterInfo(base) {
  try {
    const r = await fetch(base + "cluster_info.json");
    return r.ok ? await r.json() : {};
  } catch {
    return {};
  }
}

async function loadData(name) {
  const base = import.meta.env.BASE_URL + `data/${name}/`;
  const [edgesText, clustersText, clusterInfo] = await Promise.all([
    fetch(base + "edges.csv").then(r => r.text()),
    fetch(base + "clusters.csv").then(r => r.text()),
    loadClusterInfo(base),
  ]);
  return {
    edges: parseCSV(edgesText),
    clusters: parseCSV(clustersText),
    clusterInfo,
  };
}

// ── text rendering ────────────────────────────────────────────────────────────
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// the hypotheses are LLM markdown, render bold, headings and paragraphs, and escape everything else
function renderHypothesis(text) {
  return escapeHtml(text)
    .split(/\n{2,}/)
    .map(para => para
      .replace(/^#+\s*(.*)$/gm, "<strong>$1</strong>")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\n/g, "<br>"))
    .map(para => `<p>${para}</p>`)
    .join("");
}

function formatP(p) {
  return p == null ? "–" : p.toPrecision(2);
}

// ── build graph ───────────────────────────────────────────────────────────────
function buildGraph(edges, clusters, clusterInfo) {
  const graph = new Graph({ multi: false, type: "undirected" });

  const clusterMap = {};
  const pvalueMap = {};
  const effectMap = {};
  for (const { name, cluster_id, pvalue, cohens_d } of clusters) {
    clusterMap[name] = parseInt(cluster_id, 10);
    // pvalue and cohens_d are optional columns, datasets without them can only be coloured by cluster
    const p = parseFloat(pvalue);
    if (!Number.isNaN(p)) pvalueMap[name] = p;
    const d = parseFloat(cohens_d);
    if (!Number.isNaN(d)) effectMap[name] = d;
  }

  // Collect all nodes that appear in edges
  const nodeNames = new Set();
  for (const { name1, name2 } of edges) {
    nodeNames.add(name1);
    nodeNames.add(name2);
  }

  // Also include all cluster nodes (isolated nodes get no edges but are in the data)
  for (const { name } of clusters) {
    nodeNames.add(name);
  }

  for (const name of nodeNames) {
    const clusterId = clusterMap[name] ?? -1;
    const color = clusterColor(clusterId === -1 ? 19 : clusterId);
    graph.addNode(name, {
      label: name,
      size: 5,
      color,
      clusterColor: color,
      pvalue: pvalueMap[name] ?? null,
      significant: clusterInfo[clusterId]?.significant === true,
      cohensD: effectMap[name] ?? null,
      cluster: clusterId,
      x: Math.random() * 1000,
      y: Math.random() * 1000,
    });
  }

  for (const { name1, name2, score, false_positive } of edges) {
    if (name1 === name2) continue;
    const s = parseFloat(score);
    const isFP = false_positive === "1";
    if (!graph.hasEdge(name1, name2)) {
      graph.addEdge(name1, name2, {
        weight: s,
        falsePositive: isFP,
        size: Math.max(0.5, s * 3),
        color: isFP
          ? `rgba(220,50,50,${Math.max(0.4, s * 0.8)})`
          : `rgba(120,140,180,${Math.max(0.15, s * 0.6)})`,
      });
    }
  }

  return graph;
}

// ── layout ────────────────────────────────────────────────────────────────────
function setMsg(msg) {
  document.getElementById("loading-msg").textContent = msg;
}

function runLayout(graph) {
  graph.nodes().forEach(n => {
    graph.setNodeAttribute(n, "size", 5);
  });

  const settings = forceAtlas2.inferSettings(graph);
  settings.gravity = 0.05;
  settings.scalingRatio = 8;
  settings.strongGravityMode = false;

  forceAtlas2.assign(graph, { iterations: 300, settings });
}

// ── legend ────────────────────────────────────────────────────────────────────
function buildLegend(clusters, sigmaInstance, graph, clusterInfo) {
  const counts = {};
  for (const { cluster_id } of clusters) {
    if (significantOnly && !clusterInfo[cluster_id]?.significant) continue;
    counts[cluster_id] = (counts[cluster_id] || 0) + 1;
  }

  // when filtering, list the most significant clusters first, otherwise the largest
  const sorted = Object.entries(counts).sort((a, b) => significantOnly
    ? (clusterInfo[a[0]]?.pvalue ?? 1) - (clusterInfo[b[0]]?.pvalue ?? 1)
    : b[1] - a[1]);
  const container = document.getElementById("legend-items");
  container.innerHTML = "";

  for (const [cid, count] of sorted.slice(0, 30)) {
    const id = parseInt(cid, 10);
    const info = clusterInfo[cid];
    const arrow = info?.significant ? (info.direction === "higher" ? " ↑" : " ↓") : "";
    const div = document.createElement("div");
    div.className = "legend-item";
    div.innerHTML = `<div class="legend-dot" style="background:${clusterColor(id)}"></div>
      <span>Cluster ${id} (${count})${arrow}</span>`;
    div.addEventListener("click", () => {
      highlightCluster(id, sigmaInstance, graph);
      showClusterInfo(id, clusterInfo);
    });
    container.appendChild(div);
  }

  if (sorted.length > 30) {
    const more = document.createElement("div");
    more.style.cssText = "font-size:11px;color:#555;padding:4px 4px;";
    more.textContent = `+ ${sorted.length - 30} more clusters`;
    container.appendChild(more);
  }
}

// ── highlight cluster ─────────────────────────────────────────────────────────
function highlightCluster(clusterId, sigmaInstance, graph) {
  sigmaInstance.setSetting("nodeReducer", (node, data) => {
    if (graph.getNodeAttribute(node, "cluster") === clusterId) {
      return { ...data, highlighted: true };
    }
    return { ...data, color: "#222", label: undefined };
  });
  sigmaInstance.setSetting("edgeReducer", (edge, data) => {
    const src = graph.source(edge);
    const tgt = graph.target(edge);
    if (
      graph.getNodeAttribute(src, "cluster") === clusterId &&
      graph.getNodeAttribute(tgt, "cluster") === clusterId
    ) {
      return data;
    }
    return { ...data, color: "#1a1d27" };
  });
}

// ── cluster info ──────────────────────────────────────────────────────────────
function clusterInfoHtml(clusterId, clusterInfo) {
  const info = clusterInfo[clusterId];
  if (!info) return "";
  const stat = (label, value) =>
    `<div class="info-row"><span class="info-label">${label}</span><span class="info-value">${value}</span></div>`;
  const hasStats = info.stouffer_z != null;
  return `
    <div class="cluster-info">
      <h4>Cluster ${clusterId}${info.significant ? ` <span class="sig-badge">significant · ${info.direction}</span>` : ""}</h4>
      ${hasStats ? [
        stat("BioProjects", info.n_bioprojects),
        stat("Stouffer Z", info.stouffer_z.toFixed(2)),
        stat("p-value", formatP(info.pvalue)),
        stat("q-value", formatP(info.qvalue)),
        stat("Heterogeneity p", formatP(info.heterogeneity_pvalue)),
        stat("Direction consistency", info.direction_consistency != null ? info.direction_consistency.toFixed(2) : "–"),
      ].join("") : ""}
      ${info.hypothesis ? `<div class="hypothesis"><h4>Cluster hypothesis</h4>${renderHypothesis(info.hypothesis)}</div>` : ""}
    </div>`;
}

function showClusterInfo(clusterId, clusterInfo) {
  const html = clusterInfoHtml(clusterId, clusterInfo);
  document.getElementById("node-info").innerHTML = html || `<h3>Cluster ${clusterId}</h3>`;
}

// ── node info panel ───────────────────────────────────────────────────────────
function showNodeInfo(node, graph, sigmaInstance, clusterInfo) {
  const attrs = graph.getNodeAttributes(node);
  // neighbours hidden by the significance filter are left out
  const neighbors = graph.neighbors(node).filter(n => !graph.getNodeAttribute(n, "hidden")).map(n => ({
    name: n,
    score: graph.getEdgeAttribute(graph.edge(node, n), "weight"),
    falsePositive: graph.getEdgeAttribute(graph.edge(node, n), "falsePositive"),
  })).sort((a, b) => b.score - a.score);

  const fpCount = neighbors.filter(n => n.falsePositive).length;

  const panel = document.getElementById("node-info");
  panel.innerHTML = `
    <h3>${node}</h3>
    <div class="info-row"><span class="info-label">Cluster</span><span class="info-value">${attrs.cluster}</span></div>
    ${attrs.pvalue != null ? `<div class="info-row"><span class="info-label">p-value</span><span class="info-value">${attrs.pvalue.toPrecision(3)}</span></div>` : ""}
    ${attrs.cohensD != null ? `<div class="info-row"><span class="info-label">Cohen's d</span><span class="info-value">${attrs.cohensD.toPrecision(3)}</span></div>` : ""}
    <div class="info-row"><span class="info-label">Connections</span><span class="info-value">${neighbors.length}</span></div>
    ${fpCount ? `<div class="info-row"><span class="info-label">False positives</span><span class="info-value" style="color:#e05555">${fpCount}</span></div>` : ""}
    <div class="neighbor-list">
      <h4>Connected hypotheses</h4>
      <h4>Related findings</h4>
      ${neighbors.map(nb => `
        <div class="neighbor-item" data-node="${nb.name}" style="${nb.falsePositive ? "border-left:2px solid #e05555;padding-left:6px" : ""}">
          <span>${nb.name}</span>
          <span class="score-badge" style="${nb.falsePositive ? "color:#e05555" : ""}">${nb.score.toFixed(3)}</span>
        </div>`).join("")}
    </div>
    ${clusterInfoHtml(attrs.cluster, clusterInfo)}`;

  panel.querySelectorAll(".neighbor-item").forEach(el => {
    el.addEventListener("click", () => {
      const target = el.dataset.node;
      sigmaInstance.getCamera().animate(
        sigmaInstance.getNodeDisplayData(target),
        { duration: 500 }
      );
      showNodeInfo(target, graph, sigmaInstance, clusterInfo);
    });
  });
}

// ── search ────────────────────────────────────────────────────────────────────
function setupSearch(sigmaInstance, graph) {
  const input = document.getElementById("search-input");
  // Replace with a fresh clone to remove any prior event listeners
  const fresh = input.cloneNode(true);
  input.replaceWith(fresh);
  fresh.addEventListener("input", () => {
    const q = fresh.value.trim().toLowerCase();
    if (!q) {
      sigmaInstance.setSetting("nodeReducer", null);
      sigmaInstance.setSetting("edgeReducer", null);
      return;
    }
    const matched = new Set(
      graph.nodes().filter(n => n.toLowerCase().includes(q))
    );
    sigmaInstance.setSetting("nodeReducer", (node, data) => {
      if (matched.has(node)) return { ...data, highlighted: true, size: data.size + 3 };
      return { ...data, color: "#1e2030", label: undefined };
    });
    sigmaInstance.setSetting("edgeReducer", (_, data) => ({ ...data, color: "#1a1d27" }));
  });
}

// ── colour mode ───────────────────────────────────────────────────────────────
// "cluster", "pvalue" or "effect", each toggle button switches its mode on, or back to cluster if already on
let colorMode = "cluster";
let currentGraph = null;
let currentPvalueMax = null;
let currentHasEffects = false;

const COLOR_MODES = {
  pvalue: {
    button: "btn-color-pvalue",
    legend: "pvalue-legend",
    missing: "This dataset has no p-values",
    available: () => currentPvalueMax != null,
    color: attrs => attrs.pvalue != null ? pvalueColor(attrs.pvalue, currentPvalueMax) : null,
  },
  effect: {
    button: "btn-color-effect",
    legend: "effect-legend",
    missing: "This dataset has no effect sizes",
    available: () => currentHasEffects,
    color: attrs => attrs.cohensD != null ? effectColor(attrs.cohensD) : null,
  },
};

function applyColorMode() {
  // fall back to cluster colours if the new dataset lacks the current mode's column
  if (colorMode !== "cluster" && !COLOR_MODES[colorMode].available()) colorMode = "cluster";

  for (const [mode, spec] of Object.entries(COLOR_MODES)) {
    const button = document.getElementById(spec.button);
    const available = spec.available();
    button.disabled = !available;
    button.title = available ? "" : spec.missing;
    button.classList.toggle("active", colorMode === mode);
    document.getElementById(spec.legend).style.display = colorMode === mode ? "block" : "none";
  }
  if (colorMode === "pvalue") {
    document.getElementById("pvalue-max-label").textContent = `p ≤ 1e-${currentPvalueMax}`;
  }
  if (!currentGraph) return;

  const spec = COLOR_MODES[colorMode];
  currentGraph.forEachNode((node, attrs) => {
    const color = (spec && spec.color(attrs)) ?? attrs.clusterColor;
    currentGraph.setNodeAttribute(node, "color", color);
  });
}

// ── significance filter ───────────────────────────────────────────────────────
let significantOnly = false;
let currentClusters = [];
let currentClusterInfo = {};

function applySignificanceFilter() {
  const button = document.getElementById("btn-significant");
  const available = Object.values(currentClusterInfo).some(info => info.significant);
  // fall back to showing everything if the new dataset has no significance data
  if (!available) significantOnly = false;
  button.disabled = !available;
  button.title = available ? "" : "This dataset has no cluster significance data";
  button.classList.toggle("active", significantOnly);
  if (!currentGraph) return;

  let shown = 0;
  currentGraph.forEachNode((node, attrs) => {
    const hidden = significantOnly && !attrs.significant;
    currentGraph.setNodeAttribute(node, "hidden", hidden);
    if (!hidden) shown++;
  });
  const shownClusters = new Set(
    currentGraph.filterNodes((_, attrs) => !attrs.hidden).map(n => currentGraph.getNodeAttribute(n, "cluster"))
  ).size;
  document.getElementById("header-stats").textContent =
    `${shown} findings · ${shownClusters} clusters${significantOnly ? " (significant only)" : ""}`;
  if (currentRenderer) buildLegend(currentClusters, currentRenderer, currentGraph, currentClusterInfo);
}

// ── init graph for a named dataset ───────────────────────────────────────────
let currentRenderer = null;

async function initGraph(name) {
  document.getElementById("loading").style.display = "flex";
  setMsg("Loading data…");
  document.getElementById("header-stats").textContent = "Loading…";
  document.getElementById("legend-items").innerHTML = "";
  document.getElementById("node-info").innerHTML = '<p class="placeholder">Click a node to inspect it.</p>';

  if (currentRenderer) {
    currentRenderer.kill();
    currentRenderer = null;
  }

  const { edges, clusters, clusterInfo } = await loadData(name);
  currentClusters = clusters;
  currentClusterInfo = clusterInfo;

  setMsg("Building graph…");
  const graph = buildGraph(edges, clusters, clusterInfo);
  currentGraph = graph;
  currentPvalueMax = pvalueScaleMax(graph);
  currentHasEffects = graph.someNode((_, attrs) => attrs.cohensD != null);
  applyColorMode();

  setMsg(`Running layout (${graph.order} nodes, ${graph.size} edges)…`);
  await new Promise(r => setTimeout(r, 30));
  runLayout(graph);

  setMsg("Rendering…");
  await new Promise(r => setTimeout(r, 30));

  document.getElementById("header-stats").textContent =
    `${graph.order} hypotheses · ${graph.size} predicted matches · ${new Set(clusters.map(c => c.cluster_id)).size} clusters`;

  const container = document.getElementById("sigma-container");
  currentRenderer = new Sigma(graph, container, {
    renderEdgeLabels: false,
    defaultEdgeColor: "#2a3040",
    labelDensity: 0.07,
    labelGridCellSize: 60,
    labelColor: { color: "#ccc" },
    labelSize: 11,
    minCameraRatio: 0.02,
    maxCameraRatio: 10,
  });

  document.getElementById("loading").style.display = "none";

  // sets the header stats and builds the legend for whichever clusters are visible
  applySignificanceFilter();
  setupSearch(currentRenderer, graph);

  currentRenderer.on("clickNode", ({ node }) => {
    showNodeInfo(node, graph, currentRenderer, clusterInfo);

    const neighbors = new Set(graph.neighbors(node));
    currentRenderer.setSetting("nodeReducer", (n, data) => {
      if (n === node) return { ...data, highlighted: true };
      if (neighbors.has(n)) return { ...data, highlighted: true };
      return { ...data, color: "#1e2030", label: undefined };
    });
    currentRenderer.setSetting("edgeReducer", (edge, data) => {
      if (graph.hasExtremity(edge, node)) return data;
      return { ...data, color: "#1a1d27" };
    });
  });

  currentRenderer.on("clickStage", () => {
    currentRenderer.setSetting("nodeReducer", null);
    currentRenderer.setSetting("edgeReducer", null);
    document.getElementById("node-info").innerHTML = '<p class="placeholder">Click a node to inspect it.</p>';
  });
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Zoom controls (wired once, work across dataset switches)
  document.getElementById("btn-zoom-in").addEventListener("click", () => {
    currentRenderer?.getCamera().animatedZoom({ duration: 300 });
  });
  document.getElementById("btn-zoom-out").addEventListener("click", () => {
    currentRenderer?.getCamera().animatedUnzoom({ duration: 300 });
  });
  document.getElementById("btn-reset").addEventListener("click", () => {
    currentRenderer?.getCamera().animatedReset({ duration: 400 });
  });
  document.getElementById("btn-significant").addEventListener("click", () => {
    significantOnly = !significantOnly;
    applySignificanceFilter();
  });
  for (const [mode, spec] of Object.entries(COLOR_MODES)) {
    document.getElementById(spec.button).addEventListener("click", () => {
      colorMode = colorMode === mode ? "cluster" : mode;
      applyColorMode();
    });
  }

  // Load dataset index and populate dropdown
  const datasets = await fetch(import.meta.env.BASE_URL + "data/index.json").then(r => r.json());
  const select = document.getElementById("dataset-select");
  for (const name of datasets) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  }

  select.addEventListener("change", () => {
    initGraph(select.value).catch(err => {
      document.getElementById("loading-msg").textContent = `Error: ${err.message}`;
      console.error(err);
    });
  });

  await initGraph(datasets[0]);
}

main().catch(err => {
  document.getElementById("loading-msg").textContent = `Error: ${err.message}`;
  console.error(err);
});
