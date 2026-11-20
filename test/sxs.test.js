import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { knownBoss } from "../src/sxs/conquestBosses.js";
import { parseCodes, parseHome } from "../src/sxs/valkyrieParsers.js";

test("the live hub recognizes seasons, rotations and deduplicated gift codes", () => {
  const home = parseHome(`
    <p>Season 3 · Ashen · Server Day 30</p>
    <p>Grand Treasure Hunt #7</p><p>Level 5: Rare Relic</p>
    <p>Gift codes</p><p>ASHEN2026</p><p>Guild events</p>
  `);
  assert.deepEqual(home.season, { number: 3, region: "Ashen", serverDay: 30 });
  assert.equal(home.weekly.hunt, "Grand Treasure Hunt #7");
  assert.equal(home.weekly.reward, "Rare Relic");
  assert.deepEqual(home.currentCodeCandidates, ["ASHEN2026"]);
  assert.deepEqual(parseCodes(`
    <p>Copy all codes</p><p>ASHEN2026</p><p>100 Dawn &amp; 20 gems</p><p>Tap to copy</p>
    <p>ASHEN2026</p><p>Duplicate reward</p><p>Tap to copy</p>
  `), [{ code: "ASHEN2026", reward: "100 Dawn & 20 gems" }]);
});

test("confirmed Conquest boss records still reference their tracked artwork files", async () => {
  for (const [floor, expected] of [[136, "Spider Queen"], [156, "Chaos Herald"]]) {
    const boss = knownBoss(floor);
    assert.equal(boss.name, expected);
    const artwork = await readFile(new URL(`../${boss.artwork.asset}`, import.meta.url), "utf8");
    assert.equal(Buffer.from(artwork, "base64").toString("ascii", 0, 4), "RIFF");
  }
  assert.equal(knownBoss(5000), null);
});
