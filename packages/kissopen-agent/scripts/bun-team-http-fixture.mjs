import { startKissopenAgentDaemon } from "../dist/index.js";

/** Test-owned WorkOS public key; signature and claim verification remain real. */
async function main() {
    const jwks = JSON.parse(process.env.KISSOPEN_SMOKE_JWKS);
    const jwksUrl = "https://api.workos.com/sso/jwks/client_01TESTPRODUCTION";
    globalThis.fetch = async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url === jwksUrl) return Response.json(jwks);
        throw new Error("The HTTP smoke fixture does not permit external network requests.");
    };
    const daemon = await startKissopenAgentDaemon({ kissopenHome: process.env.KISSOPEN_HOME_DIR });
    process.on("SIGTERM", () => {
        void daemon.close().then(
            () => process.exit(0),
            () => process.exit(1),
        );
    });
    process.stdout.write(`READY ${daemon.httpUrl}\n`);
}

void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
