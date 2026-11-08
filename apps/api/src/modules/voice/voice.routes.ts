// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  editTranscriptSchema,
  fileTranscriptSchema,
  transcribeFileSchema,
  transcriptionSchema,
  voiceSettingsViewSchema,
} from '@bines/shared';
import { actorOf, requireAccount } from '../../middleware/auth';
import { accountHeader, idParam, json, jsonBody, COMMON_ERRORS } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import {
  editTranscript,
  getTranscript,
  listTranscriptionModels,
  transcribeFile,
  voiceSettingsView,
} from './voice.service';

/** Voice in updates: what the composer may offer, and turning a recording into text. */
export const voiceRoutes = (deps: AppDeps) => {
  const middleware = [requireAccount(deps)];
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/voice',
      tags: ['ai'],
      summary: 'Voice in updates: recording on, its longest length, whether transcription is available to me',
      middleware,
      request: { headers: accountHeader },
      responses: { 200: json(voiceSettingsViewSchema, 'Voice settings'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await voiceSettingsView(deps, actorOf(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/files/{id}/transcribe',
      tags: ['files'],
      summary: 'The text of an audio / video file (the account’s speech-to-text connection; counted in AI usage)',
      middleware,
      request: { headers: accountHeader, params: idParam, ...jsonBody(transcribeFileSchema) },
      responses: { 200: json(transcriptionSchema, 'The text'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await transcribeFile(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  // the kept transcript — read by whoever may read the file, corrected by whoever may edit its holder.
  r.openapi(
    createRoute({
      method: 'get',
      path: '/files/{id}/transcript',
      tags: ['files'],
      summary: "A file's kept transcript (null until someone transcribed it)",
      middleware,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(fileTranscriptSchema, 'The transcript'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await getTranscript(deps, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/files/{id}/transcript',
      tags: ['files'],
      summary: "Corrects a file's transcript (empty text removes it)",
      middleware,
      request: { headers: accountHeader, params: idParam, ...jsonBody(editTranscriptSchema) },
      responses: { 200: json(fileTranscriptSchema, 'The transcript'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await editTranscript(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/ai/connections/{id}/transcription-models',
      tags: ['ai'],
      summary: 'A connection’s speech-to-text models, newest first (admin)',
      middleware,
      request: { headers: accountHeader, params: idParam },
      responses: {
        200: json(z.object({ data: z.array(z.object({ id: z.string(), display_name: z.string() })) }), 'Models'),
        ...COMMON_ERRORS,
      },
    }),
    async (c) => c.json(await listTranscriptionModels(deps, actorOf(c), c.req.valid('param').id), 200),
  );
  return r;
};
