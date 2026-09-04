/**
 * The orbiting particles that stream around the brain.
 *
 * Pure maths, no canvas: the renderer asks for positions and draws them. Each
 * particle is pinned to one tilted ellipse and only its angle changes, which
 * keeps the motion reading as flow along a ring rather than as drift.
 */

import { seededRandom } from './cloud'

export interface Orbit {
  radiusX: number
  radiusY: number
  /** Rotation of the ellipse in the screen plane, radians. */
  tilt: number
}

export interface FieldParticle {
  /** Index into the orbit array this particle belongs to. */
  orbit: number
  /** Position along the ellipse, radians, always kept in [0, 2π). */
  angle: number
  /** Radians per second; sign decides the direction of travel. */
  speed: number
  size: number
  alpha: number
  /** Trail length in radians, drawn as a short arc behind the particle. */
  trail: number
}

const TAU = Math.PI * 2

/** Wrap into [0, 2π) for any input, including large negatives. */
export function wrapAngle(angle: number): number {
  const wrapped = angle % TAU
  return wrapped < 0 ? wrapped + TAU : wrapped
}

export function createOrbits(radius: number): Orbit[] {
  return [
    { radiusX: radius * 1.02, radiusY: radius * 0.3, tilt: -0.32 },
    { radiusX: radius * 1.12, radiusY: radius * 0.46, tilt: 0.38 },
    { radiusX: radius * 0.94, radiusY: radius * 0.9, tilt: 0.1 },
    { radiusX: radius * 1.26, radiusY: radius * 0.2, tilt: 0.86 }
  ]
}

export function createField(orbits: readonly Orbit[], perOrbit: number, seed = 0xf1e1d): FieldParticle[] {
  const random = seededRandom(seed)
  const particles: FieldParticle[] = []

  for (let orbit = 0; orbit < orbits.length; orbit += 1) {
    // Alternating direction reads as circulation rather than as one big spin.
    const direction = orbit % 2 === 0 ? 1 : -1
    for (let i = 0; i < perOrbit; i += 1) {
      particles.push({
        orbit,
        angle: random() * TAU,
        speed: direction * (0.12 + random() * 0.34),
        size: 0.4 + random() * 1.1,
        alpha: 0.2 + random() * 0.55,
        trail: 0.05 + random() * 0.16
      })
    }
  }

  return particles
}

/** Advance every particle by `dt` seconds. Mutates in place - this runs per frame. */
export function stepField(particles: FieldParticle[], dt: number): void {
  for (const p of particles) {
    p.angle = wrapAngle(p.angle + p.speed * dt)
  }
}

export interface FieldPoint {
  x: number
  y: number
  /** True on the half of the ellipse nearest the viewer, so it can draw on top. */
  front: boolean
}

/** Position of `angle` on `orbit`, relative to the centre of the ring. */
export function orbitPoint(orbit: Orbit, angle: number): FieldPoint {
  const ex = Math.cos(angle) * orbit.radiusX
  const ey = Math.sin(angle) * orbit.radiusY
  const cos = Math.cos(orbit.tilt)
  const sin = Math.sin(orbit.tilt)
  return {
    x: ex * cos - ey * sin,
    y: ex * sin + ey * cos,
    front: Math.sin(angle) > 0
  }
}
