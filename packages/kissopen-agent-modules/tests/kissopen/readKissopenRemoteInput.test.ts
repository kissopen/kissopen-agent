import { describe, expect, it } from "vitest";

import { readKissopenRemoteInput } from "../../sources/kissopen/index.js";

describe("reading a message from KISSOPEN", () => {
    it("retains ordered rich input without treating the fallback text as a second message", () => {
        const content = [
            { type: "text", text: "Inspect" },
            { type: "tool_call_request", name: "list_skills" },
        ];
        for (const value of [
            { role: "user", content: { type: "text", text: "Inspect", content } },
            {
                role: "session",
                content: { role: "user", ev: { t: "text", text: "Inspect", content } },
            },
        ])
            expect(readKissopenRemoteInput(value)).toEqual({
                kind: "text",
                selection: {},
                text: "Inspect",
                content,
            });
    });

    it("refuses malformed or repeated rich tool requests instead of downgrading to prose", () => {
        const request = { type: "tool_call_request", name: "list_skills" };
        for (const content of [[request, request], [{ ...request, arguments: [] }]]) {
            expect(
                readKissopenRemoteInput({
                    role: "user",
                    content: { type: "text", text: "Inspect", content },
                }),
            ).toBeUndefined();
        }
    });

    it("reads the plain shape the phone sends", () => {
        expect(
            readKissopenRemoteInput({ content: { text: "hello", type: "text" }, role: "user" }),
        ).toEqual({ kind: "text", selection: {}, text: "hello" });
    });

    it("reads a message wrapped in a session envelope", () => {
        expect(
            readKissopenRemoteInput({
                content: {
                    data: { ev: { t: "text", text: "wrapped" }, role: "user" },
                    type: "session",
                },
                role: "session",
            }),
        ).toEqual({ kind: "text", selection: {}, text: "wrapped" });
    });

    it("reads an envelope that was never wrapped", () => {
        expect(
            readKissopenRemoteInput({
                content: { ev: { t: "text", text: "bare" }, role: "user" },
                role: "session",
            }),
        ).toEqual({ kind: "text", selection: {}, text: "bare" });
    });

    it("recognizes KISSOPEN Agent's own message coming back around", () => {
        expect(
            readKissopenRemoteInput({
                content: { text: "mine", type: "text" },
                meta: { sentFrom: "rig" },
                role: "user",
            }),
        ).toEqual({ kind: "echo" });
    });

    it("reads an attachment", () => {
        expect(
            readKissopenRemoteInput({
                content: {
                    data: {
                        ev: {
                            mimeType: "image/png",
                            name: "screenshot.png",
                            ref: "blob-1",
                            size: 2048,
                            t: "file",
                        },
                        role: "user",
                    },
                    type: "session",
                },
                role: "session",
            }),
        ).toEqual({
            kind: "attachment",
            mimeType: "image/png",
            name: "screenshot.png",
            ref: "blob-1",
            size: 2048,
        });
    });

    it("takes what the person chose alongside what they said", () => {
        expect(
            readKissopenRemoteInput({
                content: { text: "go", type: "text" },
                meta: {
                    model: "gpt-5.6-sol",
                    modelProviderId: "codex",
                    permissionMode: "read_only",
                    thinkingLevel: "high",
                },
                role: "user",
            }),
        ).toEqual({
            kind: "text",
            selection: {
                effort: "high",
                modelId: "gpt-5.6-sol",
                permissionMode: "read_only",
                providerId: "codex",
            },
            text: "go",
        });
    });

    it("prefers the reasoning level under whichever name it arrived", () => {
        const reasoning = readKissopenRemoteInput({
            content: { text: "go", type: "text" },
            meta: { reasoning: "low" },
            role: "user",
        });
        expect(reasoning).toEqual({ kind: "text", selection: { effort: "low" }, text: "go" });
    });

    it("takes the envelope's own choices over the outer ones", () => {
        expect(
            readKissopenRemoteInput({
                content: {
                    data: {
                        ev: { t: "text", text: "inner" },
                        meta: { model: "inner-model" },
                        role: "user",
                    },
                    type: "session",
                },
                meta: { model: "outer-model" },
                role: "session",
            }),
        ).toEqual({
            kind: "text",
            selection: { modelId: "inner-model" },
            text: "inner",
        });
    });

    it("says nothing rather than guess at a message it does not know", () => {
        expect(readKissopenRemoteInput(undefined)).toBeUndefined();
        expect(readKissopenRemoteInput("hello")).toBeUndefined();
        expect(readKissopenRemoteInput({ role: "agent" })).toBeUndefined();
        expect(
            readKissopenRemoteInput({
                content: { data: { ev: { t: "sidechain" }, role: "user" }, type: "session" },
                role: "session",
            }),
        ).toBeUndefined();
    });

    it("ignores an envelope that is not from the person", () => {
        expect(
            readKissopenRemoteInput({
                content: {
                    data: { ev: { t: "text", text: "agent talking" }, role: "agent" },
                    type: "session",
                },
                role: "session",
            }),
        ).toBeUndefined();
    });
});
