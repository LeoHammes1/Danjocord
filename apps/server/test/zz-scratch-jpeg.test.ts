import { test } from "node:test";
import { register } from "tsx/esm/api";
register();
const { probeImage, sniffImage } = await import("../src/attachments/probe.js");

const cases: Array<[string, Buffer]> = [
  ["6 bytes FFD8 + 4x FF", Buffer.from([0xff,0xd8,0xff,0xff,0xff,0xff])],
  ["8 bytes FFD8 + 6x FF", Buffer.from([0xff,0xd8,0xff,0xff,0xff,0xff,0xff,0xff])],
  ["22 bytes FFD8 + 20x FF", Buffer.concat([Buffer.from([0xff,0xd8]), Buffer.alloc(20,0xff)])],
  ["5 bytes", Buffer.from([0xff,0xd8,0xff,0xff,0xff])],
  ["7 bytes", Buffer.from([0xff,0xd8,0xff,0xff,0xff,0xff,0xff])],
  ["FFD8 FFE0 truncado 4", Buffer.from([0xff,0xd8,0xff,0xe0])],
  ["FFD8 FFD9 FF FF", Buffer.from([0xff,0xd8,0xff,0xd9,0xff,0xff])],
];

test("scratch", () => {
  for (const [nome, buf] of cases) {
    let out: string;
    try {
      out = "OK " + JSON.stringify(probeImage(buf));
    } catch (e: any) {
      out = `${e.constructor.name}: ${e.message}`;
    }
    console.log(`[${nome}] len=${buf.length} sniff=${sniffImage(buf)} -> ${out}`);
  }
});
