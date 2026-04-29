import { loadConfig } from './config.ts';
import { createApp } from './server.ts';

const config = loadConfig();
const app = createApp(config);

await app.listen();
