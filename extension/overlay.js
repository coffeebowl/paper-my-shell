import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {TONE_SCALE, isPeriodic} from './papergen.js';
import {PaperPrintEffect} from './printEffect.js';
import {
    OVERLAY_SHADER, SCATTER_MAX_MM, TEXEL_MM, UNIFORMS, matteValues, setUniforms,
} from './shaders.js';
import {cacheDir, exists, generateTexture, loadTexture, pruneCache} from './textureCache.js';

Gio._promisify(Gio.DBusConnection.prototype, 'call');

const TILES = ['detail', 'tone', 'grain', 'ink'];

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

/**
 * @param {Error} e
 * @returns {boolean} whether `e` is Gio's CANCELLED, not some other GLib
 *   error or a plain JS error
 */
function isCancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

/**
 * @returns {number[]} a random position as fractions of a period
 */
function randomShift() {
    return [Math.random(), Math.random()];
}

/**
 * Physical size of a logical pixel in mm per monitor index, for the
 * monitors that report their size (EDID, via Mutter's DisplayConfig;
 * Meta.Monitor doesn't expose it to GJS).
 *
 * @param {Gio.Cancellable} cancellable
 * @returns {Promise<Map<number, number>>}
 */
async function readPixelSizes(cancellable) {
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
 * One PaperSurface per monitor, and PaperPrintEffect while a print effect
 * is on.
 */
export class PaperOverlay {
    constructor(settings, extension) {
        this._settings = settings;
        this._extension = extension;
        this._cacheDir = null;
        this._surfaces = [];
        this._textures = null;
        this._cancellable = null;
        this._pruneCancellable = null;
        this._print = null;
        this._unredirectDisabled = false;
        this._pixelSizes = new Map();
        this._sizesCancellable = null;
        this._shift = randomShift();
        this._locked = Main.sessionMode.isLocked;

        settings.connectObject(
            'changed::enabled', () => this._rebuild(),
            'changed::texture', () => this._load(),
            this);
        for (const key of SYNC_KEYS)
            settings.connectObject(`changed::${key}`, () => this._sync(), this);
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
            this._pixelSizes = await readPixelSizes(cancellable);
        } catch (e) {
            if (isCancelled(e))
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
            this._pruneCache();
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
     * Remove textures of older generator versions, in the background. A
     * new run replaces one still going, so two never delete the same files.
     */
    async _pruneCache() {
        this._pruneCancellable?.cancel();
        const cancellable = this._pruneCancellable = new Gio.Cancellable();
        try {
            await pruneCache(this._cacheDir, cancellable);
        } catch (e) {
            if (isCancelled(e))
                return;
            console.error(`Paper my Shell: cannot clean up the texture cache: ${e.message}`);
        }
        // A cancelled run can still end normally if its last step was
        // already under way; it must not drop a newer run's cancellable.
        if (this._pruneCancellable === cancellable)
            this._pruneCancellable = null;
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
                if (isCancelled(e))
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

    _sync() {
        if (!this._settings.get_boolean('enabled') || !this._textures)
            return;

        const s = this._settings;
        const values = {
            intensity: s.get_boolean('texture-enabled') ? s.get_double('intensity') : 0,
            balance: s.get_double('dark-balance'),
            grain: s.get_double('grain'),
            mottle: s.get_boolean('mottle-enabled') ? s.get_double('mottle') : 0,
            brightness: s.get_boolean('brightness-enabled') ? s.get_double('brightness') : 1,
        };
        const matte = s.get_boolean('paper-black-enabled') ? s.get_double('paper-black') : 0;
        const print = s.get_boolean('print-colors-enabled') ? s.get_double('print-colors') : 0;
        const ink = s.get_boolean('ink-spread-enabled') ? s.get_double('ink-spread') : 0;
        const scatter = s.get_boolean('light-scatter-enabled')
            ? s.get_double('light-scatter') * SCATTER_MAX_MM : 0;

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
        this._pruneCancellable?.cancel();
        this._settings.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        global.display.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        this._destroySurfaces();
        this._removePrint();
        this._textures = null;
    }
}
