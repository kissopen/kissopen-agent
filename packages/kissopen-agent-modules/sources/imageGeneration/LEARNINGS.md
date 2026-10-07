# Image generation — learnings

## No Codex account means no tool

The image tool used to be offered to every model unconditionally, so an installation with only
non-Codex accounts (for example, Bedrock only) received a tool whose every call failed with "No
Codex account is configured". The tools hook now returns nothing when no enabled Codex account
exists, because a capability with nothing behind it should be absent rather than broken.

## Validation must use the runtime image pipeline

Generated and referenced images are validated and normalized through one bounded processor
contract. Node uses Sharp and the standalone executable uses `Bun.Image`; binary builds must not
embed or load Sharp. Header metadata alone is insufficient validation, so both paths force a full
decode before unmodified source bytes are accepted or a provider PNG is published.

## Virtual model routes are not direct image accounts

A smart provider may have Codex compatibility so its agents can share Codex model context, but it
is a model-session router rather than a `CodexProvider` with the image API. Image-account discovery
therefore excludes smart providers and counts only enabled concrete Codex accounts.

## The picture travels with the result, because the file is out of reach

A finished picture used to reach a person only as a path in the model's reply, which the phone
could not open: the generated-files folder is outside every workspace root, and the workspace
file routes refuse it. The clients drew a generic "Generate image" row and nothing else. The tool
result now carries an `image_generation` presentation with a small WebP preview inside it, so the
row shows the picture as soon as the call completes without a second request, and the same
presentation is what the halftone loading state hands off to. The preview is re-encoded smaller
when a busy picture overflows the byte budget rather than dropped; a coarse preview beats a row
that says nothing until the reader finds the file.

## The KISSOPEN account draws too, through the KISSOPEN server

Cloud workspaces (and any computer signed in with the account's own models) have one account,
`kissopen`: a `KissopenProvider`, which wraps a `CodexProvider` so it can swap Codex's encrypted
compaction for a portable checkpoint. It is not itself a `CodexProvider`, so the image tool was
offered (the account's type is codex) but every call answered "cannot generate images" — a cloud
agent could only fall back to drawing SVG. `KissopenProvider` now delegates `generateImage`, and
the provider check accepts it. The request goes to the account's base URL, `/api/agent/v1/images/generations`
on the KISSOPEN server, which draws with its configured image model, answers PNG and charges the
plan like a chat drawing. Editing from a reference (`/images/edits`) is refused there for now.

## A picture made in a project is kept with the project

Pictures went only to the shared generated-files folder, outside every workspace, and the tool
told the model not to mention the path. A picture asked for in a project was therefore missing
from that project's files on every device (it survived only inside the deck built from it). The
module now also writes it to `<working directory>/outputs/<prompt words>-<call id tail>.png`, the
project's deliverables folder, and the tool result names that copy so the model links it (angle
brackets, since names hold spaces and CJK punctuation). The copy is best-effort: a folder that
cannot be written leaves the generation and its reply unaffected.
