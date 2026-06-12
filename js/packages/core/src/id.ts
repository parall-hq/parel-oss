declare const crypto: { getRandomValues<T extends ArrayBufferView>(array: T): T };

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function createId(prefix: string, len = 12): string {
	const buf = new Uint8Array(len);
	crypto.getRandomValues(buf);
	let s = "";
	for (const b of buf) s += BASE62[b % 62];
	return `${prefix}_${s}`;
}

export const agtId = () => createId("agt");
export const ssnId = () => createId("ssn");
export const keyId = () => createId("key");
export const pvkId = () => createId("pvk");
export const evtId = () => createId("evt");
export const logId = () => createId("log");
export const chkId = () => createId("chk");
export const usgId = () => createId("usg");
export const pscId = () => createId("psc");
export const trnId = () => createId("trn");
export const msgId = () => createId("msg");
export const prtId = () => createId("prt");
export const artId = () => createId("art");
