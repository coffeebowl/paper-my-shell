import Graphene from 'gi://Graphene';
import Mtk from 'gi://Mtk';

/**
 * The rectangles of a region as plain numbers. Mtk.Region.get_rectangle()
 * returns a struct by value, which crashes GJS. The iterator works, but
 * hands out the same rectangle every time, and the ring maths runs on
 * every frame, so this reads only the numbers.
 *
 * @param {Mtk.Region} region
 * @returns {number[][]} x, y, width, height
 */
export function regionRects(region) {
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
export function withRectangles(rects, f) {
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
export function grow(region, d) {
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
export function extents(rects) {
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
export function intersect(a, b) {
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
export function transformRegion(region, sx, sy, dx, dy) {
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
export function toFramebuffer(region, scale, layout, wide) {
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
export function toStage(region, scale, layout, wide) {
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
export function centrePixels(region, layout, width, height) {
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
export function spanAcross(region) {
    const rects = regionRects(region);
    return [Math.min(...rects.map(r => r[0])), Math.max(...rects.map(r => r[0] + r[2]))];
}
