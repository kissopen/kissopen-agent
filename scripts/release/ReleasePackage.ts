export type ReleasePackageKey =
    | "kissopen-terminal"
    | "kissopen-agent-base"
    | "kissopen-agent-client"
    | "kissopen-agent-compute"
    | "kissopen-plugins"
    | "kissopen-providers";

export interface ReleasePackage {
    buildArguments: readonly string[];
    checkArguments: readonly string[];
    commitPrefix: string;
    directory: string;
    key: ReleasePackageKey;
    manifestPath: string;
    tagPrefix: string;
    testArguments: readonly (readonly string[])[];
}
