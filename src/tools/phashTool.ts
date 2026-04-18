import { ai } from '../lib/ai.js';
import { z } from 'zod';
import { compareImages } from './phashCompareTool.js';

export const phashCompareTool = ai.defineTool(
  {
    name: 'phashCompareTool',
    description: 'Compares two images using perceptual hashing (pHash) to measure pixel-level similarity (Levenshtein threshold). Useful for determining whether an image in a news story is the same as one seen in another context, and for providing evidence of disinformation.',
    inputSchema: z.object({
      url1: z.string().describe('Full URL of the first image (e.g. the alleged fake-news photo)'),
      url2: z.string().describe('Full URL of the second image to compare (e.g. the genuine/original source photo)'),
    }),
    outputSchema: z.string(),
  },
  async ({ url1, url2 }) => {
    return compareImages(url1, url2);
  }
);
