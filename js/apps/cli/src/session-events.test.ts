import { describe, expect, test } from "vitest";
import { type EventsPage, readAllEvents } from "./session-events.js";

const event = (seq: number) => ({ id: `evt_${seq}`, seq, type: "step:start", data: "{}" });

describe("readAllEvents", () => {
	test("follows nextSeq while hasMore", async () => {
		const pages: Record<number, EventsPage> = {
			0: { events: [event(5), event(6)], hasMore: true, nextSeq: 6, earliestAvailableSeq: 5 },
			6: { events: [event(7)], hasMore: false, nextSeq: 7, earliestAvailableSeq: 5 },
		};
		const asked: number[] = [];
		const result = await readAllEvents(async (sinceSeq) => {
			asked.push(sinceSeq);
			return pages[sinceSeq];
		});
		expect(asked).toEqual([0, 6]);
		expect(result.events.map((e) => e.seq)).toEqual([5, 6, 7]);
		expect(result.earliestAvailableSeq).toBe(5);
	});

	test("an empty session is one empty page", async () => {
		const result = await readAllEvents(async () => ({ events: [], hasMore: false }));
		expect(result).toEqual({ events: [] });
	});

	test("stops when the cursor does not move forward", async () => {
		let calls = 0;
		const result = await readAllEvents(async () => {
			calls++;
			return { events: [event(1)], hasMore: true, nextSeq: 0 };
		});
		expect(calls).toBe(1);
		expect(result.events).toHaveLength(1);
	});
});
