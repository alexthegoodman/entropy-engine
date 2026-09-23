export type Cue = { startMs: number; endMs: number; text: string };

function timestamp(value: string): number | null {
    const match = value.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})$/);
    if (!match) return null;
    return (((Number(match[1] ?? 0) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000)
        + Number(match[4].padEnd(3, "0"));
}

export function parseSubtitles(input: string): Cue[] {
    const cues: Cue[] = [];
    for (const block of input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split(/\n\s*\n/)) {
        const lines = block.split("\n").map(line => line.trim()).filter(Boolean);
        const timing = lines.findIndex(line => line.includes("-->"));
        if (timing < 0) continue;
        const [startRaw, endRaw] = lines[timing].split(/\s*-->\s*/);
        const startMs = timestamp(startRaw);
        const endMs = timestamp((endRaw ?? "").split(/\s+/)[0]);
        if (startMs === null || endMs === null || endMs <= startMs) continue;
        const text = lines.slice(timing + 1).join("\n").replace(/<[^>]*>/g, "").trim();
        if (text) cues.push({ startMs, endMs, text });
    }
    return cues.sort((a, b) => a.startMs - b.startMs);
}

export function subtitleAt(cues: Cue[], timeMs: number): string {
    return cues.find(cue => cue.startMs <= timeMs && timeMs < cue.endMs)?.text ?? "";
}
