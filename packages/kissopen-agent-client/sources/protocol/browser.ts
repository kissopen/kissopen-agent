import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const token = Type.String({ minLength: 32, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" });
const ref = Type.String({ minLength: 1, maxLength: 96, pattern: "^[A-Za-z0-9_-]+$" });
const object = { additionalProperties: false };
const click = Type.Object({ action: Type.Literal("click"), ref }, object);
const fill = Type.Object(
    { action: Type.Literal("fill"), ref, text: Type.String({ maxLength: 8000 }) },
    object,
);
const scroll = Type.Object(
    {
        action: Type.Literal("scroll"),
        direction: Type.Union([Type.Literal("up"), Type.Literal("down")]),
    },
    object,
);
const timeoutMs = Type.Optional(Type.Integer({ minimum: 1, maximum: 10000 }));
const capabilities = Type.Array(Type.Union([Type.Literal("batch"), Type.Literal("wait")]), {
    maxItems: 2,
    uniqueItems: true,
});

export const browserOperationSchema = Type.Union([
    Type.Object(
        {
            action: Type.Literal("navigate"),
            url: Type.String({ maxLength: 4096, pattern: "^https?://" }),
        },
        object,
    ),
    Type.Object(
        {
            action: Type.Union([
                Type.Literal("read"),
                Type.Literal("screenshot"),
                Type.Literal("handoff"),
            ]),
        },
        object,
    ),
    click,
    fill,
    scroll,
    Type.Object(
        {
            action: Type.Literal("batch"),
            steps: Type.Array(Type.Union([click, fill, scroll]), { minItems: 1, maxItems: 6 }),
        },
        object,
    ),
    Type.Object(
        {
            action: Type.Literal("wait"),
            condition: Type.Union([Type.Literal("domcontentloaded"), Type.Literal("load")]),
            timeoutMs,
        },
        object,
    ),
    Type.Object(
        {
            action: Type.Literal("wait"),
            condition: Type.Union([
                Type.Literal("visible"),
                Type.Literal("hidden"),
                Type.Literal("enabled"),
            ]),
            ref,
            timeoutMs,
        },
        object,
    ),
]);
export const browserResultSchema = Type.Object(
    {
        ok: Type.Boolean(),
        text: Type.String({ maxLength: 24000 }),
        image: Type.Optional(Type.String({ maxLength: 300000 })),
        batch: Type.Optional(
            Type.Object(
                {
                    completedSteps: Type.Integer({ minimum: 0, maximum: 6 }),
                    totalSteps: Type.Integer({ minimum: 1, maximum: 6 }),
                    reason: Type.Union([
                        Type.Literal("completed"),
                        Type.Literal("page_changed"),
                        Type.Literal("failed"),
                        Type.Literal("timeout"),
                    ]),
                },
                object,
            ),
        ),
    },
    object,
);
export const browserControlRequestSchema = Type.Union([
    Type.Object(
        {
            action: Type.Literal("attach"),
            leaseId: token,
            tabId: token,
            capabilities: Type.Optional(capabilities),
        },
        object,
    ),
    Type.Object(
        {
            action: Type.Union([
                Type.Literal("poll"),
                Type.Literal("pause"),
                Type.Literal("resume"),
                Type.Literal("revoke"),
            ]),
            leaseId: token,
        },
        object,
    ),
    Type.Object(
        {
            action: Type.Literal("complete"),
            leaseId: token,
            commandId: token,
            result: browserResultSchema,
        },
        object,
    ),
]);
export const browserCommandSchema = Type.Object(
    {
        id: token,
        tabId: token,
        expiresAt: Type.Number(),
        operation: browserOperationSchema,
    },
    object,
);
export const browserControlResponseSchema = Type.Union([
    Type.Object(
        {
            ok: Type.Literal(true),
            paused: Type.Boolean(),
            command: Type.Optional(browserCommandSchema),
        },
        object,
    ),
    Type.Object({ ok: Type.Literal(false), error: Type.String({ maxLength: 2000 }) }, object),
]);
export type BrowserOperation = Static<typeof browserOperationSchema>;
export type BrowserResult = Static<typeof browserResultSchema>;
export type BrowserControlRequest = Static<typeof browserControlRequestSchema>;
export type BrowserControlResponse = Static<typeof browserControlResponseSchema>;
export type BrowserCommand = Static<typeof browserCommandSchema>;
export function isBrowserControlResponse(value: unknown): value is BrowserControlResponse {
    return Value.Check(browserControlResponseSchema, value);
}
