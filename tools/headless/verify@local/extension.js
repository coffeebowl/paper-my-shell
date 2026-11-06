// Checks that partial redraws leave the screen as a full repaint would:
// moves a dark square over a test card in small steps, then saves what
// the monitor really shows (partial.png), repaints everything and saves it
// again (full.png). Screenshots can't do this, they paint a fresh copy.
// Also counts the frames after the last step: a still screen has to
// settle. PAPER_SCALE sets the monitor scale first.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const OUT = GLib.getenv('PAPER_TEST_OUT');

const wait = ms => new Promise(resolve =>
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));

async function applyScale(scale) {
    const call = (method, args) => new Promise((resolve, reject) => Gio.DBus.session.call(
        'org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
        'org.gnome.Mutter.DisplayConfig', method, args, null, Gio.DBusCallFlags.NONE, -1, null,
        (c, r) => {
            try {
                resolve(c.call_finish(r));
            } catch (e) {
                reject(e);
            }
        }));
    const [serial, monitors] = (await call('GetCurrentState', null)).deepUnpack();
    const [[connector], modes] = monitors[0];
    const mode = modes.find(m => m[6]['is-current']?.unpack()) ?? modes[0];
    await call('ApplyMonitorsConfig', new GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})',
        [serial, 1, [[0, 0, scale, 0, true, [[connector, mode[0], {}]]]], {}]));
}

function testCard() {
    const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x: 60, y: 60,
        style: 'background-color: #fafafa; padding: 24px; spacing: 12px;'});
    box.add_child(new St.Label({text: 'Paper ink test. The quick brown fox jumps over the lazy dog.',
        style: 'color: #111; font-size: 22px;'}));
    box.add_child(new St.Label({text: 'Small text 12px: Ink spreads into absorbent paper fibres.',
        style: 'color: #222; font-size: 12px;'}));
    const row = new St.BoxLayout({style: 'spacing: 8px;'});
    for (const c of ['#0050ff', '#00c040', '#e02020', '#8a2be2', '#ffd400', '#00b7eb'])
        row.add_child(new St.Widget({width: 90, height: 60, style: `background-color: ${c};`}));
    box.add_child(row);
    Main.layoutManager.uiGroup.add_child(box);
}

/**
 * Save what the first monitor shows at the end of the next paint: the
 * view's framebuffer, after Mutter repaired it for buffer age.
 *
 * @param {string} name
 * @param {Function} trigger - makes the next frame happen
 */
function capture(name, trigger) {
    return new Promise((resolve, reject) => {
        const id = global.stage.connect_after('paint-view', (_stage, view) => {
            global.stage.disconnect(id);
            try {
                const fb = view.get_framebuffer();
                const [w, h] = [fb.get_width(), fb.get_height()];
                const texture = Cogl.Texture2D.new_with_size(fb.get_context(), w, h);
                const target = Cogl.Offscreen.new_with_texture(texture);
                target.allocate();
                fb.blit(target, 0, 0, 0, 0, w, h);
                const file = Gio.File.new_for_path(`${OUT}/${name}.png`);
                const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
                Shell.Screenshot.composite_to_stream(texture, 0, 0, -1, -1, 1, null, 0, 0, 1, stream,
                    (_o, res) => {
                        try {
                            Shell.Screenshot.composite_to_stream_finish(res);
                            stream.close(null);
                            resolve();
                        } catch (e) {
                            reject(e);
                        }
                    });
            } catch (e) {
                reject(e);
            }
        });
        trigger();
    });
}

async function run() {
    await wait(3000);
    Main.overview.hide();
    if (GLib.getenv('PAPER_SCALE'))
        await applyScale(Number(GLib.getenv('PAPER_SCALE')));
    await wait(1500);
    testCard();
    await wait(1000);
    const uiGroup = Main.layoutManager.uiGroup;
    const effect = uiGroup.get_effect('paper-my-shell-print');
    console.log(`PAPERTEST effect=${effect?.constructor.name ?? 'none'} ` +
        `scale=${global.stage.peek_stage_views()[0].get_scale()}`);

    // Partial redraws whose edges change: a dark square moves a pixel at a
    // time, over the text, the colours and the plain desktop.
    const mover = new St.Widget({width: 40, height: 40, style: 'background-color: #222;'});
    uiGroup.add_child(mover);
    let step = 0;
    const timeline = new Clutter.Timeline({actor: mover, duration: 2000});
    timeline.connect('new-frame', () => {
        step++;
        mover.set_position(50 + step * 3, 70 + (step % 40));
    });
    // The square stays: removing it repaints all of uiGroup.
    let frames = 0;
    const counter = global.stage.connect('after-paint', () => frames++);
    timeline.connect('completed', () => {
        frames = 0;
    });
    timeline.start();
    await wait(3500);
    global.stage.disconnect(counter);
    console.log(`PAPERTEST frames after the last step: ${frames}`);

    // A frame far away from the test, so something gets painted at all.
    const corner = () => uiGroup.queue_redraw_with_clip(
        new Mtk.Rectangle({x: global.stage.width - 2, y: global.stage.height - 2, width: 1, height: 1}));
    await capture('partial', corner);
    await wait(500);
    await capture('full', () => uiGroup.queue_redraw());
}

export default class {
    enable() {
        run()
            .catch(e => console.log(`PAPERTEST error ${e}\n${e.stack}`))
            .finally(() => {
                console.log('PAPERTEST done');
                global.context.terminate();
            });
    }

    disable() {}
}
