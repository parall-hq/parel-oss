/** One page of `GET /sessions/:id/events`. */
export interface EventsPage {
	events: Record<string, unknown>[];
	hasMore?: boolean;
	/** The `since_seq` that continues after this page (present when it has events). */
	nextSeq?: number;
	/** Oldest seq the session still keeps; older events fell out of its window. */
	earliestAvailableSeq?: number;
}

/**
 * Reads every page of a session's events, oldest first, following `nextSeq`
 * while the server says there is more.
 */
export async function readAllEvents(
	fetchPage: (sinceSeq: number) => Promise<EventsPage>,
): Promise<{ events: Record<string, unknown>[]; earliestAvailableSeq?: number }> {
	const events: Record<string, unknown>[] = [];
	let sinceSeq = 0;
	let earliestAvailableSeq: number | undefined;
	for (;;) {
		const page = await fetchPage(sinceSeq);
		events.push(...page.events);
		earliestAvailableSeq ??= page.earliestAvailableSeq;
		// A cursor that doesn't move forward would loop forever; stop instead.
		if (!page.hasMore || page.nextSeq === undefined || page.nextSeq <= sinceSeq) break;
		sinceSeq = page.nextSeq;
	}
	return { events, ...(earliestAvailableSeq !== undefined ? { earliestAvailableSeq } : {}) };
}
