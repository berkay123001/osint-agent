import { z } from 'zod'

export const piiOutputSchema = z.object({
  emails: z.array(z.string()).describe('Found email addresses'),
  usernames: z.array(z.string()).describe('Found usernames or nicknames'),
  realNames: z.array(z.string()).describe('Found real names'),
  phoneNumbers: z.array(z.string()).describe('Found phone numbers'),
  walletAddresses: z.array(z.string()).describe('Found crypto wallet addresses'),
  locations: z.array(z.string()).describe('Found locations or addresses'),
})

export type PIIData = z.infer<typeof piiOutputSchema>

export const PII_EXTRACTION_PROMPT = `You are an OSINT analyst. Analyze the following raw data collected from various platforms and extract ALL personally identifiable information (PII).

Rules:
- Extract every email, username, real name, phone number, crypto wallet address, and location you find.
- Do NOT fabricate data. Only extract what is explicitly present in the text.
- Deduplicate results.
- If nothing is found for a category, return an empty array.

Raw data:
{{rawData}}`
