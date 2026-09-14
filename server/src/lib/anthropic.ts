import Anthropic from '@anthropic-ai/sdk';
import { env } from './env.js';

/**
 * One client for the process, built on first use. OCR and summaries share it,
 * so both pick up the same key and the SDK's retry defaults.
 */
let client: Anthropic | null = null;
export const anthropic = () => (client ??= new Anthropic({ apiKey: env.anthropicApiKey || undefined }));
