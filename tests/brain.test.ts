import { describe, expect, it } from 'vitest'
import {
  createField,
  createOrbits,
  orbitPoint,
  stepField,
  wrapAngle
} from '@renderer/desktop/brain/field'
import {
  mulberry32,
  project,
  samplePoints,
  twinkle,
  type Region
} from '@renderer/desktop/brain/points'

/** Stand-in for the rasterised silhouette: a centred disc, plus a ridge ring. */
function disc(width: number, height: number): (x: number, y: number) => Region {
  const cx = width / 2
  const cy = height / 2
  const r = Math.min(width, height) / 2
  return (x, y) => {
    const d = Math.hypot(x - cx, y - cy)
    if (d > r) return 0
    return d > r * 0.8 ? 2 : 1
  }
}

describe('samplePoints', () => {
  const opts = { width: 200, height: 160, count: 400 }

  it('only keeps points the classifier accepts', () => {
    const classify = disc(opts.width, opts.height)
    const points = samplePoints(classify, opts)
    for (const p of points) {
      // Points come back centred on the shape, so undo that to re-classify.
      expect(classify(p.x + opts.width / 2, p.y + opts.height / 2)).not.toBe(0)
    }
  })

  it('reaches the requested count for a shape that fills much of the box', () => {
    expect(samplePoints(disc(opts.width, opts.height), opts)).toHaveLength(opts.count)
  })

  it('is deterministic for a seed, so a resize does not reshuffle the cloud', () => {
    const a = samplePoints(disc(opts.width, opts.height), { ...opts, seed: 7 })
    const b = samplePoints(disc(opts.width, opts.height), { ...opts, seed: 7 })
    expect(a).toEqual(b)
    const c = samplePoints(disc(opts.width, opts.height), { ...opts, seed: 8 })
    expect(c).not.toEqual(a)
  })

  it('gives up instead of looping forever when nothing is inside the shape', () => {
    expect(samplePoints(() => 0, opts)).toEqual([])
  })

  it('keeps depth inside the requested slab', () => {
    const depth = 12
    for (const p of samplePoints(disc(opts.width, opts.height), { ...opts, depth })) {
      expect(Math.abs(p.z)).toBeLessThanOrEqual(depth)
    }
  })

  it('marks fold points brighter than body points', () => {
    const points = samplePoints(disc(opts.width, opts.height), { ...opts, count: 800 })
    const stars = points.filter((p) => p.star)
    // Flares are rare on purpose; if this ever hits every point the twinkle
    // layer has stopped being a highlight.
    expect(stars.length).toBeGreaterThan(0)
    expect(stars.length).toBeLessThan(points.length / 4)
  })
})

describe('project', () => {
  const point = { x: 40, y: 10, z: 0, phase: 0, speed: 1, brightness: 0.5, star: false }

  it('leaves an unrotated point where it started', () => {
    const p = project({ ...point, z: 0 }, 0, 160)
    expect(p.x).toBeCloseTo(40)
    expect(p.y).toBeCloseTo(10)
    expect(p.scale).toBeCloseTo(1)
  })

  it('swings x through zero over a quarter turn', () => {
    expect(project(point, Math.PI / 2, 160).x).toBeCloseTo(0, 5)
  })

  it('magnifies a point rotated toward the viewer and shrinks one rotated away', () => {
    const near = project(point, -Math.PI / 2, 160)
    const far = project(point, Math.PI / 2, 160)
    expect(near.scale).toBeGreaterThan(1)
    expect(far.scale).toBeLessThan(1)
    expect(near.depth01).toBeGreaterThan(far.depth01)
  })
})

describe('twinkle', () => {
  it('stays within the visible range for any time', () => {
    const point = { x: 0, y: 0, z: 0, phase: 1.2, speed: 1.7, brightness: 0.5, star: false }
    for (let t = 0; t < 20; t += 0.37) {
      const value = twinkle(point, t)
      expect(value).toBeGreaterThanOrEqual(0.1)
      expect(value).toBeLessThanOrEqual(1)
    }
  })
})

describe('wrapAngle', () => {
  it('maps any input into one turn', () => {
    expect(wrapAngle(0)).toBeCloseTo(0)
    expect(wrapAngle(Math.PI * 2)).toBeCloseTo(0)
    expect(wrapAngle(-0.5)).toBeCloseTo(Math.PI * 2 - 0.5)
    expect(wrapAngle(-Math.PI * 9)).toBeGreaterThanOrEqual(0)
    expect(wrapAngle(Math.PI * 9)).toBeLessThan(Math.PI * 2)
  })
})

describe('field', () => {
  const orbits = createOrbits(100)

  it('spreads particles over every orbit', () => {
    const particles = createField(orbits, 10)
    expect(particles).toHaveLength(orbits.length * 10)
    for (const orbit of orbits.keys()) {
      expect(particles.filter((p) => p.orbit === orbit)).toHaveLength(10)
    }
  })

  it('sends alternating orbits in opposite directions', () => {
    const particles = createField(orbits, 5)
    expect(particles.filter((p) => p.speed > 0).length).toBeGreaterThan(0)
    expect(particles.filter((p) => p.speed < 0).length).toBeGreaterThan(0)
  })

  it('keeps angles inside one turn no matter how long it runs', () => {
    const particles = createField(orbits, 6)
    for (let i = 0; i < 500; i += 1) stepField(particles, 0.5)
    for (const p of particles) {
      expect(p.angle).toBeGreaterThanOrEqual(0)
      expect(p.angle).toBeLessThan(Math.PI * 2)
    }
  })

  it('moves every particle along its own orbit', () => {
    const particles = createField(orbits, 4)
    const before = particles.map((p) => p.angle)
    stepField(particles, 1)
    particles.forEach((p, i) => {
      expect(p.angle).not.toBe(before[i])
      expect(wrapAngle((before[i] ?? 0) + p.speed)).toBeCloseTo(p.angle)
    })
  })
})

describe('orbitPoint', () => {
  it('places points on the untilted ellipse', () => {
    const orbit = { radiusX: 100, radiusY: 40, tilt: 0 }
    const p = orbitPoint(orbit, 0)
    expect(p.x).toBeCloseTo(100)
    expect(p.y).toBeCloseTo(0)
    const q = orbitPoint(orbit, Math.PI / 2)
    expect(q.x).toBeCloseTo(0)
    expect(q.y).toBeCloseTo(40)
  })

  it('rotates the ellipse by its tilt without changing its radius', () => {
    const tilt = 0.7
    const orbit = { radiusX: 100, radiusY: 40, tilt }
    const p = orbitPoint(orbit, 0)
    expect(Math.hypot(p.x, p.y)).toBeCloseTo(100)
    expect(Math.atan2(p.y, p.x)).toBeCloseTo(tilt)
  })

  it('splits the ring into a near half and a far half', () => {
    const orbit = { radiusX: 100, radiusY: 40, tilt: 0 }
    expect(orbitPoint(orbit, Math.PI / 2).front).toBe(true)
    expect(orbitPoint(orbit, (Math.PI * 3) / 2).front).toBe(false)
  })
})

describe('mulberry32', () => {
  it('produces a repeatable stream in [0, 1)', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    for (let i = 0; i < 50; i += 1) {
      const value = a()
      expect(value).toBe(b())
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })
})
