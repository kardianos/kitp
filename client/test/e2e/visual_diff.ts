// PNG-vs-PNG visual diff for the e2e harness.
//
// Uses `pngjs` to decode and `pixelmatch` to compute per-pixel diff. A
// failing diff (ratio > threshold) produces a `.diff.png` next to the
// actual file showing the changed pixels in red — handy for human review
// in PRs.

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export interface DiffResult {
  /** True when the actual and baseline match within the configured threshold. */
  same: boolean;
  /** Number of pixels that differ. */
  diffPixels: number;
  /** Total pixels compared (max of the two image areas). */
  totalPixels: number;
  /** diffPixels / totalPixels. */
  ratio: number;
  /** Path to the written diff PNG, when a diff existed. */
  diffPath?: string;
}

interface DimensionMismatch {
  actualWidth: number;
  actualHeight: number;
  baselineWidth: number;
  baselineHeight: number;
}

/**
 * Compare `actual` PNG against `baseline` PNG. When any pixels differ,
 * a side-by-side `<actual>.diff.png` is written next to the actual.
 *
 * Threshold is the maximum acceptable ratio of diffPixels / totalPixels.
 * Default 0.005 (0.5%) per the migration plan §8.5.
 *
 * If the two images have different dimensions we treat the entire frame
 * as different rather than crashing — this surfaces layout regressions.
 */
export async function diffPng(
  actual: string,
  baseline: string,
  threshold = 0.005,
): Promise<DiffResult> {
  const [actualBuf, baselineBuf] = await Promise.all([
    fs.readFile(actual),
    fs.readFile(baseline),
  ]);
  const actualPng = PNG.sync.read(actualBuf);
  const baselinePng = PNG.sync.read(baselineBuf);

  // Dimension mismatch -> count the entire larger frame as different.
  if (
    actualPng.width !== baselinePng.width ||
    actualPng.height !== baselinePng.height
  ) {
    const mismatch: DimensionMismatch = {
      actualWidth: actualPng.width,
      actualHeight: actualPng.height,
      baselineWidth: baselinePng.width,
      baselineHeight: baselinePng.height,
    };
    const diffPath = `${actual}.diff.png`;
    await writeDimensionDiffMarker(actualPng, diffPath, mismatch);
    const totalPixels = Math.max(
      actualPng.width * actualPng.height,
      baselinePng.width * baselinePng.height,
    );
    return {
      same: false,
      diffPixels: totalPixels,
      totalPixels,
      ratio: 1,
      diffPath,
    };
  }

  const { width, height } = actualPng;
  const totalPixels = width * height;
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(
    actualPng.data,
    baselinePng.data,
    diff.data,
    width,
    height,
    { threshold: 0.1, includeAA: false },
  );

  const ratio = totalPixels === 0 ? 0 : diffPixels / totalPixels;
  const same = ratio <= threshold;

  let diffPath: string | undefined;
  if (diffPixels > 0) {
    diffPath = `${actual}.diff.png`;
    await fs.mkdir(dirname(diffPath), { recursive: true });
    await fs.writeFile(diffPath, PNG.sync.write(diff));
  }

  const result: DiffResult = { same, diffPixels, totalPixels, ratio };
  if (diffPath !== undefined) result.diffPath = diffPath;
  return result;
}

/**
 * When dimensions differ we can't run pixelmatch directly. Write a copy
 * of the actual PNG with a magenta border so reviewers see at a glance
 * that the diff is geometric, not pixel-level.
 */
async function writeDimensionDiffMarker(
  actualPng: PNG,
  outPath: string,
  m: DimensionMismatch,
): Promise<void> {
  const { width, height } = actualPng;
  const out = new PNG({ width, height });
  out.data.set(actualPng.data);
  // Paint a 4-pixel magenta border to flag the dimension mismatch visually.
  const border = 4;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const onBorder =
        x < border || x >= width - border || y < border || y >= height - border;
      if (!onBorder) continue;
      const idx = (y * width + x) * 4;
      out.data[idx + 0] = 0xff;
      out.data[idx + 1] = 0x00;
      out.data[idx + 2] = 0xff;
      out.data[idx + 3] = 0xff;
    }
  }
  await fs.mkdir(dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, PNG.sync.write(out));
  // Touch the unused mismatch object so TS doesn't complain about an
  // unused parameter; keeping the field around is useful for callers
  // that may want to log it.
  void m;
}
