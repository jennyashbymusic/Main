// Run the weekly drop from the command line (handy for an external cron / Task Scheduler instead of the built-in one):
//   npm run send            pick 3 new songs and email everyone
//   npm run send -- --resend  re-run the current drop (only reaches people who haven't received it)
import { latestDrop } from '../src/db.js';
import { runWeeklyDrop, sendDrop } from '../src/drops.js';

try {
  const resend = process.argv.includes('--resend');
  const drop = resend ? latestDrop() : null;
  if (resend && !drop) throw new Error('No drop exists yet.');
  const result = resend ? await sendDrop(drop.id) : await runWeeklyDrop();
  console.log(result);
  process.exit(0);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
