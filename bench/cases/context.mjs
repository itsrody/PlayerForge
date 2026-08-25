import { measure } from "../lib.mjs";
import { hashEntry, getDomainKey, domainsMatch } from "../../src/shared/context.js";

const paths = [];
for (let i = 0; i < 64; i++) {
  paths.push(`/watch/${i}?t=abc${i}`);
}

export default [
  measure("hashEntry (djb2, domain-seeded)", () => {
    let sink = 0;
    return () => {
      for (let i = 0; i < 100; i++) {
        sink += hashEntry("youtube", paths[i & 63], 600 + i);
      }
      if (sink === Infinity) throw new Error();
    };
  }),

  measure("getDomainKey typical hosts", () => {
    const hosts = ["www.youtube.com", "static.crunchyroll.com", "player.vimeo.com", "192.168.1.5", "a.b.example.co.uk"];
    let sink = "";
    return () => {
      for (let i = 0; i < 200; i++) {
        sink = getDomainKey(hosts[i % hosts.length]);
      }
      if (sink === undefined) throw new Error();
    };
  }),

  measure("domainsMatch boundary checks", () => {
    const pairs = [
      ["youtube", "youtube"],
      ["tv.apple", "apple"],
      ["apple", "tv.apple"],
      ["notyoutube", "youtube"],
      ["espnw", "espn"]
    ];
    let sink = false;
    return () => {
      for (let i = 0; i < 500; i++) {
        const [a, b] = pairs[i % pairs.length];
        sink = domainsMatch(a, b);
      }
      if (sink === undefined) throw new Error();
    };
  })
];
