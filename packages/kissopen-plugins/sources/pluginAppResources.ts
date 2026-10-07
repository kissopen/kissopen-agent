import type { KissopenPluginResourceMediaType } from "./types.js";

const RESOURCE_MEDIA_TYPES: Readonly<Record<string, KissopenPluginResourceMediaType>> = {
    ".css": "text/css",
    ".html": "text/html",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
};

/** Returns the one media type both Rig and the development host publish for a resource path. */
export function kissopenPluginAppResourceMediaType(
    path: string,
): KissopenPluginResourceMediaType | undefined {
    const slash = path.lastIndexOf("/");
    const dot = path.lastIndexOf(".");
    if (dot <= slash) return undefined;
    return RESOURCE_MEDIA_TYPES[path.slice(dot).toLowerCase()];
}

export function isKissopenPluginImageMediaType(mediaType: KissopenPluginResourceMediaType): boolean {
    return mediaType.startsWith("image/");
}
