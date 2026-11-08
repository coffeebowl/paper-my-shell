import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {textureLabel} from './textures.js';

/**
 * On and off for everything, the selected paper as subtitle, and the way
 * to the preferences. Everything else lives there.
 */
const PaperToggle = GObject.registerClass(
class PaperToggle extends QuickMenuToggle {
    constructor(extension, settings) {
        const gicon = Gio.FileIcon.new(
            extension.dir.resolve_relative_path('icons/paper-symbolic.svg'));
        super({
            title: _('Paper'),
            gicon,
            toggleMode: true,
        });
        settings.bind('enabled', this, 'checked', Gio.SettingsBindFlags.DEFAULT);
        this.connect('destroy', () => Gio.Settings.unbind(this, 'checked'));

        this.menu.setHeader(gicon, _('Paper my Shell'));
        this.menu.addAction(_('Settings'), () => extension.openPreferences());

        const syncTexture = () => (this.subtitle = textureLabel(settings.get_string('texture')));
        settings.connectObject('changed::texture', syncTexture, this);
        syncTexture();
    }
});

export const PaperIndicator = GObject.registerClass(
class PaperIndicator extends SystemIndicator {
    constructor(extension, settings) {
        super();
        this.quickSettingsItems.push(new PaperToggle(extension, settings));

        // The extension keeps running on the lock screen so the paper stays,
        // but settings are not for whoever stands at the locked machine.
        const sync = () => this.quickSettingsItems.forEach(item =>
            (item.visible = !Main.sessionMode.isLocked));
        Main.sessionMode.connectObject('updated', sync, this);
        sync();
    }

    destroy() {
        Main.sessionMode.disconnectObject(this);
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});
