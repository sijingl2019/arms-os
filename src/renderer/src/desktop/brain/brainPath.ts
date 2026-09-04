/**
 * The brain silhouette, as SVG path data in a 200x160 design space.
 *
 * Hand-authored rather than traced from an anatomical illustration: the shape
 * only has to read as a brain at ~600px through a haze of glowing particles,
 * and an original path keeps this file free of third-party artwork.
 *
 * Proportions matter more than detail here - a side-view brain is about 1.4
 * times wider than it is tall, and an outline any squarer reads as a blob no
 * matter how good the particles are.
 */

export const BRAIN_VIEWBOX = { width: 200, height: 160 } as const

/** Closed outline: frontal lobe at the left, occipital and cerebellum right. */
export const BRAIN_OUTLINE =
  'M 26 88 ' +
  'C 20 66 32 44 56 34 ' +
  'C 78 25 108 24 130 30 ' +
  'C 152 36 170 50 176 68 ' +
  'C 181 83 176 96 166 102 ' +
  'C 170 110 166 118 158 120 ' +
  'C 160 128 152 134 143 132 ' +
  'C 138 139 128 140 122 135 ' +
  'C 112 139 100 137 95 130 ' +
  'C 84 134 72 131 66 124 ' +
  'C 52 124 40 116 38 105 ' +
  'C 28 102 24 95 26 88 ' +
  'Z'

/**
 * The folds, drawn as contour lines rather than as anatomically placed sulci:
 * a set of arcs nested inside the outline, crossed by short gyral walls, then
 * the cerebellum's separation and its tighter folia.
 *
 * Contours read as a brain at a glance in a way that hand-placed squiggles do
 * not - they follow the silhouette, so the shape reinforces itself instead of
 * dissolving into noise.
 */
export const BRAIN_SULCI: readonly string[] = [
  // Nested contours, outermost first.
  'M 34 84 C 40 56 66 38 100 34 C 134 30 164 46 172 70',
  'M 44 94 C 48 68 72 52 102 48 C 130 45 157 58 165 79',
  'M 56 102 C 59 80 78 66 102 62 C 126 59 147 71 155 88',
  'M 70 108 C 72 90 86 80 104 77 C 122 74 137 83 143 95',
  // Gyral walls crossing them.
  'M 62 60 C 66 70 66 82 61 92',
  'M 92 42 C 96 54 96 68 92 78',
  'M 126 42 C 132 54 133 68 128 78',
  'M 152 58 C 157 70 156 82 150 90',
  'M 80 96 C 84 104 84 113 79 121',
  'M 112 86 C 117 96 117 107 112 115',
  // Where the cerebellum starts, then its tighter folia.
  'M 104 116 C 118 126 138 129 157 119',
  'M 120 125 C 130 131 142 132 153 125',
  'M 124 131 C 133 136 142 136 150 131'
] as const

/**
 * Width of the outline's actual bounding box. The viewBox is wider than the
 * shape, so scaling by the viewBox would leave the brain floating small inside
 * the shell.
 */
export const BRAIN_EXTENT = 162

/** The stem. Filled into the body, not treated as a fold. */
export const BRAIN_STEM = 'M 116 131 C 120 142 118 151 111 156'
