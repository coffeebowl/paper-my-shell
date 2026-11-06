import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import GObject from 'gi://GObject';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {TONE_SCALE, isPeriodic} from './papergen.js';
import {textureLabel, textureNames} from './textures.js';

Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'delete_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
Gio._promisify(GdkPixbuf.Pixbuf, 'new_from_stream_async');
Gio._promisify(Gio.DBusConnection.prototype, 'call');

const TILES = ['detail', 'tone', 'grain', 'ink'];

// Ink mottle follows the paper's formation at a quarter of its size: the
// tone tile again, stretched only by this factor.
const MOTTLE_STRETCH = 2;

// The tone tile's lowest values (0.5 is flat paper, the deepest dips of the
// textures lie around 0.3). Mottle starts there, so the whole cloud shows
// without lifting all blacks.
const MOTTLE_FLOOR = 0.3;

// Size of a texel in mm the textures are drawn for, a logical pixel at
// about 110 dpi. With true size on, tiles scale to keep it on every monitor.
const TEXEL_MM = 0.23;

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
const INK_REACH = 0.5;

// How far ink and scattered light of a pixel reach its neighbours, in whole
// physical pixels. A change repaints this much around it one frame later.
const INK_RING = Math.ceil(2 * INK_REACH);

// Scattering length kp of light in uncoated paper at the full amount of
// light scattering, in mm (Arney: about 0.1 to 0.25 mm).
const SCATTER_MAX_MM = 0.25;

// Mutter keeps the damage of this many frames for buffer age, so a redraw
// clip can contain areas painted that long ago.
const DAMAGE_HISTORY = 16;

// At fractional scales, how long the screen has to be still before the
// area that changed is repainted once more, in ms.
const SETTLE_DELAY = 100;

// More rectangles than this in a ring or in the area waiting to settle, and
// the screen is repainted whole instead. A safety net: should rings ever
// start rings of their own, they could build up to thousands of rectangles;
// one full repaint costs less and starts over clean.
const RING_MAX_RECTS = 256;

// The darkest ink on uncoated paper still reflects about 5 % of the light,
// in a slightly warm colour. The full matte look lifts black to that.
const PAPER_BLACK = [0.05, 0.05 * 0.97 ** 2.2, 0.05 * 0.92 ** 2.2];

// Settings that only change values or visibility, not the textures.
const SYNC_KEYS = [
    'texture-enabled', 'intensity', 'dark-balance', 'grain', 'true-size',
    'mottle-enabled', 'mottle', 'paper-black-enabled', 'paper-black',
    'light-scatter-enabled', 'light-scatter',
    'brightness-enabled', 'brightness',
    'print-colors-enabled', 'print-colors',
    'ink-spread-enabled', 'ink-spread',
    'hide-in-fullscreen', 'shift-texture',
];

const UNIFORMS = `
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
vec4 cloud = texture2D(${toneSampler}, uv * u_tone_ratio * ${(TONE_SCALE / MOTTLE_STRETCH).toFixed(1)});
float mottle = u_mottle * max(${(0.5 - MOTTLE_FLOOR).toFixed(2)} + cloud.r - 0.5 * cloud.a, 0.0);
float highlight = u_intensity * u_balance * light;
vec4 over = vec4(vec3(highlight), highlight) + vec4(vec3(mottle), mottle) * (1.0 - highlight);
over.rgb *= u_brightness;
`;
}

// Shade and OVER in one blend, dst * shade * (1 - over.a) + over.rgb: the
// colour is over.rgb, the alpha 1 - shade * (1 - over.a).
const OVERLAY_SHADER = `${reliefGlsl('cogl_tex_coord0_in.st',
    'cogl_sampler0', 'cogl_sampler1', 'cogl_sampler2')}${PAPER_SHADE}${paperOverGlsl('cogl_sampler1')}
cogl_color_out = vec4(over.rgb, 1.0 - shade * (1.0 - over.a));
`;

// The matte look, print colours and ink spread need the finished pixels, so
// the UI is rendered offscreen first. The paper is then applied in the same
// pass instead of the overlay. Drawn per monitor: u_origin and u_extent are
// the stage area of the offscreen copy, u_monitor the monitor's.
const PRINT_UNIFORMS = `${UNIFORMS}
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

const PRINT_SHADER = `
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
function matteValues(matte) {
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
function scatterStrength(kp, pixel) {
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
 *   vectors as arrays, uniform arrays as arrays of those arrays
 */
function setUniforms(pipeline, values) {
    for (const [name, value] of Object.entries(values)) {
        const location = pipeline.get_uniform_location(`u_${name}`);
        if (Array.isArray(value?.[0]))
            pipeline.set_uniform_float(location, value[0].length, value.length, value.flat());
        else if (Array.isArray(value))
            pipeline.set_uniform_float(location, value.length, 1, value);
        else
            pipeline.set_uniform_1f(location, value);
    }
}

/**
 * The rectangles of a region as plain numbers. Mtk.Region.get_rectangle()
 * returns a struct by value, which crashes GJS. The iterator works, but
 * hands out the same rectangle every time, and the ring maths runs on
 * every frame, so this reads only the numbers.
 *
 * @param {Mtk.Region} region
 * @returns {number[][]} x, y, width, height
 */
function regionRects(region) {
    const rects = [];
    const it = new Mtk.RegionIterator();
    for (it.init(region); !it.at_end(); it.next()) {
        const r = it.rectangle;
        rects.push([r.x, r.y, r.width, r.height]);
    }
    return rects;
}

/**
 * Calls `f` with an Mtk.Rectangle for each of `rects`. Mutter copies the
 * rectangles it is given, so one does for all.
 *
 * @param {number[][]} rects - x, y, width, height
 * @param {Function} f
 */
function withRectangles(rects, f) {
    const rect = new Mtk.Rectangle();
    for (const r of rects) {
        [rect.x, rect.y, rect.width, rect.height] = r;
        f(rect);
    }
}

/**
 * The region grown by `d` on every side: united with copies of itself
 * shifted across, then up and down, by 1, 2, 4 and so on, each step
 * growing what the steps before grew. All in Mtk, which is much faster
 * than growing each rectangle in JS.
 *
 * @param {Mtk.Region} region
 * @param {number} d
 * @returns {Mtk.Region}
 */
function grow(region, d) {
    const grown = region.copy();
    for (const across of [true, false]) {
        for (let done = 0, step = 1; done < d; done += step, step *= 2) {
            step = Math.min(step, d - done);
            const base = grown.copy();
            for (const shift of [-step, step]) {
                const moved = base.copy();
                moved.translate(across ? shift : 0, across ? 0 : shift);
                grown.union(moved);
            }
        }
    }
    return grown;
}

/**
 * @param {number[][]} rects - x, y, width, height
 * @returns {Mtk.Rectangle} the rectangle around all of them
 */
function extents(rects) {
    const x1 = Math.min(...rects.map(r => r[0]));
    const y1 = Math.min(...rects.map(r => r[1]));
    const x2 = Math.max(...rects.map(r => r[0] + r[2]));
    const y2 = Math.max(...rects.map(r => r[1] + r[3]));
    return new Mtk.Rectangle({x: x1, y: y1, width: x2 - x1, height: y2 - y1});
}

/**
 * @param {number[]} a - x, y, width, height
 * @param {number[]} b - x, y, width, height
 * @returns {number[]|null} the overlap, null if there is none
 */
function intersect(a, b) {
    const x1 = Math.max(a[0], b[0]);
    const y1 = Math.max(a[1], b[1]);
    const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
    const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
    return x2 > x1 && y2 > y1 ? [x1, y1, x2 - x1, y2 - y1] : null;
}

// Mutter turns the damage of a frame into framebuffer pixels and the result
// back into the redraw clip the UI gets, rounding out each rectangle
// (meta-stage-impl.c: offset_scale_and_clamp_region(),
// scale_offset_and_clamp_region()). It does so in float: where a factor
// isn't exact in float, an edge on a pixel boundary can end up on either
// side of it, depending on how the region happens to be cut into
// rectangles. The functions below work on whole regions in C, which is much
// faster than going through the rectangles in JS.

// How close to a pixel boundary an edge has to be for float maths to round
// it either way, in pixels. Well above float precision at screen sizes,
// well below the steps of any useful scale.
const FLOAT_SLACK = 1 / 64;

/**
 * @param {Mtk.Region} region
 * @param {number} sx - factor across
 * @param {number} sy - factor down
 * @param {number} dx - offset across, after scaling
 * @param {number} dy - offset down, after scaling
 * @returns {Mtk.Region} the region scaled and moved, each rectangle rounded
 *   out
 */
function transformRegion(region, sx, sy, dx, dy) {
    const matrix = new Graphene.Matrix().init_scale(sx, sy, 1);
    matrix.translate(new Graphene.Point3D({x: dx, y: dy, z: 0}));
    return region.apply_matrix_transform_expand(matrix);
}

/**
 * Like transformRegion(), with either outcome of float rounding on pixel
 * boundaries: the widest one, or about what all outcomes share (whole
 * regions intersected can keep a pixel in inner corners). Factors with few
 * binary digits (1, 1.25, 2) are exact and round one way only.
 *
 * @param {Mtk.Region} region
 * @param {number} scale
 * @param {number} dx
 * @param {number} dy
 * @param {boolean} wide
 * @returns {Mtk.Region}
 */
function roundRegion(region, scale, dx, dy, wide) {
    if (Number.isInteger(scale * 64))
        return transformRegion(region, scale, scale, dx, dy);
    let result = null;
    for (const ex of [-FLOAT_SLACK, FLOAT_SLACK]) {
        for (const ey of [-FLOAT_SLACK, FLOAT_SLACK]) {
            const r = transformRegion(region, scale, scale, dx + ex, dy + ey);
            if (!result)
                result = r;
            else if (wide)
                result.union(r);
            else
                result.intersect(r);
        }
    }
    return result;
}

/**
 * Damage to framebuffer pixels.
 *
 * @param {Mtk.Region} region - on the stage
 * @param {number} scale - of the view, a float
 * @param {Mtk.Rectangle} layout - of the view
 * @param {boolean} wide
 * @returns {Mtk.Region}
 */
function toFramebuffer(region, scale, layout, wide) {
    return roundRegion(region, scale, -layout.x * scale, -layout.y * scale, wide);
}

/**
 * Framebuffer pixels to the redraw clip the UI gets.
 *
 * @param {Mtk.Region} region - in framebuffer pixels
 * @param {number} scale - of the view, a float
 * @param {Mtk.Rectangle} layout - of the view
 * @param {boolean} wide
 * @returns {Mtk.Region}
 */
function toStage(region, scale, layout, wide) {
    // Mutter scales by the inverse, in float.
    return roundRegion(region, Math.fround(1 / scale), layout.x, layout.y, wide);
}

/**
 * The framebuffer pixels whose centre lies inside a stage region. At
 * fractional scales these are the ones the UI really paints anew (the
 * background, for one, fills only pixels whose centre it covers). Goes
 * through the rectangles: rounding whole regions can't do this exactly.
 *
 * @param {Mtk.Region} region - on the stage
 * @param {Mtk.Rectangle} layout - of the view
 * @param {number} width - of the framebuffer
 * @param {number} height - of the framebuffer
 * @returns {Mtk.Region}
 */
function centrePixels(region, layout, width, height) {
    const toPixel = (v, origin, ratio, size) =>
        Math.min(Math.max(Math.ceil((v - origin) * ratio - 0.5), 0), size);
    const rects = [];
    for (const [rx, ry, rw, rh] of regionRects(region)) {
        const x = toPixel(rx, layout.x, width / layout.width, width);
        const y = toPixel(ry, layout.y, height / layout.height, height);
        const x2 = toPixel(rx + rw, layout.x, width / layout.width, width);
        const y2 = toPixel(ry + rh, layout.y, height / layout.height, height);
        if (x2 > x && y2 > y)
            rects.push([x, y, x2 - x, y2 - y]);
    }
    const pixels = Mtk.Region.create();
    withRectangles(rects, r => pixels.union_rectangle(r));
    return pixels;
}

/**
 * @param {Mtk.Region} region
 * @returns {number[]} start and end across of the region, which must not
 *   be empty
 */
function spanAcross(region) {
    const rects = regionRects(region);
    return [Math.min(...rects.map(r => r[0])), Math.max(...rects.map(r => r[0] + r[2]))];
}

/**
 * How Mutter's rounding widens areas at a scale, in framebuffer pixels:
 * how far the pixels painted anew (the clip in framebuffer pixels) reach
 * past the damage, how wide a gap the rounding can fill, and how wide a
 * ring with fringe and gaps ends up in the next clip, with the damage it
 * causes widened by the fringe (a mask, see PaperPrintEffect._repainted()).
 * Measured along a stretch of pixels rather than derived where float
 * rounding comes in, so it holds for any scale.
 *
 * @param {number} scale - of the view, a float
 * @param {number} ratio - framebuffer pixels per stage pixel
 * @returns {object} fringe, ring and gap widths
 */
function roundingWidths(scale, ratio) {
    const size = 1 << 14;
    const origin = new Mtk.Rectangle({x: 0, y: 0, width: size, height: size});
    const strip = (x, w) => Mtk.Region.create_rectangle(new Mtk.Rectangle({x, y: 0, width: w, height: 1}));
    // Damage always comes in stage pixels.
    let fringe = 0;
    for (let x = 1; x < 64; x++) {
        const [d1, d2] = spanAcross(toFramebuffer(strip(x, 1), scale, origin, false));
        const wide = toFramebuffer(strip(x, 1), scale, origin, true);
        const [p1, p2] = spanAcross(centrePixels(toStage(wide, scale, origin, true),
            origin, size * ratio, size * ratio));
        fringe = Math.max(fringe, d1 - p1, p2 - d2);
    }
    // A pixel spans at most two stage cells, so a cell that only rounding
    // brings into the clip borders a damaged one: gaps it fills are at
    // most two cells wide.
    const gap = fringe > 0 ? Math.ceil(2 * ratio) : 0;
    // A ring is INK_RING outside the clip, plus the fringe and gaps inside
    // it.
    let ring = 0;
    for (let x = 1; x < 64; x++) {
        for (let w = 1; w <= INK_RING + fringe + gap; w++) {
            const stage = transformRegion(strip(x, w), 1 / ratio, 1 / ratio, 0, 0);
            const [d1, d2] = spanAcross(toFramebuffer(stage, scale, origin, true));
            ring = Math.max(ring, d2 - d1 + 2 * fringe);
        }
    }
    return {fringe, ring, gap};
}

/**
 * Ink spread, print colours, light scattering, matte and paper in one pass
 * over an offscreen copy of the UI, drawn back per monitor. Only attached
 * while one of the first four is on. The overlay is hidden then on the
 * monitors it covers.
 *
 * Each monitor view keeps its copy between frames, and a frame only paints
 * its redraw clip into it, so partial redraws keep working: the window group
 * and the background already paint only the clip, a region clip on the copy
 * keeps the rest of the UI inside it too. Everything outside the clip is
 * unchanged in the copy. The copy has the resolution of the view's
 * framebuffer, so fractional scaling doesn't resample it.
 *
 * Ink spread and light scattering read neighbours, so pixels just outside a
 * changed area change as well. Mutter offers no way to widen the redraw
 * clip of the frame from an extension, so that ring is repainted one frame
 * later.
 */
const PaperPrintEffect = GObject.registerClass(
class PaperPrintEffect extends Clutter.Effect {
    constructor(textures) {
        super();
        this._textures = textures;
        this._values = {};
        this._tileSizes = [];
        this._pixelSizes = [];
        this._scatter = new Map();
        this._skipped = new Set();
        this._template = null;
        this._plain = null;
        // Per view framebuffer: the copy, its pipelines and recent rings.
        this._copies = new Map();
        this._pendingRedraws = [];
        this._fullRedraw = false;
        this._settleId = 0;
        global.stage.connectObject('after-paint', (_stage, view) => this._afterPaint(view), this);
    }

    /**
     * @param {object} values - shader uniforms, with scatter as the
     *   scattering length in mm
     * @param {number[]} tileSizes - detail tile size per monitor index
     * @param {number[]} pixelSizes - logical pixel size in mm per monitor
     *   index
     * @param {Set<number>} skipped - monitor indices to leave untouched
     */
    setValues(values, tileSizes, pixelSizes, skipped) {
        this._values = values;
        this._tileSizes = tileSizes;
        this._pixelSizes = pixelSizes;
        this._scatter.clear();
        this._skipped = skipped;
        // The output changes everywhere.
        this.get_actor()?.queue_redraw();
    }

    destroy() {
        global.stage.disconnectObject(this);
        if (this._settleId)
            GLib.source_remove(this._settleId);
        this._settleId = 0;
        this._copies.clear();
        this._pendingRedraws = [];
    }

    _getTemplate(ctx) {
        if (this._template)
            return this._template;
        const pipeline = Cogl.Pipeline.new(ctx);
        const snippet = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, PRINT_UNIFORMS, null);
        snippet.set_replace(PRINT_SHADER);
        pipeline.add_snippet(snippet);
        // Layer 0 is the copy, set per copy.
        const {detail, tone, grain, lut, ink} = this._textures;
        [detail, tone, grain, lut, ink].forEach((texture, i) => {
            pipeline.set_layer_texture(i + 1, texture);
            pipeline.set_layer_wrap_mode(i + 1, texture === lut
                ? Cogl.PipelineWrapMode.CLAMP_TO_EDGE : Cogl.PipelineWrapMode.REPEAT);
        });
        // The lookup table is read between its entries.
        pipeline.set_layer_filters(4, Cogl.PipelineFilter.LINEAR, Cogl.PipelineFilter.LINEAR);
        ['u_screen', 'u_detail', 'u_tone', 'u_grain_tile', 'u_lut', 'u_ink_tile'].forEach((name, layer) =>
            pipeline.set_uniform_1i(pipeline.get_uniform_location(name), layer));
        // The copy is opaque.
        pipeline.set_blend('RGBA = ADD(SRC_COLOR, 0)');
        this._template = pipeline;
        return pipeline;
    }

    /**
     * A pipeline drawing `texture` with the print shader, or unchanged for
     * monitors that are skipped.
     *
     * @param {Cogl.Context} ctx
     * @param {Cogl.Texture} texture
     * @param {boolean} plain
     * @returns {Cogl.Pipeline}
     */
    _pipeline(ctx, texture, plain) {
        if (plain && !this._plain) {
            this._plain = Cogl.Pipeline.new(ctx);
            this._plain.set_blend('RGBA = ADD(SRC_COLOR, 0)');
        }
        const pipeline = (plain ? this._plain : this._getTemplate(ctx)).copy();
        pipeline.set_layer_texture(0, texture);
        pipeline.set_layer_wrap_mode(0, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
        // Ink reads neighbours between texels. The centre sample still hits
        // the texel exactly, the copy maps 1:1 onto the framebuffer.
        pipeline.set_layer_filters(0, Cogl.PipelineFilter.LINEAR, Cogl.PipelineFilter.LINEAR);
        return pipeline;
    }

    /**
     * @param {Cogl.Framebuffer} fb
     * @returns {object} texture and framebuffer of an offscreen copy the
     *   size of `fb`
     */
    _createCopy(fb) {
        const texture = Cogl.Texture2D.new_with_size(fb.get_context(), fb.get_width(), fb.get_height());
        const fbo = Cogl.Offscreen.new_with_texture(texture);
        fbo.allocate();
        return {texture, fbo};
    }

    // Same matrices as the target, so the actor paints into the copy exactly
    // as it would paint into the target.
    _syncMatrices(fbo, fb) {
        fbo.set_projection_matrix(fb.get_projection_matrix());
        fbo.set_modelview_matrix(fb.get_modelview_matrix());
        fbo.set_viewport(...fb.get_viewport4fv());
    }

    vfunc_paint_node(node, paintContext, _flags) {
        const actor = this.get_actor();
        // The magnifier paints clones of the UI. They get no paper, like
        // the overlay outside of uiGroup.
        if (actor.is_in_clone_paint()) {
            node.add_child(Clutter.ActorNode.new(actor, -1));
            return;
        }
        const fb = paintContext.get_framebuffer();
        const view = global.stage.peek_stage_views().find(v => v.get_framebuffer() === fb);
        if (view)
            this._paintView(node, paintContext, view, fb);
        else
            this._paintOther(node, paintContext, fb);
    }

    /**
     * Paint to a monitor: update the view's copy inside the redraw clip,
     * then draw it back.
     */
    _paintView(node, paintContext, view, fb) {
        const actor = this.get_actor();
        const layout = new Mtk.Rectangle();
        view.get_layout(layout);
        const area = [layout.x, layout.y, layout.width, layout.height];
        const monitors = this._monitorsIn(area);

        // Monitors showing a fullscreen window or HDR are left alone, so
        // the window can be scanned out directly. Their copy goes stale.
        if (monitors.every(m => this._skipped.has(m.index))) {
            this._copies.delete(fb);
            node.add_child(Clutter.ActorNode.new(actor, -1));
            return;
        }

        const width = fb.get_width();
        const height = fb.get_height();
        let copy = this._copies.get(fb);
        if (!copy || copy.width !== width || copy.height !== height) {
            this._pruneCopies();
            copy = {
                ...this._createCopy(fb), width, height, pipelines: new Map(), rings: [],
                changed: Mtk.Region.create(), lastPaint: 0,
                bounds: Mtk.Region.create_rectangle(new Mtk.Rectangle({x: 0, y: 0, width, height})),
            };
            this._copies.set(fb, copy);
        }
        copy.scale = view.get_scale();
        this._syncMatrices(copy.fbo, fb);
        this._popClip(copy);

        // Into the copy without clearing it, only inside the redraw clip.
        // A new copy is cleared and filled completely once; the screen
        // outside this frame's clip needs it too, in the next frame.
        const fresh = !copy.painted;
        const clip = paintContext.get_redraw_clip();
        let clipFb = null;
        if (clip && !fresh) {
            // St widgets don't cull, so translucent ones would blend over
            // their own previous frame outside the clip. A clip node can't
            // do this: it intersects its rectangles. The nodes are drawn
            // after this returns, so the clip comes off after the paint.
            clipFb = this._framebufferRegion(clip, layout, copy);
            copy.fbo.push_region_clip(clipFb);
            copy.clipped = true;
        }
        const root = Clutter.RootNode.new(copy.fbo, actor.get_color_state(),
            new Cogl.Color({red: 0, green: 0, blue: 0, alpha: 0}),
            fresh ? Cogl.BufferBit.COLOR : 0);
        root.add_child(Clutter.ActorNode.new(actor, -1));
        node.add_child(root);
        copy.painted = true;
        if (fresh && clip)
            this._fullRedraw = true;
        if (this._values.ink > 0 || this._values.scatter > 0) {
            // Every frame leaves a ring, if only an empty one, so the next
            // frame knows which one was last.
            let changed = null;
            if (clipFb)
                changed = this._queueRing(copy, clipFb, layout);
            else
                this._pushRing(copy, this._repainted(Mtk.Region.create(), layout, copy));
            if (this._roundingWidths(copy, layout).fringe > 0)
                this._noteChange(copy, changed, clipFb);
        }

        // Back onto the monitor, the stage clips it to the redraw clip.
        const ctx = fb.get_context();
        for (const monitor of monitors) {
            const plain = this._skipped.has(monitor.index);
            const key = `${monitor.index}:${plain}`;
            if (!copy.pipelines.has(key))
                copy.pipelines.set(key, this._pipeline(ctx, copy.texture, plain));
            node.add_child(this._quad(copy.pipelines.get(key), monitor, area, width, height));
        }
    }

    /**
     * Paint somewhere else (screenshots, screencasts without a view): into a
     * temporary copy of the whole target, then back with the shader.
     */
    _paintOther(node, paintContext, fb) {
        const actor = this.get_actor();
        const width = fb.get_width();
        const height = fb.get_height();
        const {texture, fbo} = this._createCopy(fb);
        this._syncMatrices(fbo, fb);
        const root = Clutter.RootNode.new(fbo, actor.get_color_state(),
            new Cogl.Color({red: 0, green: 0, blue: 0, alpha: 0}), Cogl.BufferBit.COLOR);
        root.add_child(Clutter.ActorNode.new(actor, -1));
        node.add_child(root);

        // The stage area the target shows, from its viewport: the stage
        // spans the viewport, scaled, offset by the area's origin.
        const [vx, vy, vw, vh] = fb.get_viewport4fv();
        const scaleX = vw / global.stage.width;
        const scaleY = vh / global.stage.height;
        const area = [-vx / scaleX, -vy / scaleY, width / scaleX, height / scaleY];
        const ctx = fb.get_context();
        for (const monitor of this._monitorsIn(area)) {
            const pipeline = this._pipeline(ctx, texture, this._skipped.has(monitor.index));
            node.add_child(this._quad(pipeline, monitor, area, width, height));
        }
    }

    /**
     * @param {number[]} area - stage area, x, y, width, height
     * @returns {object[]} the monitors overlapping it
     */
    _monitorsIn(area) {
        return Main.layoutManager.monitors.filter(m =>
            intersect(area, [m.x, m.y, m.width, m.height]));
    }

    /**
     * The part of the copy over `monitor`, with the print shader.
     *
     * @param {Cogl.Pipeline} pipeline
     * @param {object} monitor
     * @param {number[]} area - stage area of the copy
     * @param {number} width - of the copy in pixels
     * @param {number} height - of the copy in pixels
     * @returns {Clutter.PaintNode}
     */
    _quad(pipeline, monitor, area, width, height) {
        const bounds = [monitor.x, monitor.y, monitor.width, monitor.height];
        // Physical pixels of the copy: logical ones divided by the scale.
        const pixel = (this._pixelSizes[monitor.index] ?? TEXEL_MM) * area[2] / width;
        const key = `${monitor.index}:${pixel}`;
        if (!this._scatter.has(key))
            this._scatter.set(key, scatterStrength(this._values.scatter, pixel));
        setUniforms(pipeline, {
            ...this._values,
            scatter: this._scatter.get(key),
            tone_ratio: this._textures.toneRatio,
            grain_ratio: this._textures.grainRatio,
            lut_size: this._textures.lutSize,
            origin: area.slice(0, 2),
            extent: area.slice(2),
            texel: [1 / width, 1 / height],
            reach: [INK_REACH / width, INK_REACH / height],
            monitor: bounds,
            tile_size: this._tileSizes[monitor.index],
        });
        const [x, y, w, h] = intersect(area, bounds);
        const s = v => (v - area[0]) / area[2];
        const t = v => (v - area[1]) / area[3];
        const quad = Clutter.PipelineNode.new(pipeline);
        quad.add_texture_rectangle(new Clutter.ActorBox({x1: x, y1: y, x2: x + w, y2: y + h}),
            s(x), t(y), s(x + w), t(y + h));
        return quad;
    }

    /**
     * Queue the ring around what changed this frame, for the next frame.
     *
     * Everything is kept in pixels of the copy, where Mutter keeps damage
     * and its history too. The clip holds this frame's damage, which
     * includes last frame's ring, and with buffer age older frames' damage,
     * which comes back whole. Rings change nothing, and taking them for
     * changes would grow them forever. So the last ring is left out, and
     * older rings whose damage lies entirely in the clip; an old ring only
     * partly in it has new damage on it instead. Damage can land on a ring
     * too, so pixels up to a ring's width from what is left count as
     * changed as well. Damage that lands only on a ring and touches nothing
     * else isn't seen. A clip of rings only queues nothing, which is how a
     * still screen settles once real damage has left the history.
     *
     * At fractional scales Mutter repaints the screen in framebuffer pixels
     * rounded out from the damage, and hands the UI that clip rounded out to
     * stage pixels again. The clip, where the copy is painted anew, then
     * holds pixels the screen doesn't get: along the clip's edge (the
     * fringe), and in gaps the rounding fills between two damaged areas.
     * Those near a change go into the ring too. Gaps can only be told next
     * to last frame's ring; others, and changes hidden under rings, get
     * repainted once the screen is still (_noteChange()).
     *
     * Each ring is remembered as what Mutter will repaint for it
     * (_repainted()), so its rounding can't look like a change. Should rings
     * still pile up, the screen is repainted whole (RING_MAX_RECTS).
     *
     * @param {object} copy
     * @param {Mtk.Region} clip - in pixels of the copy
     * @param {Mtk.Rectangle} layout - of the view
     * @returns {Mtk.Region|null} what changed, as far as can be told; null
     *   when the ring got too complex and the screen is repainted whole
     */
    _queueRing(copy, clip, layout) {
        const widths = this._roundingWidths(copy, layout);
        const changed = clip.copy();
        const masks = Mtk.Region.create();
        const repainted = Mtk.Region.create();
        copy.rings.forEach((ring, i) => {
            if (ring.damage.is_empty())
                return;
            const rest = ring.damage.copy();
            rest.subtract(clip);
            if (i === copy.rings.length - 1 || rest.is_empty()) {
                masks.union(ring.mask);
                repainted.union(ring.damage);
            }
        });
        const lastSeeds = copy.rings[copy.rings.length - 1]?.seeds ?? Mtk.Region.create();
        changed.subtract(masks);
        let ring = Mtk.Region.create();
        let seeds = null;
        if (!changed.is_empty()) {
            const near = grow(changed, widths.ring);
            near.intersect(clip);
            const reach = grow(near, INK_RING);
            ring = reach.copy();
            ring.subtract(clip);
            ring.intersect(copy.bounds);
            if (widths.fringe > 0) {
                // In the clip and near a change; rings left out above did
                // reach the screen.
                const unseen = region => {
                    region.intersect(clip);
                    region.intersect(reach);
                    region.subtract(repainted);
                    return region;
                };
                const outside = copy.bounds.copy();
                outside.subtract(clip);
                const fringe = unseen(grow(outside, widths.fringe));
                const gaps = unseen(grow(lastSeeds, widths.gap));
                // Next frame looks for gaps next to this ring, but not next
                // to what filled gaps: inside damage that is repainted every
                // frame that would spread a little more each time.
                seeds = ring.copy();
                seeds.union(fringe);
                ring.union(fringe);
                ring.union(gaps);
            }
        }
        const stage = this._stageRegion(ring, layout, copy);
        if (stage.num_rectangles() > RING_MAX_RECTS) {
            this._fullRedraw = true;
            copy.rings = [];
            this._pushRing(copy, this._repainted(Mtk.Region.create(), layout, copy));
            return null;
        }
        this._pendingRedraws.push(...regionRects(stage));
        const queued = this._repainted(stage, layout, copy);
        if (seeds) {
            // As the damage they cause, which is what gaps lie next to.
            queued.seeds = toFramebuffer(this._stageRegion(seeds, layout, copy), copy.scale, layout, false);
            queued.seeds.intersect(copy.bounds);
        }
        this._pushRing(copy, queued);
        return changed;
    }

    _pushRing(copy, ring) {
        copy.rings.push(ring);
        if (copy.rings.length > DAMAGE_HISTORY)
            copy.rings.shift();
    }

    _roundingWidths(copy, layout) {
        const ratio = copy.width / layout.width;
        const key = `${copy.scale}:${ratio}`;
        if (copy.widthsKey !== key) {
            copy.widths = roundingWidths(copy.scale, ratio);
            copy.widthsKey = key;
        }
        return copy.widths;
    }

    /**
     * @param {Mtk.Region} region - in pixels of the copy
     * @param {Mtk.Rectangle} layout - of the view
     * @param {object} copy
     * @returns {Mtk.Region} stage pixels covering the region
     */
    _stageRegion(region, layout, copy) {
        return transformRegion(region, layout.width / copy.width, layout.height / copy.height,
            layout.x, layout.y);
    }

    /**
     * What redrawing `region` will repaint. Mutter rounds it out to
     * framebuffer pixels, the damage, and back to the stage for the clip,
     * where the copy is painted at pixel centres inside. Going that way
     * exactly means going through the rectangles in JS, which costs; the
     * mask is the widest damage grown by the fringe instead, which holds
     * all of it and is barely wider.
     *
     * @param {Mtk.Region} region - on the stage
     * @param {Mtk.Rectangle} layout - of the view
     * @param {object} copy
     * @returns {object} regions in pixels of the copy: damage, what surely
     *   reaches the screen, mask, all that can show up in the next clip, and
     *   seeds, empty here: the damage of the ring's parts next frame's
     *   damage can leave gaps next to (_queueRing())
     */
    _repainted(region, layout, copy) {
        const damage = toFramebuffer(region, copy.scale, layout, false);
        damage.intersect(copy.bounds);
        const mask = grow(toFramebuffer(region, copy.scale, layout, true),
            this._roundingWidths(copy, layout).fringe);
        mask.intersect(copy.bounds);
        return {damage, mask, seeds: Mtk.Region.create()};
    }

    /**
     * Where rounding leaves a fringe (fractional scales): remember what
     * changed, and repaint it once more, a little wider, when the screen has
     * been still for a moment. Then every pixel near a change was painted
     * from the final copy, whatever a ring left out. That repaint goes in as a ring, so it
     * changes nothing and happens once. A frame that repaints the whole
     * monitor leaves nothing to do.
     *
     * @param {object} copy
     * @param {Mtk.Region|null} changed - from _queueRing()
     * @param {Mtk.Region|null} clip - in pixels of the copy
     */
    _noteChange(copy, changed, clip) {
        copy.lastPaint = GLib.get_monotonic_time();
        const rest = copy.bounds.copy();
        if (clip)
            rest.subtract(clip);
        if (rest.is_empty() || !changed) {
            copy.changed = Mtk.Region.create();
            return;
        }
        copy.changed.union(changed);
        if (copy.changed.num_rectangles() > RING_MAX_RECTS)
            copy.changed = Mtk.Region.create_rectangle(extents(regionRects(copy.changed)));
        if (!copy.changed.is_empty() && !this._settleId) {
            this._settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_DELAY,
                () => this._settle());
        }
    }

    _settle() {
        const now = GLib.get_monotonic_time();
        let waiting = false;
        for (const [fb, copy] of this._copies) {
            if (copy.changed.is_empty())
                continue;
            if (now - copy.lastPaint < SETTLE_DELAY * 1000) {
                waiting = true;
                continue;
            }
            const view = global.stage.peek_stage_views().find(v => v.get_framebuffer() === fb);
            if (!view) {
                copy.changed = Mtk.Region.create();
                continue;
            }
            const layout = new Mtk.Rectangle();
            view.get_layout(layout);
            const area = grow(copy.changed, this._roundingWidths(copy, layout).ring + INK_RING);
            area.intersect(copy.bounds);
            copy.changed = Mtk.Region.create();
            const stage = this._stageRegion(area, layout, copy);
            this._pushRing(copy, this._repainted(stage, layout, copy));
            const actor = this.get_actor();
            withRectangles(regionRects(stage), r => actor?.queue_redraw_with_clip(r));
        }
        if (waiting)
            return GLib.SOURCE_CONTINUE;
        this._settleId = 0;
        return GLib.SOURCE_REMOVE;
    }

    /**
     * @param {Mtk.Region} clip - in stage coordinates
     * @param {Mtk.Rectangle} layout - of the view
     * @param {object} copy
     * @returns {Mtk.Region} the redraw clip in pixels of the copy
     *   (centrePixels()); a method of its own so the headless perf helper
     *   can hand it clips with emulated buffer age
     */
    _framebufferRegion(clip, layout, copy) {
        return centrePixels(clip, layout, copy.width, copy.height);
    }

    _popClip(copy) {
        if (!copy?.clipped)
            return;
        copy.fbo.pop_clip();
        copy.clipped = false;
    }

    // After a view's paint: the clip of its copy comes off, and redraws can
    // be queued again.
    _afterPaint(view) {
        this._popClip(this._copies.get(view.get_framebuffer()));
        this._queuePending();
    }

    _queuePending() {
        const actor = this.get_actor();
        if (!actor)
            return;
        if (this._fullRedraw)
            actor.queue_redraw();
        else
            withRectangles(this._pendingRedraws, r => actor.queue_redraw_with_clip(r));
        this._fullRedraw = false;
        this._pendingRedraws = [];
    }

    // Forget the copies of views that are gone.
    _pruneCopies() {
        const framebuffers = global.stage.peek_stage_views().map(v => v.get_framebuffer());
        for (const fb of this._copies.keys()) {
            if (!framebuffers.includes(fb))
                this._copies.delete(fb);
        }
    }
});

/**
 * Decode a PNG off the compositor thread and upload it once to the GPU.
 *
 * @param {Gio.File} file
 * @param {Gio.Cancellable} cancellable
 * @returns {Promise<Cogl.Texture>}
 */
async function loadTexture(file, cancellable) {
    const stream = await file.read_async(GLib.PRIORITY_DEFAULT, cancellable);
    const pixbuf = await GdkPixbuf.Pixbuf.new_from_stream_async(stream, cancellable);
    stream.close(null);
    const content = St.ImageContent.new_with_preferred_size(
        pixbuf.width, pixbuf.height);
    const coglContext = global.stage.context.get_backend().get_cogl_context();
    content.set_bytes(
        coglContext,
        pixbuf.read_pixel_bytes(),
        pixbuf.has_alpha ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
        pixbuf.width,
        pixbuf.height,
        pixbuf.rowstride);
    return content.get_texture();
}

/**
 * Where generated textures are kept: the user's cache, under a hash of the
 * generator, so a changed generator never shows stale textures.
 *
 * @param {Extension} extension
 * @param {Gio.Cancellable} cancellable
 * @returns {Promise<Gio.File>}
 */
async function cacheDir(extension, cancellable) {
    const [source] = await extension.dir.get_child('papergen.js').load_contents_async(cancellable);
    const hash = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, source).slice(0, 16);
    return Gio.File.new_build_filenamev([GLib.get_user_cache_dir(), extension.uuid, hash]);
}

/**
 * @param {Gio.File} file
 * @param {Gio.Cancellable} cancellable
 * @returns {Promise<boolean>}
 */
async function exists(file, cancellable) {
    try {
        await file.query_info_async('standard::type', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, cancellable);
        return true;
    } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            return false;
        throw e;
    }
}

/**
 * Generate a texture's tiles into dir, in a process of its own: it takes
 * seconds of CPU and a few hundred MB, which must not stall the compositor.
 *
 * @param {Extension} extension
 * @param {string} name
 * @param {Gio.File} dir
 * @param {Gio.Cancellable} cancellable
 */
async function generateTexture(extension, name, dir, cancellable) {
    // All literals, so review tools can tell which script runs.
    const proc = Gio.Subprocess.new(
        ['gjs', '-m', `${extension.path}/generate.js`, `${name}`, `${dir.get_path()}`],
        Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE);
    const id = cancellable.connect(() => proc.force_exit());
    try {
        const [, , stderr] = await proc.communicate_utf8_async(null, cancellable);
        if (!proc.get_successful())
            throw new Error(stderr.trim() || `generator exited with ${proc.get_exit_status()}`);
    } finally {
        cancellable.disconnect(id);
    }
}

/**
 * @param {Gio.File} dir
 * @returns {Promise<Array<[Gio.File, Gio.FileType]>>} its entries, symlinks
 *   not followed
 */
async function listDir(dir) {
    const enumerator = await dir.enumerate_children_async('standard::name,standard::type',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_LOW, null);
    const entries = [];
    let infos;
    while ((infos = await enumerator.next_files_async(32, GLib.PRIORITY_LOW, null)).length)
        entries.push(...infos.map(info => [enumerator.get_child(info), info.get_file_type()]));
    enumerator.close(null);
    return entries;
}

/**
 * @param {Gio.File} file
 * @param {Gio.FileType} type
 */
async function removeTree(file, type) {
    if (type === Gio.FileType.DIRECTORY) {
        for (const [child, childType] of await listDir(file))
            await removeTree(child, childType);
    }
    await file.delete_async(GLib.PRIORITY_LOW, null);
}

/**
 * Remove the textures of other generator versions next to dir.
 *
 * @param {Gio.File} dir - from cacheDir()
 */
async function pruneCache(dir) {
    for (const [child, type] of await listDir(dir.get_parent())) {
        if (!child.equal(dir))
            await removeTree(child, type);
    }
}

/**
 * @returns {number[]} a random position as fractions of a period
 */
function randomShift() {
    return [Math.random(), Math.random()];
}

/**
 * Physical size of a logical pixel in mm per monitor index, for the
 * monitors that report their size (EDID, via Mutter's DisplayConfig).
 *
 * @param {Gio.Cancellable} cancellable
 * @returns {Promise<Map<number, number>>}
 */
async function pixelSizes(cancellable) {
    const reply = await Gio.DBus.session.call(
        'org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
        'org.gnome.Mutter.DisplayConfig', 'GetResources',
        null, null, Gio.DBusCallFlags.NONE, -1, cancellable);
    const [, , outputs] = reply.deepUnpack();
    const monitorManager = global.backend.get_monitor_manager();
    const sizes = new Map();
    for (const [, , , , connector, , , properties] of outputs) {
        const index = monitorManager.get_monitor_for_connector(connector);
        const monitor = Main.layoutManager.monitors[index];
        const widthMm = properties['width-mm']?.unpack() ?? 0;
        const heightMm = properties['height-mm']?.unpack() ?? 0;
        if (!monitor || widthMm <= 0 || heightMm <= 0)
            continue;
        // Area based, so rotation doesn't matter.
        const mm = Math.sqrt(widthMm * heightMm / (monitor.width * monitor.height));
        // Some EDIDs only carry the aspect ratio or nothing sensible.
        if (mm > 0.05 && mm < 1)
            sizes.set(index, mm);
    }
    return sizes;
}

/**
 * Paints the paper over one monitor: shadows multiplied, highlights and
 * mottle composited OVER, in one full-screen pass. All settings are shader
 * uniforms, so changing them never rebuilds anything, and nothing animates,
 * so the surface never causes a redraw by itself.
 */
const PaperSurface = GObject.registerClass(
class PaperSurface extends Clutter.Actor {
    constructor(textures, params) {
        super(params);
        const ctx = global.stage.context.get_backend().get_cogl_context();
        const pipeline = Cogl.Pipeline.new(ctx);
        [textures.detail, textures.tone, textures.grain].forEach((texture, layer) => {
            pipeline.set_layer_texture(layer, texture);
            pipeline.set_layer_wrap_mode(layer, Cogl.PipelineWrapMode.REPEAT);
        });
        pipeline.add_snippet(Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, UNIFORMS, OVERLAY_SHADER));
        pipeline.set_blend('RGBA = ADD(SRC_COLOR, DST_COLOR * (1 - SRC_COLOR[A]))');
        setUniforms(pipeline, {tone_ratio: textures.toneRatio, grain_ratio: textures.grainRatio});
        this._pipeline = pipeline;
        this._tileSize = textures.detailSize;
        this._shift = [0, 0];
        this._values = {intensity: 0, balance: 0, mottle: 0, brightness: 1};
    }

    /**
     * @param {object} values - shader uniforms
     * @param {number} tileSize - detail tile size on this monitor, in
     *   logical pixels
     * @param {number[]} shift - where the texture starts, in tiles
     */
    setValues(values, tileSize, shift) {
        this._values = values;
        this._tileSize = tileSize;
        this._shift = shift;
        setUniforms(this._pipeline, values);
        this.queue_redraw();
    }

    vfunc_get_paint_volume(volume) {
        return volume.set_from_allocation(this);
    }

    vfunc_paint_node(root, _paintContext) {
        const {intensity, mottle, brightness} = this._values;
        if (intensity <= 0 && mottle <= 0 && brightness >= 1)
            return;
        const [width, height] = this.get_size();
        const tiles = [width / this._tileSize, height / this._tileSize];
        const box = new Clutter.ActorBox({x1: 0, y1: 0, x2: width, y2: height});
        const node = Clutter.PipelineNode.new(this._pipeline);
        const [x, y] = this._shift;
        node.add_texture_rectangle(box, x, y, x + tiles[0], y + tiles[1]);
        root.add_child(node);
    }
});

/**
 * One PaperSurface per monitor on top of the shell UI.
 *
 * Two texture layers keep the tiling invisible: the fine detail tile
 * repeats every 1024 px, which the eye can't spot in random grain. The
 * low-frequency tone would give the repetition away, so it is a separate
 * small tile stretched 8x that only repeats every few thousand pixels.
 */
class PaperOverlay {
    constructor(settings, extension) {
        this._settings = settings;
        this._extension = extension;
        this._cacheDir = null;
        this._surfaces = [];
        this._textures = null;
        this._cancellable = null;
        this._print = null;
        this._unredirectDisabled = false;
        this._pixelSizes = new Map();
        this._sizesCancellable = null;
        this._shift = randomShift();
        this._locked = Main.sessionMode.isLocked;
        // Values shown while a slider is dragged, before they are saved.
        this._previews = new Map();

        settings.connectObject(
            'changed::enabled', () => this._rebuild(),
            'changed::texture', () => this._load(),
            this);
        for (const key of SYNC_KEYS) {
            settings.connectObject(`changed::${key}`, () => {
                this._previews.delete(key);
                this._sync();
            }, this);
        }
        Main.layoutManager.connectObject('monitors-changed', () => {
            this._loadPixelSizes();
            this._rebuild();
        }, this);
        global.display.connectObject(
            'in-fullscreen-changed', () => this._sync(), this);
        // A static pattern on an OLED screen slowly wears into it. A new
        // random position at every login and unlock spreads that wear out,
        // and unlocking repaints the screen anyway.
        Main.sessionMode.connectObject('updated', () => {
            const locked = Main.sessionMode.isLocked;
            if (this._locked && !locked) {
                this._shift = randomShift();
                this._sync();
            }
            this._locked = locked;
        }, this);

        this._loadPixelSizes();
        this._rebuild();
    }

    async _loadPixelSizes() {
        this._sizesCancellable?.cancel();
        const cancellable = this._sizesCancellable = new Gio.Cancellable();
        try {
            this._pixelSizes = await pixelSizes(cancellable);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            console.error(`Paper my Shell: cannot read monitor sizes: ${e.message}`);
            this._pixelSizes = new Map();
        }
        this._sizesCancellable = null;
        this._sync();
    }

    /**
     * Where the texture starts, in detail tiles: anywhere within a period
     * of the tone tile, which repeats last, in whole texels so periodic
     * textures stay on the pixel grid.
     *
     * @returns {number[]}
     */
    _shiftTiles() {
        if (!this._settings.get_boolean('shift-texture'))
            return [0, 0];
        const {detailSize, toneRatio} = this._textures;
        const period = detailSize / toneRatio;
        return this._shift.map(f => Math.floor(f * period) / detailSize);
    }

    /**
     * Detail tile size on a monitor in logical pixels. With true size the
     * texels keep their physical size, otherwise they are logical pixels.
     * Periodic textures always stay at one texel per pixel: scaled by a
     * fraction their lines or weave would shimmer.
     *
     * @param {number} index - monitor index
     * @returns {number}
     */
    _tileSize(index) {
        const size = this._textures.detailSize;
        const mm = this._pixelSizes.get(index);
        const trueSize = this._settings.get_boolean('true-size') && !this._textures.periodic;
        return trueSize && mm ? size * TEXEL_MM / mm : size;
    }

    /**
     * Load a texture from the cache, generating it first if it isn't there
     * or incomplete.
     *
     * @param {string} name
     * @param {Gio.Cancellable} cancellable
     */
    async _loadTextures(name, cancellable) {
        this._cacheDir ??= await cacheDir(this._extension, cancellable);
        const dir = this._cacheDir.get_child(name);
        const files = TILES.map(tile => dir.get_child(`${tile}.png`));
        const found = await Promise.all(files.map(file => exists(file, cancellable)));
        if (!found.every(Boolean)) {
            await generateTexture(this._extension, name, dir, cancellable);
            pruneCache(this._cacheDir).catch(e =>
                console.error(`Paper my Shell: cannot clean up the texture cache: ${e.message}`));
        }
        const [detail, tone, grain, ink, lut] = await Promise.all([
            ...files.map(file => loadTexture(file, cancellable)),
            loadTexture(this._extension.dir.get_child('print-lut.png'), cancellable),
        ]);
        return {
            detail,
            tone,
            grain,
            lut,
            ink,
            detailSize: detail.get_width(),
            toneRatio: detail.get_width() / (tone.get_width() * TONE_SCALE),
            grainRatio: detail.get_width() / grain.get_width(),
            lutSize: lut.get_width(),
            periodic: isPeriodic(name),
        };
    }

    /**
     * Load the selected texture, or the default one if that fails, then
     * swap it in. The old texture stays on screen while loading.
     */
    async _load() {
        this._cancellable?.cancel();
        const cancellable = this._cancellable = new Gio.Cancellable();
        const selected = this._settings.get_string('texture');
        const fallback = this._settings.get_default_value('texture').unpack();

        let textures = null;
        for (const name of new Set([selected, fallback])) {
            try {
                textures = await this._loadTextures(name, cancellable);
                break;
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
                console.error(`Paper my Shell: cannot load texture ${name}: ${e.message}`);
            }
        }
        if (cancellable.is_cancelled())
            return;
        this._cancellable = null;
        // Without any texture the overlay stays off until the next rebuild.
        if (!textures)
            return;
        this._textures = textures;
        this._rebuild();
    }

    _rebuild() {
        this._destroySurfaces();
        this._removePrint();

        if (!this._settings.get_boolean('enabled'))
            return;

        if (!this._textures) {
            if (!this._cancellable)
                this._load();
            return;
        }

        for (const monitor of Main.layoutManager.monitors) {
            const surface = new PaperSurface(this._textures, {
                name: 'paper-my-shell-overlay',
                x: monitor.x,
                y: monitor.y,
                width: monitor.width,
                height: monitor.height,
                reactive: false,
            });
            Shell.util_set_hidden_from_pick(surface, true);
            // Popups raise themselves inside uiGroup when they open, so
            // sit next to uiGroup on the stage to stay above all of it.
            global.stage.add_child(surface);
            this._surfaces.push({surface, monitorIndex: monitor.index});
        }

        this._sync();
    }

    /**
     * Show a value without saving it, e.g. while a slider is dragged. The
     * next change of the setting replaces it.
     *
     * @param {string} key
     * @param {number} value
     */
    preview(key, value) {
        this._previews.set(key, value);
        this._sync();
    }

    _double(key) {
        return this._previews.get(key) ?? this._settings.get_double(key);
    }

    _sync() {
        if (!this._settings.get_boolean('enabled') || !this._textures)
            return;

        const s = this._settings;
        const values = {
            intensity: s.get_boolean('texture-enabled') ? this._double('intensity') : 0,
            balance: this._double('dark-balance'),
            grain: this._double('grain'),
            mottle: s.get_boolean('mottle-enabled') ? this._double('mottle') : 0,
            brightness: s.get_boolean('brightness-enabled') ? this._double('brightness') : 1,
        };
        const matte = s.get_boolean('paper-black-enabled') ? this._double('paper-black') : 0;
        const print = s.get_boolean('print-colors-enabled') ? this._double('print-colors') : 0;
        const ink = s.get_boolean('ink-spread-enabled') ? this._double('ink-spread') : 0;
        const scatter = s.get_boolean('light-scatter-enabled')
            ? this._double('light-scatter') * SCATTER_MAX_MM : 0;

        // A covered fullscreen window can't be scanned out directly.
        const monitors = Main.layoutManager.monitors;
        const hideInFullscreen = s.get_boolean('hide-in-fullscreen');
        const fullscreen = index => hideInFullscreen && monitors[index]?.inFullscreen;

        // The print effect leaves out monitors with a fullscreen window, so
        // it can be scanned out, and HDR monitors, whose values the shader
        // doesn't expect. HDR monitors keep the overlay.
        const hdr = new Set(global.backend.get_monitor_manager().get_logical_monitors()
            .filter(lm => lm.get_monitors().some(m => m.get_color_mode_string() === 'bt2100'))
            .map(lm => lm.get_number()));
        const skipped = new Set(monitors
            .filter(m => fullscreen(m.index) || hdr.has(m.index)).map(m => m.index));
        const printActive = (matte > 0 || print > 0 || ink > 0 || scatter > 0) &&
            monitors.some(m => !skipped.has(m.index));
        if (printActive) {
            if (!this._print) {
                this._print = new PaperPrintEffect(this._textures);
                Main.layoutManager.uiGroup.add_effect_with_name('paper-my-shell-print', this._print);
            }
            this._print.setValues(
                {...values, ...matteValues(matte), print, ink, scatter, shift: this._shiftTiles()},
                monitors.map(m => this._tileSize(m.index)),
                monitors.map(m => this._pixelSizes.get(m.index) ?? TEXEL_MM),
                skipped);
        } else {
            this._removePrint();
        }
        // Mutter doesn't look at effects on parents of a fullscreen window
        // and would scan it out past the effect.
        this._setUnredirect(!printActive || hideInFullscreen);

        for (const {surface, monitorIndex} of this._surfaces) {
            surface.setValues(values, this._tileSize(monitorIndex), this._shiftTiles());
            const printed = printActive && !skipped.has(monitorIndex);
            surface.visible = !printed && !fullscreen(monitorIndex);
        }
    }

    _setUnredirect(allowed) {
        if (allowed === !this._unredirectDisabled)
            return;
        if (allowed)
            global.compositor.enable_unredirect();
        else
            global.compositor.disable_unredirect();
        this._unredirectDisabled = !allowed;
    }

    _removePrint() {
        this._setUnredirect(true);
        if (!this._print)
            return;
        Main.layoutManager.uiGroup.remove_effect(this._print);
        this._print.destroy();
        this._print = null;
    }

    _destroySurfaces() {
        for (const {surface} of this._surfaces)
            surface.destroy();
        this._surfaces = [];
    }

    destroy() {
        this._cancellable?.cancel();
        this._sizesCancellable?.cancel();
        this._settings.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        global.display.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        this._destroySurfaces();
        this._removePrint();
        this._textures = null;
    }
}

const PaperToggle = GObject.registerClass(
class PaperToggle extends QuickMenuToggle {
    _init(extension, settings, overlay) {
        const gicon = Gio.FileIcon.new(
            extension.dir.resolve_relative_path('icons/paper-symbolic.svg'));
        super._init({
            title: _('Paper'),
            gicon,
            toggleMode: true,
        });
        this._settings = settings;
        this._overlay = overlay;
        settings.bind('enabled', this, 'checked', Gio.SettingsBindFlags.DEFAULT);
        this.connect('destroy', () => Gio.Settings.unbind(this, 'checked'));

        this.menu.setHeader(gicon, _('Paper Texture'));

        // Useful intensities are small, a quadratic curve gives them room.
        this._addSlider('intensity', 'texture-enabled', {gicon}, _('Texture intensity'),
            v => v * v, value => Math.sqrt(value));
        this._addSlider('paper-black', 'paper-black-enabled', {icon_name: 'display-brightness-symbolic'},
            _('Matte'), v => v, value => value);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._textureItems = new Map();
        for (const name of textureNames(settings)) {
            const item = new PopupMenu.PopupMenuItem(textureLabel(name));
            item.connect('activate', () => settings.set_string('texture', name));
            this.menu.addMenuItem(item);
            this._textureItems.set(name, item);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction(_('Settings'), () => extension.openPreferences());

        settings.connectObject(
            'changed::texture', () => this._syncTexture(), this);
        this._syncTexture();
    }

    _addSlider(key, enabledKey, iconParams, accessibleName, toValue, toSlider) {
        const settings = this._settings;
        const slider = new Slider(toSlider(settings.get_double(key)));
        slider.x_expand = true;
        slider.accessible_name = accessibleName;
        const save = () => {
            const value = toValue(slider.value);
            if (Math.abs(value - settings.get_double(key)) > 1e-6)
                settings.set_double(key, value);
        };
        // While dragging only show the value, dconf gets the final one.
        // Keyboard and scroll changes are single steps and saved directly.
        let dragging = false;
        slider.connect('drag-begin', () => (dragging = true));
        slider.connect('drag-end', () => {
            dragging = false;
            save();
        });
        slider.connect('notify::value', () => {
            if (dragging)
                this._overlay.preview(key, toValue(slider.value));
            else
                save();
        });
        settings.connectObject(`changed::${key}`, () => {
            const position = toSlider(settings.get_double(key));
            if (Math.abs(position - slider.value) > 1e-6)
                slider.value = position;
        }, this);

        const item = new PopupMenu.PopupBaseMenuItem({activate: false});
        item.add_child(new St.Icon({style_class: 'popup-menu-icon', ...iconParams}));
        item.add_child(slider);
        this.menu.addMenuItem(item);

        // Only offer the slider while its feature is switched on.
        const syncVisible = () => (item.visible = settings.get_boolean(enabledKey));
        settings.connectObject(`changed::${enabledKey}`, syncVisible, this);
        syncVisible();
    }

    _syncTexture() {
        const current = this._settings.get_string('texture');
        this.subtitle = textureLabel(current);
        for (const [name, item] of this._textureItems)
            item.setOrnament(name === current ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT);
    }
});

const PaperIndicator = GObject.registerClass(
class PaperIndicator extends SystemIndicator {
    _init(extension, settings, overlay) {
        super._init();
        this.quickSettingsItems.push(new PaperToggle(extension, settings, overlay));

        // The extension keeps running on the lock screen so the paper stays,
        // but settings are not for whoever stands at the locked machine.
        const sync = () => this.quickSettingsItems.forEach(item =>
            (item.visible = !Main.sessionMode.isLocked));
        Main.sessionMode.connectObject('updated', sync, this);
        sync();
    }

    destroy() {
        Main.sessionMode.disconnectObject(this);
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});

export default class PaperMyShellExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._overlay = new PaperOverlay(this._settings, this);
        this._indicator = new PaperIndicator(this, this._settings, this._overlay);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    // The paper stays on the lock screen, so locking doesn't change how the
    // screen looks, with the settings hidden there (PaperIndicator). Hence
    // the unlock-dialog session mode.
    disable() {
        this._indicator.destroy();
        this._indicator = null;
        this._overlay.destroy();
        this._overlay = null;
        this._settings = null;
    }
}
