import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {textureLabel, textureNames} from './textures.js';

/**
 * The schema default of a key, readable, so it never drifts from the schema.
 *
 * @param {Gio.Settings} settings
 * @param {string} key
 * @returns {string}
 */
function defaultText(settings, key) {
    const value = settings.get_default_value(key).recursiveUnpack();
    if (typeof value === 'boolean')
        return value ? _('Default: on.') : _('Default: off.');
    if (typeof value === 'number')
        return `${_('Default:')} ${Math.round(value * 100)} %.`;
    return `${_('Default:')} ${textureLabel(value)}.`;
}

/**
 * @param {string} text
 * @param {Gio.Settings} settings
 * @param {string} key
 * @returns {string}
 */
function withDefault(text, settings, key) {
    return text ? `${text} ${defaultText(settings, key)}` : defaultText(settings, key);
}

/**
 * A spin row editing a 0..1 double key in percent.
 *
 * @param {Gio.Settings} settings
 * @param {string} key
 * @param {number} upper - maximum in percent
 * @param {string} title
 * @param {string} subtitle
 * @param {number} [lower] - minimum in percent
 * @returns {Adw.SpinRow}
 */
function percentRow(settings, key, upper, title, subtitle, lower = 0) {
    const row = new Adw.SpinRow({
        title,
        subtitle: withDefault(subtitle, settings, key),
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: 1, page_increment: 10}),
    });
    const sync = () => {
        row.value = Math.round(settings.get_double(key) * 100);
    };
    sync();
    settings.connect(`changed::${key}`, sync);
    row.connect('notify::value', () => {
        const value = row.value / 100;
        if (Math.abs(value - settings.get_double(key)) >= 0.005)
            settings.set_double(key, value);
    });
    return row;
}

/**
 * A switch row for a boolean key.
 *
 * @param {Gio.Settings} settings
 * @param {string} key
 * @param {string} title
 * @param {string} subtitle
 * @returns {Adw.SwitchRow}
 */
function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle: withDefault(subtitle, settings, key)});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/**
 * A group for one feature, switched on and off from its header. Its rows
 * are greyed out while the feature is off.
 *
 * @param {Gio.Settings} settings
 * @param {string} enabledKey
 * @param {string} title
 * @param {string} description
 * @param {Adw.PreferencesRow[]} rows
 * @returns {Adw.PreferencesGroup}
 */
function featureGroup(settings, enabledKey, title, description, rows) {
    const group = new Adw.PreferencesGroup({
        title,
        description: withDefault(description, settings, enabledKey),
    });
    const toggle = new Gtk.Switch({valign: Gtk.Align.CENTER});
    settings.bind(enabledKey, toggle, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.set_header_suffix(toggle);
    for (const row of rows) {
        settings.bind(enabledKey, row, 'sensitive', Gio.SettingsBindFlags.GET);
        group.add(row);
    }
    return group;
}

export default class PaperMyShellPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;

        // Two pages, one per way of rendering: the effects on a page share
        // their GPU cost, so the page says what that costs.
        const page = new Adw.PreferencesPage({
            title: _('Paper'),
            icon_name: 'x-office-document-symbolic',
            description: _('These effects share two light passes over each monitor, drawn only on frames that change anyway. The first one you turn on costs a little, the others then add nothing measurable. A still screen costs nothing. While an effect from the Print page is on, the paper is drawn in its pass and costs nothing extra.'),
        });

        const general = new Adw.PreferencesGroup();
        const enabledRow = new Adw.SwitchRow({
            title: _('Enabled'),
            subtitle: _('Turns all effects on or off, same as the Quick Settings toggle.'),
        });
        settings.bind('enabled', enabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        general.add(enabledRow);
        general.add(switchRow(settings, 'hide-in-fullscreen', _('Hide on fullscreen windows'),
            _('Keeps games and videos on the fast path.')));
        page.add(general);

        const textures = textureNames(settings);
        const textureRow = new Adw.ComboRow({
            title: _('Texture'),
            subtitle: defaultText(settings, 'texture'),
            model: Gtk.StringList.new(textures.map(textureLabel)),
        });
        const syncTexture = () => {
            const index = textures.indexOf(settings.get_string('texture'));
            if (index >= 0)
                textureRow.selected = index;
        };
        syncTexture();
        settings.connect('changed::texture', syncTexture);
        textureRow.connect('notify::selected', () => {
            if (textures[textureRow.selected])
                settings.set_string('texture', textures[textureRow.selected]);
        });
        page.add(featureGroup(settings, 'texture-enabled', _('Paper texture'),
            _('A relief of paper grain and fibres over the whole screen.'), [
                textureRow,
                percentRow(settings, 'intensity', 100, _('Intensity'),
                    _('Low values look most natural.')),
                percentRow(settings, 'dark-balance', 100, _('Dark surfaces'),
                    _('Strength on dark areas, relative to light ones.')),
                percentRow(settings, 'grain', 100, _('Fine grain'),
                    _('Pixel-fine fibres on top, relative to the intensity. Without it the texture looks more like leather.')),
                switchRow(settings, 'true-size', _('True size'),
                    _('Sizes the grain in millimetres from the size the monitor reports, so it looks the same on every screen.')),
            ]));

        page.add(featureGroup(settings, 'matte-enabled', _('Matte'),
            _('The contrast of print instead of a screen: blacks lift like ink on paper, whites get dimmer and slightly warmer. Overall brightness stays the same.'), [
                percentRow(settings, 'matte', 50, _('Amount'), ''),
                percentRow(settings, 'mottle', 20, _('Ink mottle'),
                    _('Ink soaks in unevenly and lightens dark areas in soft patches.')),
            ]));

        page.add(featureGroup(settings, 'brightness-enabled', _('Brightness'),
            _('Dims the whole screen while the extension runs.'), [
                percentRow(settings, 'brightness', 100, _('Brightness'), '', 50),
            ]));
        window.add(page);

        const print = new Adw.PreferencesPage({
            title: _('Print'),
            icon_name: 'printer-symbolic',
            description: _('These effects need the finished picture, so the whole screen is rendered offscreen and every changing frame repaints all of it. Even a blinking cursor then costs several times the GPU time of the paper effects, big changes like scrolling about the same. That is paid once: with one effect on, the other adds little, and the paper effects are drawn in the same pass for free. A still screen costs nothing. Uses more battery on laptops.'),
        });
        print.add(featureGroup(settings, 'print-colors-enabled', _('Print colours (experimental)'),
            _('Only colours offset print on uncoated paper can reach: calmer blues and greens, strong reds and yellows.'), [
                percentRow(settings, 'print-colors', 100, _('Amount'), ''),
            ]));
        print.add(featureGroup(settings, 'ink-spread-enabled', _('Ink spread (experimental)'),
            _('Dark strokes grow a little where the paper takes ink, with ragged edges, and creep along fibres in short feathers, like ink on absorbent paper.'), [
                percentRow(settings, 'ink-spread', 100, _('Amount'), ''),
            ]));
        window.add(print);
    }
}
