# kissopen-worklets

The typed SDK available inside worklet processes. It connects to the private per-worklet Kissopen Agent
socket, registers TypeBox-defined tools, reports readiness and status, and receives tool calls.

Kissopen Agent ships the matching built SDK with its worklet runtime. Worklet source imports
`kissopen-worklets`; individual worklets do not vendor or install this package.
