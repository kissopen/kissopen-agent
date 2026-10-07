/*
A relay stream, as a Node duplex the terminals module can attach to.

The daemon's attach protocol wants a duplex of bytes and solves everything
else on it — ordering, resize barriers, replay, backpressure. So the job here
is only to be that duplex honestly: what the far end wrote comes out as reads,
what the terminal writes goes out as chunks, and the relay's acknowledgement
of each chunk is what tells the terminal to slow down.

Nothing here knows what the bytes mean, and it must not: the moment this
started interpreting them there would be two tellings of the attach protocol
to keep in step.
*/
import { Duplex } from "node:stream";

/** How this duplex reaches the relay. Supplied by whoever holds the socket. */
export interface KissopenStreamChannel {
    /**
     * Sends one chunk, resolving once the far end has taken it.
     *
     * The wait is the backpressure: a reader that has stopped reading stops
     * the terminal writing into this process rather than filling it with what
     * nobody is taking.
     */
    write: (chunk: Uint8Array) => Promise<void>;
    /** Says this end is finished, so the far end can stop waiting. */
    close: (error?: string) => void;
}

/**
 * The duplex end of one relay stream.
 *
 * `deliver` is how the socket hands inbound chunks in, and `end` how it
 * reports that the stream closed; both are called from outside, because the
 * socket owns the events and this owns only the stream.
 */
export class KissopenTerminalStream extends Duplex {
    readonly #channel: KissopenStreamChannel;
    /** True once the far end is gone, so nothing more is sent to it. */
    #finished = false;

    constructor(channel: KissopenStreamChannel) {
        // Object mode off: this carries bytes, which is what the attach
        // protocol frames. Reading in bytes keeps its framing its own.
        super({ allowHalfOpen: false, objectMode: false });
        this.#channel = channel;
    }

    /** One chunk from the far end, for whoever is reading this duplex. */
    deliver(chunk: Uint8Array): void {
        if (this.#finished || this.destroyed) return;
        this.push(Buffer.from(chunk));
    }

    /**
     * The far end went away.
     *
     * Ends the readable side rather than destroying outright when no reason
     * was given: bytes already pushed are still worth reading, and the attach
     * protocol's own final frames are among them. A reason means something
     * broke, and then there is nothing left worth reading.
     *
     * Deliberately not called `end`: that is Duplex's own, and means the
     * writable side is finished — a different thing from the peer leaving.
     */
    finish(error?: string): void {
        if (this.#finished) return;
        this.#finished = true;
        if (error !== undefined) this.destroy(new Error(error));
        else this.push(null);
    }

    override _read(): void {
        // Pushed as it arrives; there is nothing to pull from.
    }

    override _write(
        chunk: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
    ): void {
        if (this.#finished) {
            callback(new Error("The terminal stream is closed."));
            return;
        }
        this.#channel.write(new Uint8Array(chunk)).then(
            () => callback(),
            (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
        );
    }

    override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
        if (!this.#finished) {
            this.#finished = true;
            this.#channel.close(error ? error.message : undefined);
        }
        callback(error);
    }
}
