/**
 * The linked particle cloud at the centre of the desktop.
 *
 * Ported from the earlier Electron MVP's command-centre core (agentic-os
 * `canvas/ParticleCore.tsx`): two concentric shells of drifting dots, webbed
 * together by short links, spinning about the vertical axis. Kept free of
 * canvas APIs so the maths can be unit-tested without a DOM.
 *
 * Radii, reach and speed are expressed as fractions of the shell radius rather
 * than in pixels, because unlike the MVP this cloud lives in a stage that
 * resizes with the window.
 */

export interface CloudParticle {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  /** Index into the tone palette - which of the four ARMS colours this dot wears. */
  tone: number
  /** A few degrees of hue drift, so a tone reads as a family, not a flat swatch. */
  drift: number
}

export interface ShellSpec {
  count: number
  /** Inner and outer face of the spherical shell, as fractions of the radius. */
  min: number
  max: number
  /** Perspective focal length, also a fraction; larger flattens the depth. */
  focal: number
  /** Link reach, as a fraction of the radius. */
  link: number
  /** Drift speed per frame, as a fraction of the radius. */
  speed: number
}

/**
 * The dense cloud at the middle. Tighter than the MVP's relative radius on
 * purpose: this stage is far bigger than the MVP's 320px box, and the same
 * spread there reads as scattered specks here rather than as one cloud.
 */
export const CORE: ShellSpec = {
  count: 420,
  min: 0,
  max: 0.5,
  focal: 1.27,
  link: 0.19,
  speed: 0.0008
}

/**
 * The sparse shell around it: far fewer dots over a much larger volume, a
 * longer link reach so the thin scatter still webs up, and a slower spin so it
 * lags the core and reads as depth rather than as one big cloud.
 */
export const HALO: ShellSpec = {
  count: 96,
  min: 0.73,
  max: 1,
  focal: 4.4,
  link: 0.37,
  speed: 0.0003
}

/** Deterministic LCG, so the cloud looks the same on every launch. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

export function createCloud(spec: ShellSpec, toneCount: number, seed = 1337): CloudParticle[] {
  const rand = seededRandom(seed)
  return Array.from({ length: spec.count }, () => {
    // Even through the volume, not clumped at the shell's inner face: the cube
    // root is what makes a uniform radius pick fill a sphere evenly.
    const theta = rand() * Math.PI * 2
    const phi = Math.acos(2 * rand() - 1)
    const r = spec.min + (spec.max - spec.min) * Math.cbrt(rand())
    return {
      x: r * Math.sin(phi) * Math.cos(theta),
      y: r * Math.sin(phi) * Math.sin(theta),
      z: r * Math.cos(phi),
      vx: (rand() - 0.5) * spec.speed,
      vy: (rand() - 0.5) * spec.speed,
      vz: (rand() - 0.5) * spec.speed,
      tone: Math.floor(rand() * toneCount),
      drift: (rand() - 0.5) * 16
    }
  })
}

/** Advance the cloud one frame, reflecting anything that leaves its shell. */
export function driftCloud(particles: CloudParticle[], spec: ShellSpec): void {
  for (const p of particles) {
    p.x += p.vx
    p.y += p.vy
    p.z += p.vz
    const d = Math.hypot(p.x, p.y, p.z)
    if (d > spec.max || d < spec.min) {
      p.vx = -p.vx
      p.vy = -p.vy
      p.vz = -p.vz
    }
  }
}

export interface CloudDot {
  /** Screen offset from the centre of the stage, in pixels. */
  sx: number
  sy: number
  /** Perspective factor: above 1 is nearer the viewer, below 1 is further. */
  k: number
  tone: number
  drift: number
}

/**
 * Spin about Y, then a weak perspective divide. `radius` converts the spec's
 * fractions into pixels, so one cloud serves every window size.
 */
export function projectCloud(
  particles: readonly CloudParticle[],
  spec: ShellSpec,
  spin: number,
  radius: number
): CloudDot[] {
  const cos = Math.cos(spin)
  const sin = Math.sin(spin)
  return particles.map((p) => {
    const x = p.x * cos - p.z * sin
    const z = p.x * sin + p.z * cos
    const k = spec.focal / (spec.focal + z)
    return { sx: x * k * radius, sy: p.y * k * radius, k, tone: p.tone, drift: p.drift }
  })
}

/**
 * Visit every pair of dots closer than `reach`, with a 0..1 closeness weight.
 *
 * Bucketed into a grid of `reach`-sized cells rather than compared pairwise:
 * this runs every frame in an app that sits in the tray all day, and the naive
 * O(n^2) version costs tens of thousands of comparisons per frame once the
 * cloud is scaled up for a maximized window.
 */
export function forEachLink(
  dots: readonly CloudDot[],
  reach: number,
  visit: (a: CloudDot, b: CloudDot, closeness: number) => void
): void {
  if (reach <= 0 || dots.length < 2) return

  const cells = new Map<string, number[]>()
  const cellOf = (dot: CloudDot): string =>
    `${Math.floor(dot.sx / reach)},${Math.floor(dot.sy / reach)}`

  dots.forEach((dot, i) => {
    const key = cellOf(dot)
    const bucket = cells.get(key)
    if (bucket) bucket.push(i)
    else cells.set(key, [i])
  })

  const reach2 = reach * reach

  dots.forEach((a, i) => {
    const cx = Math.floor(a.sx / reach)
    const cy = Math.floor(a.sy / reach)
    // Nine cells cover every point within `reach` of this one.
    for (let gx = cx - 1; gx <= cx + 1; gx += 1) {
      for (let gy = cy - 1; gy <= cy + 1; gy += 1) {
        const bucket = cells.get(`${gx},${gy}`)
        if (!bucket) continue
        for (const j of bucket) {
          // Each pair is visited once, by its lower index.
          if (j <= i) continue
          const b = dots[j]
          if (!b) continue
          const dx = a.sx - b.sx
          const dy = a.sy - b.sy
          const d2 = dx * dx + dy * dy
          if (d2 > reach2) continue
          visit(a, b, 1 - Math.sqrt(d2) / reach)
        }
      }
    }
  })
}
