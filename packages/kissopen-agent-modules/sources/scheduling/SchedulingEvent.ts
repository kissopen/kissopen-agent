import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import {
    MAX_SCHEDULING_TIMESTAMP,
    schedulingAgentIdSchema,
    schedulingEventIdSchema,
    schedulingWaitRecordSchema,
    schedulingWaitResultSchema,
} from "./Scheduling.js";

const eventEnvelope = {
    eventId: schedulingEventIdSchema,
    at: Type.Integer({ minimum: 0, maximum: MAX_SCHEDULING_TIMESTAMP }),
    agentId: schedulingAgentIdSchema,
};

/** Everything scheduling does to a durable wait, as one stream. */
export const schedulingEventSchema = Type.Union([
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("wait_started"),
            wait: schedulingWaitRecordSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...eventEnvelope,
            type: Type.Literal("wait_finished"),
            wait: schedulingWaitRecordSchema,
            result: schedulingWaitResultSchema,
        },
        { additionalProperties: false },
    ),
]);

export type SchedulingEvent = Static<typeof schedulingEventSchema>;

const opaqueContextSchema = Type.Unsafe<Context>(Type.Object({}, { additionalProperties: true }));

/**
 * One subscriber to the stream above. Subscriptions are taken after construction through
 * `SchedulingModule.onEventTransactional` and `SchedulingModule.onEvent`, each of which returns
 * the function that ends the subscription.
 */
export const schedulingEventListenerSchema = Type.Function(
    [opaqueContextSchema, schedulingEventSchema],
    Type.Union([Type.Void(), Type.Promise(Type.Void())]),
);

export type SchedulingEventListener = Static<typeof schedulingEventListenerSchema>;

/** Ends a subscription. Calling it more than once does nothing further. */
export type SchedulingUnsubscribe = () => void;
