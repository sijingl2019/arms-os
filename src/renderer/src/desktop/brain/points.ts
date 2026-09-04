/**
 * Turning the brain silhouette into a point cloud.
 *
 * Kept free of canvas APIs on purpose: the sampler takes a `classify` callback,
 * so the renderer can back it with a rasterised mask while tests back it with
 * plain arithmetic. Everything here is deterministic for a given seed.
 */

/** 0 outside the brain, 1 inside it, 2 on a fold (drawn brighter). */
export type Region = 0 | 1 | 2

export interface BrainPoint {
  /** Design-space coordinates, centred on the silhouette's midpoint. */
  x: number
  y: number
  /** Depth in the same units, giving the rotation something to parallax. */
  z: number
  /** Twinkle phase offset, so points do not blink in unison. */
  phase: number
  /** Twinkle speed multiplier. */
  speed: number
  /** Base brightness before twinkle and depth are applied. */
  brightness: number
  /** Draw a cross-shaped flare on this one. */
  star: boolean
}

export interface DecorateOptions {
  width: number
  height: number
  /** Half-thickness of the slab the points are spread through. */
  depth?: number
  seed?: number
}

export interface SampleOptions extends DecorateOptions {
  /** Target number of points. Fewer are returned if the shape is tiny. */
  count: number
}

/** A position with nothing but its coordinates and whether it is on a fold. */
export interface RawPoint {
  x: number
  y: number
  ridge: boolean
}

/**
 * Small deterministic PRNG. `Math.random` would make the cloud reshuffle on
 * every resize and make the sampler untestable.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Give up rather than spin forever when `classify` rejects nearly everything. */
const MAX_ATTEMPTS_PER_POINT = 40

/**
 * Give raw positions the per-point character the renderer needs: depth,
 * twinkle, brightness and the occasional flare. Coordinates come back centred
 * on the design space, which is what `project` expects.
 */
export function decoratePoints(raw: readonly RawPoint[], opts: DecorateOptions): BrainPoint[] {
  const { width, height } = opts
  const depth = opts.depth ?? Math.min(width, height) * 0.16
  const random = mulberry32(opts.seed ?? 0x5eed)
  const cx = width / 2
  const cy = height / 2

  return raw.map((point) => ({
    x: point.x - cx,
    y: point.y - cy,
    // Cluster depth toward the middle of the slab so the silhouette stays
    // readable from the front instead of smearing into a rectangle.
    z: (random() + random() - 1) * depth,
    phase: random() * Math.PI * 2,
    speed: 0.6 + random() * 1.8,
    brightness: point.ridge ? 0.72 + random() * 0.28 : 0.22 + random() * 0.3,
    // Fold points carry most of the flares; that is where the eye already is.
    star: random() < (point.ridge ? 0.1 : 0.015)
  }))
}

/**
 * Fill the interior of a shape by rejection sampling. This is the body of the
 * cloud; the outline and the folds are sampled along their paths instead, which
 * is what keeps them reading as lines rather than as denser noise.
 */
export function samplePoints(
  classify: (x: number, y: number) => Region,
  opts: SampleOptions
): BrainPoint[] {
  const { width, height, count } = opts
  const random = mulberry32((opts.seed ?? 0x5eed) ^ 0x9e37)

  const raw: RawPoint[] = []
  let attempts = 0
  const budget = count * MAX_ATTEMPTS_PER_POINT

  while (raw.length < count && attempts < budget) {
    attempts += 1
    const x = random() * width
    const y = random() * height
    const region = classify(x, y)
    if (region === 0) continue
    raw.push({ x, y, ridge: region === 2 })
  }

  return decoratePoints(raw, opts)
}

/**
 * Spread `count` points along a polyline, with a little perpendicular jitter so
 * the result is a drawn line rather than a mechanically even dotted one.
 *
 * The polyline itself is measured elsewhere - this module stays free of SVG and
 * canvas APIs so it can be tested without a DOM.
 */
export function samplePolyline(
  polyline: readonly RawPoint[],
  count: number,
  jitter: number,
  seed: number
): RawPoint[] {
  if (polyline.length === 0 || count <= 0) return []
  const random = mulberry32(seed)
  const out: RawPoint[] = []

  for (let i = 0; i < count; i += 1) {
    // Walk the vertices proportionally; they are already evenly spaced by arc
    // length, so an index is a position along the curve.
    const t = (i + random() * 0.9) / count
    const at = Math.min(polyline.length - 1, Math.floor(t * polyline.length))
    const here = polyline[at]
    if (!here) continue
    const next = polyline[Math.min(polyline.length - 1, at + 1)] ?? here
    // Offset perpendicular to the local direction, so jitter thickens the line
    // instead of smearing it along its own length.
    const dx = next.x - here.x
    const dy = next.y - here.y
    const len = Math.hypot(dx, dy) || 1
    const offset = (random() * 2 - 1) * jitter
    out.push({
      x: here.x + (-dy / len) * offset,
      y: here.y + (dx / len) * offset,
      ridge: here.ridge
    })
  }

  return out
}

export interface Projection {
  x: number
  y: number
  /** 1 at the slab's centre, larger when the point is closer to the viewer. */
  scale: number
  /** 0 at the back of the slab, 1 at the front. Used for fading. */
  depth01: number
}

/**
 * Rotate a point about the vertical axis and project it with a weak
 * perspective. `focal` controls how strong the parallax is; larger is flatter.
 */
export function project(point: BrainPoint, angle: number, focal: number): Projection {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const rx = point.x * cos + point.z * sin
  const rz = point.z * cos - point.x * sin
  const scale = focal / Math.max(focal - rz, 1)
  return {
    x: rx * scale,
    y: point.y * scale,
    scale,
    depth01: Math.min(1, Math.max(0, 0.5 + rz / (focal * 2)))
  }
}

/** Twinkle factor in [0, 1] for one point at time `t` (seconds). */
export function twinkle(point: BrainPoint, t: number): number {
  return 0.55 + 0.45 * Math.sin(t * point.speed + point.phase)
}
