import { io } from "socket.io-client";

import type { KissopenSocket } from "./KissopenSessionClient.js";

/**
 * Opens the Socket.IO connection Kissopen speaks over.
 *
 * Kissopen's server is a Socket.IO server, so there is nothing to decide here and nothing for a caller
 * to supply: this module talks to Kissopen, and this is how Kissopen is talked to. A client takes a
 * factory only so a test can hand it a socket it can drive by hand.
 */
export function connectKissopenSocket(
    url: string,
    options: Record<string, unknown>,
): KissopenSocket {
    const socket = io(url, options);
    /*
     * Socket.IO spells the acknowledged send as `timeout(ms).emitWithAck()`.
     * Named plainly here so the client's own surface stays the narrow thing
     * a test can hand a stand-in for.
     */
    const bridged = socket as unknown as KissopenSocket;
    /*
     * Socket.IO's own send is taken off the socket before this name is given
     * its new meaning, because `timeout()` answers with the socket itself:
     * reading the send back off it afterwards would find this very function
     * and call it until the stack ran out. The timeout is a flag the next
     * send carries, so it is set on the socket and the captured send reads it.
     */
    const acknowledged = socket.emitWithAck.bind(socket);
    bridged.emitWithAck = async (event, payload, timeoutMs) => {
        socket.timeout(timeoutMs);
        return await acknowledged(event, payload);
    };
    return bridged;
}
