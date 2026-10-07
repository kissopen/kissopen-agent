/** Installation-wide third-party integration state. */

import { type Static, Type } from "@sinclair/typebox";

import { Nullable, resourceVersionSchema, timestampSchema } from "./common.js";

/** The public payload a client renders as a QR code while Kissopen pairing is active. */
export const kissopenIntegrationAuthorizationSchema = Type.Object({
    data: Type.String(),
    expiresAt: timestampSchema,
    kind: Type.Literal("qr"),
});
export type KissopenIntegrationAuthorization = Static<
    typeof kissopenIntegrationAuthorizationSchema
>;

/** A stable machine code and its human-readable presentation. */
export const kissopenIntegrationErrorSchema = Type.Object({
    code: Type.String(),
    message: Type.String(),
});
export type KissopenIntegrationError = Static<typeof kissopenIntegrationErrorSchema>;

const snapshotFields = {
    /**
     * The id this daemon registered under with Kissopen, once it holds
     * credentials; `null` before pairing. It is how a client standing next to
     * this daemon recognises this machine in the account's roster, rather than
     * guessing from a hostname. Additive; absent on an older daemon.
     */
    machineId: Type.Optional(Nullable(Type.String())),
    updatedAt: timestampSchema,
    version: resourceVersionSchema,
};

/** The complete current Kissopen integration snapshot, narrowed by `status`. */
export const kissopenIntegrationSchema = Type.Union([
    Type.Object({
        ...snapshotFields,
        authorization: Type.Null(),
        configured: Type.Boolean(),
        error: Type.Null(),
        status: Type.Literal("disabled"),
    }),
    Type.Object({
        ...snapshotFields,
        authorization: Type.Null(),
        configured: Type.Boolean(),
        error: Nullable(kissopenIntegrationErrorSchema),
        status: Type.Literal("disconnected"),
    }),
    Type.Object({
        ...snapshotFields,
        authorization: kissopenIntegrationAuthorizationSchema,
        configured: Type.Literal(false),
        error: Type.Null(),
        status: Type.Literal("pairing"),
    }),
    Type.Object({
        ...snapshotFields,
        authorization: Type.Null(),
        configured: Type.Literal(true),
        error: Type.Null(),
        status: Type.Literal("connecting"),
    }),
    Type.Object({
        ...snapshotFields,
        authorization: Type.Null(),
        configured: Type.Literal(true),
        error: Type.Null(),
        status: Type.Literal("connected"),
    }),
    Type.Object({
        ...snapshotFields,
        authorization: Type.Null(),
        configured: Type.Boolean(),
        error: kissopenIntegrationErrorSchema,
        status: Type.Literal("failed"),
    }),
]);
export type KissopenIntegration = Static<typeof kissopenIntegrationSchema>;

/** The current snapshot returned by every Kissopen integration operation. */
export const kissopenIntegrationResponseSchema = Type.Object({
    integration: kissopenIntegrationSchema,
});
export type KissopenIntegrationResponse = Static<typeof kissopenIntegrationResponseSchema>;
