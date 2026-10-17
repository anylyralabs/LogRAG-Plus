/** 知识库索引构建 CLI。用法: npx tsx src/rag/build-cli.ts [知识库目录] [索引输出路径] */
import { buildIndex, formatReport } from './build.ts';

const knowledgeDir = process.argv[2] ?? './knowledge';
const dbPath = process.argv[3] ?? './data/rag/index.db';

console.log(`构建索引: ${knowledgeDir} → ${dbPath}\n`);

const result = await buildIndex(knowledgeDir, dbPath);
console.log(formatReport(result));

process.exit(result.ok ? 0 : 1);
