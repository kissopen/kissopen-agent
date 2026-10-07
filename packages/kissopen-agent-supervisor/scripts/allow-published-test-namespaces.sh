#!/usr/bin/env bash
# Disposable hosted CI only. Allow the exact installed artifact, never all user namespaces.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]]
[[ "$(uname -s)" == Linux ]]
[[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" == 1 ]]
service_test_binary="$(pnpm --filter @kissopen/kissopen-agent-compute exec node --input-type=module -e '
import { realpathSync } from "node:fs";
import { resolveSupervisorBinary } from "@kissopen/kissopen-agent-supervisor";
console.log(realpathSync(resolveSupervisorBinary()));
')"
[[ "$service_test_binary" == "$GITHUB_WORKSPACE"/node_modules/*/kissopen-agent-supervisor ]]
[[ "$service_test_binary" != *'"'* && "$service_test_binary" != *$'\n'* ]]
[[ -x "$service_test_binary" ]]
sudo tee /etc/apparmor.d/kissopen-compute-services-tests >/dev/null <<EOF
abi <abi/4.0>,
include <tunables/global>
profile kissopen-compute-services-tests "$service_test_binary" flags=(unconfined) {
    userns,
}
EOF
sudo apparmor_parser --replace /etc/apparmor.d/kissopen-compute-services-tests