const bus = new EventTarget();

export function emit(name, detail) {
  bus.dispatchEvent(new CustomEvent(name, { detail }));
}

export function on(name, handler) {
  bus.addEventListener(name, (e) => handler(e.detail));
}

// Shared application state
export const state = {
  data: null,
  cy: null,
  cycles: [],
  selectedNode: null,
  focusDepth: 1,
  filtersActive: false,
};
