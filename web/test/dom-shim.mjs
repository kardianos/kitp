// Minimal DOM shim for control/not-found tests under node --test. Just enough
// of the Element surface the controls touch — no jsdom dependency (keeps the
// test runner dependency-light as required).

class ClassList {
  constructor() {
    this.set = new Set();
  }
  add(...cs) {
    for (const c of cs) this.set.add(c);
  }
  contains(c) {
    return this.set.has(c);
  }
  toString() {
    return [...this.set].join(' ');
  }
}

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.classList = new ClassList();
    this.style = {};
    this._text = '';
    this.tabIndex = 0;
    this.listeners = new Map();
  }
  set className(v) {
    this._className = v;
    this.classList = new ClassList();
    for (const c of String(v).split(/\s+/).filter(Boolean)) this.classList.add(c);
  }
  get className() {
    return this._className ?? '';
  }
  set textContent(v) {
    this._text = String(v);
    this.children = [];
  }
  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map((c) => c.textContent).join('');
  }
  append(...nodes) {
    for (const n of nodes) {
      n.parentNode = this;
      this.children.push(n);
    }
  }
  appendChild(n) {
    n.parentNode = this;
    this.children.push(n);
    return n;
  }
  insertBefore(n, ref) {
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(n);
    else this.children.splice(i, 0, n);
    n.parentNode = this;
    return n;
  }
  remove() {
    if (this.parentNode) {
      const i = this.parentNode.children.indexOf(this);
      if (i >= 0) this.parentNode.children.splice(i, 1);
      this.parentNode = null;
    }
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  querySelector() {
    return null;
  }
  addEventListener(t, h) {
    if (!this.listeners.has(t)) this.listeners.set(t, []);
    this.listeners.get(t).push(h);
  }
  removeEventListener(t, h) {
    const arr = this.listeners.get(t);
    if (arr) this.listeners.set(t, arr.filter((x) => x !== h));
  }
  // Test helper: recursively find descendants by data-control type.
  findByControl(type) {
    const out = [];
    const walk = (el) => {
      if (el.dataset && el.dataset.control === type) out.push(el);
      for (const c of el.children ?? []) walk(c);
    };
    walk(this);
    return out;
  }
}

export function installDomShim() {
  const doc = {
    createElement: (tag) => new FakeElement(tag),
  };
  globalThis.document = doc;
  globalThis.HTMLElement = FakeElement;
  return { FakeElement };
}
