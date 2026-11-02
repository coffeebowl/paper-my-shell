import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const UUID = GLib.getenv('PAPER_TEST_UUID');
const ROUNDS = Number(GLib.getenv('PAPER_PERF_ROUNDS') ?? 3);
// Comma-separated subset of configs and scenarios, e.g. "overlay+print:idle".
const ONLY = GLib.getenv('PAPER_PERF_ONLY')?.split(',') ?? null;
const SECONDS = 6;

const decoder = new TextDecoder();
const wait = ms => new Promise(resolve =>
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));

/** Textures are generated on first use, which takes a few seconds. */
async function waitForTextures(overlay) {
    for (let i = 0; i < 120 && !overlay._textures; i++)
        await wait(250);
}

function readText(path) {
    return decoder.decode(GLib.file_get_contents(path)[1]);
}

/** CPU time of this process in clock ticks (1/100 s). */
function cpuTicks() {
    const fields = readText('/proc/self/stat').split(') ')[1].split(' ');
    return Number(fields[11]) + Number(fields[12]);
}

/** GPU time of this process from the DRM driver, per client id. */
function gpuNs() {
    const clients = new Map();
    const dir = GLib.Dir.open('/proc/self/fdinfo', 0);
    let name;
    while ((name = dir.read_name()) !== null) {
        let text;
        try {
            text = readText(`/proc/self/fdinfo/${name}`);
        } catch {
            continue;
        }
        const id = text.match(/drm-client-id:\s+(\d+)/);
        const gfx = text.match(/drm-engine-gfx:\s+(\d+) ns/);
        if (id && gfx)
            clients.set(id[1], Number(gfx[1]));
    }
    dir.close();
    return [...clients.values()].reduce((a, b) => a + b, 0);
}

/** Nothing moves: a static screen should cost no frames at all. */
function animateNothing() {
    return () => {};
}

/** A 200 px square moving every frame: small damage. */
function animateSmall() {
    const box = new St.Widget({width: 200, height: 200, style: 'background-color: #c33;'});
    Main.layoutManager.uiGroup.add_child(box);
    const timeline = new Clutter.Timeline({actor: box, duration: 1000, repeat_count: -1});
    timeline.connect('new-frame', (_t, ms) => box.set_position(200 + ms * 2, 400 + (ms % 300)));
    timeline.start();
    return () => {
        timeline.stop();
        box.destroy();
    };
}

/** A full-screen colour changing every frame: full damage. */
function animateFull() {
    const box = new Clutter.Actor({width: global.stage.width, height: global.stage.height});
    Main.layoutManager.uiGroup.add_child(box);
    const timeline = new Clutter.Timeline({actor: box, duration: 1000, repeat_count: -1});
    timeline.connect('new-frame', (_t, ms) => {
        const v = Math.floor(100 + 100 * Math.abs(Math.sin(ms / 160)));
        box.background_color = new Cogl.Color({red: v, green: 120, blue: 255 - v, alpha: 255});
    });
    timeline.start();
    return () => {
        timeline.stop();
        box.destroy();
    };
}

async function measure(label, animate) {
    let frames = 0;
    const id = global.stage.connect('after-paint', () => frames++);
    const stop = animate();
    const t0 = GLib.get_monotonic_time(), c0 = cpuTicks(), g0 = gpuNs();
    await wait(SECONDS * 1000);
    const t1 = GLib.get_monotonic_time(), c1 = cpuTicks(), g1 = gpuNs();
    stop();
    global.stage.disconnect(id);

    const secs = (t1 - t0) / 1e6;
    const perFrame = frames ? n => (n / frames).toFixed(2) : () => '-';
    console.log(`PERF ${label}: fps ${(frames / secs).toFixed(1)} | ` +
        `CPU ms/frame ${perFrame((c1 - c0) * 10)} | ` +
        `GPU µs/frame ${perFrame((g1 - g0) / 1000)} | ` +
        `GPU ms/s ${((g1 - g0) / 1e6 / secs).toFixed(1)}`);
}

const CONFIGS = [
    ['off', {'enabled': false}],
    ['overlay', {'enabled': true, 'print-colors-enabled': false}],
    ['overlay+print', {'enabled': true, 'print-colors-enabled': true}],
];

async function run() {
    await wait(3000);
    Main.overview.hide();
    await wait(1500);
    const {_settings: settings, _overlay: overlay} = Main.extensionManager.lookup(UUID).stateObj;
    await waitForTextures(overlay);

    for (let round = 0; round < ROUNDS; round++) {
        for (const [name, config] of CONFIGS) {
            if (ONLY && !ONLY.some(o => o.startsWith(`${name}:`)))
                continue;
            for (const [key, value] of Object.entries(config))
                settings.set_boolean(key, value);
            await wait(1000);
            const scenarios = [['idle', animateNothing], ['small', animateSmall], ['full', animateFull]];
            for (const [scenario, animate] of scenarios) {
                if (!ONLY || ONLY.includes(`${name}:${scenario}`))
                    await measure(`${name} ${scenario}`, animate);
            }
        }
    }
}

export default class {
    enable() {
        run()
            .catch(e => console.log(`PERF error ${e}\n${e.stack}`))
            .finally(() => {
                console.log('PERF done');
                global.context.terminate();
            });
    }

    disable() {}
}
