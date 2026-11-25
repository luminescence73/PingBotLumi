import test from "node:test";
import assert from "node:assert/strict";
import { currentGiftCodes } from "../src/sxs/valkyrieParsers.js";
test("expired codes are excluded, unknown expiry retained, removed codes not revived",()=>{
 const now=Date.parse("2026-11-25T12:00:00Z");
 const active={code:"ACTIVE",expiresAt:"2026-11-26T00:00:00Z"};
 const unknown={code:"UNKNOWN"};
 assert.deepEqual(currentGiftCodes([active,unknown,active,{code:"OLD",expiresAt:"2026-11-25T12:00:00Z"},{code:"FLAGGED",expired:true}],now),[active,unknown]);
 assert.deepEqual(currentGiftCodes([unknown],now),[unknown]);
});
