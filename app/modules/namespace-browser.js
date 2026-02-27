import { emit, state } from './state.js';

let currentScope = []; // array of namespace segments, e.g. ['App', 'Services']
let nsData = null;

/**
 * Build Cytoscape elements for the given scope level.
 *
 * At scope [] (root): one node per top-level namespace segment.
 * At scope ['App']: one node per child of App (sub-namespace folders or leaf classes).
 * Edges are aggregated between nodes at the current scope level.
 */
export function buildNamespaceElementsAtScope(data, scope) {
  const SEP = '\\';
  const nodes = [];
  const edges = [];

  // Degree for class node sizing
  const degree = new Map();
  for (const e of data.edges) {
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  }

  // Only internal classes
  const allClasses = [...data.classes.values()].filter((c) => !c.external);

  // Group classes by their child segment at this scope level
  // Map: segment → { isFolder: bool, fqcns: Set<string> }
  const childInfo = new Map();

  for (const cls of allClasses) {
    const parts = cls.fqcn.split(SEP);

    // Skip if not under current scope
    if (scope.length > 0) {
      if (parts.length <= scope.length) continue;
      let match = true;
      for (let i = 0; i < scope.length; i++) {
        if (parts[i] !== scope[i]) { match = false; break; }
      }
      if (!match) continue;
    }

    const segment = parts[scope.length];
    if (segment === undefined) continue;

    if (!childInfo.has(segment)) {
      childInfo.set(segment, { isFolder: false, fqcns: new Set() });
    }
    childInfo.get(segment).fqcns.add(cls.fqcn);

    // If there are more parts, this segment is a namespace folder
    if (parts.length > scope.length + 1) {
      childInfo.get(segment).isFolder = true;
    }
  }

  // Cycle detection: which FQCNs are in cycles?
  const cycleSet = new Set((state.cycles || []).flat());

  // Build fqcn → nodeId mapping for edge aggregation
  const fqcnToNodeId = new Map();
  const prefix = scope.length > 0 ? scope.join(SEP) + SEP : '';

  for (const [segment, info] of childInfo) {
    const nsPath = prefix + segment;

    if (info.isFolder) {
      const nodeId = 'ns::' + nsPath;
      for (const fqcn of info.fqcns) fqcnToNodeId.set(fqcn, nodeId);

      const hasCycle = [...info.fqcns].some((fqcn) => cycleSet.has(fqcn));
      nodes.push({
        data: {
          id: nodeId,
          label: segment + '\n' + info.fqcns.size + (info.fqcns.size === 1 ? ' class' : ' classes'),
          nodeType: 'namespace',
          nsPath,
          classCount: info.fqcns.size,
          hasCycle,
        },
      });
    } else {
      const fqcn = [...info.fqcns][0];
      const cls = data.classes.get(fqcn);
      fqcnToNodeId.set(fqcn, fqcn);
      nodes.push({
        data: {
          id: fqcn,
          label: fqcn.split(SEP).pop(),
          fullLabel: fqcn,
          type: cls.type,
          nodeType: 'class',
          external: false,
          namespace: cls.namespace,
          file: cls.file,
          line: cls.line,
          depCount: cls.dependencies ? cls.dependencies.length : 0,
          dependantCount: cls.dependants ? cls.dependants.length : 0,
          degree: degree.get(fqcn) || 0,
        },
      });
    }
  }

  // Build aggregated edges
  const renderedNodeIds = new Set(nodes.map((n) => n.data.id));
  const CONFIDENCE_RANK = { certain: 4, high: 3, medium: 2, low: 1 };
  const edgeMap = new Map();

  for (const e of data.edges) {
    const srcId = fqcnToNodeId.get(e.source);
    const tgtId = fqcnToNodeId.get(e.target);
    if (!srcId || !tgtId || srcId === tgtId) continue;
    if (!renderedNodeIds.has(srcId) || !renderedNodeIds.has(tgtId)) continue;
    const key = srcId + '\u2192' + tgtId;
    if (!edgeMap.has(key)) edgeMap.set(key, { source: srcId, target: tgtId, entries: [] });
    edgeMap.get(key).entries.push(e);
  }

  let ei = 0;
  for (const group of edgeMap.values()) {
    const { source, target, entries } = group;
    const best = entries.reduce((a, b) =>
      (CONFIDENCE_RANK[b.confidence] || 0) > (CONFIDENCE_RANK[a.confidence] || 0) ? b : a
    );
    edges.push({
      data: {
        id: 'e' + ei++,
        source,
        target,
        weight: entries.length,
        confidence: best.confidence,
        edgeType: entries.map((e) => e.type).join(', '),
        entries,
      },
    });
  }

  return [...nodes, ...edges];
}

export function navigateToScope(nsPath) {
  currentScope = nsPath ? nsPath.split('\\') : [];
  renderBreadcrumb();
  emit('selection:cleared');
  emit('namespace:rebuild');
}

export function getCurrentScope() {
  return currentScope;
}

function renderBreadcrumb() {
  const el = document.getElementById('ns-breadcrumb');
  if (!el) return;

  const parts = currentScope;
  const items = [];

  if (parts.length === 0) {
    items.push('<span class="breadcrumb-item breadcrumb-item--current">root</span>');
  } else {
    items.push('<span class="breadcrumb-item" data-scope="">root</span>');
  }

  for (let i = 0; i < parts.length; i++) {
    const sc = parts.slice(0, i + 1).join('\\');
    items.push('<span class="breadcrumb-sep">›</span>');
    if (i === parts.length - 1) {
      items.push(
        '<span class="breadcrumb-item breadcrumb-item--current">' + escHtml(parts[i]) + '</span>'
      );
    } else {
      items.push(
        '<span class="breadcrumb-item" data-scope="' + escHtml(sc) + '">' + escHtml(parts[i]) + '</span>'
      );
    }
  }

  el.innerHTML = items.join('');
  el.querySelectorAll('.breadcrumb-item[data-scope]').forEach((item) => {
    item.addEventListener('click', () => navigateToScope(item.dataset.scope));
  });
}

function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function initNamespaceBrowser(data) {
  nsData = data;
  currentScope = [];
  renderBreadcrumb();
}
