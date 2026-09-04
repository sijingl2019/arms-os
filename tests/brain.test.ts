import { describe, expect, it } from 'vitest'
import {
  CORE,
  HALO,
  createCloud,
  driftCloud,
  forEachLink,
  projectCloud,
  seededRandom,
  type CloudDot,
  type ShellSpec
} from '@renderer/desktop/brain/cloud'
import {
  createField,
  createOrbits,
  orbitPoint,
  stepField,
  wrapAngle
} from '@renderer/desktop/brain/field'
import { FALLBACK_TONES, hexToTone, TONE_VARS } from '@renderer/desktop/brain/tones'

const TONES = 4

describe('seededRandom', () => {
  it('produces a repeatable stream in [0, 1)', () => {
    const a = seededRandom(42)
    const b = seededRandom(42)
    for (let i = 0; i < 50; i += 1) {
      const value = a()
      expect(value).toBe(b())
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })
})

describe('createCloud', () => {
  it('places every particle inside its shell', () => {
    for (const spec of [CORE, HALO]) {
      for (const p of createCloud(spec, TONES)) {
        const r = Math.hypot(p.x, p.y, p.z)
        expect(r).toBeGreaterThanOrEqual(spec.min - 1e-9)
        expect(r).toBeLessThanOrEqual(spec.max + 1e-9)
      }
    }
  })

  it('is deterministic for a seed, so the cloud looks the same every launch', () => {
    expect(createCloud(CORE, TONES, 7)).toEqual(createCloud(CORE, TONES, 7))
    expect(createCloud(CORE, TONES, 8)).not.toEqual(createCloud(CORE, TONES, 7))
  })

  it('uses every tone in the palette', () => {
    const used = new Set(createCloud(CORE, TONES).map((p) => p.tone))
    expect(used.size).toBe(TONES)
    for (const tone of used) {
      expect(tone).toBeGreaterThanOrEqual(0)
      expect(tone).toBeLessThan(TONES)
    }
  })

  it('fills the volume rather than clumping at the shell', () => {
    // With a cube-root radius pick, half the points of a solid sphere fall
    // inside 0.79 of its radius. A linear pick would push that out past 0.9.
    const points = createCloud({ ...CORE, count: 4000 }, TONES)
    const radii = points.map((p) => Math.hypot(p.x, p.y, p.z)).sort((a, b) => a - b)
    const median = radii[Math.floor(radii.length / 2)] ?? 0
    expect(median / CORE.max).toBeGreaterThan(0.72)
    expect(median / CORE.max).toBeLessThan(0.86)
  })
})

describe('driftCloud', () => {
  const spec: ShellSpec = { count: 200, min: 0.2, max: 0.8, focal: 1.3, link: 0.2, speed: 0.05 }

  it('keeps particles within the shell over a long run', () => {
    const cloud = createCloud(spec, TONES)
    for (let i = 0; i < 400; i += 1) driftCloud(cloud, spec)
    for (const p of cloud) {
      const r = Math.hypot(p.x, p.y, p.z)
      // A reflection happens on the step after the breach, so allow one step
      // of overshoot rather than pretending the bound is hard.
      expect(r).toBeLessThanOrEqual(spec.max + spec.speed * 3)
      expect(r).toBeGreaterThanOrEqual(spec.min - spec.speed * 3)
    }
  })

  it('reverses velocity when a particle leaves its shell', () => {
    const escaping = {
      x: spec.max + 0.1,
      y: 0,
      z: 0,
      vx: 0.01,
      vy: 0,
      vz: 0,
      tone: 0,
      drift: 0
    }
    driftCloud([escaping], spec)
    expect(escaping.vx).toBeLessThan(0)
  })

  it('leaves a particle in the middle of the shell alone', () => {
    const inside = { x: 0.5, y: 0, z: 0, vx: 0.01, vy: 0, vz: 0, tone: 0, drift: 0 }
    driftCloud([inside], spec)
    expect(inside.vx).toBeGreaterThan(0)
    expect(inside.x).toBeCloseTo(0.51)
  })
})

describe('projectCloud', () => {
  const spec: ShellSpec = { count: 1, min: 0, max: 1, focal: 2, link: 0.2, speed: 0 }
  const one = [{ x: 0.5, y: 0.25, z: 0, vx: 0, vy: 0, vz: 0, tone: 2, drift: 3 }]

  it('scales into pixels and carries the tone through', () => {
    const [dot] = projectCloud(one, spec, 0, 200)
    expect(dot?.sx).toBeCloseTo(100)
    expect(dot?.sy).toBeCloseTo(50)
    expect(dot?.k).toBeCloseTo(1)
    expect(dot?.tone).toBe(2)
    expect(dot?.drift).toBe(3)
  })

  it('swings x through zero over a quarter turn', () => {
    const [dot] = projectCloud(one, spec, Math.PI / 2, 200)
    expect(dot?.sx).toBeCloseTo(0, 5)
  })

  it('magnifies a particle rotated toward the viewer and shrinks one rotated away', () => {
    // A quarter turn swings the point fully forward, the other way fully back.
    const near = projectCloud(one, spec, -Math.PI / 2, 200)[0]
    const far = projectCloud(one, spec, Math.PI / 2, 200)[0]
    expect(near?.k).toBeGreaterThan(1)
    expect(far?.k).toBeLessThan(1)
    expect(near?.sx ?? 0).toBeCloseTo(0, 5)
  })
})

describe('forEachLink', () => {
  const dot = (sx: number, sy: number): CloudDot => ({ sx, sy, k: 1, tone: 0, drift: 0 })

  it('visits pairs within reach and skips the rest', () => {
    const dots = [dot(0, 0), dot(5, 0), dot(100, 0)]
    const seen: Array<[number, number]> = []
    forEachLink(dots, 10, (a, b) => seen.push([a.sx, b.sx]))
    expect(seen).toEqual([[0, 5]])
  })

  it('visits each pair exactly once', () => {
    const dots = [dot(0, 0), dot(1, 0), dot(2, 0), dot(3, 0)]
    let count = 0
    forEachLink(dots, 100, () => {
      count += 1
    })
    expect(count).toBe((dots.length * (dots.length - 1)) / 2)
  })

  it('agrees with the naive pairwise scan it replaces', () => {
    const random = seededRandom(5150)
    const dots = Array.from({ length: 300 }, () => dot(random() * 400 - 200, random() * 400 - 200))
    const reach = 34

    const naive = new Set<string>()
    for (let i = 0; i < dots.length; i += 1) {
      for (let j = i + 1; j < dots.length; j += 1) {
        const a = dots[i]!
        const b = dots[j]!
        if (Math.hypot(a.sx - b.sx, a.sy - b.sy) <= reach) naive.add(`${i}:${j}`)
      }
    }

    const gridded = new Set<string>()
    forEachLink(dots, reach, (a, b) => gridded.add(`${dots.indexOf(a)}:${dots.indexOf(b)}`))
    expect(gridded).toEqual(naive)
  })

  it('reports closeness as 1 at zero distance falling to 0 at the reach', () => {
    let closeness = -1
    forEachLink([dot(0, 0), dot(5, 0)], 10, (_a, _b, c) => {
      closeness = c
    })
    expect(closeness).toBeCloseTo(0.5)
  })

  it('does nothing for a degenerate reach or a single dot', () => {
    let called = false
    const mark = (): void => {
      called = true
    }
    forEachLink([dot(0, 0), dot(1, 0)], 0, mark)
    forEachLink([dot(0, 0)], 10, mark)
    expect(called).toBe(false)
  })
})

describe('hexToTone', () => {
  it('reads hue and saturation from a hex colour, with or without the hash', () => {
    expect(hexToTone('#ff0000')).toEqual({ h: 0, s: 100 })
    expect(hexToTone('00ff00')).toEqual({ h: 120, s: 100 })
    expect(hexToTone('  #0000ff  ')).toEqual({ h: 240, s: 100 })
  })

  it('gives grey a saturation of zero', () => {
    expect(hexToTone('#808080')?.s).toBe(0)
  })

  it('rejects anything that is not a six-digit hex colour', () => {
    expect(hexToTone('rgb(1,2,3)')).toBeNull()
    expect(hexToTone('#fff')).toBeNull()
    expect(hexToTone('')).toBeNull()
  })

  it('has one fallback per palette entry, for a missing or unparsable token', () => {
    expect(FALLBACK_TONES).toHaveLength(TONE_VARS.length)
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
