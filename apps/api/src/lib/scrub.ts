// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Credentials that could ride along in an error text or a log line (docs/AI-SECURITY-REVIEW.md AI-RT7): AI provider
 * keys, our API / OAuth tokens and any bearer / basic value. Logs and error reports never carry one, whatever
 * library wrote the message (CLAUDE.md rule 10). The patterns live in @bines/shared (`scrubSecrets`) so the errors
 * hub's redaction (`redactErrorMessage`, api and worker alike) uses the very same rules.
 */
export { scrubSecrets } from '@bines/shared';
