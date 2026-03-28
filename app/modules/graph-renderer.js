import { emit, on, state } from './state.js';
import { buildNamespaceElementsAtScope, buildClassElementsAtScope, initNamespaceBrowser, navigateToScope, getCurrentScope, getViewMode } from './namespace-browser.js';

let cy = null;

// Above this threshold, only the top N most-connected internal nodes are added
// to Cytoscape to prevent the initial render from freezing.
const MAX_RENDERED_NODES = 2000;

const NODE_COLORS = {
  class: '#3B82F6',
  interface: '#8B5CF6',
  trait: '#F59E0B',
  enum: '#10B981',
};

const NODE_SHAPES = {
  class: 'ellipse',
  interface: 'diamond',
  trait: 'hexagon',
  enum: 'rectangle',
};

const EDGE_STYLES = {
  certain: { width: 2, style: 'solid' },
  high: { width: 1, style: 'solid' },
  medium: { width: 1, style: 'dashed' },
  low: { width: 1, style: 'dotted' },
};

export function initGraph(data) {
  initNamespaceBrowser(data);

  const elements = buildNamespaceElementsAtScope(data, []);

  cy = cytoscape({
    container: document.getElementById('cy'),
    elements,
    style: buildStylesheet(),
    layout: { name: 'preset' },
    minZoom: 0.1,
    maxZoom: 5,
    wheelSensitivity: 0.3,
  });

  state.cy = cy;

  cy.ready(() => runLayout('fcose'));

  // Single tap on namespace → detail panel; double tap → drill down
  let nsTapTimer = null;
  cy.on('tap', 'node[nodeType="namespace"]', (evt) => {
    const node = evt.target;
    if (nsTapTimer) return; // a second tap is coming (dbltap)
    nsTapTimer = setTimeout(() => {
      nsTapTimer = null;
      cy.elements().removeClass('ns-selected');
      node.addClass('ns-selected');
      emit('namespace:selected', node.data());
    }, 220);
  });

  cy.on('dbltap', 'node[nodeType="namespace"]', (evt) => {
    clearTimeout(nsTapTimer);
    nsTapTimer = null;
    cy.elements().removeClass('ns-selected');
    navigateToScope(evt.target.data('nsPath'));
  });

  cy.on('tap', 'node[nodeType != "namespace"]', (evt) => {
    cy.elements().removeClass('ns-selected');
    emit('node:selected', evt.target.id());
  });

  cy.on('tap', 'edge', (evt) => {
    const edge = evt.target;
    emit('edge:selected', {
      source: edge.data('source'),
      target: edge.data('target'),
      weight: edge.data('weight'),
      confidence: edge.data('confidence'),
      entries: edge.data('entries'),
    });
  });

  cy.on('tap', (evt) => {
    if (evt.target === cy) {
      cy.elements().removeClass('ns-selected');
      resetFocus();
      emit('selection:cleared');
    }
  });

  on('namespace:navigate', (nsPath) => navigateToScope(nsPath));

  cy.on('mouseover', 'node', (evt) => {
    const node = evt.target;
    const d = node.data();

    if (d.nodeType === 'namespace') {
      const neighborhood = node.closedNeighborhood();
      cy.startBatch();
      cy.elements().addClass('hover-dimmed');
      cy.nodes('[nodeType="namespace-container"]').removeClass('hover-dimmed');
      neighborhood.removeClass('hover-dimmed');
      node.addClass('hover-highlighted');
      cy.endBatch();
    }

    node.connectedEdges().forEach((edge) => {
      if (edge.source().id() === node.id()) {
        edge.addClass('edge-out');
      } else {
        edge.addClass('edge-in');
      }
    });
  });

  cy.on('mouseout', 'node', () => {
    cy.startBatch();
    cy.elements().removeClass('hover-dimmed hover-highlighted');
    cy.edges().removeClass('edge-out edge-in');
    cy.endBatch();
  });

  on('focus:node', ({ nodeId, depth }) => focusNode(nodeId, depth));
  on('focus:reset', () => resetFocus());
  on('layout:run', (name) => runLayout(name));

  on('namespace:rebuild', () => {
    if (!cy || !state.data) return;
    const scope = getCurrentScope();
    const els = getViewMode() === 'classes'
      ? buildClassElementsAtScope(state.data, scope)
      : buildNamespaceElementsAtScope(state.data, scope);
    cy.startBatch();
    cy.elements().remove();
    cy.add(els);
    cy.endBatch();
    state.selectedNode = null;
    if (state.cycles && state.cycles.length > 0) markCycleNodes(state.cycles);
    runLayout('fcose');
  });

  const btnExport = document.getElementById('btn-export-png');
  if (btnExport) {
    btnExport.removeAttribute('hidden');
    btnExport.addEventListener('click', exportPng);
  }

  emit('graph:ready', cy);
}

function exportPng() {
  if (!cy) return;
  const dataUrl = cy.png({ output: 'blob', bg: '#0F172A', full: true, scale: 2 });
  const url = URL.createObjectURL(dataUrl);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'php-dep-graph.png';
  a.click();
  URL.revokeObjectURL(url);
}

function buildElements(data) {
  const nodes = [];
  const edges = [];

  // Compute degree (in + out) for each node from the raw edge list
  const degree = new Map();
  for (const e of data.edges) {
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  }

  // Determine which internal nodes to render (cap for large datasets)
  const internalNodes = [...data.classes.values()].filter((c) => !c.external);
  let allowedFQCNs = null; // null = all allowed

  if (internalNodes.length > MAX_RENDERED_NODES) {
    const sorted = [...internalNodes].sort(
      (a, b) => (degree.get(b.fqcn) || 0) - (degree.get(a.fqcn) || 0)
    );
    allowedFQCNs = new Set(sorted.slice(0, MAX_RENDERED_NODES).map((c) => c.fqcn));

    const banner = document.getElementById('large-dataset-banner');
    banner.textContent = `Large dataset: displaying top ${MAX_RENDERED_NODES} of ${internalNodes.length} most-connected nodes. Filter by namespace to explore specific subgraphs.`;
    banner.removeAttribute('hidden');
  }

  for (const [fqcn, cls] of data.classes) {
    // Skip external nodes (hidden by default anyway) and capped internal nodes
    if (cls.external) continue;
    if (allowedFQCNs && !allowedFQCNs.has(fqcn)) continue;

    const shortName = fqcn.split('\\').pop();
    nodes.push({
      data: {
        id: fqcn,
        label: shortName,
        fullLabel: fqcn,
        type: cls.type,
        external: cls.external,
        namespace: cls.namespace,
        file: cls.file,
        line: cls.line,
        depCount: cls.dependencies ? cls.dependencies.length : 0,
        dependantCount: cls.dependants ? cls.dependants.length : 0,
      },
    });
  }

  const renderedIds = new Set(nodes.map((n) => n.data.id));

  // Consolidate parallel edges
  const CONFIDENCE_RANK = { certain: 4, high: 3, medium: 2, low: 1 };
  const edgeMap = new Map();
  for (const e of data.edges) {
    // Only include edges where both endpoints are rendered
    if (!renderedIds.has(e.source) || !renderedIds.has(e.target)) continue;
    const key = `${e.source}\u2192${e.target}`;
    if (!edgeMap.has(key)) {
      edgeMap.set(key, { source: e.source, target: e.target, entries: [] });
    }
    edgeMap.get(key).entries.push(e);
  }

  let i = 0;
  for (const group of edgeMap.values()) {
    const { source, target, entries } = group;
    const best = entries.reduce((a, b) =>
      (CONFIDENCE_RANK[b.confidence] || 0) > (CONFIDENCE_RANK[a.confidence] || 0) ? b : a
    );
    edges.push({
      data: {
        id: `e${i++}`,
        source,
        target,
        weight: entries.length,
        edgeType: entries.map((e) => e.type).join(', '),
        confidence: best.confidence,
        file: best.file,
        line: best.line,
        entries,
      },
    });
  }

  return [...nodes, ...edges];
}

function buildStylesheet() {
  return [
    {
      selector: 'node',
      style: {
        label: 'data(label)',
        'text-valign': 'bottom',
        'text-margin-y': 5,
        'font-size': 11,
        'font-family': 'Inter, system-ui, sans-serif',
        color: '#E2E8F0',
        'text-outline-color': '#0F172A',
        'text-outline-width': 2,
        width: 'mapData(degree, 0, 10, 20, 60)',
        height: 'mapData(degree, 0, 10, 20, 60)',
        'border-width': 2,
        'border-color': '#1E293B',
        'transition-property': 'opacity, background-color, border-color',
        'transition-duration': '200ms',
      },
    },
    ...Object.entries(NODE_COLORS).map(([type, color]) => ({
      selector: `node[type="${type}"]`,
      style: {
        'background-color': color,
        shape: NODE_SHAPES[type],
      },
    })),
    {
      selector: 'node[?external]',
      style: {
        'background-color': '#9CA3AF',
        'border-style': 'dashed',
        'border-color': '#6B7280',
      },
    },
    {
      selector: 'node.in-cycle',
      style: {
        'border-color': '#EF4444',
        'border-width': 3,
      },
    },
    {
      selector: 'node.dimmed',
      style: { opacity: 0.15 },
    },
    {
      selector: 'edge.dimmed',
      style: { opacity: 0.15 },
    },
    {
      selector: 'node.highlighted',
      style: {
        'border-color': '#FACC15',
        'border-width': 4,
      },
    },
    {
      selector: 'edge',
      style: {
        width: 'mapData(weight, 1, 20, 1.5, 8)',
        'line-color': '#94A3B8',
        'target-arrow-color': '#94A3B8',
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.8,
        'curve-style': 'bezier',
        'transition-property': 'opacity, line-color, target-arrow-color',
        'transition-duration': '200ms',
      },
    },
    ...Object.entries(EDGE_STYLES).map(([confidence, s]) => ({
      selector: `edge[confidence="${confidence}"]`,
      style: {
        'line-style': s.style,
      },
    })),
    {
      selector: 'edge.edge-out',
      style: {
        'line-color': '#EF4444',
        'target-arrow-color': '#EF4444',
        width: 'mapData(weight, 1, 20, 2, 9)',
      },
    },
    {
      selector: 'edge.edge-in',
      style: {
        'line-color': '#22C55E',
        'target-arrow-color': '#22C55E',
        width: 'mapData(weight, 1, 20, 2, 9)',
      },
    },
    {
      selector: 'node.search-match',
      style: {
        'border-color': '#F97316',
        'border-width': 4,
      },
    },
    {
      selector: 'node.hover-dimmed',
      style: { opacity: 0.12 },
    },
    {
      selector: 'edge.hover-dimmed',
      style: { opacity: 0.08 },
    },
    {
      selector: 'node.hover-highlighted',
      style: {
        'border-color': '#60A5FA',
        'border-width': 4,
      },
    },
    {
      selector: 'node[nodeType="namespace-container"]',
      style: {
        'background-color': '#1E3A5F',
        'background-opacity': 0.35,
        'border-color': '#3B82F6',
        'border-width': 1,
        'border-opacity': 0.6,
        shape: 'roundrectangle',
        label: 'data(label)',
        'text-valign': 'top',
        'text-halign': 'center',
        'font-size': 11,
        'font-weight': 700,
        color: '#93C5FD',
        'text-outline-width': 0,
        padding: 20,
      },
    },
    {
      selector: 'node[nodeType="namespace"]',
      style: {
        'background-color': '#0F4C81',
        'background-opacity': 0.95,
        shape: 'roundrectangle',
        width: 'mapData(classCount, 1, 80, 70, 160)',
        height: 'mapData(classCount, 1, 80, 70, 160)',
        label: 'data(label)',
        'text-valign': 'center',
        'text-halign': 'center',
        'font-size': 13,
        'font-weight': 600,
        'text-wrap': 'wrap',
        'text-max-width': '140px',
        'text-outline-width': 0,
        color: '#E2E8F0',
        'border-color': '#3B82F6',
        'border-width': 2,
        cursor: 'pointer',
        'transition-property': 'border-color, border-width, background-color',
        'transition-duration': '150ms',
      },
    },
    {
      selector: 'node[nodeType="namespace"]:active',
      style: {
        'background-color': '#1E4D8C',
        'border-color': '#60A5FA',
        'border-width': 3,
      },
    },
    {
      selector: 'node.ns-selected',
      style: {
        'border-color': '#FACC15',
        'border-width': 3,
        'background-color': '#1E4D8C',
      },
    },
  ];
}

export function runLayout(name) {
  if (!cy) return;

  const visibleEles = cy.elements(':visible');
  if (visibleEles.length === 0) return;

  const visibleNodeCount = visibleEles.nodes().length;

  // For very large visible graphs, fall back to grid (instant, non-blocking)
  if (visibleNodeCount > 1500) {
    visibleEles.layout({ name: 'grid', animate: false, fit: true, padding: 40 }).run();
    return;
  }

  // For medium graphs, use fcose/cose but without animation and fewer iterations
  const large = visibleNodeCount > 500;

  const options =
    name === 'fcose'
      ? {
          name: 'fcose',
          animate: !large,
          animationDuration: large ? 0 : 500,
          fit: true,
          padding: 40,
          quality: large ? 'draft' : 'default',
          nodeDimensionsIncludeLabels: true,
          idealEdgeLength: 120,
          nodeRepulsion: 8000,
          edgeElasticity: 0.45,
          gravity: 0.25,
          gravityRange: 3.8,
          numIter: large ? 500 : 2500,
          tile: true,
          packComponents: true,
        }
      : {
          name: 'cose',
          animate: !large,
          animationDuration: large ? 0 : 500,
          fit: true,
          padding: 40,
          nodeDimensionsIncludeLabels: true,
          idealEdgeLength: 120,
          nodeRepulsion: 8000,
        };

  try {
    visibleEles.layout(options).run();
  } catch (e) {
    console.warn('Layout "' + name + '" failed, falling back to grid:', e.message);
    visibleEles.layout({ name: 'grid', animate: false, fit: true, padding: 40 }).run();
  }
}

export function focusNode(nodeId, depth = 1) {
  if (!cy) return;

  const node = cy.getElementById(nodeId);
  if (!node || node.empty()) return;

  const neighborhood = node.closedNeighborhood();
  let focus = neighborhood;

  if (depth === 2) {
    focus = neighborhood.closedNeighborhood();
  }

  cy.startBatch();
  cy.elements().addClass('dimmed');
  cy.nodes('[nodeType="namespace-container"]').removeClass('dimmed');
  focus.removeClass('dimmed');
  node.addClass('highlighted');
  cy.endBatch();

  state.selectedNode = nodeId;
  state.focusDepth = depth;
}

export function resetFocus() {
  if (!cy) return;
  cy.startBatch();
  cy.elements().removeClass('dimmed highlighted');
  cy.endBatch();
  state.selectedNode = null;
}

export function markCycleNodes(cycles) {
  if (!cy) return;
  const nodesInCycles = new Set();
  for (const cycle of cycles) {
    for (const fqcn of cycle) {
      nodesInCycles.add(fqcn);
    }
  }
  cy.startBatch();
  for (const fqcn of nodesInCycles) {
    cy.getElementById(fqcn).addClass('in-cycle');
  }
  cy.endBatch();
}
