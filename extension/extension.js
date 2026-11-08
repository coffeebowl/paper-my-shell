import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {PaperOverlay} from './overlay.js';
import {PaperIndicator} from './quickSettings.js';

export default class PaperMyShellExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._overlay = new PaperOverlay(this._settings, this);
        this._indicator = new PaperIndicator(this, this._settings);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    // unlock-dialog keeps the paper on the lock screen; otherwise every lock
    // and unlock would rebuild it. The settings are hidden while locked.
    disable() {
        this._indicator.destroy();
        this._indicator = null;
        this._overlay.destroy();
        this._overlay = null;
        this._settings = null;
    }
}
