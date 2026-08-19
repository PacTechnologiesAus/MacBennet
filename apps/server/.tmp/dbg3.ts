import { runMigrations } from '../src/db/migrate.js';
import { config } from '../src/config.js';
import { listAgents } from '../src/services/forja.js';
import { pool } from '../src/db/client.js';

await runMigrations(config.databaseUrl);
console.log('calling listAgents');
const t = setTimeout(() => { console.log('STILL HANGING after 8s'); process.exit(1); }, 8000);
const agents = await listAgents();
clearTimeout(t);
console.log('agents:', agents.map((a) => a.key));
await pool.end();
