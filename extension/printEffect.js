import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Mtk from 'gi://Mtk';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    centrePixels, extents, grow, intersect, regionRects, spanAcross, toFramebuffer, toStage,
    transformRegion, withRectangles,
} from './regions.js';
import {
    INK_REACH, INK_RING, PRINT_SHADER, PRINT_UNIFORMS, TEXEL_MM, scatterStrength, setUniforms,
} from './shaders.js';

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
export const PaperPrintEffect = GObject.registerClass(
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
        this.get_actor().queue_redraw();
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
            clipFb = centrePixels(clip, layout, copy.width, copy.height);
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
            withRectangles(regionRects(stage), r => actor.queue_redraw_with_clip(r));
        }
        if (waiting)
            return GLib.SOURCE_CONTINUE;
        this._settleId = 0;
        return GLib.SOURCE_REMOVE;
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
        if (this._fullRedraw)
            actor.queue_redraw();
        else
            withRectangles(this._pendingRedraws, r => actor.queue_redraw_with_clip(r));
        this._fullRedraw = false;
        this._pendingRedraws = [];
    }

    _pruneCopies() {
        const framebuffers = global.stage.peek_stage_views().map(v => v.get_framebuffer());
        for (const fb of this._copies.keys()) {
            if (!framebuffers.includes(fb))
                this._copies.delete(fb);
        }
    }
});
