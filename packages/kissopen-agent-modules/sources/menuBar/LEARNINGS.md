# Menu bar learnings

## The menu bar is macOS only, and deliberately so

Linux has no dependable cross-desktop tray standard worth carrying, so the app is a Swift AppKit
executable and nothing is built for Linux. Do not add a cross-platform tray implementation or a
second rendering path to "finish" the feature.

## Only a released binary has a menu bar

The app used to start from any macOS build that had compiled it, which meant working on Kissopen
Agent, or running its tests, put a status item in the developer's menu bar and sometimes left one
behind. It now ships in the released Kissopen Agent binary alone: the binary build replaces
`resolveMenuBarApp` with a resolver for its embedded copy, and the source version returns nothing
at all. Do not restore the `dist/menuBar/bin` lookup to make a development daemon show the menu
bar; build the binary and run that instead.

## It is on by default, and turned off in configuration

Within a release the module starts the app whenever the daemon runs on macOS. There is no opt-in
flag; `menu_bar = false` under `[settings]` is the way off. The app itself decides whether a machine
actually has a menu bar, by checking for a login session, and exits cleanly when there is none — a
daemon started over SSH must not look like a failure.

Team mode is the deployment exception. It has no private local API socket or token, so it never
starts the socket-dependent menu bar app even when `menu_bar` retains its standalone default.

## The app never outlives its daemon

A daemon that is killed outright never runs its shutdown handlers, so the app has to notice on its
own. It watches two things, and either is enough: end of file on the standard input the daemon holds
open, and the exit of the parent process itself through a dispatch process source. Standard input
alone was the original mechanism and is not sufficient, because anything else holding that pipe open
keeps the app alive after the daemon is gone.

## The status item shows no count; the footer opens Desktop or closes the menu bar

The bar carries the glyph alone: no number, no badge. Below the token totals, Open KissOpen opens
or activates the installed open-source Desktop app by its bundle identifier. Quit Menu Bar closes
this status item alone, leaving Agent sessions and scheduled work running. It exits cleanly, so
the existing supervisor does not restart it during this daemon's lifetime. A later daemon start
shows the item again. There is no version line or ready/draining state in the menu.

## What the menu shows

Working agents grouped by project, provider plan usage, and rolling token totals. Idle agents are
not listed at all, not even collapsed into a count.

## Plan usage shows the session and the week

The menu used to pick the single window closest to running out. That hid the week whenever the
session was the tighter limit, which is the usual case. Every provider uses the same pair: the
five-hour session and the week, each on its own line so the reset time is not cut off. Claude
also shows Fable's separate weekly allowance as a third row when Anthropic reports it. A monthly
window is shown only when there is no session window, so a Grok-style week-and-month pair still
has both numbers. Extra vendor meters such as Codex Spark are not shown.

Reset always includes a clock time. A weekday or date is added only when the reset is not today.
When the window ends in less than three hours, remaining time is added too, such as
"4:34 PM · in 2h 14m".

## The glyph is the KissOpen mark, drawn at full strength

The icon uses the canonical KissOpen mark, matching the Desktop menu bar templates. It replaces
the inherited five-pointed star so the Agent is recognizable as KissOpen. Keep the canonical two
contours, rounded joins, and proportions; do not invent a separate Agent logo. The mark stays
still when nothing is running and turns slowly while agents work. Its canvas leaves room for
every rotation so activity never clips the mark or changes the status item's width.

Draw the template image with solid black and no alpha. An earlier version dimmed the resting glyph
to 55% alpha, which made it visibly washed out beside every other menu bar icon — macOS already
tints and inverts a template image, so anything less than full strength is wrong.

## Provider names are the person's, not the config's

A provider ID is whatever someone called their account, so `bulka_kissopen_codex` is shown as
"Bulka Kissopen Codex". Never render a raw ID.

## The app is a reader

It speaks the ordinary HTTP API over the daemon's private socket with the same bearer token as any
other client. It performs no daemon mutation. Opening Desktop and closing the menu bar are local
application actions. The event stream is a change signal only: every snapshot the menu draws is
re-read, so an unfamiliar or missed event cannot leave stale state on screen.

## Supervision waits for exit, not for the streams to close

`close` on a child process waits for its stdio to close, which anything the app leaves behind can
hold open indefinitely. Supervision therefore ends a run on `exit` and gives the error pipe only a
brief moment to drain. A test covering an app that leaves a grandchild behind catches a regression
here.
