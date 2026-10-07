import { createGym, type GymInferenceResponse } from "@kissopen/kissopen-terminal-gym";
import { expect, it } from "vitest";

function call(index: number, name: string, args: Record<string, unknown>): GymInferenceResponse {
    return { content: [{ type: "toolCall", id: `goal-step-${index}`, name, arguments: args }] };
}

it("waits, continues, verifies the saved report and ends the goal through the real Terminal", async () => {
    let calls = 0;
    const gym = await createGym({
        mode: "docker",
        timeoutMs: 60_000,
        inference(request, index) {
            calls++;
            switch (index) {
                case 0:
                    return call(index, "create_goal", {
                        objective: "Save and verify a Chinese and English report",
                    });
                case 1:
                    return call(index, "update_goal_plan", {
                        revision: 1,
                        criteria: [
                            {
                                id: "report",
                                description:
                                    "Saved report contains Chinese and English versions and has been read back",
                            },
                        ],
                    });
                case 2:
                    return call(index, "exec_command", {
                        cmd: "printf '中文报告\\nEnglish report\\n' > report.txt",
                        yield_time_ms: 1000,
                    });
                case 3:
                    return call(index, "wait_for_goal", {
                        seconds: 1,
                        reason: "Wait before reading the report back",
                    });
                case 4:
                    return { content: [{ type: "text", text: "GOAL_WAITING_FOR_VERIFICATION" }] };
                case 5:
                    return call(index, "exec_command", {
                        cmd: "cat report.txt",
                        yield_time_ms: 1000,
                    });
                case 6:
                    expect(
                        JSON.stringify(
                            request.context.messages.findLast((message) => message.role === "tool"),
                        ),
                    ).toContain("中文报告");
                    expect(
                        JSON.stringify(
                            request.context.messages.findLast((message) => message.role === "tool"),
                        ),
                    ).toContain("English report");
                    return {
                        content: [
                            {
                                type: "text",
                                text: "GOAL_VERIFIED_REPORT: 中文报告 / English report. The saved file was read back.",
                            },
                        ],
                    };
                case 7:
                    return call(index, "read_agent_history", {
                        roles: ["assistant"],
                        from: "end",
                        limit: 10,
                        include_tools: false,
                    });
                case 8: {
                    const result = request.context.messages.findLast(
                        (message) => message.role === "tool",
                    );
                    if (result?.role !== "tool") throw new Error("Missing actual history result");
                    const block = result.content.find((item) => item.type === "text");
                    if (block?.type !== "text" || typeof block.text !== "string")
                        throw new Error("Missing rendered history");
                    const page = JSON.parse(block.text) as { history: string };
                    // A searching tool's own arguments can match its query. Select the
                    // delivered text from actual history, excluding tool summaries.
                    const delivered = page.history
                        .split(/(?=^\d+\. ASSISTANT)/m)
                        .find((entry) => entry.includes("GOAL_VERIFIED_REPORT:"));
                    const position = /^(\d+)\. ASSISTANT/m.exec(delivered ?? "");
                    if (position === null) throw new Error("Missing actual deliverable position");
                    return call(index, "update_goal_plan", {
                        revision: 2,
                        evidence: [
                            {
                                criterionId: "report",
                                historyPosition: Number(position[1]) - 1,
                                conclusion:
                                    "Actual file readback and the bilingual report were checked.",
                            },
                        ],
                    });
                }
                case 9:
                    expect(
                        JSON.stringify(
                            request.context.messages.findLast((message) => message.role === "tool"),
                        ),
                    ).toContain("Goal plan saved");
                    return call(index, "update_goal", { status: "complete", revision: 2 });
                case 10:
                    expect(
                        JSON.stringify(
                            request.context.messages.findLast((message) => message.role === "tool"),
                        ),
                    ).toContain("Goal status: complete");
                    return { content: [{ type: "text", text: "GOAL_AUTONOMY_COMPLETE" }] };
                case 11:
                    return call(index, "get_goal", {});
                case 12:
                    expect(
                        JSON.stringify(
                            request.context.messages.findLast((message) => message.role === "tool"),
                        ),
                    ).toContain("Goal status: complete");
                    return { content: [{ type: "text", text: "GOAL_FOLLOWUP_COMPLETE" }] };
                default:
                    throw new Error("A completed goal continued without another human request");
            }
        },
    });
    try {
        gym.terminal.type(
            "Save and verify a Chinese and English report, waiting briefly before verification.",
        );
        gym.terminal.press("enter");
        await gym.terminal.waitForText("GOAL_AUTONOMY_COMPLETE", 45_000);
        await gym.terminal.waitUntil(
            (screen) =>
                screen.text.includes("Worked for") && !screen.text.includes("esc to interrupt"),
            "the verified goal to settle",
            15_000,
        );
        expect(await gym.readFile("report.txt")).toBe("中文报告\nEnglish report\n");
        expect(calls).toBe(11);
        gym.terminal.type("Show the saved goal status.");
        gym.terminal.press("enter");
        const screen = await gym.terminal.waitForText("GOAL_FOLLOWUP_COMPLETE", 20_000);
        expect(screen.text).not.toContain("�");
        expect(calls).toBe(13);
        expect(gym.inference.handlerFailures).toEqual([]);
    } finally {
        await gym.dispose();
    }
}, 120_000);
