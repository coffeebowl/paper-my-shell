// Generate a texture and write its tiles as PNGs, e.g. for tools/preview.py.
//
// Usage: gjs -m generate.js PRESET DIR [--size N] [--scale S] [--seed N]

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import System from 'system';

import {PRESETS, generate} from './papergen.js';

const OPTIONS = ['--size', '--scale', '--seed'];

function usage() {
    printerr(`usage: gjs -m generate.js {${Object.keys(PRESETS).join(',')}} DIR ` +
        '[--size N] [--scale S] [--seed N]');
    System.exit(2);
}

const [preset, output, ...rest] = System.programArgs;
if (!Object.hasOwn(PRESETS, preset) || !output)
    usage();
const options = {};
for (let i = 0; i < rest.length; i += 2) {
    const value = Number(rest[i + 1]);
    if (!OPTIONS.includes(rest[i]) || !Number.isFinite(value))
        usage();
    options[rest[i].slice(2)] = value;
}

const dir = Gio.File.new_for_path(output);
try {
    dir.make_directory_with_parents(null);
} catch (e) {
    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
        throw e;
}
// Each file is replaced atomically, so an interrupted run leaves no
// truncated tiles, only missing ones.
for (const [name, tile] of Object.entries(generate(preset, options))) {
    const [, png] = GdkPixbuf.Pixbuf.new_from_bytes(tile.pixels, GdkPixbuf.Colorspace.RGB,
        true, 8, tile.size, tile.size, tile.size * 4).save_to_bufferv('png', [], []);
    dir.get_child(`${name}.png`).replace_contents(png, null, false,
        Gio.FileCreateFlags.REPLACE_DESTINATION, null);
}
