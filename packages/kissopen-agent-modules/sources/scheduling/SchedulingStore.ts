import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    schedulingAgentIdSchema,
    schedulingWaitIdSchema,
    schedulingWaitRecordSchema,
    schedulingWaitResultSchema,
    type SchedulingWaitRecord,
    type SchedulingWaitResult,
} from "./Scheduling.js";

export const schedulingContextSchema = Type.Unsafe<Context>(
    Type.Object({}, { additionalProperties: true }),
);

const voidPromiseSchema = Type.Promise(Type.Void());

export const schedulingStoreSchema = Type.Object(
    {
        readWait: Type.Function(
            [schedulingContextSchema, schedulingAgentIdSchema, schedulingWaitIdSchema],
            Type.Promise(Type.Union([schedulingWaitRecordSchema, Type.Undefined()])),
        ),
        writeWait: Type.Function(
            [schedulingContextSchema, schedulingWaitRecordSchema],
            voidPromiseSchema,
        ),
    },
    { additionalProperties: false },
);

export type SchedulingStore = Static<typeof schedulingStoreSchema>;

export function assertSchedulingStore(value: unknown): asserts value is SchedulingStore {
    if (!Value.Check(schedulingStoreSchema, value)) {
        throw new Error("Scheduling module received an invalid internal storage adapter.");
    }
}
export function assertSchedulingWaitRecord(value: unknown): asserts value is SchedulingWaitRecord {
    if (!Value.Check(schedulingWaitRecordSchema, value)) {
        throw new Error("Scheduling store returned an invalid durable wait.");
    }
    const record = value as SchedulingWaitRecord;
    if (record.createdAt > record.updatedAt || record.startedAt < record.createdAt) {
        throw new Error("Scheduling durable wait has invalid timestamp ordering.");
    }
    if (record.startedAt > record.dueAt) {
        throw new Error("Scheduling durable wait starts after its due time.");
    }
    if (record.status === "waiting") {
        if ("finishedAt" in record || "elapsedMs" in record) {
            throw new Error("Waiting durable wait has terminal fields.");
        }
    } else if (
        record.finishedAt < record.startedAt ||
        record.finishedAt < record.createdAt ||
        record.elapsedMs !== record.finishedAt - record.startedAt ||
        (record.status === "elapsed" && record.finishedAt < record.dueAt)
    ) {
        throw new Error("Scheduling durable wait has an untruthful elapsed duration.");
    }
}

export function assertSchedulingWaitResult(value: unknown): asserts value is SchedulingWaitResult {
    if (!Value.Check(schedulingWaitResultSchema, value)) {
        throw new Error("Scheduling produced an invalid wait result.");
    }
    const result = value as SchedulingWaitResult;
    if (
        result.endedAt < result.startedAt ||
        result.elapsedMs !== result.endedAt - result.startedAt
    ) {
        throw new Error("Scheduling produced an untruthful elapsed duration.");
    }
    if (result.outcome === "elapsed" && result.endedAt < result.dueAt) {
        throw new Error("An elapsed wait ended before its requested due time.");
    }
}
