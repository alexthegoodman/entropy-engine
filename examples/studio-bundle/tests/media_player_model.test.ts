import { describe, expect, it } from "vitest";
import { parseSubtitles, subtitleAt } from "../src/apps/media_player_model";

describe("Media Player subtitles", () => {
    it("parses SRT and VTT timing, ignores malformed cues, and uses an exclusive end", () => {
        const cues = parseSubtitles(`1\r\n00:00:01,500 --> 00:00:03,000\r\n<em>Hello</em>\r\n\r\n00:04.000 --> 00:05.250\nWorld\n\n00:10.000 --> 00:09.000\nInvalid`);
        expect(cues).toEqual([
            { startMs: 1500, endMs: 3000, text: "Hello" },
            { startMs: 4000, endMs: 5250, text: "World" },
        ]);
        expect(subtitleAt(cues, 1500)).toBe("Hello");
        expect(subtitleAt(cues, 3000)).toBe("");
        expect(subtitleAt(cues, 5250)).toBe("");
    });
});
