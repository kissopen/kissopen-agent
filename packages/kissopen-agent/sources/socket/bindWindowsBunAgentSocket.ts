import { randomBytes } from "node:crypto";
import type { PreparedKissopenAgentRuntime } from "@kissopen/kissopen-agent-modules";

import {
    bindNodeAgentHttpServer,
    prepareAgentSocketPath,
    type AgentDaemonPaths,
    type BoundAgentSocket,
} from "./AgentSocket.js";
import { startBunSocketBridge, type BunSocketBridge } from "./BunSocketBridge.js";
import { bunRuntime, startBunHttpServer, type BunWebSocketServer } from "./bindBunAgentSocket.js";
import { createBunHttpForwarder } from "./createBunHttpForwarder.js";
import { forwardBunAttachment } from "./forwardBunAttachment.js";

/** Windows AF_UNIX reparse points do not support the private socket chmod contract. */
export async function bindWindowsBunAgentSocket(
    prepared: PreparedKissopenAgentRuntime,
    paths: AgentDaemonPaths,
): Promise<BoundAgentSocket> {
    await prepareAgentSocketPath(paths.socketPath);
    const bun = bunRuntime();
    const http = await bindNodeAgentHttpServer(prepared, "127.0.0.1", 0);
    const forwarder = createBunHttpForwarder({ hostname: http.host, port: http.port });
    let nativeHttp: BunWebSocketServer | undefined;
    let bridge: BunSocketBridge | undefined;
    const close = async () => {
        bridge?.close();
        forwarder.close();
        try {
            await Promise.resolve(nativeHttp?.stop(true));
        } finally {
            await http.close();
        }
    };
    try {
        const proxyToken = randomBytes(32).toString("base64url");
        const proxyPort = await prepared.api.listenWorkspaceProxyTcp(proxyToken);
        nativeHttp = startBunHttpServer(
            bun,
            prepared,
            { hostname: "127.0.0.1", port: 0 },
            forwarder,
        );
        bridge = startBunSocketBridge(bun, {
            publicAddress: { unix: paths.socketPath },
            httpAddress: { hostname: "127.0.0.1", port: nativeHttp.port },
            proxyHttpAddress: { hostname: "127.0.0.1", port: proxyPort },
            proxyHttpAuthorization: `Bearer ${proxyToken}`,
            prepareWorkspaceProxy: (pathname, authorization) =>
                prepared.api.prepareWorkspaceProxySocket(
                    prepared.context("bun-http-connect"),
                    pathname,
                    authorization,
                ),
            forwardAuthenticatedAttachment: (head, stream, bytes) =>
                forwardBunAttachment(prepared, head, stream, bytes),
        });
    } catch (error) {
        await close().catch(() => undefined);
        throw error;
    }
    let closing: Promise<void> | undefined;
    return {
        socketPath: paths.socketPath,
        close: () => (closing ??= close()),
    };
}
