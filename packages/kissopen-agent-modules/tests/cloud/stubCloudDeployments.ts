import { beforeEach, vi } from "vitest";

/** Configure both Cloud deployments with placeholder origins and WorkOS clients before each test. */
export function stubCloudDeployments(): void {
    beforeEach(() => {
        vi.stubEnv("KISSOPEN_CLOUD_URL", "https://cloud.example.test");
        vi.stubEnv("KISSOPEN_CLOUD_WORKOS_CLIENT_ID", "client_01TESTPRODUCTION");
        vi.stubEnv("KISSOPEN_CLOUD_STAGING_URL", "https://cloud-staging.example.test");
        vi.stubEnv("KISSOPEN_CLOUD_STAGING_WORKOS_CLIENT_ID", "client_01TESTSTAGING");
    });
}
