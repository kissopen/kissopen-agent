import { KISSOPEN_COMPUTE_DEFAULT_PROVISIONING_TIMEOUT_MS, kissopen } from "kissopen-plugins";

import { createLocalBashComputeProvider } from "./localBashCompute.ts";

const provider = createLocalBashComputeProvider();
const registration = await kissopen.compute.register(provider.handlers, {
    provisioningTimeoutMs: KISSOPEN_COMPUTE_DEFAULT_PROVISIONING_TIMEOUT_MS,
});
await kissopen.ready("Ready.");

await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
});

await registration.close();
await provider.close();
