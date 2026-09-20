// How many weeks of songs are left in the weekly rotation?
//   npm run runway
// Prints the numbers and exits with code 2 if there are fewer than RUNWAY_WARN_WEEKS (default 8) weeks left,
// so it can also be used from a scheduled task that alerts you.
import { runway } from '../src/drops.js';

try {
  const r = await runway();
  console.log(`Songs on the channel (public, no Shorts): ${r.totalSongs}`);
  console.log(`Already sent in a weekly drop:            ${r.alreadySent}`);
  console.log(`Unsent, still in the rotation:            ${r.remaining}`);
  console.log(`Weeks of runway at ${r.perWeek} songs a week:        ${r.weeksOfRunway}`);
  console.log(`\n${r.message}`);
  process.exit(r.warn ? 2 : 0);
} catch (err) {
  console.error(`Could not check the runway: ${err.message}`);
  process.exit(1);
}
