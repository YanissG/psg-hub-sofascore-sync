// Compatibility entrypoint: one collector, one authentication policy, one cadence.
import { main } from './sofascore-sync.mjs';
main().then(() => process.exit(0), (error) => {
  process.stderr.write(error.message + '\n');
  process.exit(1);
});
