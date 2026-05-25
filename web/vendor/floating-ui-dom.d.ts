// Hand-authored type surface for the vendored @floating-ui/dom bundle
// (vendor/floating-ui-dom.js, bundled from @floating-ui/dom@1.7.6 +
// @floating-ui/core@1.7.5 + @floating-ui/utils@0.2.11).
//
// The upstream .d.mts re-imports dozens of cross-package types from
// '@floating-ui/core' / '@floating-ui/utils', which we did NOT vendor as
// separate type packages. Rather than vendor + rewrite that whole type graph,
// this declares exactly the surface web/src/ui/popover.ts consumes — the one
// place floating-ui is used (single-floating-impl discipline). Widen here if a
// future primitive needs more middleware. Resolved as the sibling .d.ts to the
// `./floating-ui-dom.js` import under tsconfig's Bundler resolution, mirroring
// how vendor/dompurify.d.ts / vendor/marked.d.ts type their .js bundles.

export type Alignment = 'start' | 'end';
export type Side = 'top' | 'right' | 'bottom' | 'left';
export type AlignedPlacement = `${Side}-${Alignment}`;
export type Placement = Side | AlignedPlacement;
export type Strategy = 'absolute' | 'fixed';

export interface Coords {
  x: number;
  y: number;
}
export interface Dimensions {
  width: number;
  height: number;
}
export interface Rect extends Coords, Dimensions {}
export interface ElementRects {
  reference: Rect;
  floating: Rect;
}

export interface ComputePositionReturn extends Coords {
  placement: Placement;
  strategy: Strategy;
  middlewareData: Record<string, unknown>;
}

// The DOM bundle's Middleware is intentionally opaque to consumers — they
// build instances via the factory helpers below and pass them in an array.
export interface Middleware {
  name: string;
  options?: unknown;
  fn: (state: unknown) => unknown | Promise<unknown>;
}

export interface ComputePositionConfig {
  placement?: Placement;
  strategy?: Strategy;
  middleware?: Array<Middleware | null | undefined | false>;
}

export function computePosition(
  reference: Element,
  floating: HTMLElement,
  config?: ComputePositionConfig,
): Promise<ComputePositionReturn>;

export interface AutoUpdateOptions {
  ancestorScroll?: boolean;
  ancestorResize?: boolean;
  elementResize?: boolean;
  layoutShift?: boolean;
  animationFrame?: boolean;
}

export function autoUpdate(
  reference: Element,
  floating: HTMLElement,
  update: () => void,
  options?: AutoUpdateOptions,
): () => void;

export interface OffsetOptions {
  mainAxis?: number;
  crossAxis?: number;
  alignmentAxis?: number | null;
}
export function offset(value?: number | OffsetOptions): Middleware;

export interface FlipOptions {
  mainAxis?: boolean;
  crossAxis?: boolean | 'alignment';
  fallbackPlacements?: Placement[];
  padding?: number;
}
export function flip(options?: FlipOptions): Middleware;

export interface ShiftOptions {
  mainAxis?: boolean;
  crossAxis?: boolean;
  padding?: number;
}
export function shift(options?: ShiftOptions): Middleware;

export interface SizeApplyState {
  rects: ElementRects;
  elements: { reference: Element; floating: HTMLElement };
  availableWidth: number;
  availableHeight: number;
  placement: Placement;
}
export interface SizeOptions {
  apply?: (state: SizeApplyState) => void | Promise<void>;
  padding?: number;
}
export function size(options?: SizeOptions): Middleware;
