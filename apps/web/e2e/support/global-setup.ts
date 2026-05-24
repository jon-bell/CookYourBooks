import { startFunctionsServer } from './functionsServer.js';

export default async function globalSetup(): Promise<void> {
  await startFunctionsServer();
}
