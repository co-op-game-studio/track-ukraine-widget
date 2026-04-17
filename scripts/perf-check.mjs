import { readFileSync } from 'node:fs';

const PADDED = rc => String(rc).padStart(5, '0');
const urls = [];
const bills = JSON.parse(readFileSync('src/data/ukraineBills.json', 'utf8'));
for (const b of bills) {
  for (const v of b.votes) {
    if (v.chamber === 'Senate') {
      urls.push(
        `https://www.senate.gov/legislative/LIS/roll_call_votes/vote${v.congress}${v.session}/vote_${v.congress}_${v.session}_${PADDED(v.rollCall)}.xml`,
      );
    }
  }
}
console.log('Senate URLs to fetch:', urls.length);

async function runBatch(limit) {
  let active = 0, next = 0, done = 0;
  return new Promise((resolve) => {
    const start = Date.now();
    const step = () => {
      while (active < limit && next < urls.length) {
        const i = next++;
        active++;
        fetch(urls[i])
          .then((r) => r.text())
          .finally(() => {
            active--;
            done++;
            if (done === urls.length) resolve(Date.now() - start);
            else step();
          });
      }
    };
    step();
  });
}

for (const c of [3, 6, 10, 20]) {
  const t = await runBatch(c);
  console.log(`Concurrency ${c}: ${t}ms total for ${urls.length} Senate XML fetches`);
}
