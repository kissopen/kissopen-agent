import { createId } from "@paralleldrive/cuid2";
import {
    localThemeGeneratedSchema,
    localThemeDocSchema,
    type LocalThemeGenerate,
    type LocalThemeGenerated,
    type LocalThemePalette,
} from "@kissopen/kissopen-agent-client";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { withLifetime, type Context } from "@steve.kite/stdlib";
import type { ConfigModule } from "../config/index.js";

export class LocalThemeError extends Error {
    constructor(
        readonly status: number,
        readonly code:
            | "theme_generation_busy"
            | "theme_model_unavailable"
            | "theme_generation_timeout"
            | "theme_generation_failed"
            | "theme_invalid_output",
        message: string,
    ) {
        super(message);
    }
}

const modelOutputSchema = Type.Object(
    {
        ...localThemeGeneratedSchema.properties,
        doc: Type.Object(
            { ...localThemeDocSchema.properties, background: Type.Optional(Type.Unknown()) },
            { additionalProperties: false },
        ),
    },
    { additionalProperties: false },
);
const instructions = `You design KissOpen themes. Return only one JSON object, without commentary:
{"name":"Short theme name","description":"One short sentence","doc":{"version":1,"font":"sans","radius":"soft","light":{...},"dark":{...}}}
Each palette must contain exactly eleven #rrggbb colors: accent, on_accent, canvas, surface, raised, text, muted, line, success, warning, danger.
Light canvas and surface must be pale (relative luminance at least 0.5); dark canvas and surface dark (at most 0.2).
Text must contrast at least 4.5:1 with canvas and surface; muted at least 3:1 with surface; on_accent at least 3:1 with accent.
Use harmonious colors matching the user's description. font is sans, serif or mono; radius is sharp, soft or round. Default to sans and soft unless requested otherwise.
Name must be 1–40 characters, description at most 200, in the user's language. Do not generate background URLs. When given a base theme, change only what the user requests.`;

/** Provider-boundary output, never executable CSS or a renderer-owned validation guess. */
export function localThemeRead(text: string, input: LocalThemeGenerate): LocalThemeGenerated {
    const invalid = () =>
        new LocalThemeError(
            502,
            "theme_invalid_output",
            "The model returned an incomplete or unreadable theme. Your previous draft is unchanged; try describing it again.",
        );
    let value: unknown;
    try {
        value = JSON.parse(
            text
                .trim()
                .replace(/^```(?:json)?\s*/iu, "")
                .replace(/\s*```$/u, ""),
        );
    } catch {
        throw invalid();
    }
    if (!Value.Check(modelOutputSchema, value)) throw invalid();
    // A model-written URL never replaces the trusted base background.
    value.doc.background = input.base?.background;
    if (!Value.Check(localThemeGeneratedSchema, value)) throw invalid();
    for (const [palette, light] of [
        [value.doc.light, true],
        [value.doc.dark, false],
    ] as const) {
        if (
            light
                ? luminance(palette.canvas) < 0.5 || luminance(palette.surface) < 0.5
                : luminance(palette.canvas) > 0.2 || luminance(palette.surface) > 0.2
        )
            throw invalid();
        repair(palette);
        if (
            contrast(palette.text, palette.canvas) < 4.5 ||
            contrast(palette.text, palette.surface) < 4.5 ||
            contrast(palette.muted, palette.surface) < 3 ||
            contrast(palette.on_accent, palette.accent) < 3
        )
            throw invalid();
    }
    value.name = value.name.trim();
    value.description = value.description.trim();
    if (!value.name) throw invalid();
    return value;
}
function luminance(hex: string): number {
    const channel = (start: number) => {
        const value = parseInt(hex.slice(start, start + 2), 16) / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    return channel(1) * 0.2126 + channel(3) * 0.7152 + channel(5) * 0.0722;
}
function contrast(left: string, right: string): number {
    const a = luminance(left),
        b = luminance(right);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function repair(p: LocalThemePalette): void {
    const best = (background: string) =>
        contrast("#000000", background) >= contrast("#ffffff", background) ? "#000000" : "#ffffff";
    if (contrast(p.text, p.canvas) < 4.5 || contrast(p.text, p.surface) < 4.5)
        p.text = best(p.canvas);
    if (contrast(p.muted, p.surface) < 3) p.muted = best(p.surface);
    if (contrast(p.on_accent, p.accent) < 3) p.on_accent = best(p.accent);
}

/** A request-owned one-shot session. No chat, tools, retry or durable background work. */
export async function localThemeGenerate(
    ctx: Context,
    config: ConfigModule,
    input: LocalThemeGenerate,
): Promise<LocalThemeGenerated> {
    const model = config.models.find((entry) => entry.providerId !== "kissopen");
    if (!model)
        throw new LocalThemeError(
            503,
            "theme_model_unavailable",
            "Enable a model in Settings → Providers before making a theme.",
        );
    const controller = new AbortController();
    const signal = ctx.lifetime
        ? AbortSignal.any([ctx.lifetime, controller.signal])
        : controller.signal;
    const timeout = setTimeout(
        () =>
            controller.abort(
                new LocalThemeError(
                    504,
                    "theme_generation_timeout",
                    "The model took too long to make a theme. Your previous draft is unchanged; try again.",
                ),
            ),
        120000,
    );
    timeout.unref();
    let rejectAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(signal.reason);
        if (signal.aborted) rejectAbort();
        else signal.addEventListener("abort", rejectAbort, { once: true });
    });
    try {
        const generate = async () => {
            signal.throwIfAborted();
            const provider = await config.providers.resolve(model.providerId, model.id);
            signal.throwIfAborted();
            if (!provider)
                throw new LocalThemeError(
                    503,
                    "theme_model_unavailable",
                    "The selected model is unavailable. Check Settings → Providers and try again.",
                );
            const session = await provider.session(`theme:${createId()}`, {
                instructions,
                tools: [],
                inferenceMaxRetries: 0,
            });
            try {
                signal.throwIfAborted();
                const consume = async () => {
                    let text = "";
                    const prompt =
                        input.prompt.trim() +
                        (input.base ? "\n\nBase theme:\n" + JSON.stringify(input.base) : "");
                    for await (const event of session.run(withLifetime(ctx, signal), {
                        model: model.id,
                        effort: model.defaultEffort,
                        context: {
                            instructions,
                            messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
                        },
                    })) {
                        if (event.type === "text_delta") {
                            text += event.delta;
                            if (Buffer.byteLength(text, "utf8") > 32768)
                                throw new LocalThemeError(
                                    502,
                                    "theme_invalid_output",
                                    "The model returned too much theme data. Try a simpler description.",
                                );
                        }
                        if (event.type !== "done") continue;
                        if (event.state === "error" || event.state === "cancelled") {
                            if (signal.aborted) throw signal.reason;
                            throw new LocalThemeError(
                                502,
                                "theme_generation_failed",
                                "The model could not finish the theme. Check your model connection or allowance and try again; your previous draft is unchanged.",
                            );
                        }
                        return localThemeRead(text, input);
                    }
                    throw new LocalThemeError(
                        502,
                        "theme_generation_failed",
                        "The model did not finish its reply. Your previous draft is unchanged; try again.",
                    );
                };
                return await consume();
            } finally {
                await session.destroy();
            }
        };
        return await Promise.race([generate(), aborted]);
    } catch (error) {
        if (error instanceof LocalThemeError) throw error;
        if (signal.reason instanceof LocalThemeError) throw signal.reason;
        throw new LocalThemeError(
            502,
            "theme_generation_failed",
            "The model connection failed. Check Settings → Providers and try again; your previous draft is unchanged.",
        );
    } finally {
        clearTimeout(timeout);
        if (rejectAbort) signal.removeEventListener("abort", rejectAbort);
    }
}
