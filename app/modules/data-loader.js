import { emit, state } from './state.js';

// Inline worker code — runs JSON.parse + data processing off the main thread.
// Uses String.fromCharCode(92) for backslash to avoid template-literal escaping issues.
const WORKER_CODE = `
  var SEP = String.fromCharCode(92);

  function getNamespaceKey(fqcn, isExternal) {
    var parts = fqcn.split(SEP);
    if (parts.length < 2) return parts[0];
    return isExternal ? parts[0] : parts.slice(0, 2).join(SEP);
  }

  function detectCycles(edges, nodeCount) {
    if (nodeCount > 3000) return [];
    var adj = new Map();
    for (var i = 0; i < edges.length; i++) {
      var e = edges[i];
      if (!adj.has(e.source)) adj.set(e.source, []);
      adj.get(e.source).push(e.target);
    }
    var visited = new Set();
    var inStack = new Set();
    var cycles = [];
    var MAX_CYCLES = 50;

    function dfs(node, path) {
      if (cycles.length >= MAX_CYCLES) return;
      if (inStack.has(node)) {
        var cycleStart = path.indexOf(node);
        if (cycleStart !== -1) cycles.push(path.slice(cycleStart));
        return;
      }
      if (visited.has(node)) return;
      visited.add(node);
      inStack.add(node);
      path.push(node);
      var neighbors = adj.get(node) || [];
      for (var i = 0; i < neighbors.length; i++) dfs(neighbors[i], path);
      path.pop();
      inStack.delete(node);
    }

    var nodes = Array.from(adj.keys());
    for (var i = 0; i < nodes.length; i++) {
      if (!visited.has(nodes[i])) dfs(nodes[i], []);
    }
    return cycles;
  }

  self.onmessage = function(e) {
    try {
      var raw = JSON.parse(e.data);
      var seen = new Set(raw.classes.map(function(c) { return c.fqcn; }));
      var classesArray = raw.classes.map(function(cls) {
        return Object.assign({}, cls, {
          external: false,
          namespace: getNamespaceKey(cls.fqcn, false),
        });
      });
      for (var i = 0; i < raw.edges.length; i++) {
        var edge = raw.edges[i];
        var fqcns = [edge.source, edge.target];
        for (var j = 0; j < fqcns.length; j++) {
          var fqcn = fqcns[j];
          if (!seen.has(fqcn)) {
            seen.add(fqcn);
            classesArray.push({
              fqcn: fqcn, type: 'class', file: null, line: null,
              dependencies: [], dependants: [],
              external: true,
              namespace: getNamespaceKey(fqcn, true),
            });
          }
        }
      }
      var nodeCount = (raw.meta && raw.meta.node_count) || raw.classes.length;
      var cycles = detectCycles(raw.edges, nodeCount);
      self.postMessage({ ok: true, classesArray: classesArray, edges: raw.edges, meta: raw.meta, warnings: raw.warnings || [], cycles: cycles });
    } catch(err) {
      self.postMessage({ ok: false, error: err.message });
    }
  };
`;

function parseAndProcessInWorker(text) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    worker.onmessage = (e) => {
      URL.revokeObjectURL(url);
      worker.terminate();
      if (e.data.ok) {
        resolve(processWorkerResult(e.data));
      } else {
        reject(new Error(e.data.error));
      }
    };
    worker.onerror = (err) => {
      URL.revokeObjectURL(url);
      worker.terminate();
      reject(new Error(err.message || 'Worker error'));
    };
    worker.postMessage(text);
  });
}

function processWorkerResult({ classesArray, edges, meta, warnings, cycles }) {
  const classMap = new Map(classesArray.map((cls) => [cls.fqcn, cls]));

  const processed = { meta, classes: classMap, edges, warnings, cycles };

  state.data = processed;
  state.cycles = cycles;
  emit('data:loaded', processed);

  if (meta && meta.node_count > 200) {
    const banner = document.getElementById('large-dataset-banner');
    banner.textContent = `Large dataset (${meta.node_count} nodes). Use namespace filters for better performance.`;
    banner.removeAttribute('hidden');
  }

  return processed;
}

/**
 * Try fetch, fallback to file picker UI.
 */
export async function loadData() {
  if (sessionStorage.getItem('forceFilePicker')) {
    sessionStorage.removeItem('forceFilePicker');
    return waitForFilePicker();
  }
  try {
    const res = await fetch('data.json');
    if (!res.ok) throw new Error(res.statusText);
    const text = await res.text();
    return await parseAndProcessInWorker(text);
  } catch {
    return waitForFilePicker();
  }
}

function showDropZone() {
  const zone = document.getElementById('drop-zone');
  zone.classList.add('visible');
}

function hideDropZone() {
  const zone = document.getElementById('drop-zone');
  zone.classList.remove('visible');
}

function waitForFilePicker() {
  return new Promise((resolve) => {
    showDropZone();
    const zone = document.getElementById('drop-zone');
    const input = zone.querySelector('input[type="file"]');

    function handleFile(file) {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const processed = await parseAndProcessInWorker(e.target.result);
          hideDropZone();
          resolve(processed);
        } catch {
          zone.querySelector('.drop-zone__error').textContent = 'Invalid JSON file.';
        }
      };
      reader.readAsText(file);
    }

    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('dragover');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('dragover');
      if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
    });
    zone.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      if (input.files.length) handleFile(input.files[0]);
    });
  });
}

/**
 * Get namespace key: first 2 segments for internal, first segment for external.
 */
export function getNamespaceKey(fqcn, isExternal) {
  const parts = fqcn.split('\\');
  if (parts.length < 2) return parts[0];
  return isExternal ? parts[0] : parts.slice(0, 2).join('\\');
}
