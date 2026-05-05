// Minimal type declarations for the `pixelmatch` package, which ships
// untyped at version 6.x. Mirrors the documented signature in the
// package README.

declare module 'pixelmatch' {
  interface PixelmatchOptions {
    threshold?: number;
    includeAA?: boolean;
    alpha?: number;
    aaColor?: [number, number, number];
    diffColor?: [number, number, number];
    diffColorAlt?: [number, number, number];
    diffMask?: boolean;
  }

  /**
   * Compare two images pixel by pixel and produce a diff image.
   * Returns the number of differing pixels.
   */
  export default function pixelmatch(
    img1: Uint8Array | Buffer,
    img2: Uint8Array | Buffer,
    output: Uint8Array | Buffer | null,
    width: number,
    height: number,
    options?: PixelmatchOptions,
  ): number;
}
