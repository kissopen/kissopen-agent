import { describe, expect, it, vi } from "vitest";

/*
 * Socket.IO as this factory meets it: `timeout()` records the deadline for the
 * next send and answers with the socket itself, and the acknowledged send is a
 * method on the class rather than a property of the instance. Both are what
 * make the bridge's name collide with the one it wraps, so a stand-in that got
 * either of them wrong would pass a bridge that cannot work.
 */
class FakeSocket {
    readonly sent: { event: string; payload: unknown; timeoutMs: number | undefined }[] = [];
    #timeoutMs: number | undefined;

    timeout(timeoutMs: number): this {
        this.#timeoutMs = timeoutMs;
        return this;
    }

    async emitWithAck(event: string, payload: unknown): Promise<unknown> {
        const timeoutMs = this.#timeoutMs;
        this.#timeoutMs = undefined;
        this.sent.push({ event, payload, timeoutMs });
        return { ok: true };
    }
}

const socket = new FakeSocket();
vi.mock("socket.io-client", () => ({ io: () => socket }));

const { connectKissopenSocket } = await import("../../sources/kissopen/connectKissopenSocket.js");

describe("the socket Kissopen is spoken to over", () => {
    /*
     * The bridge names the acknowledged send the way this client's own surface
     * spells it, which is the same name Socket.IO gives it. Wrapping a name
     * with itself is how a send becomes a recursion instead of a send.
     */
    it("sends through Socket.IO's own acknowledged send, not through itself", async () => {
        const bridged = connectKissopenSocket("https://kissopen.invalid", {});
        const answer = await bridged.emitWithAck?.("stream-data", { id: "stream-1" }, 30_000);
        expect(answer).toEqual({ ok: true });
        expect(socket.sent).toEqual([
            { event: "stream-data", payload: { id: "stream-1" }, timeoutMs: 30_000 },
        ]);
    });
});
