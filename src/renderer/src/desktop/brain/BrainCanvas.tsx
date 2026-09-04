import { useEffect, useRef } from 'react'
import {
  BRAIN_EXTENT,
  BRAIN_OUTLINE,
  BRAIN_STEM,
  BRAIN_SULCI,
  BRAIN_VIEWBOX
} from './brainPath'
import { createField, createOrbits, orbitPoint, stepField } from './field'
import {
  decoratePoints,
  project,
  samplePoints,
  samplePolyline,
  twinkle,
  type BrainPoint,
  type RawPoint,
  type Region
} from './points'

/**
 * The particle brain at the centre of the desktop.
 *
 * One canvas, one rAF loop, three layers: a glowing shell, the brain's point
 * cloud, and particles streaming along tilted orbits. Canvas 2D rather than a
 * 3D engine because this app lives in the tray all day - it has to be cheap and
 * it has to be able to stop.
 */

/**
 * Point budgets at the reference size below; they scale with the canvas so a
 * maximized window does not thin the cloud out into a haze.
 */
const BODY_POINTS = 700
const OUTLINE_POINTS = 340
const SULCI_POINTS = 820
/** Canvas size the budgets above were tuned at, in CSS pixels. */
const REFERENCE_SIZE = 640
const MAX_DENSITY = 2.6
const PARTICLES_PER_ORBIT = 90
/** Radians per second. Slow enough to read as breathing, not spinning. */
const ROTATION_SPEED = 0.16
/** Weak perspective: large values flatten the parallax. */
const FOCAL = 160
/** Supersampling of the silhouette mask, in pixels per design unit. */
const MASK_SCALE = 2

export interface BrainCanvasProps {
  /** Stop the loop entirely - used while a panel covers the desktop. */
  paused: boolean
  /** Fade the brain back so the search field on top of it stays readable. */
  dimmed: boolean
}

/**
 * Rasterise the silhouette once and return a classifier over design space.
 * The fold strokes are composited `source-atop` so a stroke that overshoots the
 * outline cannot create points floating outside the brain.
 */
function buildClassifier(): ((x: number, y: number) => Region) | null {
  const { width, height } = BRAIN_VIEWBOX
  const mask = document.createElement('canvas')
  mask.width = Math.round(width * MASK_SCALE)
  mask.height = Math.round(height * MASK_SCALE)
  const ctx = mask.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null

  ctx.scale(MASK_SCALE, MASK_SCALE)
  ctx.fillStyle = 'rgb(255,0,0)'
  ctx.fill(new Path2D(BRAIN_OUTLINE))

  // The stem belongs to the body, so it is stroked before the clip is armed.
  ctx.strokeStyle = 'rgb(255,0,0)'
  ctx.lineCap = 'round'
  ctx.lineWidth = 9
  ctx.stroke(new Path2D(BRAIN_STEM))

  ctx.globalCompositeOperation = 'source-atop'
  ctx.strokeStyle = 'rgb(0,255,0)'
  ctx.lineWidth = 2.4
  for (const d of BRAIN_SULCI) ctx.stroke(new Path2D(d))

  const { data } = ctx.getImageData(0, 0, mask.width, mask.height)
  const rowStride = mask.width * 4
  const maskWidth = mask.width
  const maskHeight = mask.height

  return (x, y) => {
    const px = Math.floor(x * MASK_SCALE)
    const py = Math.floor(y * MASK_SCALE)
    if (px < 0 || py < 0 || px >= maskWidth || py >= maskHeight) return 0
    const i = py * rowStride + px * 4
    if ((data[i + 1] ?? 0) > 128) return 2
    if ((data[i] ?? 0) > 128) return 1
    return 0
  }
}

/**
 * Walk an SVG path at a fixed arc-length step. `SVGPathElement` is the only
 * thing in the platform that can measure a bezier, and a detached element is
 * enough - nothing is ever added to the document.
 */
function pathToPolyline(d: string, ridge: boolean, step = 1): RawPoint[] {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  el.setAttribute('d', d)
  const total = el.getTotalLength()
  if (!Number.isFinite(total) || total <= 0) return []

  const out: RawPoint[] = []
  for (let at = 0; at <= total; at += step) {
    const p = el.getPointAtLength(at)
    out.push({ x: p.x, y: p.y, ridge })
  }
  return out
}

/**
 * The full cloud: interior fill, outline, and folds. `density` scales every
 * budget with the canvas, so the brain keeps the same visual weight whether the
 * window is 900px wide or maximized.
 */
function buildCloud(
  classify: ((x: number, y: number) => Region) | null,
  density: number
): BrainPoint[] {
  const size = { width: BRAIN_VIEWBOX.width, height: BRAIN_VIEWBOX.height }
  const scaled = (count: number): number => Math.round(count * density)

  const body = classify ? samplePoints(classify, { ...size, count: scaled(BODY_POINTS) }) : []

  const outline = decoratePoints(
    // Marked as a ridge so the silhouette gets the bright treatment: it is the
    // single strongest cue that this cloud is a brain.
    samplePolyline(pathToPolyline(BRAIN_OUTLINE, true), scaled(OUTLINE_POINTS), 1.1, 0xa11ce),
    { ...size, seed: 0xa11ce, depth: 10 }
  )

  // Spread the fold budget across the curves by length, so a long sulcus does
  // not end up as sparse as a short one.
  const sulci = BRAIN_SULCI.map((d) => pathToPolyline(d, true))
  const totalVertices = sulci.reduce((sum, line) => sum + line.length, 0) || 1
  const folds = sulci.flatMap((line, i) =>
    decoratePoints(
      samplePolyline(line, scaled((SULCI_POINTS * line.length) / totalVertices), 1.5, 0x5c1 + i),
      { ...size, seed: 0x5c1 + i, depth: 14 }
    )
  )

  return [...body, ...outline, ...folds]
}

export function BrainCanvas({ paused, dimmed }: BrainCanvasProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Read inside the loop so toggling them never restarts the animation.
  const pausedRef = useRef(paused)
  const dimmedRef = useRef(dimmed)
  pausedRef.current = paused
  dimmedRef.current = dimmed

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let width = 0
    let height = 0
    const resize = (): void => {
      const rect = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      width = rect.width
      height = rect.height
      canvas.width = Math.max(1, Math.round(width * dpr))
      canvas.height = Math.max(1, Math.round(height * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()

    // Built once, from the first measurement: rebuilding on every resize would
    // visibly reshuffle the cloud while the user drags the window edge.
    const density = Math.min(MAX_DENSITY, Math.max(1, Math.min(width, height) / REFERENCE_SIZE))
    const points: BrainPoint[] = buildCloud(buildClassifier(), density)

    const observer = new ResizeObserver(resize)
    observer.observe(canvas)

    // Orbit geometry depends on the canvas size, so it is rebuilt per frame,
    // but the particles themselves are not - they keep their angles and the
    // ring never visibly re-shuffles on resize.
    let orbits = createOrbits(1)
    const particles = createField(orbits, PARTICLES_PER_ORBIT)

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    let angle = 0
    let elapsed = 0

    const draw = (): void => {
      const cx = width / 2
      const cy = height / 2
      const radius = Math.min(width, height) * 0.44
      // The brain fills most of the shell, as in the reference: sized off the
      // shell's diameter rather than off the canvas, so the two stay in step.
      const brainScale = (radius * 2 * 0.84) / BRAIN_EXTENT
      orbits = createOrbits(radius)
      const fade = dimmedRef.current ? 0.28 : 1

      ctx.clearRect(0, 0, width, height)
      ctx.save()
      ctx.globalAlpha = fade

      // --- layer 1: the shell around the brain
      const shell = ctx.createRadialGradient(cx, cy, radius * 0.55, cx, cy, radius)
      shell.addColorStop(0, 'rgba(66,142,255,0)')
      shell.addColorStop(0.82, 'rgba(66,142,255,0.10)')
      shell.addColorStop(1, 'rgba(120,200,255,0)')
      ctx.fillStyle = shell
      ctx.beginPath()
      ctx.arc(cx, cy, radius, 0, Math.PI * 2)
      ctx.fill()

      ctx.globalCompositeOperation = 'lighter'
      ctx.strokeStyle = 'rgba(120,200,255,0.22)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(cx, cy, radius, 0, Math.PI * 2)
      ctx.stroke()
      for (const orbit of orbits) {
        ctx.save()
        ctx.translate(cx, cy)
        ctx.rotate(orbit.tilt)
        ctx.strokeStyle = 'rgba(90,170,255,0.05)'
        ctx.beginPath()
        ctx.ellipse(0, 0, orbit.radiusX, orbit.radiusY, 0, 0, Math.PI * 2)
        ctx.stroke()
        ctx.restore()
      }

      // --- layer 2: orbiting particles, split around the brain for depth
      const drawParticles = (front: boolean): void => {
        for (const p of particles) {
          const orbit = orbits[p.orbit]
          if (!orbit) continue
          const pos = orbitPoint(orbit, p.angle)
          if (pos.front !== front) continue
          const tail = orbitPoint(orbit, p.angle - p.trail * Math.sign(p.speed))
          ctx.strokeStyle = 'rgba(140,215,255,' + p.alpha * 0.5 + ')'
          ctx.lineWidth = p.size * 0.7
          ctx.beginPath()
          ctx.moveTo(cx + tail.x, cy + tail.y)
          ctx.lineTo(cx + pos.x, cy + pos.y)
          ctx.stroke()
          ctx.fillStyle = 'rgba(210,240,255,' + p.alpha + ')'
          ctx.beginPath()
          ctx.arc(cx + pos.x, cy + pos.y, p.size, 0, Math.PI * 2)
          ctx.fill()
        }
      }
      drawParticles(false)

      // --- layer 3: the brain's point cloud
      for (const point of points) {
        const p = project(point, angle, FOCAL)
        const x = cx + p.x * brainScale
        const y = cy + p.y * brainScale
        const glint = twinkle(point, elapsed)
        const alpha = Math.min(1, point.brightness * glint * (0.45 + p.depth01 * 0.75))
        // Capped: past about 2.5px the dots stop reading as stars and start
        // reading as squares.
        const size = Math.min(2.5, Math.max(0.6, (0.6 + point.brightness) * p.scale * (brainScale / 3.4)))

        // Fold points run warm, the body runs violet: the structure has to
        // survive being drawn as loose dots.
        ctx.fillStyle =
          point.brightness > 0.6
            ? 'rgba(255,214,150,' + alpha + ')'
            : 'rgba(170,150,255,' + alpha * 0.85 + ')'
        ctx.fillRect(x - size / 2, y - size / 2, size, size)

        if (point.star && glint > 0.8) {
          const arm = size * 3.4
          ctx.strokeStyle = 'rgba(255,240,210,' + alpha * 0.5 + ')'
          ctx.lineWidth = 0.7
          ctx.beginPath()
          ctx.moveTo(x - arm, y)
          ctx.lineTo(x + arm, y)
          ctx.moveTo(x, y - arm)
          ctx.lineTo(x, y + arm)
          ctx.stroke()
        }
      }

      drawParticles(true)
      ctx.restore()
      ctx.globalCompositeOperation = 'source-over'
    }

    // Reduced motion still deserves the picture, just not the movement.
    if (reduceMotion) {
      draw()
      return () => observer.disconnect()
    }

    let frame = 0
    let last = performance.now()

    const tick = (now: number): void => {
      const dt = Math.min((now - last) / 1000, 0.1)
      last = now
      // A hidden window, or one with a panel over the desktop, has nothing to
      // animate for.
      if (!pausedRef.current && !document.hidden && width > 0) {
        elapsed += dt
        angle += ROTATION_SPEED * dt
        stepField(particles, dt)
        draw()
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)

    // Without this, `last` accumulates the whole hidden interval and the brain
    // jumps forward when the window comes back.
    const resync = (): void => {
      last = performance.now()
    }
    document.addEventListener('visibilitychange', resync)
    window.addEventListener('focus', resync)

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      document.removeEventListener('visibilitychange', resync)
      window.removeEventListener('focus', resync)
    }
  }, [])

  return <canvas ref={canvasRef} className="brain-canvas" aria-hidden="true" />
}
