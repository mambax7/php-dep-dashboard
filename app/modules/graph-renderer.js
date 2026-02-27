import { emit, on, state } from './state.js';

let cy = null;

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
  const elements = buildElements(data);

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

  // Hide external nodes by default
  cy.nodes('[?external]').hide();

  // Run layout
  runLayout('fcose');

  // Events
  cy.on('tap', 'node', (evt) => {
    const node = evt.target;
    emit('node:selected', node.id());
  });

  cy.on('tap', 'edge', (evt) => {
    const edge = evt.target;
    emit('edge:selected', {
      source: edge.data('source'),
      target: edge.data('target'),
      type: edge.data('edgeType'),
      confidence: edge.data('confidence'),
      file: edge.data('file'),
      line: edge.data('line'),
    });
  });

  cy.on('tap', (evt) => {
    if (evt.target === cy) {
      resetFocus();
      emit('selection:cleared');
    }
  });

  cy.on('mouseover', 'node', (evt) => {
    const node = evt.target;
    node.connectedEdges().forEach((edge) => {
      if (edge.source().id() === node.id()) {
        edge.addClass('edge-out');
      } else {
        edge.addClass('edge-in');
      }
    });
  });

  cy.on('mouseout', 'node', () => {
    cy.edges().removeClass('edge-out edge-in');
  });

  on('focus:node', ({ nodeId, depth }) => focusNode(nodeId, depth));
  on('focus:reset', () => resetFocus());
  on('layout:run', (name) => runLayout(name));

  emit('graph:ready', cy);
}

function buildElements(data) {
  const nodes = [];
  const edges = [];

  for (const [fqcn, cls] of data.classes) {
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

  for (let i = 0; i < data.edges.length; i++) {
    const e = data.edges[i];
    edges.push({
      data: {
        id: `e${i}`,
        source: e.source,
        target: e.target,
        edgeType: e.type,
        confidence: e.confidence,
        file: e.file,
        line: e.line,
      },
    });
  }

  return [...nodes, ...edges];
}

function buildStylesheet() {
  const styles = [
    // Base node style
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
    // Node types
    ...Object.entries(NODE_COLORS).map(([type, color]) => ({
      selector: `node[type="${type}"]`,
      style: {
        'background-color': color,
        shape: NODE_SHAPES[type],
      },
    })),
    // External nodes
    {
      selector: 'node[?external]',
      style: {
        'background-color': '#9CA3AF',
        'border-style': 'dashed',
        'border-color': '#6B7280',
      },
    },
    // Cycle nodes
    {
      selector: 'node.in-cycle',
      style: {
        'border-color': '#EF4444',
        'border-width': 3,
      },
    },
    // Dimmed (focus mode)
    {
      selector: 'node.dimmed',
      style: { opacity: 0.15 },
    },
    {
      selector: 'edge.dimmed',
      style: { opacity: 0.15 },
    },
    // Highlighted node
    {
      selector: 'node.highlighted',
      style: {
        'border-color': '#FACC15',
        'border-width': 4,
      },
    },
    // Base edge style
    {
      selector: 'edge',
      style: {
        width: 1,
        'line-color': '#94A3B8',
        'target-arrow-color': '#94A3B8',
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.8,
        'curve-style': 'bezier',
        'transition-property': 'opacity, line-color, target-arrow-color',
        'transition-duration': '200ms',
      },
    },
    // Edge confidence styles
    ...Object.entries(EDGE_STYLES).map(([confidence, s]) => ({
      selector: `edge[confidence="${confidence}"]`,
      style: {
        width: s.width,
        'line-style': s.style,
      },
    })),
    // Edge hover colors
    {
      selector: 'edge.edge-out',
      style: {
        'line-color': '#EF4444',
        'target-arrow-color': '#EF4444',
        width: 2,
      },
    },
    {
      selector: 'edge.edge-in',
      style: {
        'line-color': '#22C55E',
        'target-arrow-color': '#22C55E',
        width: 2,
      },
    },
    // Search highlight
    {
      selector: 'node.search-match',
      style: {
        'border-color': '#F97316',
        'border-width': 4,
      },
    },
  ];

  return styles;
}

export function runLayout(name) {
  if (!cy) return;

  const options =
    name === 'fcose'
      ? {
          name: 'fcose',
          animate: true,
          animationDuration: 500,
          quality: 'default',
          nodeDimensionsIncludeLabels: true,
          idealEdgeLength: 120,
          nodeRepulsion: 8000,
          edgeElasticity: 0.45,
          gravity: 0.25,
          gravityRange: 3.8,
          numIter: 2500,
          tile: true,
          packComponents: true,
        }
      : {
          name: 'cose',
          animate: true,
          animationDuration: 500,
          nodeDimensionsIncludeLabels: true,
          idealEdgeLength: 120,
          nodeRepulsion: 8000,
        };

  const visibleEles = cy.elements(':visible');
  if (visibleEles.length > 0) {
    visibleEles.layout(options).run();
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
