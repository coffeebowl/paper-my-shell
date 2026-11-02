import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

const OUT = GLib.getenv('PAPER_TEST_OUT');
const UUID = GLib.getenv('PAPER_TEST_UUID');

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

function shot(name) {
    return new Promise((resolve, reject) => {
        const file = Gio.File.new_for_path(`${OUT}/${name}.png`);
        const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
        new Shell.Screenshot().screenshot(false, stream, (shooter, res) => {
            try {
                shooter.screenshot_finish(res);
                stream.close(null);
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });
}

async function run() {
    await wait(3000);
    Main.overview.hide();
    await wait(1500);

    const extension = Main.extensionManager.lookup(UUID);
    await waitForTextures(extension.stateObj._overlay);
    const overlays = global.stage.get_children()
        .filter(a => a.name === 'paper-my-shell-overlay');
    const print = Main.layoutManager.uiGroup.get_effect('paper-my-shell-print');
    console.log(`PAPERTEST state=${extension.state} error=${extension.error} ` +
        `overlays=${overlays.length} visible=${overlays.filter(a => a.visible).length} ` +
        `print-effect=${print !== null}`);
    await shot('desktop');

    const quickSettings = Main.panel.statusArea.quickSettings;
    quickSettings.menu.open(false);
    await wait(500);
    const toggle = quickSettings.menu._grid.get_children()
        .find(c => c.constructor.name.includes('PaperToggle'));
    toggle?.menu.open(false);
    await wait(1000);
    await shot('menu');

    // Dragging a slider only previews, the value is saved on release.
    const settings = extension.stateObj._settings;
    const slider = toggle.menu._getMenuItems()
        .flatMap(item => item.get_children())
        .find(child => child instanceof Slider);
    const before = settings.get_double('intensity');
    slider.emit('drag-begin');
    slider.value = 0.5;
    const during = settings.get_double('intensity');
    slider.emit('drag-end');
    const after = settings.get_double('intensity');
    console.log(`PAPERTEST slider intensity before=${before} during=${during} after=${after}`);
    settings.reset('intensity');
    quickSettings.menu.close(false);

    extension.stateObj.openPreferences();
    await wait(5000);
    await shot('prefs');
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
