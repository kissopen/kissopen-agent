import { createServer, request } from "node:http";
import { connect, type Socket } from "node:net";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { bindBunAgentSocket } from "../sources/socket/bindBunAgentSocket.ts";
import { checkBinaryKeepAlive } from "./check-binary-keepalive.mjs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { localAgentSocketPath } from "@kissopen/kissopen-agent-compute";

const modulesRequire = createRequire(
    new URL("../../kissopen-agent-modules/package.json", import.meta.url),
);
// Bun's built-in ws shim ignores custom named-pipe connections; exercise the installed Node client.
const WebSocket = modulesRequire(
    join(dirname(modulesRequire.resolve("ws/package.json")), "lib/websocket.js"),
);
if (process.platform !== "win32") throw new Error("This transport check requires Windows.");
const token = "windows-transport-verifier";
const home = await mkdtemp(join(tmpdir(), "kissopen-socket-proof-"));
await writeFile(`${home}/unrelated.txt`, "PRESERVE");
// Old AF_UNIX files must not participate in Windows startup or be replaced.
for (const name of ["h", "p", "w"]) await writeFile(join(home, `${name}.sock`), "PRESERVE");

function get(socketPath: string) {
    return new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
        const req = request(
            { socketPath, path: "/v0/health", headers: { authorization: `Bearer ${token}` } },
            (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (b) => chunks.push(b));
                res.on("error", reject);
                res.on("end", () =>
                    resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }),
                );
            },
        );
        req.on("error", reject);
        req.setTimeout(10000, () => req.destroy(Error("request timeout")));
        req.end();
    });
}

async function checkWebSocket(socketPath: string, credential: string, expectedStatus: number) {
    const socket = new WebSocket("ws://localhost/v0/workspaces/project/terminals/terminal/attach", {
        createConnection: () => connect(socketPath),
        headers: { authorization: `Bearer ${credential}` },
        handshakeTimeout: 5000,
        perMessageDeflate: false,
    });
    const payload = Buffer.from([0, 255, 1, 128, 13, 10, 42]);
    try {
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(Error("WebSocket echo timed out")), 5000);
            const finish = (error?: unknown) => {
                clearTimeout(timer);
                error ? reject(error) : resolve();
            };
            socket.on("error", finish);
            socket.once("unexpected-response", (_request: unknown, response: any) => {
                response.resume();
                try {
                    assert.equal(response.statusCode, expectedStatus);
                    finish();
                } catch (error) {
                    finish(error);
                }
            });
            socket.once("open", () => {
                try {
                    assert.equal(expectedStatus, 101);
                    socket.send(payload);
                } catch (error) {
                    finish(error);
                }
            });
            socket.once("message", (data: Buffer, binary: boolean) => {
                try {
                    assert.equal(binary, true);
                    assert.deepEqual(Buffer.from(data), payload);
                    finish();
                } catch (error) {
                    finish(error);
                }
            });
        });
    } finally {
        socket.terminate();
    }
}

function openTunnel(socketPath: string, credential: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const socket = connect(socketPath);
        let received = Buffer.alloc(0);
        const timer = setTimeout(() => finish(Error("CONNECT timed out")), 5000);
        const finish = (error?: Error, head?: Buffer) => {
            clearTimeout(timer);
            socket.off("data", data);
            socket.off("error", finish);
            if (error) {
                socket.destroy();
                reject(error);
            } else {
                if (head?.length) socket.unshift(head);
                resolve(socket);
            }
        };
        const data = (chunk: Buffer) => {
            received = Buffer.concat([received, chunk]);
            const end = received.indexOf("\r\n\r\n");
            if (end < 0) return;
            const status = /^HTTP\/1\.1 (\d+)/.exec(received.toString())?.[1];
            finish(
                status === "200" ? undefined : Error(`CONNECT returned ${status}`),
                received.subarray(end + 4),
            );
        };
        socket.on("data", data);
        socket.once("error", finish);
        socket.once("connect", () =>
            socket.write(
                `CONNECT /v0/workspaces/project/proxy HTTP/1.1\r\nHost: kissopen-agent\r\nAuthorization: Bearer ${credential}\r\n\r\n`,
            ),
        );
    });
}

function exchange(socket: Socket, bytes: string, expected: string): Promise<void> {
    return new Promise((resolve, reject) => {
        let received = "";
        const timer = setTimeout(() => finish(Error(`Tunnel response timed out: ${received}`)), 5000);
        const finish = (error?: Error) => {
            clearTimeout(timer);
            socket.off("data", data);
            socket.off("error", finish);
            error ? reject(error) : resolve();
        };
        const data = (chunk: Buffer) => {
            received += chunk.toString();
            if (received.includes(expected)) finish();
            else if (received.length > 65536) finish(Error("Unexpected tunnel response"));
        };
        socket.on("data", data);
        socket.once("error", finish);
        socket.write(bytes);
    });
}

for (let round = 0; round < 2; round++) {
    let privateProxyToken: string | undefined;
    let privateProxyPort: number | undefined;
    const admittedProxyConnections = new WeakSet<Socket>();
    const proxy = createServer((req, res) => {
        if (!admittedProxyConnections.has(req.socket) &&
            req.headers["proxy-authorization"] !== `Bearer ${privateProxyToken}`) {
            res.statusCode = 407;
            res.end("UNAUTHORIZED");
        } else {
            admittedProxyConnections.add(req.socket);
            res.end("PROXY_OK");
        }
    });
    const target = createServer((_req, res) => res.end("TCP_OK"));
    await new Promise<void>((resolve, reject) => {
        target.once("error", reject);
        target.listen(0, "127.0.0.1", resolve);
    });
    const targetAddress = target.address();
    assert.ok(targetAddress && typeof targetAddress !== "string");
    const prepared = {
        context: () => ({}),
        api: {
            handleRequest: async (_ctx: unknown, req: any, res: any) => {
                if (req.headers.authorization !== `Bearer ${token}`) {
                    res.statusCode = 401;
                    res.end("UNAUTHORIZED");
                } else if (req.url === "/v0/health") res.end("HTTP_OK");
                else {
                    res.statusCode = req.url === "/v0/cloud/auth/start" ? 400 : 404;
                    res.end("NOT_FOUND");
                }
            },
            handleUpgrade: async () => false,
            handleConnect: async () => false,
            listenWorkspaceProxyTcp: async (credential: string) => {
                privateProxyToken = credential;
                await new Promise<void>((resolve, reject) => {
                    proxy.once("error", reject);
                    proxy.listen(0, "127.0.0.1", resolve);
                });
                const address = proxy.address();
                assert.ok(address && typeof address !== "string");
                privateProxyPort = address.port;
                return address.port;
            },
            prepareWorkspaceProxySocket: async (
                _ctx: unknown,
                _path: string,
                authorization: string,
            ) =>
                authorization === `Bearer ${token}`
                    ? { handled: true }
                    : {
                          handled: true,
                          rejection: { status: 401, code: "unauthorized", message: "Unauthorized" },
                      },
            prepareTerminalSocket: async (_ctx: unknown, _path: string, authorization: string) => {
                await new Promise((resolve) => setImmediate(resolve));
                return authorization === `Bearer ${token}`
                    ? { handled: true, attach: (stream: any) => stream.pipe(stream) }
                    : {
                          handled: true,
                          rejection: { status: 401, code: "unauthorized", message: "Unauthorized" },
                      };
            },
        },
    };
    const socketPath = localAgentSocketPath(home);
    let bound;
    try {
        bound = await bindBunAgentSocket(prepared as any, {
            agentHome: home,
            socketPath,
            tokenPath: `${home}/token`,
        });
        assert.equal((await get(socketPath)).body, "HTTP_OK");
        assert.equal((await fetch(`http://127.0.0.1:${privateProxyPort}`)).status, 407);
        await checkBinaryKeepAlive(socketPath, token);
        await checkWebSocket(socketPath, "invalid", 401);
        await checkWebSocket(socketPath, token, 101);
        await checkWebSocket(socketPath, token, 101);
        await assert.rejects(openTunnel(socketPath, "invalid"), /401/);
        for (const nested of [false, true]) {
            const tunnel = await openTunnel(socketPath, token);
            try {
                if (nested)
                    await exchange(
                        tunnel,
                        `CONNECT 127.0.0.1:${targetAddress.port} HTTP/1.1\r\nHost: 127.0.0.1:${targetAddress.port}\r\n\r\n`,
                        "HTTP/1.1 200 Connection Established\r\n\r\n",
                    );
                for (let requestIndex = 0; requestIndex < 2; requestIndex++) {
                    await exchange(
                        tunnel,
                        `GET ${nested ? "/" : "http://example.test/"} HTTP/1.1\r\nHost: example.test\r\nConnection: keep-alive\r\n\r\n`,
                        nested ? "TCP_OK" : "PROXY_OK",
                    );
                }
            } finally {
                tunnel.destroy();
            }
        }
        console.log(
            `PASS round ${round + 1}: public named-pipe HTTP keep-alive, guarded internal loopback proxy, authenticated binary WebSocket/reconnect, CONNECT/inner HTTP keep-alive/nested TCP`,
        );
    } finally {
        await bound?.close();
        proxy.closeAllConnections();
        target.closeAllConnections();
        await Promise.all(
            [proxy, target].map(
                (server) => new Promise<void>((resolve) => server.close(() => resolve())),
            ),
        );
    }
}
assert.equal(await readFile(`${home}/unrelated.txt`, "utf8"), "PRESERVE");
for (const name of ["h", "p", "w"]) assert.equal(await readFile(join(home, `${name}.sock`), "utf8"), "PRESERVE");
console.log("PASS restart with legacy socket paths and unrelated file preserved");
process.exit(0);
