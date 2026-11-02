/**
 * Names of the built-in textures, from the choices of the texture key in
 * the schema, in the order shown. Each is a preset in papergen.js.
 *
 * @param {Gio.Settings} settings
 * @returns {string[]}
 */
export function textureNames(settings) {
    const [, choices] = settings.settings_schema.get_key('texture')
        .get_range().recursiveUnpack();
    return choices;
}

/**
 * @param {string} name
 * @returns {string}
 */
export function textureLabel(name) {
    const words = name.replaceAll('-', ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
}
