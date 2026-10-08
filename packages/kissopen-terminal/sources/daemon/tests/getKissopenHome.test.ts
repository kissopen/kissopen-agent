import { describe, expect, it } from "vitest";
import { getKissopenHome } from "../getKissopenHome.js";

describe("the shared open-source Agent home", () => {
    it("matches packaged Windows Desktop, including a redirected AppData directory", () => {
        expect(getKissopenHome({ APPDATA: "D:\\Roaming" }, "C:\\Users\\person", "win32")).toBe(
            "D:\\Roaming\\kissopen-oss\\runtime\\.kissopen",
        );
        expect(getKissopenHome({}, "C:\\Users\\person", "win32")).toBe(
            "C:\\Users\\person\\AppData\\Roaming\\kissopen-oss\\runtime\\.kissopen",
        );
    });

    it("matches packaged macOS Desktop regardless of XDG settings", () => {
        expect(getKissopenHome({ XDG_CONFIG_HOME: "/other" }, "/Users/person", "darwin")).toBe(
            "/Users/person/Library/Application Support/kissopen-oss/runtime/.kissopen",
        );
    });

    it("matches Linux Desktop and honors an absolute XDG config home", () => {
        expect(getKissopenHome({}, "/home/person", "linux")).toBe(
            "/home/person/.config/kissopen-oss/runtime/.kissopen",
        );
        expect(getKissopenHome({ XDG_CONFIG_HOME: "/data/config" }, "/home/person", "linux")).toBe(
            "/data/config/kissopen-oss/runtime/.kissopen",
        );
        expect(getKissopenHome({ XDG_CONFIG_HOME: "relative" }, "/home/person", "linux")).toBe(
            "/home/person/.config/kissopen-oss/runtime/.kissopen",
        );
    });

    it("retains explicit development, custom, and previous standalone installations", () => {
        expect(getKissopenHome({ KISSOPEN_HOME_DIR: "~/.kissopen" }, "/home/person", "linux")).toBe(
            "/home/person/.kissopen",
        );
        expect(getKissopenHome({ KISSOPEN_HOME_DIR: "/isolated" }, "/home/person", "linux")).toBe(
            "/isolated",
        );
        expect(getKissopenHome({ KISSOPEN_HOME_DIR: "dev" }, "C:\\Users\\person", "win32")).toBe(
            "C:\\Users\\person\\dev",
        );
        expect(
            getKissopenHome(
                { KISSOPEN_HOME_DIR: " D:\\Agent ", APPDATA: "C:\\Roaming" },
                "C:\\Users\\person",
                "win32",
            ),
        ).toBe("D:\\Agent");
    });
});
