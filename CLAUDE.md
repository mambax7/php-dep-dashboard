# PHP Dep Insights — Developer Guide for Claude

## Project Overview

A browser-based, zero-dependency PHP dependency graph explorer. Users drop a `data.json` file (produced by a static analysis tool) and get an interactive Cytoscape.js graph of class dependencies with namespace drill-down navigation.

**Key constraint**: works via `file://` protocol — no dev server, no bundler at runtime, no ES module imports in the browser.

---

## Architecture

```
index.html          ← single entry point, loads vendor scripts then app.bundle.js
style.css           ← all styles
data.json           ← sample / user-provided data file
app/
  app.bundle.js     ← GENERATED — the only JS file loaded by the browser
  app.js            ← root init (calls initX() on each module after data loads)
  modules/          ← ES module source files (edit these, never app.bundle.js)
    constants.js
    state.js
    data-loader.js
    namespace-browser.js
    graph-renderer.js
    filter-manager.js
    detail-panel.js
    warnings-panel.js
    search.js
scripts/
  bundle.js         ← Node.js bundler: strips imports/exports, concatenates modules
vendor/             ← cytoscape.min.js, cytoscape-fcose.min.js, layout-base.min.js, cose-base.min.js
```

### Build Workflow

**After every change to any `app/modules/*.js` or `app/app.js` file, run:**
```bash
npm run bundle
```
This regenerates `app/app.bundle.js`. Never edit `app.bundle.js` manually.

The bundler strips `import` lines and `export` keywords, then concatenates modules in dependency order. All symbols become globals in the bundle scope.

---

## Module Load Order (dependencies first)

1. `constants.js` — EVENTS, DOM, NODE_TYPE enums
2. `state.js` — event bus (emit/on) + shared `state` object
3. `data-loader.js` — fetch/parse data.json via Web Worker
4. `namespace-browser.js` — namespace drill-down logic + breadcrumb
5. `graph-renderer.js` — Cytoscape init, layout, focus
6. `filter-manager.js` — left sidebar filters
7. `detail-panel.js` — right sidebar node/edge details
8. `warnings-panel.js` — warnings badge + dropdown
9. `search.js` — top-bar search input
10. `app.js` (root entry) — wires everything together

---

## Constants (always use these, never hardcode strings)

```js
// app/modules/constants.js

EVENTS.DATA_LOADED        // 'data:loaded'
EVENTS.NODE_SELECTED      // 'node:selected'
EVENTS.EDGE_SELECTED      // 'edge:selected'
EVENTS.SELECTION_CLEARED  // 'selection:cleared'
EVENTS.FOCUS_NODE         // 'focus:node'
EVENTS.FOCUS_RESET        // 'focus:reset'
EVENTS.LAYOUT_RUN         // 'layout:run'
EVENTS.FILTERS_APPLIED    // 'filters:applied'
EVENTS.NAMESPACE_REBUILD  // 'namespace:rebuild'
EVENTS.GRAPH_READY        // 'graph:ready'

DOM.CY                    // 'cy'
DOM.FILTERS               // 'filters'
DOM.DETAIL_PANEL          // 'detail-panel'
DOM.NS_BREADCRUMB         // 'ns-breadcrumb'
DOM.GRAPH_STATUS          // 'graph-status'
// ... see constants.js for full list

NODE_TYPE.NAMESPACE       // 'namespace'  — drillable folder node
NODE_TYPE.CLASS           // 'class'      — individual PHP class/interface/trait/enum
```

---

## Event Bus (state.js)

```js
emit(EVENTS.DATA_LOADED, data);        // fire an event with payload
on(EVENTS.NODE_SELECTED, (nodeId) => { ... }); // subscribe
```

All inter-module communication uses this bus. Never call other modules' functions directly for reactions — emit an event.

---

## Shared State (state.js)

```js
state.data          // processed data: { meta, classes: Map<fqcn, cls>, edges, warnings, cycles }
state.cy            // Cytoscape instance (set by graph-renderer after init)
state.cycles        // array of circular dependency arrays (set by data-loader)
state.selectedNode  // currently focused FQCN or null
state.focusDepth    // 1 or 2 (neighborhood depth for focus mode)
state.filtersActive // boolean
```

---

## Data Format (data.json)

```jsonc
{
  "meta": {
    "version": "1.0",
    "generated_at": "...",
    "analyzed_path": "/path/to/project",
    "file_count": 42,
    "class_count": 38,
    "node_count": 95,   // includes external
    "edge_count": 312,
    "warning_count": 2
  },
  "classes": [
    {
      "fqcn": "App\\Service\\UserService",   // backslash-separated
      "type": "class",                        // class | interface | trait | enum
      "file": "/path/to/UserService.php",
      "line": 12,
      "dependencies": ["App\\Repository\\UserRepository"],
      "dependants": ["App\\Controller\\UserController"]
    }
  ],
  "edges": [
    {
      "source": "App\\Service\\UserService",
      "target": "App\\Repository\\UserRepository",
      "type": "param_type",   // edge type string
      "confidence": "certain", // certain | high | medium | low
      "file": "/path/to/UserService.php",
      "line": 23
    }
  ],
  "warnings": [
    { "type": "dynamic_instantiation", "file": "...", "line": 45, "message": "..." }
  ]
}
```

After `data-loader.js` processing, `state.data.classes` is a `Map<fqcn, cls>` where each cls also has:
- `external: boolean` — true if the class appears only as an edge endpoint, not in the `classes` array
- `namespace: string` — first 2 segments for internal (e.g. `App\Service`), first segment for external

---

## Namespace Navigation

### Two view modes (toggled by breadcrumb button)

- **`folders`** (default) — each graph node = one namespace folder or one leaf class at the current scope
- **`classes`** — all individual classes under the scope, grouped visually into `namespace-container` compound nodes

### Key functions (namespace-browser.js)

```js
navigateToScope(nsPath)   // e.g. navigateToScope('App\\Services') — drills in; '' = root
getCurrentScope()         // returns currentScope array, e.g. ['App', 'Services']
getViewMode()             // 'folders' | 'classes'
setViewMode(mode)         // switch view mode and rebuild graph
initNamespaceBrowser(data) // call once on data load (called by graph-renderer.initGraph)

buildNamespaceElementsAtScope(data, scope)  // returns Cytoscape elements for folders view
buildClassElementsAtScope(data, scope)      // returns Cytoscape elements for classes view
```

### Node ID conventions

- Namespace folder node: `ns::<nsPath>` e.g. `ns::App\Services`
- Namespace container (classes view): `ns-container::<nsPath>`
- Class node: the FQCN itself e.g. `App\Services\UserService`

### Rebuild trigger

Emit `EVENTS.NAMESPACE_REBUILD` to re-render the graph at the current scope. `graph-renderer.js` listens and calls the appropriate `buildXElementsAtScope` function.

---

## Graph Rendering (graph-renderer.js)

- **Library**: Cytoscape.js (loaded as global via `vendor/cytoscape.min.js`)
- **Layouts**: `fcose` (default, force-directed), `cose` (fallback) — both loaded via vendor scripts
- **Large dataset guard**: >2000 nodes → only top-N most-connected rendered

### Node visual rules

| nodeType | Shape | Color | Notes |
|---|---|---|---|
| `class` (type=class) | ellipse | `#3B82F6` blue | size ∝ degree |
| `class` (type=interface) | diamond | `#8B5CF6` purple | |
| `class` (type=trait) | hexagon | `#F59E0B` amber | |
| `class` (type=enum) | rectangle | `#10B981` green | |
| external class | ellipse | `#9CA3AF` gray | dashed border |
| `namespace` | roundrectangle | `#0F4C81` dark blue | size ∝ classCount, clickable |
| `namespace-container` | roundrectangle | `#1E3A5F` 35% opacity | compound parent in classes view |

### CSS classes on nodes

- `.in-cycle` — red border, part of a circular dependency
- `.dimmed` — 15% opacity in focus mode
- `.highlighted` — yellow border for selected node
- `.search-match` — orange border from search

### Key functions

```js
initGraph(data)           // init Cytoscape, wire events, called once
runLayout(name)           // 'fcose' | 'cose', auto-degrades to grid for >1500 nodes
focusNode(nodeId, depth)  // dim everything except neighborhood
resetFocus()              // clear all dimming
markCycleNodes(cycles)    // add .in-cycle class to cyclic nodes
```

---

## Left Sidebar Filters (filter-manager.js)

Filters: type (class/interface/trait/enum), confidence (certain/high/medium/low), namespace, show external.

- Namespace nodes (`nodeType === 'namespace'` or `'namespace-container'`) are **always shown** — they are navigational, not filterable.
- Changing filters emits `EVENTS.FILTERS_APPLIED`.

---

## Right Sidebar Detail Panel (detail-panel.js)

Listens to `EVENTS.NODE_SELECTED` and `EVENTS.EDGE_SELECTED`. Shows:
- Node: type chip, FQCN, file:line, fan-in/fan-out counts, focus depth controls, clickable dep/dependant lists
- Edge: confidence, type, source → target

Clicking a dep/dependant in the list emits `EVENTS.NODE_SELECTED` for that FQCN.

---

## Search (search.js)

- Searches all FQCNs in `state.data.classes`
- Highlights matching nodes in the graph with `.search-match`
- If the target node is not in the current view, calls `navigateToScope` to the node's parent namespace then centers/selects after a 600ms delay (waiting for layout)

---

## Data Loading (data-loader.js)

1. Try `fetch('data.json')` — works when served over HTTP
2. Fallback to drag-and-drop / file picker (`#drop-zone`) — works with `file://`
3. JSON parsing and cycle detection run in an inline Web Worker (blob URL) to avoid blocking the main thread
4. Cycle detection: DFS, capped at 50 cycles, skipped for >3000 nodes

---

## HTML Layout

```
<header.topbar>
  .topbar__left   → title + #meta-stats
  .topbar__center → #search-input / #search-results
  .topbar__right  → #btn-new-analysis, #btn-export-png, #warnings-badge / #warnings-list

<div.main-layout>
  <aside.sidebar--left>  → #filters (filter-manager)
  <main.graph-area>
    #ns-breadcrumb        ← breadcrumb + view-mode toggle button
    #cy                   ← Cytoscape canvas
    #large-dataset-banner
    #loading              ← spinner overlay
    #drop-zone            ← file picker fallback
  <aside.sidebar--right> → #detail-panel (detail-panel)
```

---

## Vendor Libraries (loaded globally before app.bundle.js)

- `cytoscape.min.js` → global `cytoscape`
- `layout-base.min.js` + `cose-base.min.js` → required by fcose
- `cytoscape-fcose.min.js` → registers `fcose` layout on the `cytoscape` global

Do not replace or update vendor files without checking compatibility.
