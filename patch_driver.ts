import fs from 'fs';
const neo4jPath = '/home/berkayhsrt/Baykara/osint-agent/src/lib/neo4j.ts';
let code = fs.readFileSync(neo4jPath, 'utf8');

code = code.replace("function getDriver(): Driver", "export function getDriver(): Driver");

fs.writeFileSync(neo4jPath, code);
