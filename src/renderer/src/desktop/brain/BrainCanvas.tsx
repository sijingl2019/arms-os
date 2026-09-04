import { useEffect, useRef } from 'react'
import {
  CORE,
  HALO,
  createCloud,
  driftCloud,
  forEachLink,
  projectCloud,
  type CloudDot
} from './cloud'
import { createField, createOrbits, orbitPoint, stepField } from './field'
import { FALLBACK_TONES, hexToTone, TONE_VARS, type Tone } from './tones'

/**
 * The centrepiece of the desktop.
 *
 * Inner layer: the linked particle cloud from the earlier MVP's command centre
 * - a dense core inside a sparse halo, both drifting and spinning.
 * Outer layer: a glowing shell with particles streaming along tilted orbits.
 *
 * One canvas, one rAF loop. Canvas 2D rather than a 3D engine because this app
 * lives in the tray all day: it has to be cheap and it has to be able to stop.
 */

const PARTICLES_PER_ORBIT = 90
/** Radians per frame for the core; the halo lags it, as in the MVP. */
const SPIN_PER_FRAME = 0.0016
const HALO_SPIN_RATIO = 0.55
/** Canvas radius the MVP's dot sizes were tuned against, in CSS pixels. */
const REFERENCE_RADIUS = 280

export interface BrainCanvasProps {
  /** Stop the loop entirely - used while a panel covers the desktop. */
  paused: boolean
  /** Fade the cloud back so the search field on top of it stays readable. */
  dimmed: boolean
}

/** How one shell of the cloud is painted. */
interface LayerStyle {
  /** Opacity of a link at zero distance. */
  linkWeight: number
  /** Saturation multiplier; the halo is washed out so it frames the core. */
  sat: number
  dotSize: number
  lightBase: number
  alphaFloor: number
  alphaGain: number
  /** Perspective factor below which a dot has faded to `alphaFloor`. */
  kFloor: number
}

const CORE_STYLE: LayerStyle = {
  linkWeight: 0.2,
  sat: 1,
  dotSize: 1.5,
  lightBase: 52,
  alphaFloor: 0.12,
  alphaGain: 1.7,
  kFloor: 0.55
}

const HALO_STYLE: LayerStyle = {
  linkWeight: 0.06,
  sat: 0.5,
  dotSize: 1.1,
  lightBase: 58,
  alphaFloor: 0.08,
  alphaGain: 1.1,
  kFloor: 0.7
}

/** The palette, resolved from the document's custom properties. */
function readTones(): Tone[] {
  const style = getComputedStyle(document.documentElement)
  return TONE_VARS.map(
    (name, i) => hexToTone(style.getPropertyValue(name)) ?? FALLBACK_TONES[i] ?? FALLBACK_TONES[0]!
  )
}

/** `hsla()` for a dot or a link, given its tone and how much light it carries. */
function toneColor(tone: Tone, drift: number, lightness: number, alpha: number, sat: number): string {
  const s = Math.round(tone.s * sat)
  return `hsla(${(tone.h + drift).toFixed(0)}, ${s}%, ${lightness.toFixed(0)}%, ${alpha.toFixed(3)})`
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

    let tones = readTones()
    const core = createCloud(CORE, TONE_VARS.length, 1337)
    const halo = createCloud(HALO, TONE_VARS.length, 90210)

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

    const observer = new ResizeObserver(resize)
    observer.observe(canvas)

    // Orbit geometry depends on the canvas size, so it is rebuilt per frame,
    // but the particles themselves are not - they keep their angles and the
    // ring never visibly re-shuffles on resize.
    let orbits = createOrbits(1)
    const particles = createField(orbits, PARTICLES_PER_ORBIT)

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let spin = 0

    /** Links first, then dots on top of them - the MVP's ordering. */
    const drawCloud = (
      dots: CloudDot[],
      reach: number,
      style: LayerStyle,
      cx: number,
      cy: number,
      scale: number
    ): void => {
      ctx.lineWidth = 0.5
      forEachLink(dots, reach, (a, b, closeness) => {
        // A link takes the colour of its first endpoint: cheaper than a
        // gradient, and near neighbours are usually the same tone anyway.
        const tone = tones[a.tone] ?? tones[0]
        if (!tone) return
        ctx.strokeStyle = toneColor(tone, a.drift, 62, closeness * style.linkWeight, style.sat)
        ctx.beginPath()
        ctx.moveTo(cx + a.sx, cy + a.sy)
        ctx.lineTo(cx + b.sx, cy + b.sy)
        ctx.stroke()
      })

      for (const dot of dots) {
        const tone = tones[dot.tone] ?? tones[0]
        if (!tone) continue
        const alpha = Math.min(
          1,
          Math.max(style.alphaFloor, (dot.k - style.kFloor) * style.alphaGain)
        )
        ctx.fillStyle = toneColor(
          tone,
          dot.drift,
          style.lightBase + dot.k * 13,
          alpha,
          style.sat
        )
        ctx.beginPath()
        ctx.arc(cx + dot.sx, cy + dot.sy, style.dotSize * scale * dot.k, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    const draw = (): void => {
      const cx = width / 2
      const cy = height / 2
      const radius = Math.min(width, height) * 0.44
      orbits = createOrbits(radius)
      const fade = dimmedRef.current ? 0.28 : 1
      const scale = Math.max(1, radius / REFERENCE_RADIUS)

      ctx.clearRect(0, 0, width, height)
      ctx.save()
      ctx.globalAlpha = fade

      // --- outer: the shell
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

      // --- outer: orbiting particles, split around the cloud for depth
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

      // --- inner: the cloud's own halo, then its core on top
      drawCloud(
        projectCloud(halo, HALO, spin * HALO_SPIN_RATIO, radius),
        HALO.link * radius,
        HALO_STYLE,
        cx,
        cy,
        scale
      )
      drawCloud(projectCloud(core, CORE, spin, radius), CORE.link * radius, CORE_STYLE, cx, cy, scale)

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
        spin += SPIN_PER_FRAME
        driftCloud(core, CORE)
        driftCloud(halo, HALO)
        stepField(particles, dt)
        draw()
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)

    // Without this, `last` accumulates the whole hidden interval and the orbits
    // jump forward when the window comes back.
    const resync = (): void => {
      last = performance.now()
    }
    document.addEventListener('visibilitychange', resync)
    window.addEventListener('focus', resync)

    // The palette lives on <html>, so follow it if the theme is ever switched.
    const themeWatch = new MutationObserver(() => {
      tones = readTones()
    })
    themeWatch.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    })

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      themeWatch.disconnect()
      document.removeEventListener('visibilitychange', resync)
      window.removeEventListener('focus', resync)
    }
  }, [])

  return <canvas ref={canvasRef} className="brain-canvas" aria-hidden="true" />
}
