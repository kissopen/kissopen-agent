import { readPackageManifest } from "./release/readPackageManifest.js";
import { assertReleaseBumpAllowed } from "./release/assertReleaseBumpAllowed.js";
import { assertRegistryLatestMatchesManifest } from "./release/assertRegistryLatestMatchesManifest.js";
import { resolveReleasePackage } from "./release/resolveReleasePackage.js";
import { runCommand } from "./release/runCommand.js";
import { validateRelease } from "./release/validateRelease.js";
import { resolveReleaseVersionArguments } from "./release/resolveReleaseVersionArguments.js";

const VERSION_BUMPS = new Set([
    "major",
    "minor",
    "patch",
    "premajor",
    "preminor",
    "prepatch",
    "prerelease",
]);
const SEMANTIC_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const USAGE = `Usage:
  pnpm release kissopen-agent-base <version>
  pnpm release kissopen-agent-client <version>
  pnpm release kissopen-agent-compute <version>
  pnpm release kissopen-plugins <version>
  pnpm release kissopen-providers <version>

Examples:
  pnpm release kissopen-agent-base patch
  pnpm release kissopen-agent-client patch
  pnpm release kissopen-agent-compute patch
  pnpm release kissopen-plugins patch
  pnpm release kissopen-providers patch

KISSOPEN Terminal releases use the Release KISSOPEN Terminal GitHub Actions workflow, which requires
an explicit version and Markdown release notes.`;

async function release(): Promise<void> {
    const arguments_ = process.argv.slice(2);
    if (arguments_.length === 1 && (arguments_[0] === "--help" || arguments_[0] === "-h")) {
        console.log(USAGE);
        return;
    }
    const explicitPackage =
        arguments_[0] === "kissopen-terminal" ||
        arguments_[0] === "kissopen-agent-base" ||
        arguments_[0] === "kissopen-agent-client" ||
        arguments_[0] === "kissopen-agent-compute" ||
        arguments_[0] === "kissopen-plugins" ||
        arguments_[0] === "kissopen-providers";
    const releasePackage = resolveReleasePackage(explicitPackage ? arguments_.shift() : undefined);
    if (releasePackage.key === "kissopen-terminal") {
        throw new Error(
            "KISSOPEN Terminal releases must use the Release KISSOPEN Terminal GitHub Actions workflow.",
        );
    }
    const releaseInput = arguments_[0];
    if (
        releaseInput === undefined ||
        arguments_.length !== 1 ||
        (releaseInput !== "beta" &&
            !VERSION_BUMPS.has(releaseInput) &&
            !SEMANTIC_VERSION.test(releaseInput))
    ) {
        throw new Error(USAGE);
    }

    const initialManifest = readPackageManifest(releasePackage);
    const versionArguments = resolveReleaseVersionArguments(initialManifest.version, releaseInput);
    if (versionArguments.beta) {
        throw new Error("Beta releases are only available for @kissopen/kissopen-terminal.");
    }
    assertReleaseBumpAllowed({ currentVersion: initialManifest.version, requested: releaseInput });

    const worktreeStatus = runCommand("git", ["status", "--porcelain"], {
        captureOutput: true,
    }).stdout;
    if (worktreeStatus.length > 0) {
        throw new Error("The working tree must be clean before creating a release.");
    }

    const tagsAtHead = runCommand("git", ["tag", "--points-at", "HEAD"], {
        captureOutput: true,
    }).stdout.split("\n");
    const releaseTag = `${releasePackage.tagPrefix}${initialManifest.version}`;
    const retryingRelease =
        releaseInput === initialManifest.version && tagsAtHead.includes(releaseTag);
    if (releaseInput === initialManifest.version && !retryingRelease) {
        throw new Error(
            `${initialManifest.name} is already version ${initialManifest.version}. Choose a newer version or a version bump.`,
        );
    }

    console.log("Checking the latest main branch...");
    runCommand("git", ["fetch", "origin", "main"]);
    const head = runCommand("git", ["rev-parse", "HEAD"], { captureOutput: true }).stdout;
    const originMain = runCommand("git", ["rev-parse", "origin/main"], {
        captureOutput: true,
    }).stdout;
    if (head !== originMain) {
        const originIsAncestor =
            runCommand("git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"], {
                allowFailure: true,
                captureOutput: true,
            }).status === 0;
        const commitsAhead = Number(
            runCommand("git", ["rev-list", "--count", "origin/main..HEAD"], {
                captureOutput: true,
            }).stdout,
        );
        if (!retryingRelease || !originIsAncestor || commitsAhead !== 1) {
            throw new Error(
                "HEAD must match origin/main. Update the worktree before creating a release.",
            );
        }
        console.log(`Resuming the local ${releaseTag} release commit.`);
    }
    if (
        (releasePackage.key === "kissopen-agent-base" ||
            releasePackage.key === "kissopen-agent-client" ||
            releasePackage.key === "kissopen-providers") &&
        !retryingRelease
    ) {
        const initialRelease =
            releasePackage.key === "kissopen-providers" && initialManifest.version === "0.0.0";
        if (initialRelease) {
            console.log(`Preparing the first published ${releasePackage.key} version.`);
        } else {
            console.log(`Checking the published ${releasePackage.key} version...`);
            const latest = runCommand(
                "pnpm",
                ["view", initialManifest.name, "dist-tags.latest", "--json"],
                { captureOutput: true },
            ).stdout;
            const isTaggedUnpublishedVersion = (version: string): boolean => {
                const tag = `${releasePackage.tagPrefix}${version}`;
                const tagExists =
                    runCommand("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], {
                        allowFailure: true,
                        captureOutput: true,
                    }).status === 0;
                return (
                    tagExists &&
                    runCommand("git", ["merge-base", "--is-ancestor", tag, "HEAD"], {
                        allowFailure: true,
                        captureOutput: true,
                    }).status === 0
                );
            };
            assertRegistryLatestMatchesManifest(initialManifest, latest, {
                isTaggedUnpublishedVersion,
            });
            if (JSON.parse(latest) !== initialManifest.version) {
                console.log(
                    `Recovering after tagged releases through ${releaseTag} were not published.`,
                );
            }
        }
    }

    console.log("Validating the release...");
    validateRelease(releasePackage, { tests: !versionArguments.beta });

    if (!retryingRelease) {
        console.log(`Creating the ${releaseInput} release commit and tag...`);
        runCommand("pnpm", ["version", ...versionArguments.arguments], {
            cwd: releasePackage.directory,
        });
        const versionedManifest = readPackageManifest(releasePackage);
        runCommand("git", ["add", releasePackage.manifestPath, "pnpm-lock.yaml"]);
        runCommand("git", [
            "commit",
            "-m",
            `${releasePackage.commitPrefix}${versionedManifest.version}`,
        ]);
        runCommand("git", ["tag", `${releasePackage.tagPrefix}${versionedManifest.version}`]);
    }

    const releaseManifest = readPackageManifest(releasePackage);
    console.log(`Previewing ${releaseManifest.name}@${releaseManifest.version}...`);
    runCommand(
        "pnpm",
        [
            "publish",
            "--access",
            "public",
            "--dry-run",
            "--no-git-checks",
            ...(versionArguments.beta ? ["--tag", "beta"] : []),
        ],
        { cwd: releasePackage.directory },
    );

    console.log("Pushing the release commit and tag...");
    const tag = `${releasePackage.tagPrefix}${releaseManifest.version}`;
    runCommand("git", ["push", "origin", "HEAD:main", tag, "--atomic"]);
    console.log(
        `Pushed ${tag}. GitHub Actions will publish ${releaseManifest.name}@${releaseManifest.version}.`,
    );
}

try {
    await release();
} catch (error) {
    console.error(error instanceof Error ? error.message : "The release failed unexpectedly.");
    process.exitCode = 1;
}
