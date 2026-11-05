import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
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

// Size of a texel in mm the textures are drawn for, a logical pixel at
// about 110 dpi. With true size on, tiles scale to keep it on every monitor.
const TEXEL_MM = 0.23;

// Ink spread at full amount, keep in sync with preview.py: the share of
// the paper that takes ink, how far a pixel darkens towards its darkest
// neighbour, and towards the ink one pixel along a fibre (a quarter of
// that two pixels along).
const INK_SHARE = 0.3;
const INK_STRENGTH = 0.6;
const INK_FEATHER = 0.6;

// The print effect spans all monitors and gets their geometry as uniform
// arrays of this length.
const MAX_MONITORS = 4;

// Schema maximum of the matte key.
const MATTE_MAX = 0.5;

// The darkest ink on uncoated paper still reflects about 5 % of the light.
// The maximum matte reaches that.
const PAPER_BLACK = 0.05 / MATTE_MAX;

// Screen value of 18 % grey (L* 50), which keeps its brightness under the
// matte look.
const MID_GREY = 0.46;

const FIT_SAMPLES = Array.from({length: 65}, (_, i) => i / 64);

const NO_CLIPPED_REDRAWS = Clutter.DrawDebugFlag.DISABLE_CLIPPED_REDRAWS;

// Settings that only change values or visibility, not the textures.
const SYNC_KEYS = [
    'texture-enabled', 'intensity', 'dark-balance', 'grain', 'true-size',
    'matte-enabled', 'matte', 'mottle',
    'brightness-enabled', 'brightness',
    'print-colors-enabled', 'print-colors',
    'ink-spread-enabled', 'ink-spread',
    'hide-in-fullscreen', 'shift-texture',
];

const UNIFORMS = `
uniform float u_intensity;
uniform float u_balance;
uniform float u_grain;
uniform float u_matte;
uniform float u_lift;
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

// Multiplied with the screen: shadows of the relief and the slightly warmer
// white of paper under room light. Brightness is a plain dimming factor on
// top.
const PAPER_MULTIPLY = `
vec3 multiply = u_brightness *
    vec3(1.0, 1.0 - 0.04 * u_matte, 1.0 - 0.12 * u_matte) *
    (1.0 - u_intensity * shadow);
`;

/**
 * GLSL composited OVER the screen: relief highlights, over uneven ink
 * (mottle: ink soaks into the paper's cloudy formation unevenly, which
 * lightens dark areas in patches), over the light paper reflects even from
 * its darkest ink, which lifts blacks. Dimmed along with the rest so
 * nothing gets brighter than the dimmed white.
 *
 * @param {string} toneSampler
 * @returns {string}
 */
function paperOverGlsl(toneSampler) {
    return `
vec4 cloud = texture2D(${toneSampler}, uv * u_tone_ratio * ${(TONE_SCALE / MOTTLE_STRETCH).toFixed(1)});
float mottle = u_mottle * (0.5 + cloud.r - 0.5 * cloud.a);
float highlight = u_intensity * u_balance * light;
vec4 over = vec4(vec3(highlight), highlight) +
    (vec4(vec3(mottle), mottle) +
     vec4(vec3(1.0, 0.97, 0.92) * u_lift, u_lift) * (1.0 - mottle)) * (1.0 - highlight);
over.rgb *= u_brightness;
`;
}

const OVERLAY_RELIEF = reliefGlsl('cogl_tex_coord0_in.st',
    'cogl_sampler0', 'cogl_sampler1', 'cogl_sampler2');
const MULTIPLY_SHADER = `${OVERLAY_RELIEF}${PAPER_MULTIPLY}
cogl_color_out = vec4(multiply, 1.0);
`;
const OVER_SHADER = `${OVERLAY_RELIEF}${paperOverGlsl('cogl_sampler1')}
cogl_color_out = over;
`;

// Print colours and ink spread need the finished pixels, so the UI is
// rendered offscreen first. The paper is then applied in the same pass
// instead of the overlay.
const PRINT_UNIFORMS = `${UNIFORMS}
uniform float u_print;
uniform float u_ink;
uniform vec2 u_origin;
uniform vec2 u_extent;
uniform vec2 u_pixel;
uniform vec2 u_shift;
uniform vec4 u_monitors[${MAX_MONITORS}];
uniform float u_tile_sizes[${MAX_MONITORS}];
uniform sampler2D u_screen;
uniform sampler2D u_detail;
uniform sampler2D u_tone;
uniform sampler2D u_grain_tile;
uniform sampler2D u_gamut;
uniform vec2 u_gamut_size;
uniform sampler2D u_ink_tile;
`;

/**
 * GLSL reading the offscreen copy `offset` away from `st`, kept on the
 * monitor bounds `lo` and `hi`: around and between the monitors the copy is
 * black, which would darken the edges.
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

// The paper is laid out per monitor like the overlay, each monitor with its
// own tile size.
vec2 pos = u_origin + st * u_extent;
vec2 paper_uv = pos / u_tile_sizes[0];
vec4 monitor = vec4(u_origin, u_extent);
for (int i = 0; i < ${MAX_MONITORS}; i++) {
    vec4 m = u_monitors[i];
    if (pos.x >= m.x && pos.y >= m.y && pos.x < m.x + m.z && pos.y < m.y + m.w) {
        paper_uv = (pos - m.xy) / u_tile_sizes[i];
        monitor = m;
    }
}
paper_uv += u_shift;

// Ink soaks into the paper (u_ink_tile, see papergen.js ink()). Strokes
// grow towards their darkest neighbour, but only where the paper takes ink,
// on its fibres and raised grain: a hard threshold, so edges turn ragged
// instead of soft. Where a fibre runs through a pixel, ink also creeps along
// it, the short feathers of ink on absorbent paper, fading with the square
// of the distance. Everything scales with the amount. Never lightens.
if (u_ink > 0.0) {
    vec3 soak = texture2D(u_ink_tile, paper_uv * u_grain_ratio).rgb;
    vec2 lo = (monitor.xy - u_origin) / u_extent + 0.5 * u_pixel;
    vec2 hi = (monitor.xy + monitor.zw - u_origin) / u_extent - 0.5 * u_pixel;
    vec3 near = min(
        min(${neighbourGlsl('vec2(u_pixel.x, 0.0)')}, ${neighbourGlsl('vec2(-u_pixel.x, 0.0)')}),
        min(${neighbourGlsl('vec2(0.0, u_pixel.y)')}, ${neighbourGlsl('vec2(0.0, -u_pixel.y)')}));
    float take = step(1.0 - ${INK_SHARE.toFixed(2)} * u_ink, soak.b);
    vec3 spread = c + (near - c) * take * ${INK_STRENGTH.toFixed(2)} * u_ink;
    vec2 along = soak.rg * 2.0 - 1.0;
    if (length(along) >= 0.5) {
        // Doubled angle back to the fibre, in whole pixels.
        float angle = 0.5 * atan(along.y, along.x);
        vec2 fibre = vec2(cos(angle), sin(angle));
        for (int i = 1; i <= 2; i++) {
            float distance = float(i);
            vec2 reach = floor(distance * fibre + 0.5) * u_pixel;
            vec3 far = min(${neighbourGlsl('reach')}, ${neighbourGlsl('-reach')});
            spread = min(spread,
                c + (far - c) * ${INK_FEATHER.toFixed(2)} * u_ink / (distance * distance));
        }
    }
    c = min(c, spread);
}

// Print can't reach the colourfulness of emitted light, least of all in
// blue, violet and green. Colours outside the gamut of offset print on
// uncoated paper (u_gamut, see tools/printgamut.py) move in OKLab towards
// the grey of their hue's most colourful print colour, with a soft knee so
// gradients stay smooth. Greys and colours print can reach stay untouched,
// greys skip the conversion.
if (u_print > 0.0 && max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)) > 1.0 / 1024.0) {
    vec3 lin = mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
    vec3 lms = pow(lin * mat3(
        0.4122214708, 0.5363325363, 0.0514459929,
        0.2119034982, 0.6806995451, 0.1073969566,
        0.0883024619, 0.2817188376, 0.6299787005), vec3(1.0 / 3.0));
    vec3 lab = lms * mat3(
        0.2104542553, 0.7936177850, -0.0040720468,
        1.9779984951, -2.4285922050, 0.4505937099,
        0.0259040371, 0.7827717662, -0.8086757660);
    float chroma = length(lab.yz);
    float column = (fract(atan(lab.z, lab.y) / 6.2831853) * (u_gamut_size.x - 1.0) + 0.5) /
        u_gamut_size.x;
    float cusp = texture2D(u_gamut, vec2(column, 0.0)).g;
    vec2 p = vec2(lab.x - cusp, chroma);
    float angle = atan(p.y, p.x) / 3.14159265;
    float limit = texture2D(u_gamut,
        vec2(column, (angle * (u_gamut_size.y - 1.0) + 0.5) / u_gamut_size.y)).r;
    float x = length(p) / max(limit, 1e-4);
    // Towards the grey axis the knee moves out to the boundary, so light
    // greys close to white stay put.
    float knee = 1.0 - 0.2 * chroma / length(p);
    if (x > knee) {
        float y = (x - knee) / max(1.0 - knee, 1e-4);
        float squeezed = knee + (1.0 - knee) * y / sqrt(1.0 + y * y);
        p *= mix(1.0, squeezed / x, u_print);
        lab = vec3(cusp + p.x, lab.yz * (p.y / chroma));
        lms = lab * mat3(
            1.0, 0.3963377774, 0.2158037573,
            1.0, -0.1055613458, -0.0638541728,
            1.0, -0.0894841775, -1.2914855480);
        lin = clamp((lms * lms * lms) * mat3(
            4.0767416621, -3.3077115913, 0.2309699292,
            -1.2684380046, 2.6097574011, -0.3413193965,
            -0.0041960863, -0.7034186147, 1.7076147010), 0.0, 1.0);
        c = mix(12.92 * lin, 1.055 * pow(lin, vec3(1.0 / 2.4)) - 0.055,
            step(0.0031308, lin));
    }
}
${reliefGlsl('paper_uv', 'u_detail', 'u_tone', 'u_grain_tile')}${PAPER_MULTIPLY}${paperOverGlsl('u_tone')}
c = c * multiply * (1.0 - over.a) + over.rgb;
cogl_color_out = vec4(c * color.a, color.a);
`;

/**
 * How far the matte look lifts black, in screen values. Paper adds the
 * light it reflects from its darkest ink in linear light, which lifts
 * shadows a lot and midtones little. Blending can only map the screen
 * along a straight line, so this is the lift of the line closest to that.
 *
 * @param {number} matte
 * @returns {number}
 */
function matteLift(matte) {
    const black = PAPER_BLACK * matte;
    const paper = d => (black + (1 - black) * d ** 2.2) ** (1 / 2.2);
    const error = lift => Math.max(...FIT_SAMPLES.map(d =>
        Math.abs(lift + (1 - lift) * d - paper(d))));
    // The error is convex in the lift, so narrow it down by thirds.
    let [lo, hi] = [0, paper(0)];
    for (let i = 0; i < 40; i++) {
        const a = lo + (hi - lo) / 3;
        const b = hi - (hi - lo) / 3;
        if (error(a) < error(b))
            hi = b;
        else
            lo = a;
    }
    return (lo + hi) / 2;
}

/**
 * Overall level of the matte look. Paper only reflects light, so its white
 * is dimmer than a screen's. Scaled so mid grey stays as it is: blacks
 * lift, whites drop, and the screen as a whole doesn't get lighter.
 *
 * @param {number} lift - from matteLift()
 * @returns {number}
 */
function matteLevel(lift) {
    return MID_GREY / (lift + (1 - lift) * MID_GREY);
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
 * Ink spread, print colours and paper in one pass over an offscreen copy of
 * the UI. Only attached while one of the first two is on, since rendering
 * offscreen costs an extra full-screen pass on every change. The overlay is
 * hidden then.
 */
const PaperPrintEffect = GObject.registerClass(
class PaperPrintEffect extends Clutter.ShaderEffect {
    constructor(textures) {
        super();
        this._textures = textures;
        this._values = {};
        this._pipeline = null;
    }

    // Called once for the class, Clutter adds the snippet to the offscreen
    // pipeline.
    vfunc_get_static_snippet() {
        const snippet = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, PRINT_UNIFORMS, null);
        snippet.set_replace(PRINT_SHADER);
        return snippet;
    }

    setValues(values) {
        this._values = values;
        this.queue_repaint();
    }

    vfunc_paint(node, paintContext, flags) {
        // Each monitor is painted separately and only fills its own part of
        // the offscreen copy, so with several monitors it can't be reused.
        if (Main.layoutManager.monitors.length > 1)
            flags |= Clutter.EffectPaintFlags.ACTOR_DIRTY;
        super.vfunc_paint(node, paintContext, flags);
    }

    vfunc_paint_target(node, paintContext) {
        // Layer 0 is the offscreen copy, the paper textures and the gamut
        // table go next to it. Clutter makes a new pipeline whenever it
        // recreates the offscreen buffer (new size or scale), so they are
        // set again then.
        const pipeline = this.get_pipeline();
        if (pipeline !== this._pipeline) {
            const {detail, tone, grain, gamut, ink} = this._textures;
            [detail, tone, grain, gamut, ink].forEach((texture, i) => {
                pipeline.set_layer_texture(i + 1, texture);
                pipeline.set_layer_wrap_mode(i + 1, texture === gamut
                    ? Cogl.PipelineWrapMode.CLAMP_TO_EDGE : Cogl.PipelineWrapMode.REPEAT);
            });
            ['u_screen', 'u_detail', 'u_tone', 'u_grain_tile', 'u_gamut', 'u_ink_tile'].forEach((name, layer) =>
                pipeline.set_uniform_1i(pipeline.get_uniform_location(name), layer));
            this._pipeline = pipeline;
        }
        // Texture coordinates span the offscreen buffer. Clutter sizes it
        // from the actor's paint volume, or its allocation when one of the
        // children has no paint volume (common with real windows), in local
        // coordinates: right/bottom edge rounded up past 0.75 px of padding,
        // the size rounded plus 3 px, the rest goes to the left/top
        // (_clutter_actor_box_enlarge_for_effects), then scaled by the
        // rounded up resource scale. uiGroup sits at the stage origin, so
        // this maps straight back to stage coordinates and the paper lines
        // up with the overlay.
        const actor = this.get_actor();
        const volume = actor.get_paint_volume();
        let x1, y1, x2, y2;
        if (volume) {
            const origin = volume.get_origin();
            [x1, y1] = [origin.x, origin.y];
            [x2, y2] = [x1 + volume.get_width(), y1 + volume.get_height()];
        } else {
            ({x1, y1, x2, y2} = actor.get_allocation_box());
        }
        const width = Math.round(x2 - x1);
        const height = Math.round(y2 - y1);
        x2 = Math.ceil(x2 + 0.75);
        y2 = Math.ceil(y2 + 0.75);
        x1 = x2 - width - 3;
        y1 = y2 - height - 3;
        const scale = Math.ceil(actor.get_resource_scale());
        setUniforms(pipeline, {
            ...this._values,
            tone_ratio: this._textures.toneRatio,
            grain_ratio: this._textures.grainRatio,
            gamut_size: this._textures.gamutSize,
            origin: [x1, y1],
            extent: [x2 - x1, y2 - y1],
            pixel: [1 / Math.ceil((x2 - x1) * scale), 1 / Math.ceil((y2 - y1) * scale)],
        });
        super.vfunc_paint_target(node, paintContext);
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
 * Paints the paper over one monitor in two full-screen passes: a multiply
 * for shadows and paper light, and an OVER for highlights and flare. All
 * settings are shader uniforms, so changing them never rebuilds anything,
 * and nothing animates, so the surface never causes a redraw by itself.
 */
const PaperSurface = GObject.registerClass(
class PaperSurface extends Clutter.Actor {
    constructor(textures, params) {
        super(params);
        const ctx = global.stage.context.get_backend().get_cogl_context();
        this._multiply = this._createPipeline(ctx, textures, MULTIPLY_SHADER,
            'RGBA = ADD(SRC_COLOR * (DST_COLOR), 0)');
        this._over = this._createPipeline(ctx, textures, OVER_SHADER,
            'RGBA = ADD(SRC_COLOR, DST_COLOR * (1 - SRC_COLOR[A]))');
        this._tileSize = textures.detailSize;
        this._shift = [0, 0];
        this._values = {intensity: 0, balance: 0, lift: 0, mottle: 0, brightness: 1};
    }

    _createPipeline(ctx, textures, shader, blend) {
        const pipeline = Cogl.Pipeline.new(ctx);
        [textures.detail, textures.tone, textures.grain].forEach((texture, layer) => {
            pipeline.set_layer_texture(layer, texture);
            pipeline.set_layer_wrap_mode(layer, Cogl.PipelineWrapMode.REPEAT);
        });
        pipeline.add_snippet(Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, UNIFORMS, shader));
        pipeline.set_blend(blend);
        setUniforms(pipeline, {tone_ratio: textures.toneRatio, grain_ratio: textures.grainRatio});
        return pipeline;
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
        setUniforms(this._multiply, values);
        setUniforms(this._over, values);
        this.queue_redraw();
    }

    vfunc_get_paint_volume(volume) {
        return volume.set_from_allocation(this);
    }

    vfunc_paint_node(root, _paintContext) {
        const {intensity, balance, lift, mottle, brightness} = this._values;
        const [width, height] = this.get_size();
        const tiles = [width / this._tileSize, height / this._tileSize];
        const box = new Clutter.ActorBox({x1: 0, y1: 0, x2: width, y2: height});

        const passes = [];
        if (intensity > 0 || brightness < 1)
            passes.push(this._multiply);
        if (intensity * balance > 0 || lift > 0 || mottle > 0)
            passes.push(this._over);

        for (const pipeline of passes) {
            const node = Clutter.PipelineNode.new(pipeline);
            const [x, y] = this._shift;
            node.add_texture_rectangle(box, x, y, x + tiles[0], y + tiles[1]);
            root.add_child(node);
        }
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
        this._clippedRedrawsDisabled = false;
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
        const [detail, tone, grain, ink, gamut] = await Promise.all([
            ...files.map(file => loadTexture(file, cancellable)),
            loadTexture(this._extension.dir.get_child('print-gamut.png'), cancellable),
        ]);
        return {
            detail,
            tone,
            grain,
            gamut,
            ink,
            detailSize: detail.get_width(),
            toneRatio: detail.get_width() / (tone.get_width() * TONE_SCALE),
            grainRatio: detail.get_width() / grain.get_width(),
            gamutSize: [gamut.get_width(), gamut.get_height()],
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
        const matteEnabled = s.get_boolean('matte-enabled');
        const matte = matteEnabled ? this._double('matte') : 0;
        const lift = matteLift(matte);
        const brightness = s.get_boolean('brightness-enabled') ? this._double('brightness') : 1;
        const values = {
            intensity: s.get_boolean('texture-enabled') ? this._double('intensity') : 0,
            balance: this._double('dark-balance'),
            grain: this._double('grain'),
            matte,
            lift,
            mottle: matteEnabled ? this._double('mottle') : 0,
            brightness: brightness * matteLevel(lift),
        };
        const print = s.get_boolean('print-colors-enabled') ? this._double('print-colors') : 0;
        const ink = s.get_boolean('ink-spread-enabled') ? this._double('ink-spread') : 0;

        // A covered fullscreen window can't be scanned out directly.
        const monitors = Main.layoutManager.monitors;
        const hideInFullscreen = s.get_boolean('hide-in-fullscreen');
        const fullscreen = index => hideInFullscreen && monitors[index]?.inFullscreen;

        // The print effect spans all monitors, so any fullscreen window
        // turns it off and the overlay takes over again.
        const printActive = (print > 0 || ink > 0) && !monitors.some(m => fullscreen(m.index));
        if (printActive) {
            if (!this._print) {
                this._print = new PaperPrintEffect(this._textures);
                Main.layoutManager.uiGroup.add_effect_with_name('paper-my-shell-print', this._print);
                // A partial redraw would leave everything outside the
                // changed area empty in the offscreen copy, so frames have
                // to repaint the whole screen while the effect is on. This
                // only widens frames that happen anyway, a still screen
                // stays still.
                const [, drawFlags] = Clutter.get_debug_flags();
                this._clippedRedrawsDisabled = !(drawFlags & NO_CLIPPED_REDRAWS);
                if (this._clippedRedrawsDisabled)
                    Clutter.add_debug_flags(0, NO_CLIPPED_REDRAWS, 0);
            }
            const slots = Array.from({length: MAX_MONITORS}, (_, i) => monitors[i]);
            this._print.setValues({
                ...values,
                print,
                ink,
                shift: this._shiftTiles(),
                monitors: slots.map(m => m ? [m.x, m.y, m.width, m.height] : [0, 0, 0, 0]),
                tile_sizes: slots.map((m, i) => [this._tileSize(m ? i : 0)]),
            });
        } else {
            this._removePrint();
        }

        for (const {surface, monitorIndex} of this._surfaces) {
            surface.setValues(values, this._tileSize(monitorIndex), this._shiftTiles());
            surface.visible = !printActive && !fullscreen(monitorIndex);
        }
    }

    _removePrint() {
        if (!this._print)
            return;
        // Leave the flag alone if someone else had set it.
        if (this._clippedRedrawsDisabled)
            Clutter.remove_debug_flags(0, NO_CLIPPED_REDRAWS, 0);
        Main.layoutManager.uiGroup.remove_effect(this._print);
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
        this._addSlider('matte', 'matte-enabled', {icon_name: 'display-brightness-symbolic'},
            _('Matte'), v => v * MATTE_MAX, value => value / MATTE_MAX);

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
