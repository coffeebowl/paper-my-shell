import {TONE_SCALE} from './papergen.js';

// Ink mottle follows the paper's formation at three eighths of its size:
// the tone tile again, stretched only by this factor.
const MOTTLE_STRETCH = 3;

// The tone tile's lowest values (0.5 is flat paper, the deepest dips of the
// textures lie around 0.3). Mottle starts there, so the whole cloud shows
// without lifting all blacks.
const MOTTLE_FLOOR = 0.3;

// Size of a texel in mm the textures are drawn for, a logical pixel at
// about 110 dpi. With true size on, tiles scale to keep it on every monitor.
export const TEXEL_MM = 0.23;

// Ink spread at full amount, keep in sync with preview.py: the share of
// the paper that takes ink, how far a pixel darkens towards its darkest
// neighbour, and towards the ink one step along a fibre (a quarter of that
// two steps along). The share grows with the amount, the strengths with its
// square root: half the amount still looks like ink, more of it spreads to
// more places rather than only darker.
const INK_SHARE = 0.7;
const INK_STRENGTH = 0.9;
const INK_FEATHER = 0.9;

// Distance of the ink neighbours and length of a feather step, in physical
// pixels. Half a pixel, read with linear filtering, lets strokes grow by
// less than a pixel and softens the ragged edges. It also halves the pull
// of a neighbour, which the strengths above make up for. Light scattering
// reads the same four neighbours.
export const INK_REACH = 0.5;

// How far ink and scattered light of a pixel reach its neighbours, in whole
// physical pixels. A change repaints this much around it one frame later.
export const INK_RING = Math.ceil(2 * INK_REACH);

// Scattering length kp of light in uncoated paper at the full amount of
// light scattering, in mm (Arney: about 0.1 to 0.25 mm).
export const SCATTER_MAX_MM = 0.25;

// The darkest ink on uncoated paper still reflects about 5 % of the light,
// in a slightly warm colour. The full matte look lifts black to that.
const PAPER_BLACK = [0.05, 0.05 * 0.97 ** 2.2, 0.05 * 0.92 ** 2.2];

export const UNIFORMS = `
uniform float u_intensity;
uniform float u_balance;
uniform float u_grain;
uniform float u_mottle;
uniform float u_brightness;
uniform float u_tone_ratio;
uniform float u_grain_ratio;
`;

/**
 * GLSL computing `shadow` and `light` of the paper relief at `uv`, given in
 * detail-tile coordinates. u_tone_ratio and u_grain_ratio convert them to
 * the other tiles' coordinates.
 *
 * Texels are grey + alpha, premultiplied on upload: grey 0 marks a shadow,
 * grey 1 a highlight. So .r is the highlight and .a - .r the shadow amount.
 *
 * @param {string} uv - GLSL expression
 * @param {string} detailSampler
 * @param {string} toneSampler
 * @param {string} grainSampler
 * @returns {string}
 */
function reliefGlsl(uv, detailSampler, toneSampler, grainSampler) {
    return `
vec2 uv = ${uv};
vec4 detail = texture2D(${detailSampler}, uv);
vec4 tone = texture2D(${toneSampler}, uv * u_tone_ratio);
vec4 grain = u_grain * texture2D(${grainSampler}, uv * u_grain_ratio);
float shadow = 1.0 - (1.0 - (detail.a - detail.r)) * (1.0 - (tone.a - tone.r)) *
    (1.0 - (grain.a - grain.r));
float light = 1.0 - (1.0 - detail.r) * (1.0 - tone.r) * (1.0 - grain.r);
`;
}

// Multiplied with the screen: shadows of the relief. Brightness is a plain
// dimming factor on top.
const PAPER_SHADE = `
float shade = u_brightness * (1.0 - u_intensity * shadow);
`;

/**
 * GLSL composited OVER the screen: relief highlights over uneven ink
 * (mottle: ink soaks into the paper's cloudy formation unevenly, which
 * lightens dark areas in patches). The cloud without the even floor under
 * it, which would only lift blacks along a straight line and wash the
 * screen out: its darkest spots, where ink went on thickest, stay as they
 * are. Dimmed along with the rest so nothing gets brighter than the dimmed
 * white.
 *
 * @param {string} toneSampler
 * @returns {string}
 */
function paperOverGlsl(toneSampler) {
    return `
vec4 cloud = texture2D(${toneSampler}, uv * u_tone_ratio * ${(TONE_SCALE / MOTTLE_STRETCH).toFixed(4)});
float mottle = u_mottle * max(${(0.5 - MOTTLE_FLOOR).toFixed(2)} + cloud.r - 0.5 * cloud.a, 0.0);
float highlight = u_intensity * u_balance * light;
vec4 over = vec4(vec3(highlight), highlight) + vec4(vec3(mottle), mottle) * (1.0 - highlight);
over.rgb *= u_brightness;
`;
}

// Shade and OVER in one blend, dst * shade * (1 - over.a) + over.rgb: the
// colour is over.rgb, the alpha 1 - shade * (1 - over.a).
export const OVERLAY_SHADER = `${reliefGlsl('cogl_tex_coord0_in.st',
    'cogl_sampler0', 'cogl_sampler1', 'cogl_sampler2')}${PAPER_SHADE}${paperOverGlsl('cogl_sampler1')}
cogl_color_out = vec4(over.rgb, 1.0 - shade * (1.0 - over.a));
`;

// The matte look, print colours and ink spread need the finished pixels, so
// the UI is rendered offscreen first. The paper is then applied in the same
// pass instead of the overlay. Drawn per monitor: u_origin and u_extent are
// the stage area of the offscreen copy, u_monitor the monitor's.
export const PRINT_UNIFORMS = `${UNIFORMS}
uniform float u_print;
uniform float u_ink;
uniform float u_scatter;
uniform vec3 u_paper_black;
uniform vec3 u_tint;
uniform vec2 u_origin;
uniform vec2 u_extent;
uniform vec2 u_texel;
uniform vec2 u_reach;
uniform vec2 u_shift;
uniform vec4 u_monitor;
uniform float u_tile_size;
uniform sampler2D u_screen;
uniform sampler2D u_detail;
uniform sampler2D u_tone;
uniform sampler2D u_grain_tile;
uniform sampler2D u_lut;
uniform float u_lut_size;
uniform sampler2D u_ink_tile;

// The print colours lookup table (tools/printlut.py), a 3D table laid out
// like Mutter's: red along x, green + blue × size along y. Linear within a
// blue slice, mixed between the two nearest slices.
vec3 print_lut(vec3 c) {
    float n = u_lut_size;
    vec3 s = clamp(c, 0.0, 1.0) * (n - 1.0);
    float b0 = floor(s.b);
    float b1 = min(b0 + 1.0, n - 1.0);
    float x = (s.r + 0.5) / n;
    vec3 lo = texture2D(u_lut, vec2(x, (s.g + 0.5 + b0 * n) / (n * n))).rgb;
    vec3 hi = texture2D(u_lut, vec2(x, (s.g + 0.5 + b1 * n) / (n * n))).rgb;
    return mix(lo, hi, s.b - b0);
}
`;

/**
 * GLSL reading the offscreen copy `offset` away from `st`, kept on the
 * monitor bounds `lo` and `hi`: ink doesn't cross from one monitor to the
 * next.
 *
 * @param {string} offset - GLSL vec2 expression
 * @returns {string}
 */
function neighbourGlsl(offset) {
    return `texture2D(u_screen, clamp(st + ${offset}, lo, hi)).rgb`;
}

export const PRINT_SHADER = `
vec2 st = cogl_tex_coord0_in.st;
vec4 color = texture2D(u_screen, st) * cogl_color_in;
vec3 c = color.a > 0.0 ? color.rgb / color.a : color.rgb;

// The paper is laid out per monitor like the overlay.
vec2 pos = u_origin + st * u_extent;
vec2 paper_uv = (pos - u_monitor.xy) / u_tile_size + u_shift;

// The four neighbours half a pixel away, each the mean of two pixels. Ink
// spread and light scattering read them.
vec2 lo = (u_monitor.xy - u_origin) / u_extent + 0.5 * u_texel;
vec2 hi = (u_monitor.xy + u_monitor.zw - u_origin) / u_extent - 0.5 * u_texel;
vec3 raw = c;
vec3 right, left, down, up;
if (u_ink > 0.0 || u_scatter > 0.0) {
    right = ${neighbourGlsl('vec2(u_reach.x, 0.0)')};
    left = ${neighbourGlsl('vec2(-u_reach.x, 0.0)')};
    down = ${neighbourGlsl('vec2(0.0, u_reach.y)')};
    up = ${neighbourGlsl('vec2(0.0, -u_reach.y)')};
}

// Ink soaks into the paper (u_ink_tile, see papergen.js ink()). Strokes
// grow towards their darkest neighbour, but only where the paper takes ink,
// on its fibres and raised grain: a hard threshold, so edges turn ragged
// instead of soft. It is taken at four points inside the pixel, so a pixel
// takes part of the ink and the ragged edge isn't made of whole pixels.
// Where a fibre runs through a pixel, ink also creeps along it, the short
// feathers of ink on absorbent paper, fading with the square of the
// distance. Everything scales with the amount. Never lightens.
if (u_ink > 0.0) {
    vec2 ink_uv = paper_uv * u_grain_ratio;
    vec3 soak = texture2D(u_ink_tile, ink_uv).rgb;
    vec2 quarter = 0.25 * u_extent * u_texel / u_tile_size * u_grain_ratio;
    float threshold = 1.0 - ${INK_SHARE.toFixed(2)} * u_ink;
    float take = 0.25 * (
        step(threshold, texture2D(u_ink_tile, ink_uv + quarter).b) +
        step(threshold, texture2D(u_ink_tile, ink_uv - quarter).b) +
        step(threshold, texture2D(u_ink_tile, ink_uv + vec2(quarter.x, -quarter.y)).b) +
        step(threshold, texture2D(u_ink_tile, ink_uv + vec2(-quarter.x, quarter.y)).b));
    float strength = sqrt(u_ink);
    vec3 near = min(min(right, left), min(down, up));
    vec3 spread = c + (near - c) * take * ${INK_STRENGTH.toFixed(2)} * strength;
    vec2 along = soak.rg * 2.0 - 1.0;
    if (length(along) >= 0.5) {
        // Doubled angle back to the fibre, in whole steps.
        float angle = 0.5 * atan(along.y, along.x);
        vec2 fibre = vec2(cos(angle), sin(angle));
        for (int i = 1; i <= 2; i++) {
            float distance = float(i);
            vec2 reach = floor(distance * fibre + 0.5) * u_reach;
            vec3 far = min(${neighbourGlsl('reach')}, ${neighbourGlsl('-reach')});
            spread = min(spread,
                c + (far - c) * ${INK_FEATHER.toFixed(2)} * strength / (distance * distance));
        }
    }
    c = min(c, spread);
}

// Print can't reach the colourfulness of emitted light, least of all in
// blue, violet and green. Colours outside the gamut of offset print on
// uncoated paper move in OKLab towards the grey of their hue's most
// colourful print colour, with a soft knee so gradients stay smooth (see
// tools/printgamut.py and preview.py print_colours()). Baked into a lookup
// table. Greys and colours print can reach stay untouched, greys skip it.
if (u_print > 0.0 && max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)) > 1.0 / 1024.0)
    c = mix(c, print_lut(c), u_print);

// Light scattering (optical dot gain): light enters the paper through the
// ink, scatters sideways and leaves through the ink where it comes out.
// With T the ink's transmittance, a flat area reflects T * T, so
// T = sqrt(linear) = c^1.1; at edges it is T * blur(T). Dark strokes get a
// soft halo, light gaps between them get darker. u_scatter mixes in the
// mean of the four neighbours, from the physical scattering length and the
// pixel size (scatterStrength()). The blur is taken from the unprocessed
// copy, as a difference, so flat areas stay exactly as they are.
if (u_scatter > 0.0) {
    vec3 e = vec3(1.1);
    vec3 around = 0.25 * (pow(right, e) + pow(left, e) + pow(down, e) + pow(up, e));
    vec3 t = pow(max(c, 0.0), e);
    vec3 blurred = max(t + u_scatter * (around - pow(raw, e)), 0.0);
    c = pow(t * blurred, vec3(1.0 / 2.2));
}

// Matte: even the darkest ink reflects some light, which adds up in linear
// light. Shadows lift, midtones barely, white not at all.
if (u_paper_black.r > 0.0)
    c = pow(u_paper_black + (1.0 - u_paper_black) * pow(max(c, 0.0), vec3(2.2)), vec3(1.0 / 2.2));
${reliefGlsl('paper_uv', 'u_detail', 'u_tone', 'u_grain_tile')}${PAPER_SHADE}${paperOverGlsl('u_tone')}
c = c * shade * u_tint * (1.0 - over.a) + over.rgb;
cogl_color_out = vec4(c * color.a, color.a);
`;

/**
 * The matte look's uniforms. The black lift is even in screen values, so
 * the slider feels linear, up to the black of uncoated paper. Paper white
 * under room light is a little warmer than a screen's.
 *
 * @param {number} matte - 0..1
 * @returns {object} paper_black (linear light) and tint
 */
export function matteValues(matte) {
    return {
        paper_black: PAPER_BLACK.map(b => (matte * b ** (1 / 2.2)) ** 2.2),
        tint: [1, 1 - 0.015 * matte, 1 - 0.045 * matte],
    };
}

/**
 * How much of the four neighbours' mean light scattering mixes in. Paper
 * scatters light by Arney's point spread function (2π/kp²)·exp(−2πr/kp).
 * Light enters evenly over a pixel and is seen evenly over pixels, so the
 * share that stays in its pixel is that function against the pixel's
 * autocorrelation (1 − |x|)(1 − |y|). The rest goes to the neighbours: a
 * mix of s gives them s / 2, diagonals and further pixels included, which
 * hold only a few percent of it at the sizes that fit. It can't give them
 * more than half, so on very fine pixels the halo stops growing.
 *
 * @param {number} kp - scattering length in mm
 * @param {number} pixel - size of a physical pixel in mm
 * @returns {number} 0..1
 */
export function scatterStrength(kp, pixel) {
    if (kp <= 0)
        return 0;
    // The distance from entry to exit has the density t·exp(−t) in units
    // of kp / 2π. Integrated over t and a quarter of the directions.
    const scale = kp / pixel / (2 * Math.PI);
    const steps = 80, end = 16, angles = 8;
    let stay = 0;
    for (let i = 0; i < steps; i++) {
        const t = (i + 0.5) * end / steps;
        const r = scale * t;
        let ring = 0;
        for (let j = 0; j < angles; j++) {
            const angle = (j + 0.5) * Math.PI / 2 / angles;
            ring += Math.max(0, 1 - r * Math.cos(angle)) * Math.max(0, 1 - r * Math.sin(angle));
        }
        stay += t * Math.exp(-t) * ring / angles * end / steps;
    }
    return Math.min(1, 2 * (1 - stay));
}

/**
 * @param {Cogl.Pipeline} pipeline
 * @param {object} values - uniform names without the u_ prefix; numbers,
 *   vectors as arrays
 */
export function setUniforms(pipeline, values) {
    for (const [name, value] of Object.entries(values)) {
        const location = pipeline.get_uniform_location(`u_${name}`);
        if (Array.isArray(value))
            pipeline.set_uniform_float(location, value.length, 1, value);
        else
            pipeline.set_uniform_1f(location, value);
    }
}
