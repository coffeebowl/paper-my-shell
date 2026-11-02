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

import {TONE_SCALE} from './papergen.js';
import {textureLabel, textureNames} from './textures.js';

Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'delete_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
Gio._promisify(GdkPixbuf.Pixbuf, 'new_from_stream_async');

const TILES = ['detail', 'tone'];

// Schema maximum of the matte key.
const MATTE_MAX = 0.5;

// The darkest ink on uncoated paper still reflects about 5 % of the light.
// The maximum matte reaches that.
const PAPER_BLACK = 0.05 / MATTE_MAX;

// Screen value of 18 % grey (L* 50), which keeps its brightness under the
// matte look.
const MID_GREY = 0.46;

const FIT_SAMPLES = Array.from({length: 65}, (_, i) => i / 64);

// Settings that only change values or visibility, not the textures.
const SYNC_KEYS = [
    'texture-enabled', 'intensity', 'dark-balance',
    'matte-enabled', 'matte',
    'hide-in-fullscreen',
];

const UNIFORMS = `
uniform float u_intensity;
uniform float u_balance;
uniform float u_matte;
uniform float u_lift;
uniform float u_brightness;
uniform float u_tone_ratio;
`;

/**
 * GLSL computing `shadow` and `light` of the paper relief at `uv`, given in
 * detail-tile coordinates. u_tone_ratio converts them to tone-tile ones.
 *
 * Texels are grey + alpha, premultiplied on upload: grey 0 marks a shadow,
 * grey 1 a highlight. So .r is the highlight and .a - .r the shadow amount.
 *
 * @param {string} uv - GLSL expression
 * @param {string} detailSampler
 * @param {string} toneSampler
 * @returns {string}
 */
function reliefGlsl(uv, detailSampler, toneSampler) {
    return `
vec2 uv = ${uv};
vec4 detail = texture2D(${detailSampler}, uv);
vec4 tone = texture2D(${toneSampler}, uv * u_tone_ratio);
float shadow = 1.0 - (1.0 - (detail.a - detail.r)) * (1.0 - (tone.a - tone.r));
float light = 1.0 - (1.0 - detail.r) * (1.0 - tone.r);
`;
}

// Multiplied with the screen: shadows of the relief and the slightly warmer
// white of paper under room light, at the overall brightness of the matte
// look.
const PAPER_MULTIPLY = `
vec3 multiply = u_brightness *
    vec3(1.0, 1.0 - 0.04 * u_matte, 1.0 - 0.12 * u_matte) *
    (1.0 - u_intensity * shadow);
`;

// Composited OVER the screen: relief highlights, over the light paper
// reflects even from its darkest ink, which lifts blacks. Dimmed along with
// the rest so nothing gets brighter than the dimmed white.
const PAPER_OVER = `
float highlight = u_intensity * u_balance * light;
vec4 over = vec4(vec3(highlight), highlight) +
    vec4(vec3(1.0, 0.97, 0.92) * u_lift, u_lift) * (1.0 - highlight);
over.rgb *= u_brightness;
`;

const OVERLAY_RELIEF = reliefGlsl('cogl_tex_coord0_in.st', 'cogl_sampler0', 'cogl_sampler1');
const MULTIPLY_SHADER = `${OVERLAY_RELIEF}${PAPER_MULTIPLY}
cogl_color_out = vec4(multiply, 1.0);
`;
const OVER_SHADER = `${OVERLAY_RELIEF}${PAPER_OVER}
cogl_color_out = over;
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
 * @param {object} values - uniform names without the u_ prefix
 */
function setUniforms(pipeline, values) {
    for (const [name, value] of Object.entries(values))
        pipeline.set_uniform_1f(pipeline.get_uniform_location(`u_${name}`), value);
}

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
        this._values = {intensity: 0, balance: 0, lift: 0, brightness: 1};
    }

    _createPipeline(ctx, textures, shader, blend) {
        const pipeline = Cogl.Pipeline.new(ctx);
        [textures.detail, textures.tone].forEach((texture, layer) => {
            pipeline.set_layer_texture(layer, texture);
            pipeline.set_layer_wrap_mode(layer, Cogl.PipelineWrapMode.REPEAT);
        });
        pipeline.add_snippet(Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, UNIFORMS, shader));
        pipeline.set_blend(blend);
        setUniforms(pipeline, {tone_ratio: textures.toneRatio});
        return pipeline;
    }

    /**
     * @param {object} values - shader uniforms
     */
    setValues(values) {
        this._values = values;
        setUniforms(this._multiply, values);
        setUniforms(this._over, values);
        this.queue_redraw();
    }

    vfunc_get_paint_volume(volume) {
        return volume.set_from_allocation(this);
    }

    vfunc_paint_node(root, _paintContext) {
        const {intensity, balance, lift, brightness} = this._values;
        const [width, height] = this.get_size();
        const tiles = [width / this._tileSize, height / this._tileSize];
        const box = new Clutter.ActorBox({x1: 0, y1: 0, x2: width, y2: height});

        const passes = [];
        if (intensity > 0 || brightness < 1)
            passes.push(this._multiply);
        if (intensity * balance > 0 || lift > 0)
            passes.push(this._over);

        for (const pipeline of passes) {
            const node = Clutter.PipelineNode.new(pipeline);
            node.add_texture_rectangle(box, 0, 0, ...tiles);
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
        Main.layoutManager.connectObject(
            'monitors-changed', () => this._rebuild(), this);
        global.display.connectObject(
            'in-fullscreen-changed', () => this._sync(), this);

        this._rebuild();
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
        const [detail, tone] = await Promise.all(files.map(file => loadTexture(file, cancellable)));
        return {
            detail,
            tone,
            detailSize: detail.get_width(),
            toneRatio: detail.get_width() / (tone.get_width() * TONE_SCALE),
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
        const matte = s.get_boolean('matte-enabled') ? this._double('matte') : 0;
        const lift = matteLift(matte);
        const values = {
            intensity: s.get_boolean('texture-enabled') ? this._double('intensity') : 0,
            balance: this._double('dark-balance'),
            matte,
            lift,
            brightness: matteLevel(lift),
        };

        // A covered fullscreen window can't be scanned out directly.
        const monitors = Main.layoutManager.monitors;
        const hideInFullscreen = s.get_boolean('hide-in-fullscreen');
        const fullscreen = index => hideInFullscreen && monitors[index]?.inFullscreen;

        for (const {surface, monitorIndex} of this._surfaces) {
            surface.setValues(values);
            surface.visible = !fullscreen(monitorIndex);
        }
    }

    _destroySurfaces() {
        for (const {surface} of this._surfaces)
            surface.destroy();
        this._surfaces = [];
    }

    destroy() {
        this._cancellable?.cancel();
        this._settings.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        global.display.disconnectObject(this);
        this._destroySurfaces();
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
    }

    destroy() {
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

    disable() {
        this._indicator.destroy();
        this._indicator = null;
        this._overlay.destroy();
        this._overlay = null;
        this._settings = null;
    }
}
