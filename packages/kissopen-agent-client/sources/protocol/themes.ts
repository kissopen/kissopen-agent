import { Type, type Static } from "@sinclair/typebox";

const colour = Type.String({ pattern: "^#[0-9a-fA-F]{6}$" });
export const localThemePaletteSchema = Type.Object(
    {
        accent: colour,
        on_accent: colour,
        canvas: colour,
        surface: colour,
        raised: colour,
        text: colour,
        muted: colour,
        line: colour,
        success: colour,
        warning: colour,
        danger: colour,
    },
    { additionalProperties: false },
);
export const localThemeBackgroundSchema = Type.Object(
    {
        url: Type.String({
            maxLength: 2048,
            pattern: "^https?://[^/?#@]+/api/themes/images/[0-9a-f]{16,64}$",
        }),
        opacity: Type.Number({ minimum: 0.05, maximum: 1 }),
        blur: Type.Number({ minimum: 0, maximum: 40 }),
    },
    { additionalProperties: false },
);
export const localThemeDocSchema = Type.Object(
    {
        version: Type.Literal(1),
        font: Type.Union([Type.Literal("sans"), Type.Literal("serif"), Type.Literal("mono")]),
        radius: Type.Union([Type.Literal("sharp"), Type.Literal("soft"), Type.Literal("round")]),
        light: localThemePaletteSchema,
        dark: localThemePaletteSchema,
        background: Type.Optional(Type.Union([localThemeBackgroundSchema, Type.Null()])),
    },
    { additionalProperties: false },
);
export const localThemeGenerateSchema = Type.Object(
    {
        prompt: Type.String({ minLength: 1, maxLength: 300 }),
        base: Type.Optional(Type.Union([localThemeDocSchema, Type.Null()])),
    },
    { additionalProperties: false },
);
export const localThemeGeneratedSchema = Type.Object(
    {
        name: Type.String({ minLength: 1, maxLength: 40 }),
        description: Type.String({ maxLength: 200 }),
        doc: localThemeDocSchema,
    },
    { additionalProperties: false },
);
export const localThemeCapabilitySchema = Type.Object(
    {
        available: Type.Boolean(),
        model: Type.Union([
            Type.Object(
                { providerId: Type.String(), modelId: Type.String() },
                { additionalProperties: false },
            ),
            Type.Null(),
        ]),
    },
    { additionalProperties: false },
);
export type LocalThemePalette = Static<typeof localThemePaletteSchema>;
export type LocalThemeDoc = Static<typeof localThemeDocSchema>;
export type LocalThemeGenerate = Static<typeof localThemeGenerateSchema>;
export type LocalThemeGenerated = Static<typeof localThemeGeneratedSchema>;
export type LocalThemeCapability = Static<typeof localThemeCapabilitySchema>;
