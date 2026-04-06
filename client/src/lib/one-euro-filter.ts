/**
 * One Euro Filter — TypeScript port from XR Animator's one_euro_filter.js
 * https://gist.github.com/3846masa/5628f711e86fd62bea56b18e32177c60
 *
 * Provides adaptive low-pass filtering: aggressive at rest (no jitter),
 * transparent during fast motion (no lag). This is the key technique XR Animator
 * uses to make avatar tracking feel snappy without being jittery.
 *
 * Usage (Vec3, for landmark filtering):
 *   const f = new OneEuroFilter(30, 1.0, 0.5, 1.0);
 *   const filtered = f.filterVec3([x, y, z], performance.now());
 */

// ── Scalar low-pass filter ────────────────────────────────────────────────────

class ScalarLPF {
  private alpha: number;
  private raw: number | null = null;
  private smoothed: number | null = null;

  constructor(alpha: number) { this.alpha = alpha; }

  setAlpha(a: number) { this.alpha = a; }
  lastRaw() { return this.raw; }

  filter(value: number, alpha?: number): number {
    if (alpha !== undefined) this.setAlpha(alpha);
    const s = this.raw === null ? value : this.alpha * value + (1 - this.alpha) * this.smoothed!;
    this.raw = value;
    this.smoothed = s;
    return s;
  }
}

// ── Vec3 low-pass filter ──────────────────────────────────────────────────────

class Vec3LPF {
  private alpha: number;
  private raw:      [number, number, number] | null = null;
  private smoothed: [number, number, number] | null = null;

  constructor(alpha: number) { this.alpha = alpha; }

  setAlpha(a: number) { this.alpha = a; }
  lastRaw() { return this.raw; }

  filter(v: [number, number, number], alpha?: number): [number, number, number] {
    if (alpha !== undefined) this.setAlpha(alpha);
    const s: [number, number, number] =
      this.raw === null
        ? [v[0], v[1], v[2]]
        : [
            this.alpha * v[0] + (1 - this.alpha) * this.smoothed![0],
            this.alpha * v[1] + (1 - this.alpha) * this.smoothed![1],
            this.alpha * v[2] + (1 - this.alpha) * this.smoothed![2],
          ];
    this.raw = [v[0], v[1], v[2]];
    this.smoothed = s;
    return s;
  }
}

// ── One Euro Filter (Vec3) ────────────────────────────────────────────────────

export class OneEuroFilter {
  private freq: number;
  readonly minCutOff: number;
  readonly beta: number;
  readonly dCutOff: number;

  private xFilt: Vec3LPF;
  private dxFilt: Vec3LPF;
  private lastTs: number | null = null;

  /**
   * @param freq      Nominal sample rate in Hz (updated dynamically each call)
   * @param minCutOff Minimum cutoff frequency — lower = more smoothing at rest
   * @param beta      Speed coefficient — higher = less lag during fast motion
   * @param dCutOff   Derivative cutoff frequency
   */
  constructor(freq = 30, minCutOff = 1.0, beta = 0.5, dCutOff = 1.0) {
    this.freq     = freq;
    this.minCutOff = minCutOff;
    this.beta     = beta;
    this.dCutOff  = dCutOff;
    this.xFilt    = new Vec3LPF(this.alpha(minCutOff));
    this.dxFilt   = new Vec3LPF(this.alpha(dCutOff));
  }

  private alpha(cutOff: number): number {
    const te  = 1.0 / this.freq;
    const tau = 1.0 / (2 * Math.PI * cutOff);
    return 1.0 / (1.0 + tau / te);
  }

  filterVec3(x: [number, number, number], timestamp?: number): [number, number, number] {
    // Update frequency from real elapsed time to adapt across frame rate changes
    if (this.lastTs !== null && timestamp !== undefined) {
      const dt = Math.max((timestamp - this.lastTs) / 1000, 1 / 240);
      this.freq = 1.0 / dt;
    }
    this.lastTs = timestamp ?? this.lastTs;

    // Estimate derivative
    const prev = this.xFilt.lastRaw();
    const dx: [number, number, number] =
      prev === null
        ? [0, 0, 0]
        : [
            (x[0] - prev[0]) * this.freq,
            (x[1] - prev[1]) * this.freq,
            (x[2] - prev[2]) * this.freq,
          ];

    // Filter derivative
    const dxSmoothed = this.dxFilt.filter(dx, this.alpha(this.dCutOff));

    // Magnitude of derivative drives the adaptive cutoff
    const edx = Math.sqrt(
      dxSmoothed[0] ** 2 + dxSmoothed[1] ** 2 + dxSmoothed[2] ** 2
    );
    const cutOff = this.minCutOff + this.beta * edx;

    return this.xFilt.filter(x, this.alpha(cutOff));
  }

  /** Reset filter state — call when tracking is lost and regained */
  reset() {
    this.xFilt  = new Vec3LPF(this.alpha(this.minCutOff));
    this.dxFilt = new Vec3LPF(this.alpha(this.dCutOff));
    this.lastTs = null;
  }
}
