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
  remove(...cs) {
    for (const c of cs) this.set.delete(c);
  }
  toggle(c, force) {
    const has = this.set.has(c);
    const want = force === undefined ? !has : force;
    if (want) this.set.add(c);
    else this.set.delete(c);
    return want;
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
    this.attributes = {};
    // Common element props the real screen controls set directly.
    this.draggable = false;
    this.disabled = false;
    this.title = '';
    this.type = '';
    this.placeholder = '';
    this.value = '';
    this.selected = false;
    // Scroll-viewport surface the recycling virtual list reads. Plain numeric
    // fields the test sets directly; a real layout engine would derive them.
    this.scrollTop = 0;
    this.clientHeight = 0;
  }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
    // Mirror real DOM behaviour: setAttribute('data-foo-bar', v) writes
    // dataset.fooBar. Without this, code paths that go through the
    // bindAttr() helper (or the canonical setAttribute API) can't be
    // observed via .dataset reads in tests.
    if (typeof k === 'string' && k.startsWith('data-')) {
      const camel = k
        .slice(5)
        .replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
      this.dataset[camel] = String(v);
    }
  }
  getAttribute(k) {
    return k in this.attributes ? this.attributes[k] : null;
  }
  removeAttribute(k) {
    delete this.attributes[k];
    if (typeof k === 'string' && k.startsWith('data-')) {
      const camel = k
        .slice(5)
        .replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
      delete this.dataset[camel];
    }
  }
  hasAttribute(k) {
    return k in this.attributes;
  }
  // Class-selector querySelector/All ('.foo') + tag fallback. Enough for the
  // shell/screen-host body lookups the tests exercise.
  querySelector(sel) {
    return this._query(sel)[0] ?? null;
  }
  querySelectorAll(sel) {
    return this._query(sel);
  }
  _query(sel) {
    const out = [];
    const matches = (el) => {
      if (typeof sel !== 'string') return false;
      if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
      if (sel.startsWith('[') && sel.endsWith(']')) {
        // Support both presence `[data-foo]` and value `[data-foo="bar"]`
        // selectors. The value form is split on the first `=`.
        const inner = sel.slice(1, -1);
        const eq = inner.indexOf('=');
        const rawName = (eq === -1 ? inner : inner.slice(0, eq)).replace(/^data-/, '');
        const ds = rawName.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        if (!el.dataset || !(ds in el.dataset)) return false;
        if (eq === -1) return true;
        const want = inner.slice(eq + 1).replace(/^["']|["']$/g, '');
        return String(el.dataset[ds]) === want;
      }
      return el.tagName === String(sel).toUpperCase();
    };
    const walk = (el) => {
      for (const c of el.children ?? []) {
        if (matches(c)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  // Synchronous event dispatch — fires registered listeners for the type.
  dispatchEvent(ev) {
    const arr = this.listeners.get(ev.type) ?? [];
    if (ev.target === undefined) ev.target = this;
    if (typeof ev.preventDefault !== 'function') ev.preventDefault = () => {};
    if (typeof ev.stopPropagation !== 'function') ev.stopPropagation = () => {};
    for (const h of [...arr]) h(ev);
    return true;
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
      // A DocumentFragment splices its children in (matching real DOM).
      if (n && n.tagName === '#FRAGMENT') {
        for (const c of n.children.splice(0)) {
          c.parentNode = this;
          this.children.push(c);
        }
        continue;
      }
      n.parentNode = this;
      this.children.push(n);
    }
  }
  appendChild(n) {
    if (n && n.tagName === '#FRAGMENT') {
      this.append(n);
      return n;
    }
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
  replaceChildren(...nodes) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }
  get firstChild() {
    return this.children[0] ?? null;
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

// Minimal ResizeObserver stub: records observed targets and disconnect() so a
// test can assert the virtual list wires + tears it down. It does NOT fire
// automatically (no layout engine); a test triggers a resize by setting
// clientHeight and calling the handle's refresh(), which mirrors the same code
// path the real observer callback runs.
class FakeResizeObserver {
  static instances = [];
  constructor(cb) {
    this.cb = cb;
    this.targets = [];
    this.disconnected = false;
    FakeResizeObserver.instances.push(this);
  }
  observe(target) {
    this.targets.push(target);
  }
  disconnect() {
    this.disconnected = true;
    this.targets = [];
  }
  // Test helper: emulate a layout change firing the callback.
  trigger() {
    this.cb();
  }
}

export function installDomShim() {
  const html = new FakeElement('html');
  html.setAttribute('data-theme', 'light');
  // A minimal document-level event-listener surface so controls that wire a
  // document-tier keydown listener (e.g. the HelpOverlay's overlay-tier Esc/`?`
  // handler, the HotkeyController) work under the shim. dispatchEvent fires the
  // registered listeners synchronously — a test drives it directly.
  const docListeners = new Map();
  const doc = {
    // DOMPurify's init guard (vendor/dompurify.js) checks
    // `window.document.nodeType === 9` (DOCUMENT_NODE) + `window.Element`
    // before it defines `addHook`. The markdown module registers a hook at
    // import; any app.js test that transitively pulls it in (now incl.
    // TaskDetail) would crash with "addHook is not a function" without these.
    // The light shim never actually renders Markdown (only the jsdom-backed
    // markdown.test.mjs does), so this just lets the hook register harmlessly.
    nodeType: 9,
    createElement: (tag) => new FakeElement(tag),
    // A DocumentFragment is, for our purposes, just a transient container the
    // shim treats like an element: append() collects nodes, and append()-ing
    // the fragment elsewhere splices its children in.
    createDocumentFragment: () => new FakeElement('#fragment'),
    documentElement: html,
    // The currently-focused element, if any (FakeElement.focus sets it).
    activeElement: null,
    addEventListener(t, h) {
      if (!docListeners.has(t)) docListeners.set(t, []);
      docListeners.get(t).push(h);
    },
    removeEventListener(t, h) {
      const arr = docListeners.get(t);
      if (arr) docListeners.set(t, arr.filter((x) => x !== h));
    },
    dispatchEvent(ev) {
      const arr = docListeners.get(ev.type) ?? [];
      if (ev.target === undefined) ev.target = doc;
      if (typeof ev.preventDefault !== 'function') ev.preventDefault = () => {};
      if (typeof ev.stopPropagation !== 'function') ev.stopPropagation = () => {};
      for (const h of [...arr]) h(ev);
      return true;
    },
  };
  // FakeElement.focus records the active element so controls can restore focus.
  FakeElement.prototype.focus = function focus() {
    doc.activeElement = this;
  };

  // ---- History-API + location shim for the URL router ----
  // A minimal location/history pair so navigate()/popstate work under node
  // --test without jsdom. history maintains an entry stack; back()/forward()
  // move a cursor and dispatch a 'popstate' on the window. location reflects
  // the current entry's path. pushState/replaceState parse the path into
  // pathname + search. dispatchEvent fires window-level listeners synchronously.
  const winListeners = new Map();
  const win = {
    // See the `doc.nodeType` note: DOMPurify's init guard also requires
    // `window.document` + `window.Element` to be present to define addHook.
    get document() {
      return doc;
    },
    Element: FakeElement,
    addEventListener(t, h) {
      if (!winListeners.has(t)) winListeners.set(t, []);
      winListeners.get(t).push(h);
    },
    removeEventListener(t, h) {
      const arr = winListeners.get(t);
      if (arr) winListeners.set(t, arr.filter((x) => x !== h));
    },
    dispatchEvent(ev) {
      const arr = winListeners.get(ev.type) ?? [];
      for (const h of [...arr]) h(ev);
      return true;
    },
  };

  const loc = { pathname: '/', search: '' };
  const setLoc = (path) => {
    const qIdx = path.indexOf('?');
    if (qIdx === -1) {
      loc.pathname = path || '/';
      loc.search = '';
    } else {
      loc.pathname = path.slice(0, qIdx) || '/';
      loc.search = path.slice(qIdx);
    }
  };

  const stack = [{ state: null, path: '/' }];
  let cursor = 0;
  const hist = {
    get state() {
      return stack[cursor]?.state ?? null;
    },
    pushState(state, _title, path) {
      // Truncate any forward entries (matching real history semantics).
      stack.splice(cursor + 1);
      stack.push({ state, path });
      cursor = stack.length - 1;
      setLoc(path);
    },
    replaceState(state, _title, path) {
      stack[cursor] = { state, path };
      setLoc(path);
    },
    back() {
      if (cursor > 0) {
        cursor--;
        setLoc(stack[cursor].path);
        win.dispatchEvent({ type: 'popstate', state: stack[cursor].state });
      }
    },
    forward() {
      if (cursor < stack.length - 1) {
        cursor++;
        setLoc(stack[cursor].path);
        win.dispatchEvent({ type: 'popstate', state: stack[cursor].state });
      }
    },
  };

  globalThis.document = doc;
  globalThis.HTMLElement = FakeElement;
  globalThis.window = win;
  globalThis.location = loc;
  globalThis.history = hist;
  FakeResizeObserver.instances = [];
  globalThis.ResizeObserver = FakeResizeObserver;
  // Test helper: reset the URL to a starting path before a router test.
  const setPath = (path) => {
    setLoc(path);
    stack.length = 0;
    stack.push({ state: { path }, path });
    cursor = 0;
  };
  return { FakeElement, FakeResizeObserver, location: loc, history: hist, window: win, setPath };
}
