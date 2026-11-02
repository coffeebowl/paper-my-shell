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
  (Grace Gilbert's watercolor stylization does this).
- **Wood:** concentric rings `sin(k·sqrt(x² + y²))` stretched strongly along
  one axis (e.g. 2.0 vs 0.4), domain-warped with FBM so the rings wobble,
  plus fine directional grain noise along the fibre direction. Mostly a
  height/tone pattern, little relief.
- **Fabric / canvas:** a weave pattern as height map: alternating over/under
  threads (`sin` on x and y, swapped every other cell), each thread with
  slight thickness and position jitter, plus fuzz noise. Linen: irregular
  thread widths. Canvas: coarser, stronger relief.
- **Leather:** Worley cells as pores and creases, low relief.

### Sources

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
