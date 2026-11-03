# Believable textures

Notes on what makes a screen overlay read as a physical material, and how to
add more materials (fabric, wood, ...) later.

## What the eye needs

A texture reads as a surface, not as noise, when it has:

1. **Relief with consistent lighting.** A height map shaded from one light
   direction (we use upper left). Per-pixel random values without lighting
   read as sensor noise or film grain.
2. **Several scales.** Low-frequency tone variation (paper "formation",
   wood figure), a mid-frequency structure (paper tooth, weave, grain lines)
   and a high-frequency layer (fibres, fuzz).
3. **Cavity shading.** Valleys collect a bit of extra shadow
   (`height - blur(height)`), ridges catch a bit of light.
4. **No visible repetition.** Random high-frequency detail can repeat every
   1024 px unnoticed, low-frequency features can't. They go into a
   separate tone layer with a much longer period (see README).

This is the common pattern across procedural paper shaders: low-frequency
FBM for tone, Worley+FBM or Gabor noise for the tooth, high-frequency or
directional noise for fibres, then bump/normal shading.

## Overlay encoding

The extension draws two passes with custom Cogl pipelines:

- multiply: `dst · (1 − shadow)`, shows on light surfaces
- OVER with white: `dst + (1 − dst) · highlight`, shows on dark surfaces

A signed shading value `m` is stored as black (`m < 0`) or white (`m > 0`)
with `alpha = |m|` in a grey + alpha PNG. Raking light makes shadows much
stronger than highlights, so highlights are stored boosted to the same
spread; the dark-balance setting scales them down at runtime. On dark
surfaces paper structure is harder to see, around 0.4 looks natural.

## Reflective look

What makes a screen read as emissive rather than reflective:

- whites brighter than anything else in the room,
- deep blacks (paper always scatters some light back),
- cool, neutral white (paper and room light are warmer).

The matte setting handles all three. Paper's darkest ink still reflects a
few percent of the light (about 5 % on uncoated paper). That light adds up
in linear light, so in screen values `(b + (1 − b) · d^2.2)^(1/2.2)`:
shadows lift a lot, midtones little. Only dimming and warming the white
with a tiny flare reads as a colour filter, not as paper.

Blending can't apply that curve. Each pass maps `dst` along a straight
line (`src · dst` or `src + dst · (1 − a)`), and the only curved factor,
`DST_COLOR` on both sides, gives `dst²` at a fixed weight that is far too
strong. Correcting it needs extra passes that band in 8 bits. So the OVER
pass lifts black along the straight line closest to the paper curve
(least maximum error). Midtones come out up to 16 levels too light at the
maximum, about 6 at the default. The exact curve would need the finished
pixels, like print colours, which costs a full repaint on every change.

Lifting black alone made the whole screen lighter. So the curve is scaled
until 18 % grey (L* 50) keeps its value: at the maximum black goes to 40,
white down to 208, mid grey stays at 117. That also covers the first
point, paper white doesn't glow. The scale is applied as an overall
brightness factor on both passes.

The multiply also warms the white a little. There is no light falloff
across the screen: it is still a monitor, and the illusion shouldn't fight
that.

## Grain, mottle, ink spread, true size

- **Grain.** The detail tile's rounded tooth, shaded on its own, reads as
  leather. A third tile (256², 1:1) with pixel-fine fibres and grain
  breaks that up. Its strength is relative to the intensity, at 0.5 the
  pixel-level detail rises by about 12 %.
- **Ink mottle.** On uncoated paper ink soaks in unevenly along the
  formation, so solid dark areas have soft lighter patches. That is the
  tone tile again at a quarter of its size (stretched 2× instead of 8×),
  added to the OVER pass. `d + (1 − d) · a` only shows on dark areas,
  so light ones stay clean and it costs one texture lookup.
- **Ink spread.** Needs neighbouring pixels, so it runs in the offscreen
  pass with print colours. Real ink on uncoated paper grows strokes with
  sharp, ragged edges (boundary roughening, see MoXi) and feathers along
  fibres. Averaging the four neighbours would only be a one-sided blur.
  Instead:
  - An ink tile per texture, on the grain tile's grid: fibre direction as
    a doubled-angle vector (a fibre has no front and back) and
    absorbency, the grain height ranked to a uniform spread, so fibres
    and raised grain take ink first. Ink wets the fibres and wicks along
    them and into the pores between them; the pores are far below a
    pixel, the fibres are not. MoXi likewise eases the flow where its
    fibre texture has strands.
  - A pixel darkens towards its darkest neighbour (strokes grow) only
    where absorbency passes a hard threshold, so the edge turns ragged
    but stays sharp. At full amount 30 % of the paper takes ink, 60 %
    strength.
  - On a fibre it also darkens towards the ink one and two whole pixels
    along it, the feathers, weighted 1/d² so they fade instead of
    standing out. Whole pixels keep it independent of filtering.
  - Everything scales with the amount, feathers included, or even 1 %
    would show hard outliers. Growing a full pixel would make text
    illegible, real dot gain is well below 0.23 mm.
  - Neighbours are clamped to the pixel's monitor. Around and between
    the monitors the offscreen copy is black, which would otherwise ink
    the outermost pixels.
  - Cost: the four neighbours, one ink lookup and up to four along the
    fibre, little next to the offscreen pass itself.
- **True size.** Mutter's `DisplayConfig.GetResources` reports each
  output's size in mm (from EDID). Tiles are scaled so a texel stays
  0.23 mm, the logical pixel size the textures were made on (about
  110 dpi). Most monitors run at a scale that keeps logical pixels near
  that anyway, so the difference is usually small. The print pass gets
  each monitor's tile size as a uniform array too.

## Print colours

Print can't reach the colourfulness of a screen, and how far it falls
short depends on the hue. From Fogra's data for offset print on uncoated
paper (FOGRA52), as a share of sRGB's chroma at the most colourful point
of each hue, in OKLCH:

| hue | yellow | red | green | blue, violet |
|---|---|---|---|---|
| print / sRGB | ~100 % | ~80 % | ~60 % | 35–55 % |

Cyans at 210–225° are the exception, print reaches more there than sRGB.

Compressing HSV saturation and keeping the HSV value treats all hues
alike in RGB but not to the eye: blue gets 7 OKLab lightness points
lighter and shifts towards violet, red turns salmon, green barely changes.
That is close to the opposite of print.

Blending can't do this either: it works per channel, so lifting green and
blue of a red pixel also lifts them in black. The print colours setting
therefore runs a `Shell.GLSLEffect` on `uiGroup` that sees the finished
pixels and maps them into the print gamut in OKLab:

- The gamut comes from the convex hull of the FOGRA52 patches, mapped
  media-relative with black point compensation, so it only limits chroma.
  `tools/printgamut.py` stores it as a 73 × 33 table
  (`print-gamut.png`).
- Colours move towards the grey at the lightness of their hue's most
  colourful print colour (the cusp). Keeping lightness instead would
  bleach yellows and light greens: print yellow peaks at lightness 0.89,
  sRGB yellow sits at 0.97, where print has almost no chroma left.
- A soft knee starts at 80 % of the boundary, so gradients stay smooth.
  It moves out to the boundary towards the grey axis, so whites and greys
  stay exact.
- Pixels with equal RGB channels skip the conversion. While the effect is
  on every frame repaints the whole screen, and most of a desktop is grey.

The paper is computed in the same shader while the effect is on, which
saves the two overlay passes. It is laid out per monitor like the overlay,
from the monitor rectangles as a uniform array (up to four).

Pitfall: offscreen effects and partial redraws. On a partial redraw Clutter
re-renders the offscreen copy, but Mutter culls everything outside the
changed area (background and windows paint only their clip region), so the
rest of the copy is black. Queueing a full redraw of `uiGroup` from a stage
signal fixes the picture but can keep frames coming forever. What works is
`Clutter.add_debug_flags(0, DrawDebugFlag.DISABLE_CLIPPED_REDRAWS, 0)` while
the effect is on, as Blur my Shell does: frames that happen anyway get
widened to the whole screen, a still screen stays still. With several
monitors each one is painted separately into the shared copy, so the effect
also forces `ACTOR_DIRTY` on every paint there.

Pitfall: where the offscreen copy lies. The shader maps its texture
coordinates back to the screen to line the paper up with the overlay.
Clutter places the copy on the actor's paint volume, or on its allocation
when there is none, and one child without a paint volume is enough for
that. Real sessions often have such windows, a bare test desktop
doesn't. `get_paint_box()` returns nothing then, so using it stretched the
relief until only a soft gradient was left.

Considered instead: giving windows a narrower colour state
(`Clutter.Actor.set_color_state`) so Mutter's own colour transforms
desaturate them for free. Mutter sets those per surface from the client's
colour description and would overwrite them, and it would interfere with
HDR and ICC profiles. Too fragile.

## More materials

### From scans (most believable, least work)

[ambientCG](https://ambientcg.com/) publishes everything under CC0, including
redistribution. Materials come with Color, Displacement, Normal, Roughness
and AO maps, mostly seamless, up to 8K. Categories cover paper, fabric and
leather, wood and many more. [Poly Haven](https://polyhaven.com/) is CC0 too.

Use the **displacement or normal map, not the colour map**: colour maps have
baked-in lighting and tint. A small importer could take a displacement map,
downscale it so the features have the right on-screen size, and run it
through the same shading and encoding as `papergen.js`. Then all materials
share one light direction and one look.

If a scan isn't tileable, the histogram-preserving blending tool by Deliot,
Heitz and Neyret
([demo](https://unity-grenoble.github.io/website/demo/2020/10/16/demo-histogram-preserving-blend-make-tileable.html))
makes stochastic textures tileable.

### Procedural recipes

- **Paper:** current generator. Possible upgrade: Worley + FBM for the tooth
  (Grace Gilbert's watercolor stylization does this). Checked against the
  literature again: graphics models paper as a shaded pseudo-random height
  field (Curtis et al. 1997), paper science as a random fibre network
  whose flocs make the formation (Sampson). Both match what the generator
  does. One difference: wood pulp fibres are 1–3 mm (4–13 px), the detail
  tile's fibres reach 9 mm. They are weighted low, so they stay.
- **Washi:** kozo fibres are 7–15 mm, about 10× longer than wood pulp, and
  stay visible in a thin, unsmoothed, cloudy sheet. Preset with 55 px
  fibres at high weight, little tooth, strong formation.
- **Laid paper:** about 10 laid lines per cm (8–12, medieval 5–15) and
  chain lines 20–30 mm apart (15–50). Laid lines every 4 px (0.92 mm),
  9 chain lines per 1024 px tile (26 mm), both wobbling a little like
  hand-strung wires. Laid lines run vertically, across the text lines.
- **Cardboard (grey board):** pressed recycled fibre, matt and rough,
  short fibres, lumps. Paper preset with short dense fibres and lumps.
- **Wood:** concentric rings `sin(k·sqrt(x² + y²))` stretched strongly along
  one axis (e.g. 2.0 vs 0.4), domain-warped with FBM so the rings wobble,
  plus fine directional grain noise along the fibre direction. Mostly a
  height/tone pattern, little relief.
- **Fabric / canvas:** a weave pattern as height map: alternating over/under
  threads (`sin` on x and y, swapped every other cell), each thread with
  slight thickness and position jitter, plus fuzz noise. Linen: irregular
  thread widths. Canvas: coarser, stronger relief. Artist canvas has 16–24
  threads per cm (#10 duck ~20 × 16, Belgian linen ~24 × 20). At 0.23 mm
  per pixel that is about 2 px per thread, too fine to read as weave, so
  the canvas preset uses 4 px (~11 per cm, a coarse canvas).
- **Periodic patterns** need a period of whole pixels to tile and must not
  be resampled by a fraction, or they shimmer. True size is off for them
  (`isPeriodic()` in papergen.js).
- **Leather:** Worley cells as pores and creases, low relief.

### Sources

- [Curtis et al., Computer-Generated Watercolor](https://grail.cs.washington.edu/projects/watercolor/paper_small.pdf)
- [Sampson, The Structural Characterisation of Fibre Networks in Papermaking](https://bioresources.cnr.ncsu.edu/wp-content/uploads/2020/03/2001.2.1205.pdf)
- [MoXi: real-time ink dispersion in absorbent paper](https://www.researchgate.net/publication/220184655_MoXi_real-time_ink_dispersion_in_absorbent_paper)
- [Chain and laid lines in medieval paper (Heritage Science)](https://www.nature.com/articles/s40494-023-01013-3)
- [Etherington & Roberts: chain lines](https://cool.culturalheritage.org/don/dt/dt0650.html)
- [Hand Papermaking: Washi](https://www.handpapermaking.org/post/washi)
- [IFLA: paper conservation with washi](https://www.ifla.org/paper-conservation-by-using-japanese-paper-washi/)
- [Cotton duck](https://en.wikipedia.org/wiki/Cotton_duck), [Talas linen canvas](https://www.talasonline.com/Linen-Canvas)

- [Survey of Procedural Methods for Two-Dimensional Texture Generation](https://pmc.ncbi.nlm.nih.gov/articles/PMC7070409/)
- [Real-Time Procedural Textures (finite-difference bump shading)](https://faculty.cc.gatech.edu/~turk/my_papers/real_time_textures.pdf)
- [gracelgilbert/watercolor-stylization](https://github.com/gracelgilbert/watercolor-stylization)
- [The Tech Behind Transparent Watercolor on the Web](https://wtrclred.io/en/posts/16)
- [texturize.app paper generator](https://texturize.app/generators/paper)
- [Paper Texture Shader (paper.design)](https://shaders.paper.design/paper-texture)
- [ambientCG](https://ambientcg.com/), CC0 license
- [Heitz & Neyret, histogram-preserving blending](https://www.jcgt.org/published/0008/04/02/paper-lowres.pdf)
- [Rombo: Wood Noise](https://www.rombo.tools/2026/01/01/wood-noise/)
- [Procedural Wood: A Deep Dive (Octane)](https://help.otoy.com/hc/en-us/articles/45411909964827-Procedural-Wood-A-Deep-Dive)
- [Apple Metal wood shader](https://developer.apple.com/library/content/samplecode/MetalShaderShowcase/Listings/MetalShaderShowcase_AAPLWoodShader_metal.html)
