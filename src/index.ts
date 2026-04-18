import 'dotenv/config'
export { ai } from './lib/ai.js'

import './tools/sherlockTool.js'
import './flows/investigateFlow.js'

console.log('🕵️ OSINT Agent started.')
