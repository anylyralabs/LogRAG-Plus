/** LogRAG+ 服务入口。用法: node dist/server.js 或 npx tsx src/server.ts */
import { startServer } from './server/start.ts';

void startServer().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
