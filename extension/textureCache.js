import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'delete_async');
Gio._promisify(Gio.InputStream.prototype, 'close_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
Gio._promisify(GdkPixbuf.Pixbuf, 'new_from_stream_async');

/**
 * Decode a PNG off the compositor thread and upload it once to the GPU.
 *
 * @param {Gio.File} file
 * @param {Gio.Cancellable} cancellable
 * @returns {Promise<Cogl.Texture>}
 */
export async function loadTexture(file, cancellable) {
    const stream = await file.read_async(GLib.PRIORITY_DEFAULT, cancellable);
    let pixbuf;
    try {
        pixbuf = await GdkPixbuf.Pixbuf.new_from_stream_async(stream, cancellable);
    } finally {
        await stream.close_async(GLib.PRIORITY_DEFAULT, null);
    }
    const content = St.ImageContent.new_with_preferred_size(
        pixbuf.width, pixbuf.height);
    const coglContext = global.stage.context.get_backend().get_cogl_context();
    content.set_bytes(
        coglContext,
        pixbuf.read_pixel_bytes(),
        pixbuf.has_alpha ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
        pixbuf.width,
        pixbuf.height,
        pixbuf.rowstride);
    return content.get_texture();
}

/**
 * Where generated textures are kept: the user's cache, under a hash of the
 * generator, so a changed generator never shows stale textures.
 *
 * @param {Extension} extension
 * @param {Gio.Cancellable} cancellable
 * @returns {Promise<Gio.File>}
 */
export async function cacheDir(extension, cancellable) {
    const [source] = await extension.dir.get_child('papergen.js').load_contents_async(cancellable);
    const hash = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, source).slice(0, 16);
    return Gio.File.new_build_filenamev([GLib.get_user_cache_dir(), extension.uuid, hash]);
}

/**
 * @param {Gio.File} file
 * @param {Gio.Cancellable} cancellable
 * @returns {Promise<boolean>}
 */
export async function exists(file, cancellable) {
    try {
        await file.query_info_async('standard::type', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, cancellable);
        return true;
    } catch (e) {
        if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            return false;
        throw e;
    }
}

/**
 * Generate a texture's tiles into dir, in a process of its own: it takes
 * seconds of CPU and a few hundred MB, which must not stall the compositor.
 *
 * @param {Extension} extension
 * @param {string} name
 * @param {Gio.File} dir
 * @param {Gio.Cancellable} cancellable
 */
export async function generateTexture(extension, name, dir, cancellable) {
    // All literals, so review tools can tell which script runs.
    const proc = Gio.Subprocess.new(
        ['gjs', '-m', `${extension.path}/generate.js`, `${name}`, `${dir.get_path()}`],
        Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE);
    const id = cancellable.connect(() => proc.force_exit());
    try {
        const [, , stderr] = await proc.communicate_utf8_async(null, cancellable);
        if (!proc.get_successful())
            throw new Error(stderr.trim() || `generator exited with ${proc.get_exit_status()}`);
    } finally {
        cancellable.disconnect(id);
    }
}

/**
 * @param {Gio.File} dir
 * @param {Gio.Cancellable} cancellable
 * @returns {Promise<Array<[Gio.File, Gio.FileType]>>} its entries, symlinks
 *   not followed
 */
async function listDir(dir, cancellable) {
    const enumerator = await dir.enumerate_children_async('standard::name,standard::type',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_LOW, cancellable);
    const entries = [];
    try {
        let infos;
        while ((infos = await enumerator.next_files_async(32, GLib.PRIORITY_LOW, cancellable)).length)
            entries.push(...infos.map(info => [enumerator.get_child(info), info.get_file_type()]));
    } finally {
        await enumerator.close_async(GLib.PRIORITY_LOW, null);
    }
    return entries;
}

/**
 * @param {Gio.File} file
 * @param {Gio.FileType} type
 * @param {Gio.Cancellable} cancellable
 */
async function removeTree(file, type, cancellable) {
    if (type === Gio.FileType.DIRECTORY) {
        for (const [child, childType] of await listDir(file, cancellable))
            await removeTree(child, childType, cancellable);
    }
    await file.delete_async(GLib.PRIORITY_LOW, cancellable);
}

/**
 * Remove the textures of other generator versions next to dir.
 *
 * @param {Gio.File} dir - from cacheDir()
 * @param {Gio.Cancellable} cancellable
 */
export async function pruneCache(dir, cancellable) {
    for (const [child, type] of await listDir(dir.get_parent(), cancellable)) {
        if (!child.equal(dir))
            await removeTree(child, type, cancellable);
    }
}
