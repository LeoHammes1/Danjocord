import { test } from "node:test";
import { register } from "tsx/esm/api";
register();
const { probeImage, sniffImage } = await import("./src/attachments/probe.js");

const cases: Record<string, number[]> = {
  "6 bytes FFD8 + 4xFF": [0xff,0xd8,0xff,0xff,0xff,0xff],
  "5 bytes": [0xff,0xd8,0xff,0xff,0xff],
  "7 bytes": [0xff,0xd8,0xff,0xff,0xff,0xff,0xff],
  "8 bytes": [0xff,0xd8,0xff,0xff,0xff,0xff,0xff,0xff],
  "22 bytes todos FF": new Array(22).fill(0xff).map((v,i)=> i===1?0xd8:0xff),
  "FFD8FF + 00 00": [0xff,0xd8,0xff,0x00,0x00],
};

test("probe", () => {
  for (const [nome, arr] of Object.entries(cases)) {
    const buf = Buffer.from(arr);
    try {
      const out = probeImage(buf);
      console.log(nome, "OK ->", JSON.stringify(out));
    } catch (e: any) {
      console.log(nome, "| sniff=", sniffImage(buf), "| throw:", e.constructor.name, "|", e.message);
    }
  }
});
