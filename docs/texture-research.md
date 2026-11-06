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

The extension blends two parts with a custom Cogl pipeline:

- multiply: `dst · (1 − shadow)`, shows on light surfaces
- OVER with white: `dst + (1 − dst) · highlight`, shows on dark surfaces

Both fit into one blend, `src + dst · (1 − src.a)`, with the highlight as
colour and `1 − (1 − shadow) · (1 − highlight)` as alpha.

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

The matte setting handles the last two. Paper's darkest ink still reflects
a few percent of the light (about 5 % on uncoated paper). That light adds
up in linear light, so in screen values `(b + (1 − b) · d^2.2)^(1/2.2)`:
shadows lift a lot, midtones little, white not at all. Only dimming and
warming the white with a tiny flare reads as a colour filter, not as
paper.

Blending can't apply that curve. Each pass maps `dst` along a straight
line (`src · dst` or `src + dst · (1 − a)`), and passes in a row stay a
straight line. An earlier version lifted black along the line closest to
the curve and dimmed white to keep mid grey; that lifted midtones and
colours too and looked washed out and grey. So the matte look needs the
finished pixels and runs in the offscreen pass of print colours, with the
exact curve. The lift is even in screen values along the slider, up to
the black of uncoated paper (a screen value of 65).

White isn't dimmed: the eye adapts to the brightest white anyway, the
brightness setting is there for a dimmer screen. Matte warms the white a
little. There is no light falloff across the screen: it is still a
monitor, and the illusion shouldn't fight that.

## Grain, mottle, ink spread, light scattering, true size

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
    but stays sharp. The threshold is taken at four points inside the
    pixel and averaged, so a pixel can take part of the ink: one
    decision per pixel made the ragged edge out of whole pixels, which
    read as noise at scale 1 (at 1.25 the old 2× offscreen copy averaged
    it by accident).
  - On a fibre it also darkens towards the ink one and two steps along
    it, the feathers, weighted 1/d² so they fade instead of standing out.
    More steps that grow with the amount were tried: hardly visible, the
    far steps get lost in the texture, and every step costs two reads.
  - Neighbours and steps are half a pixel, read with linear filtering.
    Whole pixels made strokes heavy and smeared small text; half a pixel
    grows them by less than a pixel and softens the ragged edges, at
    every scale. Reading between two pixels halves a neighbour's pull,
    which the strengths make up for.
  - Everything scales with the amount, feathers included, or even 1 %
    would show hard outliers. The share of paper that takes ink grows
    linearly (70 % at full amount), strength and feathers with the
    square root (90 % at full), so 40 % (the default) already looks like
    ink, and more of it reaches more places instead of only
    getting darker. Growing a full pixel would make text illegible, real
    dot gain is well below 0.23 mm.
  - Neighbours are clamped to the pixel's monitor, ink doesn't cross
    from one monitor to the next.
  - Cost: the four neighbours, one ink lookup and up to four along the
    fibre, little next to the offscreen pass itself.
- **Light scattering** (optical dot gain). On uncoated paper the largest
  effect of ink at screen scale is not the ink moving but the light:
  light enters the paper next to a stroke, scatters sideways under it and
  is absorbed, so strokes look darker and softer than the ink is. The
  usual model (Arney, Yule–Nielsen): with T the transmittance of the ink
  layer, light passes it twice, R = T · (PSF ∗ T). A flat area reflects
  T², so T = √R in linear light, c^1.1 in screen values; only edges
  change. Arney's point spread function for paper is
  (2π/kp²)·exp(−2πr/kp), with kp about 0.1–0.25 mm on uncoated paper.
  - Integrated over the area of a pixel (light enters evenly over one
    pixel, the eye sees each pixel evenly), at 0.23 mm per pixel 17 % to
    38 % of the light leaves its pixel, almost all of it to the four
    direct neighbours, nearly nothing beyond one pixel. So the four
    half-pixel neighbours ink spread reads already make the kernel: their
    mean is the pixel with weight ½ and each neighbour ⅛, mixed in by
    twice the share that leaves. Diagonals and further pixels (a few
    percent of that share) go to the direct neighbours instead.
  - The share is computed per monitor from the physical pixel size
    (logical size from EDID divided by the scale), so the halo has the
    same size in mm everywhere. The kernel can pass on at most half the
    light, which kp 0.25 mm reaches at about 0.155 mm per pixel; on finer
    pixels the halo stops growing. A wider kernel would need more reads
    and a two-pixel ring, for a difference too fine to see there.
  - The blur is taken as a difference from the unprocessed copy, so flat
    areas stay exact even when print colours or ink spread changed the
    pixel itself. Their changes to the neighbours aren't scattered.
  - Light text on dark surfaces gets a little thinner and dimmer:
    physically right (the gaps between ink lose light), and the reason it
    is a setting of its own.
  - It is a different effect from the matte look: that lifts flat blacks
    (light reflected before it reaches the ink), scattering leaves flat
    areas alone. One can't stand in for the other.
- **True size.** Mutter's `DisplayConfig.GetResources` reports each
  output's size in mm (from EDID). Tiles are scaled so a texel stays
  0.23 mm, the logical pixel size the textures were made on (about
  110 dpi). Most monitors run at a scale that keeps logical pixels near
  that anyway, so the difference is usually small. The print pass is
  drawn per monitor, with that monitor's tile size.

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
therefore runs an effect on `uiGroup` that sees the finished pixels and
maps them into the print gamut in OKLab:

- The gamut comes from the convex hull of the FOGRA52 patches, mapped
  media-relative with black point compensation, so it only limits chroma.
  `tools/printgamut.py` stores it as a 73 × 33 table
  (`tools/print-gamut.png`).
- Colours move towards the grey at the lightness of their hue's most
  colourful print colour (the cusp). Keeping lightness instead would
  bleach yellows and light greens: print yellow peaks at lightness 0.89,
  sRGB yellow sits at 0.97, where print has almost no chroma left.
- A soft knee starts at 80 % of the boundary, so gradients stay smooth.
  It moves out to the boundary towards the grey axis, so whites and greys
  stay exact.
- Pixels with equal RGB channels skip the conversion, most of a desktop
  is grey.
- The shader doesn't compute any of this. `tools/printlut.py` bakes the
  mapping into a 65³ table (`print-lut.png`, laid out like Mutter's 3D
  LUTs for ICC profiles: red along x, green + blue × 65 along y; Cogl has
  no 3D textures). Two linear lookups and a mix between blue slices
  replace the OKLab conversions and the trigonometry. Against the exact
  mapping: mean 0.28 levels, 99.9 % within 1.4, at most 5; 33³ would be
  off by up to 10. A strength below 1 mixes in sRGB instead of moving in
  OKLab, hardly different.

The paper is computed in the same shader while the effect is on, which
saves the overlay passes. It is drawn per monitor like the overlay.

Pitfall: offscreen effects and partial redraws. A `ClutterOffscreenEffect`
clears its copy and re-renders it on every frame, but on a partial redraw
Mutter culls everything outside the changed area (background and windows
paint only their clip region), so the rest of the copy is black. Turning
off clipped redraws (`DrawDebugFlag.DISABLE_CLIPPED_REDRAWS`, as Blur my
Shell does) fixes the picture, but then every changing frame repaints the
whole screen, a blinking cursor as much as scrolling. Instead the effect
builds its own paint nodes and keeps a copy per monitor between frames,
painting only the redraw clip into it:

- The clip goes onto the copy as a region clip (`push_region_clip`). A
  `ClutterClipNode` intersects its rectangles, so with a clip made of
  several the copy got nothing. St widgets don't cull, without the clip
  translucent ones would blend over their own previous frame.
- At fractional scales Mutter repaints the screen in whole framebuffer
  pixels and hands the UI a clip rounded out to stage pixels again. The
  copy takes the pixels whose centre lies in that clip, which includes
  every pixel the screen gets and only pixels the background really
  repaints.
- Ink spread and light scattering read neighbours, so pixels just outside
  a change change too.
  Mutter has no way for an extension to widen the redraw clip of the
  current frame (its redraw clip filters are private), so the ring is
  queued for the next frame. The ring itself is damage then, and buffer
  age brings back older damage, rings included: widening those again
  would keep frames coming forever. The last ring and old rings lying
  wholly in the clip are left out (buffer age brings a frame's damage back
  whole, an old ring only partly in the clip has damage on it). A clip of
  rings only queues nothing, so a still screen settles a few frames after
  the last change.
- At fractional scales that isn't exact by itself. Mutter unites the
  damage in framebuffer pixels, splits it into bands and rounds each band
  back out to stage pixels, in float, so the clip gets a fringe the screen
  doesn't get, and gaps of a pixel or two between damage get swallowed
  into the clip without being repainted. The framebuffer clip itself can't
  be read from an extension. So rings are kept in framebuffer pixels, like
  Mutter's damage, and each ring is remembered as what Mutter will make of
  it: the pixels it surely repaints on the screen, and a mask of all the
  pixels it can add to the next clip (an edge on a pixel boundary can
  round either way, depending on how the region is cut into bands). No
  rounding can make a ring look like a change then, not even when buffer
  age brings it back with older damage. The rounding runs on whole regions
  in C (`Mtk.Region.apply_matrix_transform_expand`); going through the
  rectangles in JS cost more than the repaints it saved. Near a change
  the ring also takes in what the clip got without the screen: the fringe
  along the clip's edge, and gaps next to the last ring. A framebuffer
  pixel spans at most two stage pixels at scales of 1 and more, so the
  rounding fills gaps of two stage pixels at most; widths are measured per
  scale rather than written down for a few. What it still misses (a change
  hidden under a ring, gaps between other damage) is repainted once more,
  as a ring, after the screen has been still for 100 ms.
- Rings kept in stage pixels, as before, were rounded twice per round
  trip. With buffer age the slivers that left looked like changes and
  started rings of their own, which fed back into thousands of rectangles
  per frame and stalled the shell. As a safety net, a ring of more than a
  few hundred rectangles still repaints the screen whole instead and
  starts over. The headless shell has no buffer age; the perf helper can
  emulate it (`PAPER_EMULATE_AGE`).
- Screenshots paint the stage without a monitor view; they get a fresh
  copy of their whole area.

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
- Arney & Pray, J. Imaging Sci. Technol. 43(4); Arney & Arney, J. Imaging Sci. Technol. 40(3): the paper point spread function and kp
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
