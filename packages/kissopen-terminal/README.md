# Kissopen Terminal

Kissopen Terminal is the terminal interface for Kissopen Agent. The published `@kissopen/kissopen-terminal`
package can be installed as a command, embedded directly in another Node.js application, used by
the `kissopen` CLI, or hosted by Kissopen Desktop.

## Command line

Install Node.js 24 or newer, then install the terminal client:

```sh
pnpm add --global @kissopen/kissopen-terminal
kissopen
```

The separate Kissopen CLI also integrates Kissopen Terminal and exposes it through `kissopen`.

Released installations check for a newer Kissopen Agent in the background. When one is available,
the terminal shows the host command to run, such as `kissopen upgrade` or
`kissopen upgrade`. The standalone command downloads and verifies the newest Agent release,
selects it, and gracefully reloads the daemon onto it. A locally linked `0.0.0` Agent is offered
that same update; running it replaces the local Agent with the published release.

## Embed in a Node.js application

```ts
import { runKissopenTerminal, upgradeKissopenAgent } from "@kissopen/kissopen-terminal";

if (process.argv[2] === "upgrade") {
    await upgradeKissopenAgent();
} else {
    await runKissopenTerminal({
        commandName: "my-command",
        cwd: process.cwd(),
    });
}
```

`runKissopenTerminal()` uses the current process's stdin and stdout, takes over the terminal until the
person exits, restores terminal modes, and then resolves. It does not install the CLI's fatal-error
handlers and does not exit the host process. Startup failures reject the returned promise. A host
can observe non-fatal background failures with `onError`:

```ts
await runKissopenTerminal({
    cwd: "/path/to/project",
    onError: (error) => applicationLogger.error(error),
});
```

Embedded sessions use `kissopen` in resume instructions by default. A different host command can be
provided with `commandName`. An embedded host may also provide `version` to replace the installed
Kissopen Terminal package version in the startup UI.

Run only one inline terminal at a time because each instance owns the process terminal while it is
active. Kissopen Terminal requires Node.js 24 or newer.

The embedding options type is exported as `RunKissopenTerminalOptions`. Kissopen Agent API types belong
to `@kissopen/kissopen-agent-client`; embedding the TUI does not create a second API contract. The
package version helper is available from `@kissopen/kissopen-terminal/package-version`. Embedding hosts
that provide a custom `commandName` should route that command's `upgrade` entry point through
`upgradeKissopenAgent()` so the suggestion shown by the terminal is actionable.

## Kissopen Agent daemon

Kissopen Terminal connects to an already-running Kissopen Agent daemon first. Otherwise it starts the
selected binary recorded under `~/.kissopen/dist/config.json`. A published installation downloads the
latest matching macOS, Linux, or Windows x64 release from
[`kissopen/kissopen-agent`](https://github.com/kissopen/kissopen-agent/releases) once when nothing is
selected yet. Downloads are checked against the release asset's SHA-256 digest before installation.
