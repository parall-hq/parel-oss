import { describe, expect, test } from "vitest";
import { agtId, chkId, createId, evtId, keyId, logId, pscId, pvkId, ssnId, usgId } from "../id";

describe("createId", () => {
	test("format: prefix_12chars", () => {
		const id = createId("tst");
		expect(id).toMatch(/^tst_[0-9A-Za-z]{12}$/);
	});

	test("unique", () => {
		const ids = new Set(Array.from({ length: 1000 }, () => createId("tst")));
		expect(ids.size).toBe(1000);
	});

	test("all generators produce correct prefix", () => {
		expect(agtId()).toMatch(/^agt_/);
		expect(ssnId()).toMatch(/^ssn_/);
		expect(evtId()).toMatch(/^evt_/);
		expect(logId()).toMatch(/^log_/);
		expect(chkId()).toMatch(/^chk_/);
		expect(keyId()).toMatch(/^key_/);
		expect(pvkId()).toMatch(/^pvk_/);
		expect(usgId()).toMatch(/^usg_/);
		expect(pscId()).toMatch(/^psc_/);
	});
});
