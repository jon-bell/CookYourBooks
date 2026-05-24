import { stopFunctionsServer } from './functionsServer.js';

export default async function globalTeardown(): Promise<void> {
  await stopFunctionsServer();
}
