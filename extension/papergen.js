/**
 * Seamless paper textures, generated on the device from a seed, so every
 * device gets the same paper.
 *
 * A texture is two tiles, each RGBA bytes. They are signed shading,
 * stored as grey + alpha and composited with normal alpha blending: black
 * with some alpha darkens what is below (like multiply), white lightens it
 * (like screen). That way the texture modulates the content instead of
 * pulling it towards grey.
 *
 * - detail: relief (tooth, fibres, grain), tiled 1:1. Only small, random
 *   features, so its repetition can't be spotted.
 * - tone: low-frequency tone variation, stretched by TONE_SCALE so it
 *   repeats only every few thousand pixels. Large features would make the
 *   repetition obvious if they were part of the detail tile.
 *
 * Sizes follow a logical pixel of about 0.23 mm (110 dpi). Everything is
 * computed on a periodic domain via FFT, so tiles repeat without seams.
 */

// The tone tile is drawn stretched by this factor.
export const TONE_SCALE = 8;

const DETAIL_SIZE = 1024;
const TONE_SIZE = 512;

export const PRESETS = {
    // Cold-press watercolour paper: pronounced rounded tooth.
    'watercolor': {
        tooth: 1.0, toothSize: 1.7, coarse: 0.35, coarseSize: 5.0,
        fibers: 0.15, fine: 0.15, formation: 0.18,
        bump: 1.6, cavity: 0.35, aniso: 1.08,
    },
    // Smooth drawing paper: fine grain, some fibres.
    'drawing': {
        tooth: 0.55, toothSize: 1.2, coarse: 0.2, coarseSize: 4.0,
        fibers: 0.3, fine: 0.2, formation: 0.22,
        bump: 1.4, cavity: 0.25, aniso: 1.15,
    },
    // Recycled / newsprint: flat, fibrous, cloudy.
    'recycled': {
        tooth: 0.35, toothSize: 1.2, coarse: 0.15, coarseSize: 4.0,
        fibers: 0.45, fine: 0.25, formation: 0.4,
        bump: 1.3, cavity: 0.2, aniso: 1.0,
    },
};

/** xoshiro128**, seeded through splitmix32. */
class Random {
    constructor(seed) {
        let s = seed >>> 0;
        const next = () => {
            s = (s + 0x9e3779b9) | 0;
            let z = s;
            z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
            z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
            return (z ^ (z >>> 16)) | 0;
        };
        this._s = Int32Array.of(next(), next(), next(), next());
        this._spare = null;
    }

    _uint32() {
        const s = this._s;
        const r = Math.imul(rotl(Math.imul(s[1], 5), 7), 9);
        const t = s[1] << 9;
        s[2] ^= s[0];
        s[3] ^= s[1];
        s[1] ^= s[2];
        s[0] ^= s[3];
        s[2] ^= t;
        s[3] = rotl(s[3], 11);
        return r >>> 0;
    }

    /** Uniform in (lo, hi), never exactly lo, so it is safe for log(). */
    uniform(lo = 0, hi = 1) {
        return lo + (hi - lo) * (this._uint32() + 0.5) / 2 ** 32;
    }

    integer(n) {
        return Math.floor(this.uniform() * n);
    }

    /** Standard normal, Box-Muller. */
    normal() {
        if (this._spare !== null) {
            const z = this._spare;
            this._spare = null;
            return z;
        }
        const r = Math.sqrt(-2 * Math.log(this.uniform()));
        const a = 2 * Math.PI * this.uniform();
        this._spare = r * Math.sin(a);
        return r * Math.cos(a);
    }

    /** Gamma with shape 2: the sum of two exponentials. */
    gamma2(scale) {
        return -scale * Math.log(this.uniform() * this.uniform());
    }

    normals(count) {
        const a = new Float64Array(count);
        for (let i = 0; i < count; i++)
            a[i] = this.normal();
        return a;
    }
}

function rotl(x, k) {
    return (x << k) | (x >>> (32 - k));
}

/** Modulo with the sign of the divisor, like Python's %. */
function mod(a, n) {
    return ((a % n) + n) % n;
}

function mean(a) {
    let sum = 0;
    for (let i = 0; i < a.length; i++)
        sum += a[i];
    return sum / a.length;
}

function std(a) {
    const m = mean(a);
    let sum = 0;
    for (let i = 0; i < a.length; i++)
        sum += (a[i] - m) ** 2;
    return Math.sqrt(sum / a.length);
}

/** Percentile with linear interpolation between ranks, like numpy. */
function percentile(a, q) {
    const sorted = Float64Array.from(a).sort();
    const rank = q / 100 * (sorted.length - 1);
    const lo = Math.floor(rank);
    const hi = Math.min(lo + 1, sorted.length - 1);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

function map(a, fn) {
    const out = new Float64Array(a.length);
    for (let i = 0; i < a.length; i++)
        out[i] = fn(a[i], i);
    return out;
}

/** In-place radix-2 FFT of every row of an n x n complex field. */
class Fft {
    constructor(n) {
        this.n = n;
        this._cos = new Float64Array(n / 2);
        this._sin = new Float64Array(n / 2);
        for (let k = 0; k < n / 2; k++) {
            this._cos[k] = Math.cos(2 * Math.PI * k / n);
            this._sin[k] = Math.sin(2 * Math.PI * k / n);
        }
        this._reverse = new Uint32Array(n);
        const bits = Math.log2(n);
        for (let i = 0; i < n; i++) {
            let r = 0;
            for (let b = 0; b < bits; b++)
                r |= ((i >> b) & 1) << (bits - 1 - b);
            this._reverse[i] = r;
        }
    }

    rows(re, im, inverse) {
        const n = this.n;
        const sign = inverse ? 1 : -1;
        for (let o = 0; o < n * n; o += n) {
            for (let i = 0; i < n; i++) {
                const j = this._reverse[i];
                if (j > i) {
                    let t = re[o + i];
                    re[o + i] = re[o + j];
                    re[o + j] = t;
                    t = im[o + i];
                    im[o + i] = im[o + j];
                    im[o + j] = t;
                }
            }
            for (let size = 2; size <= n; size *= 2) {
                const half = size / 2;
                const step = n / size;
                for (let i = 0; i < n; i += size) {
                    for (let j = 0; j < half; j++) {
                        const wr = this._cos[j * step];
                        const wi = sign * this._sin[j * step];
                        const a = o + i + j;
                        const b = a + half;
                        const tr = wr * re[b] - wi * im[b];
                        const ti = wr * im[b] + wi * re[b];
                        re[b] = re[a] - tr;
                        im[b] = im[a] - ti;
                        re[a] += tr;
                        im[a] += ti;
                    }
                }
            }
        }
    }
}

function transpose(a, n) {
    for (let y = 0; y < n; y++) {
        for (let x = y + 1; x < n; x++) {
            const t = a[y * n + x];
            a[y * n + x] = a[x * n + y];
            a[x * n + y] = t;
        }
    }
}

/** Random fields on an n x n periodic domain. */
class Field {
    constructor(n, seed) {
        this.n = n;
        this.rng = new Random(seed);
        this._fft = new Fft(n);
        this._freq = Float64Array.from({length: n}, (_, k) => (k < n / 2 ? k : k - n) / n);
    }

    /**
     * Gaussian filter in frequency space, in the transposed layout blur()
     * works in, including the 1 / n² of the inverse transform.
     */
    _gaussian(sigma, aniso, angle) {
        const n = this.n;
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        const g = new Float64Array(n * n);
        for (let kx = 0; kx < n; kx++) {
            const fx = this._freq[kx];
            for (let ky = 0; ky < n; ky++) {
                const fy = this._freq[ky];
                const u = (c * fx + s * fy) * aniso;
                const v = (-s * fx + c * fy) / aniso;
                g[kx * n + ky] = Math.exp(-2 * (Math.PI * sigma) ** 2 * (u * u + v * v)) / n ** 2;
            }
        }
        return g;
    }

    _filter(filter, a) {
        const n = this.n;
        const re = Float64Array.from(a);
        const im = new Float64Array(n * n);
        // Transposing only twice, the spectrum stays transposed.
        this._fft.rows(re, im, false);
        transpose(re, n);
        transpose(im, n);
        this._fft.rows(re, im, false);
        for (let i = 0; i < n * n; i++) {
            re[i] *= filter[i];
            im[i] *= filter[i];
        }
        this._fft.rows(re, im, true);
        transpose(re, n);
        transpose(im, n);
        this._fft.rows(re, im, true);
        return re;
    }

    /** Periodic (anisotropic) gaussian blur, sigma in px. */
    blur(a, sigma, aniso = 1, angle = 0) {
        return this._filter(this._gaussian(sigma, aniso, angle), a);
    }

    noise(sigma, aniso = 1, angle = 0) {
        const a = this.blur(this.rng.normals(this.n ** 2), sigma, aniso, angle);
        const d = std(a);
        return map(a, v => v / d);
    }

    band(sigma, aniso = 1, angle = 0) {
        const fine = this._gaussian(sigma, aniso, angle);
        const coarse = this._gaussian(sigma * 2.2, aniso, angle);
        const a = this._filter(map(fine, (v, i) => v - coarse[i]), this.rng.normals(this.n ** 2));
        const d = std(a);
        return map(a, v => v / d);
    }

    /** Randomly placed rounded bumps of varying height. */
    pebbles(spacing, sigma, aniso = 1, angle = 0) {
        const n = this.n;
        const count = Math.trunc(n * n / spacing ** 2);
        const canvas = new Float64Array(n * n);
        for (let i = 0; i < count; i++) {
            const y = this.rng.integer(n);
            const x = this.rng.integer(n);
            canvas[y * n + x] += this.rng.gamma2(0.5);
        }
        const a = this.blur(canvas, sigma, aniso, angle);
        const m = mean(a);
        const d = std(a);
        return map(a, v => (v - m) / d);
    }

    /**
     * Short thin raised strands, wrapped around the tile edges. A pixel
     * gets each strand once, however often the strand passes it.
     */
    fibers(count, length, scale) {
        const n = this.n;
        const canvas = new Float64Array(n * n);
        const seen = new Int32Array(n * n);
        for (let f = 1; f <= count; f++) {
            let x = this.rng.uniform(0, n);
            let y = this.rng.uniform(0, n);
            const angle = this.rng.uniform(0, Math.PI);
            const ln = this.rng.uniform(0.4, 1.0) * length * scale;
            const bend = 0.6 * this.rng.normal();
            const steps = Math.max(Math.trunc(ln * 2), 2);
            const pixels = [];
            for (let i = 0; i < steps; i++) {
                const a = angle + bend * (i / (steps - 1) - 0.5);
                x += Math.cos(a) * ln / steps;
                y += Math.sin(a) * ln / steps;
                const p = mod(Math.trunc(y), n) * n + mod(Math.trunc(x), n);
                if (seen[p] !== f) {
                    seen[p] = f;
                    pixels.push(p);
                }
            }
            const weight = this.rng.uniform(0.5, 1.0);
            for (const p of pixels)
                canvas[p] += weight;
        }
        const a = this.blur(canvas, 0.9 * scale);
        const d = std(a) + 1e-9;
        return map(a, v => v / d);
    }
}

function detail(n, preset, seed, scale) {
    const p = PRESETS[preset];
    const f = new Field(n, seed);
    const angle = -25 * Math.PI / 180;

    // Height map: rounded tooth, coarser undulation, fibres, fine grain.
    const ts = p.toothSize * scale;
    const big = f.pebbles(ts * 2.2, ts, p.aniso, angle);
    const small = f.pebbles(ts * 1.3, ts * 0.6, p.aniso, angle);
    const band = f.band(p.coarseSize * scale, p.aniso, angle);
    const fibers = f.fibers(Math.trunc(n * n / 900), 40, scale);
    const fine = f.noise(0.5 * scale);
    const h = map(big, (v, i) => p.tooth * (v + 0.5 * small[i]) +
        p.coarse * band[i] + p.fibers * fibers[i] * 0.35 + p.fine * fine[i]);
    return shade(f, h, p.bump, p.cavity, scale);
}

/** Height map to signed shading in [-1, 1]. */
function shade(f, h, bump, cavity, scale) {
    const n = f.n;
    // Lambert shading with light from the upper left.
    const norm = Math.hypot(-1.0, -0.8, 1.6);
    const [lx, ly, lz] = [-1.0 / norm, -0.8 / norm, 1.6 / norm];
    const valleys = cavity ? f.blur(h, 3 * scale) : null;
    const s = map(h, (v, i) => {
        const y = Math.floor(i / n);
        const x = i % n;
        const gx = (h[y * n + (x + 1) % n] - h[y * n + (x + n - 1) % n]) / 2 * bump / scale;
        const gy = (h[((y + 1) % n) * n + x] - h[((y + n - 1) % n) * n + x]) / 2 * bump / scale;
        const nz = 1 / Math.sqrt(gx * gx + gy * gy + 1);
        let result = (-gx * lx - gy * ly + lz) * nz / lz - 1;
        // Valleys collect shadow.
        if (valleys)
            result += cavity * (v - valleys[i]) * 0.3;
        return result;
    });
    // Soft-compress the peaks instead of clipping them into flat blotches.
    const top = percentile(map(s, Math.abs), 99.5);
    return map(s, v => Math.tanh(1.5 * v / top));
}

/** Cloudy pulp density ("formation"), in texels of the stretched tile. */
function tone(seed) {
    const f = new Field(TONE_SIZE, seed + 1);
    const large = f.noise(60 / TONE_SCALE);
    const small = f.noise(25 / TONE_SCALE);
    const m = map(large, (v, i) => v + 0.5 * small[i]);
    const top = percentile(map(m, Math.abs), 99.5);
    return map(m, v => Math.min(1, Math.max(-1, v / top)));
}

function toByte(v) {
    return Math.trunc(v * 255 + 0.5);
}

/**
 * Signed shading in [-1, 1] to grey + alpha, as RGBA bytes.
 *
 * Shadows (m < 0) become black with alpha a_s, highlights (m > 0) white
 * with alpha a_h. The extension multiplies the screen by (1 - a_s), which
 * shows on light surfaces, and adds a_h * (1 - dst), which shows on dark
 * ones. Raking light makes shadows much stronger than highlights, so
 * highlights are boosted to the same spread. The dark-balance setting
 * scales them down again at runtime.
 */
function encode(m, strength = 1.0) {
    const gain = std(map(m, v => Math.max(-v, 0))) / std(map(m, v => Math.max(v, 0)));
    const bytes = new Uint8Array(m.length * 4);
    for (let i = 0; i < m.length; i++) {
        const shadow = strength * Math.max(-m[i], 0);
        const light = strength * Math.min(1, gain * Math.max(m[i], 0));
        const alpha = shadow + light;
        const grey = toByte(alpha > 0 ? light / alpha : 0);
        bytes.fill(grey, i * 4, i * 4 + 3);
        bytes[i * 4 + 3] = toByte(alpha);
    }
    return bytes;
}

/**
 * @typedef {object} Tile
 * @property {number} size - width and height in texels
 * @property {Uint8Array} pixels - RGBA
 */

/**
 * @param {string} name - a key of PRESETS
 * @param {object} [options]
 * @param {number} [options.seed]
 * @param {number} [options.size] - detail tile size
 * @param {number} [options.scale] - feature scale, e.g. 2 for a @2x texture
 * @returns {{detail: Tile, tone: Tile}}
 */
export function generate(name, {seed = 1, size = DETAIL_SIZE, scale = 1} = {}) {
    return {
        detail: {size, pixels: encode(detail(size, name, seed, scale))},
        tone: {size: TONE_SIZE, pixels: encode(tone(seed), PRESETS[name].formation)},
    };
}
