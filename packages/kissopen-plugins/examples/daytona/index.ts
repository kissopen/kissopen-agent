import { kissopen } from "kissopen-plugins";

import { createDaytonaComputeProvider } from "./daytonaCompute.ts";

const apiKey = process.env.DAYTONA_API_KEY;
const provider = createDaytonaComputeProvider(apiKey === undefined ? {} : { apiKey });
const registration = await kissopen.compute.register(provider.handlers, {
    provisioningTimeoutMs: 10 * 60_000,
});
await kissopen.ready(
    apiKey === undefined ? "Ready. Set DAYTONA_API_KEY before starting a sandbox." : "Ready.",
);

await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
});

await registration.close();
await provider.close();
